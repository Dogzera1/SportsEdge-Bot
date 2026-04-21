#!/usr/bin/env node
'use strict';

/**
 * scripts/sync-opendota-team-stats.js
 *
 * Sync Dota2 pro team stats via OpenDota API → table dota_team_stats.
 * Substrato pra features de training (extract-esports-features.js Dota2
 * extras: rating_diff, wr_diff, games_diff, has_team_stats).
 *
 * Endpoints usados:
 *   GET /api/teams  — lista top teams (ranked by rating, max ~1000 rows)
 *   [opcional] GET /api/teams/{id} — stats detalhados (não necessário, lista já tem tudo)
 *
 * Throttle: 100 req/min default (sem api key). Com OPENDOTA_API_KEY mais relaxado.
 *
 * Uso:
 *   node scripts/sync-opendota-team-stats.js                # top 200 teams
 *   node scripts/sync-opendota-team-stats.js --limit=500    # top 500
 *   node scripts/sync-opendota-team-stats.js --dry-run      # não escreve
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

  const upsert = db.prepare(`
    INSERT INTO dota_team_stats (team_id, name, tag, rating, wins, losses, wr, last_match_time, updated_at)
    VALUES (@team_id, @name, @tag, @rating, @wins, @losses, @wr, @last_match_time, datetime('now'))
    ON CONFLICT(team_id) DO UPDATE SET
      name=excluded.name, tag=excluded.tag, rating=excluded.rating,
      wins=excluded.wins, losses=excluded.losses, wr=excluded.wr,
      last_match_time=excluded.last_match_time, updated_at=datetime('now')
  `);

  let written = 0;
  const tx = db.transaction((rows) => {
    for (const t of rows) {
      const wins = Number(t.wins) || 0;
      const losses = Number(t.losses) || 0;
      const total = wins + losses;
      const wr = total > 0 ? wins / total : null;
      upsert.run({
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
  console.log(`[opendota-teams] wrote ${written} teams to dota_team_stats`);
}

main().catch(e => {
  console.error('[opendota-teams] FATAL:', e.message);
  process.exit(1);
});
