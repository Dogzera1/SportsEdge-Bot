#!/usr/bin/env node
'use strict';

/**
 * scripts/sync-opendota-team-stats.js
 *
 * Sync Dota2 pro team stats via OpenDota API → table dota_team_stats.
 * Substrato pra features de training (Dota2 v1: rating/wr/games;
 * v2 com --deep: rolling 30d kill_margin, duration, streak, form).
 *
 * Endpoints usados:
 *   GET /api/teams  — lista top teams (sempre)
 *   GET /api/teams/{id}/matches  — recent matches (só com --deep, 1 req/team)
 *
 * Throttle: 60 req/min sem API key (1s entre requests). Com OPENDOTA_API_KEY
 * mais relaxado. --deep com 100 teams = ~2min extra.
 *
 * Uso:
 *   node scripts/sync-opendota-team-stats.js                  # v1 só rating/wr
 *   node scripts/sync-opendota-team-stats.js --limit=500      # top 500 teams
 *   node scripts/sync-opendota-team-stats.js --deep           # v2 rolling 30d
 *   node scripts/sync-opendota-team-stats.js --deep --limit=500 --dry-run
 */

require('dotenv').config({ override: true });
const path = require('path');
const https = require('https');
const Database = require('better-sqlite3');
const { applyMigrations } = require('../migrations');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');
const API_KEY = process.env.OPENDOTA_API_KEY || '';

const argv = process.argv.slice(2);
const argVal = (name, def) => {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
};
const LIMIT = parseInt(argVal('limit', '200'), 10);
const DRY_RUN = argv.includes('--dry-run');
const DEEP = argv.includes('--deep');
const THROTTLE_MS = parseInt(argVal('throttle-ms', API_KEY ? '200' : '1100'), 10);

function getJson(url, { retries = 2, delayMs = 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      https.get(url, { headers: { 'User-Agent': 'SportsEdge/1.0' }, timeout: 30000 }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode === 429 && n > 0) {
            setTimeout(() => attempt(n - 1), delayMs * 2);
            return;
          }
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }).on('error', err => {
        if (n > 0) setTimeout(() => attempt(n - 1), delayMs);
        else reject(err);
      }).on('timeout', () => reject(new Error('timeout')));
    };
    attempt(retries);
  });
}

