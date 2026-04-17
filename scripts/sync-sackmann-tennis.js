#!/usr/bin/env node
'use strict';

// Sync Sackmann tennis data → match_results
// Fonte: github.com/JeffSackmann/tennis_atp + tennis_wta (CSVs open-source)
//
// Popula match_results com matches ATP/WTA 2024+2025 pra:
//   - Backtest histórico (Fase 1B)
//   - Smoke test ter sample real (não só nossas 52 tips)
//
// Uso:
//   node scripts/sync-sackmann-tennis.js [--years 2024,2025] [--tour atp,wta]

require('dotenv').config({ override: true });
const path = require('path');
const https = require('https');
const initDatabase = require('../lib/database');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');
const YEARS = (process.argv.find(a => a.startsWith('--years'))?.split('=')[1] || '2024,2025,2026').split(',');
const TOURS = (process.argv.find(a => a.startsWith('--tour'))?.split('=')[1] || 'atp,wta').split(',');

function httpGetText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'SportsEdge-SackmannSync/1.0' } }, (res) => {
      if (res.statusCode === 404) return resolve(null);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

// CSV simples (Sackmann files são bem-formatados, sem quotes complexos)
function parseCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < headers.length) continue;
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = (cols[j] || '').trim();
    rows.push(row);
  }
  return rows;
}

// Sackmann tourney_date é YYYYMMDD
function parseSackmannDate(s) {
  if (!s || s.length !== 8) return null;
  const y = s.slice(0, 4), m = s.slice(4, 6), d = s.slice(6, 8);
  return `${y}-${m}-${d} 00:00:00`;
}

async function main() {
  console.log(`\n=== Sackmann Tennis Sync ===`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`Years: ${YEARS.join(', ')} | Tours: ${TOURS.join(', ')}`);

  const { db } = initDatabase(DB_PATH);

  // Stats
  const beforeCount = db.prepare(`SELECT COUNT(*) as n FROM match_results WHERE game='tennis'`).get().n;
  console.log(`Match results tennis ANTES: ${beforeCount}`);

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO match_results (match_id, game, team1, team2, winner, final_score, league, resolved_at)
    VALUES (?, 'tennis', ?, ?, ?, ?, ?, ?)
  `);

  let totalInserted = 0;
  let totalSkipped = 0;
  let urls404 = [];

  for (const tour of TOURS) {
    for (const year of YEARS) {
      const repo = tour === 'wta' ? 'tennis_wta' : 'tennis_atp';
      const filePrefix = tour === 'wta' ? 'wta_matches' : 'atp_matches';
      const url = `https://raw.githubusercontent.com/JeffSackmann/${repo}/master/${filePrefix}_${year}.csv`;
      console.log(`\n→ ${tour.toUpperCase()} ${year}: ${url}`);

      let text = null;
      try { text = await httpGetText(url); }
      catch (e) { console.log(`  ❌ erro: ${e.message}`); continue; }
      if (!text) { console.log(`  ⚠️ 404 — arquivo não disponível ainda`); urls404.push(url); continue; }

      const rows = parseCsv(text);
      console.log(`  CSV parsed: ${rows.length} matches`);

      const trx = db.transaction((rs) => {
        let inserted = 0, skipped = 0;
        for (const r of rs) {
          const matchId = `sackmann_${tour}_${r.tourney_id}_${r.match_num}`;
          const winner = r.winner_name;
          const loser = r.loser_name;
          const tourneyName = r.tourney_name;
          const surface = r.surface;
          const score = r.score;
          const date = parseSackmannDate(r.tourney_date);

          if (!winner || !loser || !tourneyName || !date) { skipped++; continue; }

          // League: prefixar surface pra detection automática (ex: "Roland Garros [clay]")
          const leagueWithSurface = surface ? `${tourneyName} [${surface.toLowerCase()}]` : tourneyName;

          insertStmt.run(
            matchId,
            winner,             // team1 = winner (convenção Sackmann)
            loser,              // team2 = loser
            winner,             // winner field
            score || '',
            leagueWithSurface,
            date
          );
          inserted++;
        }
        return { inserted, skipped };
      });
      const result = trx(rows);
      console.log(`  ✅ inserido: ${result.inserted} | pulado: ${result.skipped}`);
      totalInserted += result.inserted;
      totalSkipped += result.skipped;
    }
  }

  const afterCount = db.prepare(`SELECT COUNT(*) as n FROM match_results WHERE game='tennis'`).get().n;
  console.log(`\n=== RESUMO ===`);
  console.log(`Match results tennis DEPOIS: ${afterCount} (delta +${afterCount - beforeCount})`);
  console.log(`Inseridos: ${totalInserted} | Pulados (sem dados): ${totalSkipped}`);
  if (urls404.length) console.log(`URLs 404 (arquivos ainda não disponíveis): ${urls404.length}`);
  console.log('');
  console.log('Próximo: rodar `node scripts/tennis-v2-smoke.js --limit 500` pra re-validar features.');
  process.exit(0);
}

main().catch(e => { console.error('ERRO:', e); process.exit(1); });
