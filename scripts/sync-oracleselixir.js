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

const PLAYER_COLS = [
  'gameid', 'participantid', 'side', 'position', 'playerid', 'playername',
  'teamname', 'champion', 'date', 'league', 'year', 'split', 'playoffs', 'patch',
  'gamelength', 'result', 'kills', 'deaths', 'assists',
  'doublekills', 'triplekills', 'quadrakills', 'pentakills',
  'damagetochampions', 'dpm', 'damageshare',
  'wardsplaced', 'wardskilled', 'visionscore', 'vspm',
  'totalgold', 'earnedgoldshare', 'totalcs', 'cspm',
  'goldat10', 'xpat10', 'csat10', 'golddiffat10', 'xpdiffat10', 'csdiffat10',
  'goldat15', 'xpat15', 'csat15', 'golddiffat15', 'xpdiffat15', 'csdiffat15',
];

// Nome no CSV → nome da coluna no DB (quando diferentes)
const CSV_TO_DB = {
  'team kpm': 'team_kpm',
  'void_grubs': 'void_grubs',
  'total cs': 'totalcs',
  'damagetochampions': 'damagetochampions',
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
  'year', 'playoffs', 'gamelength', 'result', 'kills', 'deaths', 'assists', 'firstblood',
  'firstdragon', 'dragons', 'firstherald', 'heralds', 'void_grubs',
  'firstbaron', 'barons', 'firsttower', 'towers', 'inhibitors',
  'doublekills', 'triplekills', 'quadrakills', 'pentakills',
  'damagetochampions', 'wardsplaced', 'wardskilled',
  'totalgold', 'totalcs',
  'goldat10', 'xpat10', 'csat10', 'golddiffat10', 'xpdiffat10', 'csdiffat10',
  'goldat15', 'xpat15', 'csat15', 'golddiffat15', 'xpdiffat15', 'csdiffat15',
  'killsat15', 'deathsat15', 'participantid',
]);
const REAL_COLS = new Set([
  'team_kpm', 'ckpm', 'dpm', 'wpm', 'vspm', 'gspd', 'gpr',
  'damageshare', 'earnedgoldshare', 'visionscore', 'cspm',
]);

