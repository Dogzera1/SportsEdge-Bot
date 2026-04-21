#!/usr/bin/env node
'use strict';

/**
 * scripts/sync-hltv-cs-teams.js
 *
 * Sync CS2 pro team stats via HLTV (lib/hltv.js + HLTV_PROXY_BASE).
 * Equivalente Dota2 sync-opendota-team-stats.js, mas HLTV não tem API
 * estruturada — usa scraping HTML via proxy.
 *
 * Fluxo:
 *   1) getTopTeams() — top ~30 do ranking mundial
 *   2) Pra cada team: getTeamRecentMatches(teamId, slug, 15) — últimos 15 matches
 *   3) Compute wins, losses, wr, streak, last_match_date
 *   4) Upsert em cs_team_stats (migration 049)
 *
 * Throttle: HLTV via proxy ngrok — usa delay padrão da lib (sequential).
 * Runtime: ~2-3 min pra top 30 (15 req/team × 30 teams = 450 req mas lib
 *   já reusa cache de 15min).
 *
 * Uso:
 *   node scripts/sync-hltv-cs-teams.js              # top 30 ranking
 *   node scripts/sync-hltv-cs-teams.js --limit=50   # top 50
 *   node scripts/sync-hltv-cs-teams.js --dry-run
 *
 * Env: HLTV_PROXY_BASE required (mesmo padrão do enrichment runtime).
 */

require('dotenv').config({ override: true });
const path = require('path');
const Database = require('better-sqlite3');
const { applyMigrations } = require('../migrations');
const hltv = require('../lib/hltv');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');

const argv = process.argv.slice(2);
const argVal = (name, def) => {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
};
const LIMIT = parseInt(argVal('limit', '30'), 10);
const DRY_RUN = argv.includes('--dry-run');
const RECENT_N = parseInt(argVal('recent-n', '15'), 10);

function _streak(results) {
  if (!results?.length) return 0;
  const first = results[0];
  if (first !== 'W' && first !== 'L') return 0;
  let n = 0;
  for (const r of results) {
    if (r === first) n++; else break;
  }
  return first === 'W' ? n : -n;
}

async function main() {
  if (!process.env.HLTV_PROXY_BASE && !process.env.HLTV_DIRECT) {
    console.error('[hltv-cs-teams] HLTV_PROXY_BASE não definido (ou HLTV_DIRECT=true). Abort.');
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  applyMigrations(db);

  console.log(`[hltv-cs-teams] fetching top teams (limit=${LIMIT})...`);
  const ranked = await hltv.getTopTeams();
  if (!Array.isArray(ranked) || !ranked.length) {
    console.error('[hltv-cs-teams] getTopTeams retornou vazio — proxy ok?');
    process.exit(1);
  }
  console.log(`[hltv-cs-teams] got ${ranked.length} ranked teams, processing top ${LIMIT}`);
  const teams = ranked.slice(0, LIMIT);

  const upsert = db.prepare(`
    INSERT INTO cs_team_stats (team_id, name, slug, ranking, ranking_points,
      recent_n, recent_wr, win_streak_current, last_match_date, updated_at)
    VALUES (@team_id, @name, @slug, @ranking, @ranking_points,
      @recent_n, @recent_wr, @win_streak_current, @last_match_date, datetime('now'))
    ON CONFLICT(team_id) DO UPDATE SET
      name=excluded.name, slug=excluded.slug, ranking=excluded.ranking,
      ranking_points=excluded.ranking_points, recent_n=excluded.recent_n,
      recent_wr=excluded.recent_wr, win_streak_current=excluded.win_streak_current,
      last_match_date=excluded.last_match_date, updated_at=datetime('now')
  `);

  let ok = 0, fail = 0;

  for (let i = 0; i < teams.length; i++) {
    const t = teams[i];
    try {
      // getTeamRecentMatches retorna summarizeForm: {wins, losses, winRate, recent, streak}
      const form = await hltv.getTeamRecentMatches(t.teamId, t.slug, RECENT_N);
      if (!form) {
        // Team no ranking mas sem recent results parseable
        if (!DRY_RUN) {
          upsert.run({
            team_id: t.teamId, name: t.name, slug: t.slug,
            ranking: t.rank, ranking_points: t.points,
            recent_n: 0, recent_wr: null, win_streak_current: 0, last_match_date: null,
          });
        }
        continue;
      }
      const n = (form.wins || 0) + (form.losses || 0);
      const wr = n > 0 ? (form.wins / n) : null;
      const streak = Number.isFinite(form.streak) ? form.streak : _streak(form.recent);

      if (DRY_RUN) {
        if (i < 10) console.log(`  #${t.rank} ${t.name.padEnd(20)} n=${n} wr=${wr != null ? (wr*100).toFixed(1) + '%' : '—'} streak=${streak}`);
      } else {
        upsert.run({
          team_id: t.teamId, name: t.name, slug: t.slug,
          ranking: t.rank, ranking_points: t.points,
          recent_n: n, recent_wr: wr, win_streak_current: streak,
          last_match_date: null, // summarizeForm não expõe date da última match — parseTeamRecent tem mas não é exportado
        });
      }
      ok++;
    } catch (e) {
      fail++;
      if (fail <= 3) console.warn(`  team ${t.teamId} (${t.name}): ${e.message}`);
    }
    // Log progresso cada 10
    if ((i + 1) % 10 === 0) console.log(`  ... ${i + 1}/${teams.length}`);
  }

  console.log(`[hltv-cs-teams] ${ok} ok, ${fail} fail`);
  const total = db.prepare('SELECT COUNT(*) AS n FROM cs_team_stats').get();
  console.log(`[hltv-cs-teams] total rows in cs_team_stats: ${total.n}`);
}

main().catch(e => {
  console.error('[hltv-cs-teams] FATAL:', e.message);
  process.exit(1);
});
