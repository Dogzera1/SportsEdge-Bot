#!/usr/bin/env node
'use strict';

/**
 * scripts/sync-tennis-stats.js
 *
 * Ingesta stats detalhadas de tenis (ace, df, svpt, etc) do Sackmann CSV em
 * tennis_match_stats. Complementa match_results (que tem só winner + final_score).
 *
 * Uso:
 *   node scripts/sync-tennis-stats.js                      # default 2024+2025+2026, atp+wta, main+chall
 *   node scripts/sync-tennis-stats.js --years=2023,2024,2025
 *   node scripts/sync-tennis-stats.js --tours=atp
 *   node scripts/sync-tennis-stats.js --tiers=main          # só ATP/WTA main tour
 *   node scripts/sync-tennis-stats.js --tiers=main,chall    # +ATP Challenger / WTA 125
 *   node scripts/sync-tennis-stats.js --tiers=main,chall,futures  # +ITF
 *   node scripts/sync-tennis-stats.js --delay=500
 */

require('dotenv').config({ override: true });
const path = require('path');
const https = require('https');
const initDatabase = require('../lib/database');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');
const argv = process.argv.slice(2);
const argVal = (n, d) => {
  const i = argv.findIndex(a => a === `--${n}` || a.startsWith(`--${n}=`));
  if (i < 0) return d;
  const a = argv[i];
  return a.includes('=') ? a.split('=').slice(1).join('=') : argv[i + 1];
};

const YEARS = (argVal('years', '2024,2025,2026')).split(',').map(s => s.trim()).filter(Boolean);
const TOURS = (argVal('tours', 'atp,wta')).split(',').map(s => s.trim()).filter(Boolean);
// 2026-04-28: tiers configurável — main tour only deixa 80% das tips lower-tier
// sem serve stats (Markov falha "no serve stats available"). Chall+futures cobre
// ATP Challenger + ITF Men + WTA 125 + ITF Women.
const TIERS = (argVal('tiers', 'main,chall')).split(',').map(s => s.trim()).filter(Boolean);
const DELAY = parseInt(argVal('delay', '400'), 10);

// Sackmann CSV path por (tour, tier, year)
function buildUrl(tour, tier, year) {
  const repo = tour === 'wta' ? 'tennis_wta' : 'tennis_atp';
  let prefix;
  if (tour === 'atp') {
    prefix = tier === 'chall' ? 'atp_matches_qual_chall'
      : tier === 'futures' ? 'atp_matches_futures'
      : 'atp_matches';
  } else {
    prefix = tier === 'chall' ? 'wta_matches_qual_itf'
      : tier === 'futures' ? 'wta_matches_qual_itf'  // WTA não separa futures
      : 'wta_matches';
  }
  return `https://raw.githubusercontent.com/JeffSackmann/${repo}/master/${prefix}_${year}.csv`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGetText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'SportsEdge/1.0' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        resolve(d);
      });
    }).on('error', reject);
  });
}

// 2026-05-06 FIX: parser CSV state-machine respeitando quoted fields ("...,...").
// Sackmann CSVs trazem `tourney_name="Bordeaux, France"` e `score="6-4 6-7(5) 6-3"`
// — split(',') ingênuo descartava ~10-15% das rows ("cols.length < headers"), causando
// gap em tennis_match_stats e Markov falhando "no serve stats available" em torneios
// com vírgula no nome (Bordeaux Challenger, Roland Garros, etc).
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map(h => h.trim());
  const out = [];
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < headers.length) { skipped++; continue; }
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = (cols[j] || '').trim();
    out.push(row);
  }
  if (skipped > 0) console.log(`[parseCsv] skipped=${skipped} lines (col count mismatch)`);
  return out;
}

const parseIntOrNull = (s) => {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
};

const parseDate = (s) => {
  if (!s || s.length !== 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} 00:00:00`;
};

async function main() {
  const { db } = initDatabase(DB_PATH);
  const before = db.prepare(`SELECT COUNT(*) AS n FROM tennis_match_stats`).get().n;
  console.log(`[sync-tennis-stats] ANTES: ${before} rows`);

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO tennis_match_stats (
      match_id, tour, player1, player2, winner, date, surface, tourney_name, best_of, round, minutes,
      p1_ace, p1_df, p1_svpt, p1_1st_in, p1_1st_won, p1_2nd_won, p1_sv_gms, p1_bp_saved, p1_bp_faced,
      p2_ace, p2_df, p2_svpt, p2_1st_in, p2_1st_won, p2_2nd_won, p2_sv_gms, p2_bp_saved, p2_bp_faced,
      p1_rank, p2_rank, score
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let total = 0, inserted = 0, skipped = 0;
  // Dedup chall+futures pra WTA (mesmo arquivo)
  const seenUrls = new Set();
  for (const tour of TOURS) {
    for (const tier of TIERS) {
      for (const year of YEARS) {
        const url = buildUrl(tour, tier, year);
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
        console.log(`  ${tour}/${tier}/${year}: fetching...`);
        let csv;
        try { csv = await httpGetText(url); }
        catch (e) { console.log(`    err: ${e.message}`); continue; }
        const rows = parseCsv(csv);
        total += rows.length;

      const tx = db.transaction((rs) => {
        for (const r of rs) {
          const matchId = `sackmann_${tour}_${tier}_${r.tourney_id}_${r.match_num}`;
          // Sackmann ordena (winner, loser). Convertemos pra (p1=winner, p2=loser).
          const p1 = r.winner_name, p2 = r.loser_name;
          if (!p1 || !p2) { skipped++; continue; }
          const date = parseDate(r.tourney_date);
          if (!date) { skipped++; continue; }
          stmt.run(
            matchId, tour, p1, p2, p1, date, (r.surface || '').toLowerCase(), r.tourney_name,
            parseIntOrNull(r.best_of), r.round || null, parseIntOrNull(r.minutes),
            parseIntOrNull(r.w_ace), parseIntOrNull(r.w_df), parseIntOrNull(r.w_svpt),
            parseIntOrNull(r.w_1stIn), parseIntOrNull(r.w_1stWon), parseIntOrNull(r.w_2ndWon),
            parseIntOrNull(r.w_SvGms), parseIntOrNull(r.w_bpSaved), parseIntOrNull(r.w_bpFaced),
            parseIntOrNull(r.l_ace), parseIntOrNull(r.l_df), parseIntOrNull(r.l_svpt),
            parseIntOrNull(r.l_1stIn), parseIntOrNull(r.l_1stWon), parseIntOrNull(r.l_2ndWon),
            parseIntOrNull(r.l_SvGms), parseIntOrNull(r.l_bpSaved), parseIntOrNull(r.l_bpFaced),
            parseIntOrNull(r.winner_rank), parseIntOrNull(r.loser_rank), r.score || null
          );
          inserted++;
        }
      });
        tx(rows);
        console.log(`    parsed=${rows.length}, skipped=${rows.length - (inserted)}`);
        await sleep(DELAY);
      }
    }
  }

  const after = db.prepare(`SELECT COUNT(*) AS n FROM tennis_match_stats`).get().n;
  console.log(`\n[sync-tennis-stats] DEPOIS: ${after} (delta +${after - before})`);
  console.log(`[sync-tennis-stats] fetched=${total}, inserted≈${inserted}, skipped=${skipped}`);
}

main().catch(e => { console.error('fatal:', e.message); process.exit(1); });
