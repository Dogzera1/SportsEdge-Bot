#!/usr/bin/env node
'use strict';

// scripts/sync-pandascore-history.js
//
// Baixa matches passados do PandaScore e grava em match_results.
// Usado para formar dataset de treino de modelos por esporte.
//
// Uso:
//   node scripts/sync-pandascore-history.js --game lol --from 2023-01-01 --to 2024-12-31 [--max 20000]
//   node scripts/sync-pandascore-history.js --game dota2 --from 2023-01-01 --max 10000
//   node scripts/sync-pandascore-history.js --game valorant --from 2023-06-01 --max 8000
//   node scripts/sync-pandascore-history.js --game cs-go --from 2023-01-01 --max 10000
//
// PandaScore endpoints:
//   /lol/matches/past, /dota2/matches/past, /valorant/matches/past, /cs-go/matches/past
// Rate limit free tier: ~1000/hora. Script respeita com delay configurável.

require('dotenv').config({ override: true });
const path = require('path');
const https = require('https');
const initDatabase = require('../lib/database');

const TOKEN = process.env.PANDASCORE_TOKEN;
if (!TOKEN) { console.error('[sync-ps] PANDASCORE_TOKEN não configurado'); process.exit(1); }

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');

const argv = process.argv.slice(2);
function argVal(name, def) {
  const i = argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return def;
  const a = argv[i];
  if (a.includes('=')) return a.split('=').slice(1).join('=');
  return argv[i + 1];
}

const GAME = argVal('game', 'lol');
const FROM = argVal('from', '2023-01-01');
const TO = argVal('to', new Date().toISOString().slice(0, 10));
const MAX = parseInt(argVal('max', '15000'), 10);
const PER_PAGE = 50;
const DELAY_MS = parseInt(argVal('delay', '500'), 10);

// Map game → PandaScore path. 'game' field salvo em match_results.
const GAME_CFG = {
  lol:        { path: 'lol',      dbGame: 'lol' },
  dota2:      { path: 'dota2',    dbGame: 'dota2' },
  valorant:   { path: 'valorant', dbGame: 'valorant' },
  'cs-go':    { path: 'csgo',     dbGame: 'cs2' },
  cs2:        { path: 'csgo',     dbGame: 'cs2' },
};
const cfg = GAME_CFG[GAME];
if (!cfg) { console.error(`[sync-ps] game inválido: ${GAME}`); process.exit(1); }

console.log(`[sync-ps] game=${GAME} path=${cfg.path} db=${cfg.dbGame}`);
console.log(`[sync-ps] range=${FROM}..${TO} max=${MAX} per_page=${PER_PAGE} delay=${DELAY_MS}ms`);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: `Bearer ${TOKEN}` } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          // 2026-05-06: expor Retry-After header em 429 — caller usa pra sleep
          // dinâmico em vez de fixed 30s. Free tier PS = ~1000 req/h.
          const err = new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
          err.statusCode = res.statusCode;
          const ra = res.headers?.['retry-after'];
          if (ra) {
            const raSec = parseInt(ra, 10);
            err.retryAfterMs = Number.isFinite(raSec) ? raSec * 1000 : 60000;
          }
          return reject(err);
        }
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const { db } = initDatabase(DB_PATH);

  const before = db.prepare(`SELECT COUNT(*) as n FROM match_results WHERE game=?`).get(cfg.dbGame).n;
  console.log(`[sync-ps] match_results ${cfg.dbGame} ANTES: ${before}`);

  // ON CONFLICT preserva final_score válido se excluded for vazio. Permite
  // re-sync sobrescrever rows que o bot scanner inseriu com '' vazio sem
  // destruir scores válidos vindos de outro sync.
  const insertStmt = db.prepare(`
    INSERT INTO match_results (match_id, game, team1, team2, winner, final_score, league, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(match_id, game) DO UPDATE SET
      team1 = excluded.team1,
      team2 = excluded.team2,
      winner = excluded.winner,
      final_score = COALESCE(NULLIF(excluded.final_score, ''), final_score),
      league = excluded.league,
      resolved_at = excluded.resolved_at
  `);

  let inserted = 0, skipped = 0, page = 1;
  const rangeFilter = `&range[end_at]=${FROM}T00:00:00Z,${TO}T23:59:59Z`;

  while (inserted + skipped < MAX) {
    const url = `https://api.pandascore.co/${cfg.path}/matches/past?per_page=${PER_PAGE}&page=${page}&sort=-end_at${rangeFilter}`;
    let rows = [];
    try {
      rows = await httpGetJson(url);
    } catch (e) {
      // 2026-05-06: usa Retry-After do servidor em 429 — antes fixed 30s
      // perdia janela quando rate-limit pedia 60s+.
      const sleepMs = e.retryAfterMs || (e.statusCode === 429 ? 60000 : 30000);
      console.warn(`[sync-ps] page ${page} status=${e.statusCode || '?'} error: ${e.message}. Retry em ${Math.round(sleepMs/1000)}s...`);
      await sleep(sleepMs);
      continue;
    }
    if (!Array.isArray(rows) || !rows.length) break;

    for (const m of rows) {
      const opps = m.opponents || [];
      if (opps.length < 2) { skipped++; continue; }
      const t1 = opps[0]?.opponent?.name;
      const t2 = opps[1]?.opponent?.name;
      const winner = m.winner?.name || null;
      const endAt = m.end_at || m.scheduled_at || m.begin_at;
      if (!t1 || !t2 || !winner || !endAt) { skipped++; continue; }

      const matchId = `ps_${m.id}`;
      const league = m.league?.name || m.tournament?.name || '';
      const nGames = m.number_of_games || 1;
      const results = m.results || [];
      let score = '';
      if (results.length === 2) score = `${results[0]?.score || 0}-${results[1]?.score || 0}`;
      const finalScore = `${nGames === 1 ? 'Bo1' : `Bo${nGames}`} ${score}`.trim();
      const resolvedAt = String(endAt).replace('T', ' ').replace('Z', '').slice(0, 19);

      try {
        insertStmt.run(matchId, cfg.dbGame, t1, t2, winner, finalScore, league, resolvedAt);
        inserted++;
      } catch (e) {
        skipped++;
      }
    }

    console.log(`[sync-ps] page ${page}: +${rows.length} raw → ${inserted} inseridos (${skipped} skipped)`);
    page++;
    if (rows.length < PER_PAGE) break;
    await sleep(DELAY_MS);
  }

  const after = db.prepare(`SELECT COUNT(*) as n FROM match_results WHERE game=?`).get(cfg.dbGame).n;
  console.log(`\n[sync-ps] ${cfg.dbGame} DEPOIS: ${after} (delta +${after - before})`);
  console.log(`[sync-ps] rodada: inserted=${inserted} skipped=${skipped}`);
}

main().catch(e => { console.error('[sync-ps] fatal:', e.message); process.exit(1); });