async function main() {
  const db = new Database(DB_PATH);
  applyMigrations(db); // garante table dota_team_stats existe
  const keyQs = API_KEY ? `?api_key=${API_KEY}` : '';

  console.log(`[opendota-teams] fetching top ${LIMIT} teams...`);
  const url = `https://api.opendota.com/api/teams${keyQs}`;
  const teams = await getJson(url);
  if (!Array.isArray(teams)) {
    console.error('Expected array, got:', typeof teams);
    process.exit(1);
  }
  console.log(`[opendota-teams] got ${teams.length} total teams`);

  // API retorna todos os teams mas muitos são inativos. Filtra:
  //   - Tem name
  //   - rating > 900 OU wins+losses >= 5 (safety net — rating pode estar null)
  //   - last_match_time nos últimos 2 anos (pra não pegar times extintos)
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - 2 * 365 * 86400;
  const filtered = teams
    .filter(t => t.name && ((t.rating != null && t.rating > 900) || (t.wins + t.losses >= 5)))
    .filter(t => !t.last_match_time || t.last_match_time > cutoff)
    .sort((a, b) => (b.rating || 0) - (a.rating || 0))
    .slice(0, LIMIT);

  console.log(`[opendota-teams] ${filtered.length} teams após filter (rating + ativo)`);

  if (DRY_RUN) {
    console.log('[dry-run] would upsert:');
    for (const t of filtered.slice(0, 10)) {
      console.log(` ${t.team_id}\t${t.name} (${t.tag || '-'}) rating=${(t.rating||0).toFixed(0)} W=${t.wins} L=${t.losses}`);
    }
    console.log(`... +${Math.max(0, filtered.length - 10)} mais`);
    return;
  }

  const upsertBasic = db.prepare(`
    INSERT INTO dota_team_stats (team_id, name, tag, rating, wins, losses, wr, last_match_time, updated_at)
    VALUES (@team_id, @name, @tag, @rating, @wins, @losses, @wr, @last_match_time, datetime('now'))
    ON CONFLICT(team_id) DO UPDATE SET
      name=excluded.name, tag=excluded.tag, rating=excluded.rating,
      wins=excluded.wins, losses=excluded.losses, wr=excluded.wr,
      last_match_time=excluded.last_match_time, updated_at=datetime('now')
  `);

  // Basic upsert primeiro — sempre roda
  let written = 0;
  const tx = db.transaction((rows) => {
    for (const t of rows) {
      const wins = Number(t.wins) || 0;
      const losses = Number(t.losses) || 0;
      const total = wins + losses;
      const wr = total > 0 ? wins / total : null;
      upsertBasic.run({
        team_id: t.team_id,
        name: t.name || null,
        tag: t.tag || null,
        rating: Number.isFinite(t.rating) ? t.rating : null,
        wins, losses, wr,
        last_match_time: Number(t.last_match_time) || null,
      });
      written++;
    }
  });
  tx(filtered);
  console.log(`[opendota-teams] wrote ${written} teams basic`);

  // ── Deep sync: per-team rolling 30d aggregates ────────────────────────
  if (!DEEP) return;
  console.log(`[opendota-teams] deep sync: fetching matches for ${filtered.length} teams...`);
  const upsertRolling = db.prepare(`
    UPDATE dota_team_stats
    SET recent_n = ?, recent_wr = ?, avg_kill_margin = ?, avg_duration_sec = ?,
        win_streak_current = ?, days_since_last = ?, updated_at = datetime('now')
    WHERE team_id = ?
  `);

  const rollingWindowDays = 30;
  const rollingCutoff = Math.floor(Date.now() / 1000) - rollingWindowDays * 86400;
  let deepOk = 0, deepFail = 0;

  for (let i = 0; i < filtered.length; i++) {
    const t = filtered[i];
    if (i > 0) await new Promise(r => setTimeout(r, THROTTLE_MS));
    try {
      const murl = `https://api.opendota.com/api/teams/${t.team_id}/matches${keyQs}`;
      const matches = await getJson(murl);
      if (!Array.isArray(matches)) { deepFail++; continue; }
      // Filter last 30d
      const recent = matches.filter(m => (m.start_time || 0) >= rollingCutoff);
      const n = recent.length;
      if (n < 3) {
        // Team não ativa suficiente — marca 0/null mas não erro
        if (!DRY_RUN) upsertRolling.run(0, null, null, null, 0, null, t.team_id);
        continue;
      }
      // WR, kill margin, duration
      let wins = 0, killMarginSum = 0, killMarginN = 0, durSum = 0, durN = 0;
      for (const m of recent) {
        const isRadiant = !!m.radiant;
        const rScore = Number(m.radiant_score);
        const dScore = Number(m.dire_score);
        const radWin = !!m.radiant_win;
        const teamWon = radWin === isRadiant;
        if (teamWon) wins++;
        if (Number.isFinite(rScore) && Number.isFinite(dScore)) {
          const teamScore = isRadiant ? rScore : dScore;
          const oppScore = isRadiant ? dScore : rScore;
          killMarginSum += (teamScore - oppScore);
          killMarginN++;
        }
        if (Number.isFinite(m.duration)) { durSum += m.duration; durN++; }
      }
      const recentWr = wins / n;
      const avgKillMargin = killMarginN > 0 ? killMarginSum / killMarginN : null;
      const avgDur = durN > 0 ? durSum / durN : null;

      // Current streak: matches ordenados por start_time desc (OpenDota retorna assim)
      let streak = 0;
      const first = recent[0];
      if (first) {
        const firstWon = !!first.radiant_win === !!first.radiant;
        for (const m of recent) {
          const won = !!m.radiant_win === !!m.radiant;
          if (won === firstWon) streak += firstWon ? 1 : -1;
          else break;
        }
      }
      // Days since last match
      const daysSinceLast = first?.start_time
        ? Math.floor((Date.now() / 1000 - first.start_time) / 86400)
        : null;

      if (DRY_RUN) {
        if (i < 5) console.log(`  ${t.name}: n=${n} wr=${(recentWr*100).toFixed(1)}% km=${avgKillMargin?.toFixed(1)} dur=${((avgDur||0)/60).toFixed(1)}m streak=${streak} dsl=${daysSinceLast}`);
      } else {
        upsertRolling.run(n, recentWr, avgKillMargin, avgDur, streak, daysSinceLast, t.team_id);
      }
      deepOk++;
    } catch (e) {
      deepFail++;
      if (deepFail < 5) console.warn(`  team ${t.team_id} (${t.name}): ${e.message}`);
    }
    if ((i + 1) % 20 === 0) console.log(`  ... ${i + 1}/${filtered.length}`);
  }
  console.log(`[opendota-teams] deep sync: ${deepOk} ok, ${deepFail} fail`);
}

main().catch(e => {
  console.error('[opendota-teams] FATAL:', e.message);
  process.exit(1);
});
