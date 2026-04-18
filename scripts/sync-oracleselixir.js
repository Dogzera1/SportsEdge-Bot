#!/usr/bin/env node
'use strict';

/**
 * sync-oracleselixir.js
 *
 * Baixa o CSV anual do Oracle's Elixir e popula a tabela `oracleselixir_games`
 * (linhas com position='team' apenas — 2 linhas por gameid, uma blue uma red).
 *
 * Uso:
 *   node scripts/sync-oracleselixir.js              # ano corrente
 *   node scripts/sync-oracleselixir.js --year=2025
 *   node scripts/sync-oracleselixir.js --year=2025 --year=2026   (múltiplos)
 *
 * Arquivo é re-downloadado toda execução (OE sobrescreve o mesmo path).
 * UPSERT por (gameid, side) — idempotente.
 *
 * Fonte: https://oracles-elixir.s3.amazonaws.com/{YEAR}_LoL_esports_match_data_from_OraclesElixir.csv
 */

const https = require('https');
const path = require('path');
const Database = require('better-sqlite3');
const { applyMigrations } = require('../migrations');

const DB_PATH = path.resolve(__dirname, '..', 'sportsedge.db');
const URL_TEMPLATE = (year) =>
  `https://oracles-elixir.s3.amazonaws.com/${year}_LoL_esports_match_data_from_OraclesElixir.csv`;

// Colunas que persistimos (subset do CSV). Ordem do INSERT abaixo.
const PERSIST_COLS = [
  'gameid', 'side', 'date', 'league', 'year', 'split', 'playoffs', 'patch',
  'teamid', 'teamname', 'gamelength', 'result', 'kills', 'deaths', 'firstblood',
  'team_kpm', 'ckpm', 'firstdragon', 'dragons', 'firstherald', 'heralds', 'void_grubs',
  'firstbaron', 'barons', 'firsttower', 'towers', 'inhibitors',
  'dpm', 'wpm', 'vspm', 'gspd', 'gpr',
  'goldat10', 'xpat10', 'csat10', 'golddiffat10', 'xpdiffat10', 'csdiffat10',
  'goldat15', 'xpat15', 'csat15', 'golddiffat15', 'xpdiffat15', 'csdiffat15',
  'killsat15', 'deathsat15',
  'ban1', 'ban2', 'ban3', 'ban4', 'ban5',
  'pick1', 'pick2', 'pick3', 'pick4', 'pick5',
];

// Nome no CSV → nome da coluna no DB (quando diferentes)
const CSV_TO_DB = {
  'team kpm': 'team_kpm',
  'void_grubs': 'void_grubs',
};

function parseYears(argv) {
  const years = [];
  for (const a of argv) {
    const m = a.match(/^--year=(\d{4})$/);
    if (m) years.push(parseInt(m[1], 10));
  }
  if (!years.length) years.push(new Date().getFullYear());
  return years;
}

// ── CSV streaming parser ──────────────────────────────────────────────────
// State-machine simples: lida com aspas e aspas duplas escapadas.
// Retorna cada linha como array de strings.

