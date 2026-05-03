#!/usr/bin/env node
'use strict';

/**
 * seed-basket-history.js
 *
 * Popula `basket_match_history` puxando ESPN NBA scoreboards das últimas N
 * temporadas. Usado como dataset de treino pelo train-basket-model.js.
 *
 * Run: node scripts/seed-basket-history.js [days_back=730]
 *
 * Cobertura: ~1300 games/season (regular + playoffs). 2 seasons = ~2600 samples.
 * NBA regular season: out → abr (~6 meses, jogos diários ~10/dia).
 * Playoffs: abr → jun (~2 meses, jogos jovenços).
 */

const path = require('path');
const Database = require('better-sqlite3');
const { applyMigrations } = require('../migrations');

const _norm = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

const espnGet = (path) => new Promise((resolve) => {
  const https = require('https');
  const req = https.request({
    hostname: 'site.api.espn.com',
    path,
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
  }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      let j = null;
      try { j = JSON.parse(d); } catch (_) {}
      resolve({ status: res.statusCode, body: j });
    });
  });
  req.on('error', () => resolve({ status: 0, body: null }));
  req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, body: null }); });
  req.end();
});

function fmtYmd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function parseEvent(ev) {
  try {
    const comp = Array.isArray(ev?.competitions) ? ev.competitions[0] : null;
    if (!comp) return null;
    const completed = comp.status?.type?.completed === true;
    if (!completed) return null;
    const cps = Array.isArray(comp.competitors) ? comp.competitors : [];
    if (cps.length < 2) return null;
    const home = cps.find(c => c.homeAway === 'home');
    const away = cps.find(c => c.homeAway === 'away');
    if (!home || !away) return null;
    const homeName = home.team?.displayName || home.team?.name || '';
    const awayName = away.team?.displayName || away.team?.name || '';
    const hs = parseInt(home.score, 10);
    const as = parseInt(away.score, 10);
    if (!homeName || !awayName || !Number.isFinite(hs) || !Number.isFinite(as)) return null;
    if (hs === as) return null; // overtime always resolves NBA, mas guard
    return {
      espn_id: String(ev.id),
      season: ev.season?.year || null,
      season_type: ev.season?.slug || comp.season?.slug || null,
      game_date: (ev.date || '').slice(0, 10),
      home_team: homeName,
      away_team: awayName,
      home_team_norm: _norm(homeName),
      away_team_norm: _norm(awayName),
      home_score: hs,
      away_score: as,
      home_won: hs > as ? 1 : 0,
      league: ev.league?.name || comp.league?.name || 'nba',
    };
  } catch (_) { return null; }
}

async function main() {
  const daysBack = parseInt(process.argv[2] || '730', 10);
  const dbPath = path.resolve(process.env.DB_PATH || 'sportsedge.db');
  console.log(`[BASKET-SEED] DB: ${dbPath} | daysBack: ${daysBack}`);

  const db = new Database(dbPath);
  applyMigrations(db);

  const ups = db.prepare(`
    INSERT INTO basket_match_history
    (espn_id, season, season_type, game_date, home_team, away_team,
     home_team_norm, away_team_norm, home_score, away_score, home_won, league)
    VALUES (@espn_id, @season, @season_type, @game_date, @home_team, @away_team,
            @home_team_norm, @away_team_norm, @home_score, @away_score, @home_won, @league)
    ON CONFLICT(espn_id) DO UPDATE SET
      home_score=excluded.home_score, away_score=excluded.away_score,
      home_won=excluded.home_won, season_type=excluded.season_type
  `);

  const today = new Date();
  let inserted = 0, queried = 0, errors = 0;
  // ESPN tem rate limit suave (~10/s). Sleep 100ms entre queries pra evitar 429.
  for (let i = 0; i <= daysBack; i++) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const ymd = fmtYmd(d);
    queried++;
    const r = await espnGet(`/apis/site/v2/sports/basketball/nba/scoreboard?dates=${ymd}&limit=200`);
    if (r.status !== 200 || !r.body) { errors++; await sleep(100); continue; }
    const events = Array.isArray(r.body?.events) ? r.body.events : [];
    const tx = db.transaction((rows) => {
      for (const row of rows) {
        try { ups.run(row); inserted++; } catch (_) { errors++; }
      }
    });
    const parsed = events.map(parseEvent).filter(Boolean);
    tx(parsed);
    if (i % 30 === 0) console.log(`[BASKET-SEED] ${i}d ago (${ymd}): ${parsed.length} games | total inserted ${inserted}`);
    await sleep(80);
  }

  const total = db.prepare(`SELECT COUNT(*) AS n FROM basket_match_history`).get().n;
  const seasons = db.prepare(`SELECT season, COUNT(*) AS n FROM basket_match_history GROUP BY season ORDER BY season DESC`).all();
  console.log(`[BASKET-SEED] complete: queried=${queried} inserted=${inserted} errors=${errors}`);
  console.log(`[BASKET-SEED] total in DB: ${total} games`);
  console.log(`[BASKET-SEED] by season:`, seasons);
  db.close();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

main().catch(e => { console.error('[BASKET-SEED] fatal:', e); process.exit(1); });