function rowToRecord(cells, header, colIdx, cols) {
  const targetCols = cols || PERSIST_COLS;
  const rec = {};
  for (const dbCol of targetCols) {
    let csvIdx = colIdx.get(dbCol);
    if (csvIdx === undefined) {
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

// ── Sync (callable) ───────────────────────────────────────────────────────

/**
 * Sync Oracle's Elixir CSV(s) into provided DB. Idempotent (UPSERT por gameid+side
 * pra games, gameid+participantid pra players).
 *
 * @param {object} args
 * @param {Database} args.db — instância better-sqlite3 (caller owns lifecycle)
 * @param {Array<number>} args.years — anos a sincronizar (ex: [2025, 2026])
 * @param {function} [args.logger] — fn(level, msg) p/ output (default console.log)
 * @returns {Promise<{ years: object[], totalGames, totalPlayers, ms }>}
 */
async function syncOracleselixirYears({ db, years, logger = null }) {
  const log = logger || ((lvl, msg) => console.log(`[${lvl}]`, msg));
  const t0 = Date.now();

  const insert = db.prepare(`
    INSERT INTO oracleselixir_games (${PERSIST_COLS.join(', ')}, ingested_at)
    VALUES (${PERSIST_COLS.map(c => '@' + c).join(', ')}, datetime('now'))
    ON CONFLICT(gameid, side) DO UPDATE SET
      ${PERSIST_COLS.filter(c => c !== 'gameid' && c !== 'side').map(c => `${c}=excluded.${c}`).join(', ')},
      ingested_at = datetime('now')
  `);

  const insertPlayer = db.prepare(`
    INSERT INTO oracleselixir_players (${PLAYER_COLS.join(', ')}, ingested_at)
    VALUES (${PLAYER_COLS.map(c => '@' + c).join(', ')}, datetime('now'))
    ON CONFLICT(gameid, participantid) DO UPDATE SET
      ${PLAYER_COLS.filter(c => c !== 'gameid' && c !== 'participantid').map(c => `${c}=excluded.${c}`).join(', ')},
      ingested_at = datetime('now')
  `);

  const PLAYER_POSITIONS = new Set(['top', 'jng', 'mid', 'bot', 'sup']);
  const yearsResults = [];

  for (const year of years) {
    log('INFO', `── ${year} ──`);
    const url = URL_TEMPLATE(year);
    let header = null, colIdx = new Map();
    let seen = 0, skipped = 0, teamRows = 0, playerRows = 0;
    let insertedTeam = 0, insertedPlayer = 0;
    const BATCH = 500;
    let batchTeam = [], batchPlayer = [];

    function flushTeam() {
      if (!batchTeam.length) return;
      const n = batchTeam.length;
      const tx = db.transaction((rows) => { for (const r of rows) insert.run(r); });
      tx(batchTeam);
      insertedTeam += n;
      batchTeam = [];
    }
    function flushPlayer() {
      if (!batchPlayer.length) return;
      const n = batchPlayer.length;
      const tx = db.transaction((rows) => { for (const r of rows) insertPlayer.run(r); });
      tx(batchPlayer);
      insertedPlayer += n;
      batchPlayer = [];
    }

    await streamCsv(url,
      (h) => {
        header = h;
        colIdx = new Map(h.map((name, i) => [name, i]));
        const missing = ['gameid', 'side', 'position', 'teamname'].filter(c => !colIdx.has(c));
        if (missing.length) throw new Error(`CSV missing columns: ${missing.join(', ')}`);
      },
      (cells, h) => {
        seen++;
        const posIdx = colIdx.get('position');
        const pos = cells[posIdx];
        if (pos === 'team') {
          teamRows++;
          const rec = rowToRecord(cells, h, colIdx, PERSIST_COLS);
          if (!rec.gameid || !rec.side) return;
          batchTeam.push(rec);
          if (batchTeam.length >= BATCH) flushTeam();
        } else if (PLAYER_POSITIONS.has(pos)) {
          playerRows++;
          const rec = rowToRecord(cells, h, colIdx, PLAYER_COLS);
          if (!rec.gameid || rec.participantid == null) return;
          batchPlayer.push(rec);
          if (batchPlayer.length >= BATCH) flushPlayer();
        } else {
          skipped++;
        }
      }
    );
    flushTeam();
    flushPlayer();

    log('INFO', `  rows seen: ${seen} | team: ${teamRows}→${insertedTeam} upserted | player: ${playerRows}→${insertedPlayer} upserted`);

    const gc = db.prepare('SELECT COUNT(*) AS n FROM oracleselixir_games WHERE year = ?').get(year);
    const pc = db.prepare('SELECT COUNT(*) AS n FROM oracleselixir_players WHERE year = ?').get(year);
    log('INFO', `  DB count year ${year}: games=${gc.n} players=${pc.n}`);
    yearsResults.push({ year, gamesRows: gc.n, playerRows: pc.n, insertedTeam, insertedPlayer });
  }

  return {
    years: yearsResults,
    totalGames: yearsResults.reduce((s, r) => s + (r.insertedTeam || 0), 0),
    totalPlayers: yearsResults.reduce((s, r) => s + (r.insertedPlayer || 0), 0),
    ms: Date.now() - t0,
  };
}

// ── CLI wrapper ───────────────────────────────────────────────────────────
async function main() {
  const years = parseYears(process.argv.slice(2));
  console.log(`Sync Oracle's Elixir — years: ${years.join(', ')}`);
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  applyMigrations(db);
  const r = await syncOracleselixirYears({ db, years });
  db.close();
  console.log(`\nDone. ${r.totalGames} games + ${r.totalPlayers} players upserted em ${r.ms}ms.`);
}

module.exports = { syncOracleselixirYears };

if (require.main === module) {
  main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
}