async function streamCsv(url, onHeader, onRow) {
  return new Promise((resolve, reject) => {
    console.log('  GET', url);
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage}`));
        res.resume();
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0, lastPct = -1;
      let buf = '';
      let header = null;

      // State-machine per-line
      function flushLines() {
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          let line = buf.slice(0, nl);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const cells = parseCsvLine(line);
          if (!header) {
            header = cells;
            onHeader(header);
          } else {
            onRow(cells, header);
          }
        }
      }

      res.on('data', (chunk) => {
        received += chunk.length;
        if (total) {
          const pct = Math.floor(received / total * 100);
          if (pct !== lastPct && pct % 10 === 0) {
            process.stdout.write(`    ${pct}% (${(received / 1024 / 1024).toFixed(1)}MB)\r`);
            lastPct = pct;
          }
        }
        buf += chunk.toString('utf8');
        flushLines();
      });
      res.on('end', () => {
        if (buf) {
          const line = buf.endsWith('\r') ? buf.slice(0, -1) : buf;
          if (line) onRow(parseCsvLine(line), header);
        }
        console.log();
        resolve();
      });
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// ── Row → DB mapping ──────────────────────────────────────────────────────

function toInt(s) {
  if (s === '' || s === null || s === undefined) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}
function toReal(s) {
  if (s === '' || s === null || s === undefined) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function toText(s) { return (s === '' || s === null || s === undefined) ? null : s; }

// Tipagem por coluna (int / real / text)
const INT_COLS = new Set([
  'year', 'playoffs', 'gamelength', 'result', 'kills', 'deaths', 'firstblood',
  'firstdragon', 'dragons', 'firstherald', 'heralds', 'void_grubs',
  'firstbaron', 'barons', 'firsttower', 'towers', 'inhibitors',
  'goldat10', 'xpat10', 'csat10', 'golddiffat10', 'xpdiffat10', 'csdiffat10',
  'goldat15', 'xpat15', 'csat15', 'golddiffat15', 'xpdiffat15', 'csdiffat15',
  'killsat15', 'deathsat15',
]);
const REAL_COLS = new Set(['team_kpm', 'ckpm', 'dpm', 'wpm', 'vspm', 'gspd', 'gpr']);

function rowToRecord(cells, header, colIdx) {
  const rec = {};
  for (const dbCol of PERSIST_COLS) {
    // Procura o nome no CSV: check CSV_TO_DB reverso + dbCol literal
    let csvIdx = colIdx.get(dbCol);
    if (csvIdx === undefined) {
      // procura equivalente com espaço
      for (const [csvName, dbName] of Object.entries(CSV_TO_DB)) {
        if (dbName === dbCol) { csvIdx = colIdx.get(csvName); break; }
      }
    }
    const raw = csvIdx !== undefined ? cells[csvIdx] : '';
    if (INT_COLS.has(dbCol)) rec[dbCol] = toInt(raw);
    else if (REAL_COLS.has(dbCol)) rec[dbCol] = toReal(raw);
    else rec[dbCol] = toText(raw);
  }
  return rec;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const years = parseYears(process.argv.slice(2));
  console.log(`Sync Oracle's Elixir — years: ${years.join(', ')}`);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  applyMigrations(db);

  const insert = db.prepare(`
    INSERT INTO oracleselixir_games (${PERSIST_COLS.join(', ')}, ingested_at)
    VALUES (${PERSIST_COLS.map(c => '@' + c).join(', ')}, datetime('now'))
    ON CONFLICT(gameid, side) DO UPDATE SET
      ${PERSIST_COLS.filter(c => c !== 'gameid' && c !== 'side').map(c => `${c}=excluded.${c}`).join(', ')},
      ingested_at = datetime('now')
  `);

  for (const year of years) {
    console.log(`\n── ${year} ──`);
    const url = URL_TEMPLATE(year);
    let header = null, colIdx = new Map();
    let seen = 0, inserted = 0, skipped = 0, teamRows = 0;
    const BATCH = 500;
    let batch = [];

    function flush() {
      if (!batch.length) return;
      const tx = db.transaction((rows) => {
        for (const r of rows) insert.run(r);
      });
      tx(batch);
      batch = [];
    }

    await streamCsv(url,
      (h) => {
        header = h;
        colIdx = new Map(h.map((name, i) => [name, i]));
        // Sanity: confirm expected columns
        const missing = ['gameid', 'side', 'position', 'teamname'].filter(c => !colIdx.has(c));
        if (missing.length) {
          throw new Error(`CSV missing columns: ${missing.join(', ')}`);
        }
      },
      (cells, h) => {
        seen++;
        const posIdx = colIdx.get('position');
        if (cells[posIdx] !== 'team') { skipped++; return; }
        teamRows++;
        const rec = rowToRecord(cells, h, colIdx);
        if (!rec.gameid || !rec.side) return;
        batch.push(rec);
        if (batch.length >= BATCH) { flush(); inserted += BATCH; }
      }
    );
    if (batch.length) { const n = batch.length; flush(); inserted += n; }

    console.log(`  rows seen: ${seen} | team rows: ${teamRows} | upserted: ${inserted}`);

    const dbCount = db.prepare('SELECT COUNT(*) AS n FROM oracleselixir_games WHERE year = ?').get(year);
    console.log(`  DB count for year ${year}: ${dbCount.n}`);
  }

  db.close();
  console.log('\nDone.');
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
