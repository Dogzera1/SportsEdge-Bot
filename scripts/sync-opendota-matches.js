#!/usr/bin/env node
'use strict';

// scripts/sync-opendota-matches.js
//
// Sincroniza histórico de matches Dota2 do OpenDota API para match_results.
// Endpoint público: /api/proMatches. Paginação via ?less_than_match_id.
// Free tier: 60 req/min, cada req retorna até 100 matches.
//
// Uso:
//   node scripts/sync-opendota-matches.js                      # default: 50k matches
//   node scripts/sync-opendota-matches.js --max 100000
//   node scripts/sync-opendota-matches.js --delay 1200

require('dotenv').config({ override: true });
const path = require('path');
const https = require('https');
const initDatabase = require('../lib/database');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');

const argv = process.argv.slice(2);
function argVal(n, d) {
  const i = argv.findIndex(a => a === `--${n}` || a.startsWith(`--${n}=`));
  if (i < 0) return d;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
}

const MAX = parseInt(argVal('max', '50000'), 10);
const DELAY_MS = parseInt(argVal('delay', '1100'), 10); // 60/min → ~1s
const API_KEY = process.env.OPENDOTA_API_KEY || '';

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'SportsEdge/1.0' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const { db } = initDatabase(DB_PATH);
  const before = db.prepare(`SELECT COUNT(*) as n FROM match_results WHERE game='dota2'`).get().n;
  console.log(`[opendota] match_results.dota2 ANTES: ${before}`);

  // ON CONFLICT preserva final_score válido se excluded for vazio. Permite
  // re-sync atualizar rows que o bot scanner inseriu com '' vazio.
  const insertStmt = db.prepare(`
    INSERT INTO match_results (match_id, game, team1, team2, winner, final_score, league, resolved_at)
    VALUES (?, 'dota2', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(match_id, game) DO UPDATE SET
      team1 = excluded.team1,
      team2 = excluded.team2,
      winner = excluded.winner,
      final_score = COALESCE(NULLIF(excluded.final_score, ''), final_score),
      league = excluded.league,
      resolved_at = excluded.resolved_at
  `);

  let lastId = null, totalFetched = 0, totalInserted = 0, totalSkipped = 0;
  let consecutiveEmpty = 0, rateLimit429Count = 0;

  while (totalFetched < MAX && consecutiveEmpty < 3) {
    let url = `https://api.opendota.com/api/proMatches`;
    if (lastId) url += `?less_than_match_id=${lastId}`;
    if (API_KEY) url += `${url.includes('?') ? '&' : '?'}api_key=${API_KEY}`;

    let rows;
    try {
      const r = await get(url);
      if (r.status === 429) {
        rateLimit429Count++;
        console.log(`  rate limited (429), backoff 30s...`);
        await sleep(30000);
        continue;
      }
      if (r.status !== 200) { console.log(`  HTTP ${r.status}, aborting`); break; }
      rows = JSON.parse(r.body);
    } catch (e) { console.log(`  err: ${e.message}, retry em 10s`); await sleep(10000); continue; }

    if (!Array.isArray(rows) || !rows.length) { consecutiveEmpty++; await sleep(DELAY_MS); continue; }
    consecutiveEmpty = 0;
    totalFetched += rows.length;

    let pageInserted = 0;
    const tx = db.transaction((batch) => {
      for (const m of batch) {
        const t1 = m.radiant_name, t2 = m.dire_name;
        if (!t1 || !t2 || t1.trim() === '' || t2.trim() === '') { totalSkipped++; continue; }
        if (typeof m.radiant_win !== 'boolean') { totalSkipped++; continue; }
        const winner = m.radiant_win ? t1 : t2;
        const startMs = (m.start_time || 0) * 1000;
        if (!startMs) { totalSkipped++; continue; }
        const resolvedAt = new Date(startMs + (m.duration || 0) * 1000)
          .toISOString().replace('T', ' ').replace('Z', '').slice(0, 19);
        const league = m.league_name || `League_${m.leagueid || 0}`;
        // OpenDota API `radiant_score`/`dire_score` = kills (não map wins). Series info
        // vem em m.series_type mas map-wins reais requerem outro endpoint. Armazena só Bo-format
        // sem score pra evitar settlement parsing erroneamente kills como mapas (ex: "Bo3 40-27"
        // → _parseEsportsMapScore lia como 40-27 maps). Winner já é correto (radiant_win bool).
        const boFormat = m.series_type === 1 ? 'Bo3' : m.series_type === 2 ? 'Bo5' : 'Bo1';
        const finalScore = boFormat; // sem kills — evita mislabel em settlement
        const res = insertStmt.run(`od_${m.match_id}`, t1, t2, winner, finalScore, league, resolvedAt);
        if (res.changes > 0) pageInserted++;
      }
    });
    tx(rows);

    totalInserted += pageInserted;
    lastId = rows[rows.length - 1].match_id;
    console.log(`  page: ${rows.length} fetched, +${pageInserted} inserted | total=${totalInserted}/${totalFetched} | lastId=${lastId}`);
    await sleep(DELAY_MS);
  }

  const after = db.prepare(`SELECT COUNT(*) as n FROM match_results WHERE game='dota2'`).get().n;
  console.log(`\n[opendota] DEPOIS: ${after} (delta +${after - before})`);
  console.log(`[opendota] fetched=${totalFetched} inserted=${totalInserted} skipped=${totalSkipped} (429 hits=${rateLimit429Count})`);
}

main().catch(e => { console.error('fatal:', e.message); process.exit(1); });
