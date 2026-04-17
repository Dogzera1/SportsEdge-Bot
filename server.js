require('dotenv').config({ override: true });
const http = require('http');
const https = require('https');
const path = require('path');
const url = require('url');
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const initDatabase = require('./lib/database');
const { SPORTS, getSportById } = require('./lib/sports');
const { log, sendJson, safeParse, norm, httpGet, cachedHttpGet, aiPost, oddsApiAllowed, oddsApiPeek, oddsApiQuotaStatus, getMetricsLite, calcKellyWithP, getLogBuffer, addLogClient, removeLogClient, ingestExternalLog } = require('./lib/utils');
const dashboard = require('./lib/dashboard');
const footballData  = require('./lib/football-data');
const apiFootball   = require('./lib/api-football');
const { tennisSinglePlayerNameMatch, tennisPairMatchesPlayers } = require('./lib/tennis-match');
const { nameMatches } = require('./lib/name-match');
const sofascoreDarts = require('./lib/sofascore-darts');
const pinnacleSnooker = require('./lib/pinnacle-snooker');
const pinnacle = require('./lib/pinnacle');
// lib/betfair.js mantido no repo mas não usado aqui (Betfair bloqueia IPs brasileiros).
const { esportsPreFilter } = require('./lib/ml');
const tennisML = require('./lib/tennis-ml');
const { fetchGridEnrichForMatch } = require('./lib/grid');
const { radarGetInfo, radarGetByPath } = require('./lib/radar-sport');

// Railway sets $PORT automatically; start.js bridges it to SERVER_PORT
const PORT = parseInt(process.env.PORT || process.env.SERVER_PORT) || 3000;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
// Aceita múltiplos nomes de variável para a chave OddsPapi
const ODDSPAPI_KEY = process.env.ODDS_API_KEY
  || process.env.ODDSPAPI_KEY
  || process.env.ODDS_PAPI_KEY
  || process.env.ESPORTS_ODDS_KEY;
// Chave pública do lolesports (mesma hardcoded por andy/aureom/maisesports).
// Vaza em qualquer inspect do frontend — Riot a trata como chave read-only pública.
const LOL_PUBLIC_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const LOL_KEY = process.env.LOL_API_KEY || process.env.NEXT_PUBLIC_LOL_API || LOL_PUBLIC_KEY;
const LOL_HEADERS = { 'x-api-key': LOL_KEY };
const PANDASCORE_TOKEN = process.env.PANDASCORE_TOKEN || '';
// The Odds API — usado para MMA (20k req/mês)
const THE_ODDS_API_KEY = process.env.THE_ODDS_API_KEY || '';
// Odds-API.io (odds-api.io) — alternativa (esports/tennis/etc)
const ODDS_API_IO_KEY = process.env.ODDS_API_IO_KEY || process.env.ODDSAPIIO_KEY || '';
const GRID_API_KEY = (process.env.GRID_API_KEY || '').trim();

// DB_PATH allows pointing to a Railway volume (e.g. /data/sportsedge.db)
const fs = require('fs');
let DB_PATH = (process.env.DB_PATH || 'sportsedge.db').trim().replace(/^=+/, '');
// Ensure the directory exists — fall back to local path if creation fails (no volume mounted)
try {
  const dbDir = path.dirname(path.resolve(DB_PATH));
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
} catch(e) {
  log('WARN', 'DB', `Não foi possível criar diretório para ${DB_PATH}: ${e.message}. Usando sportsedge.db local.`);
  DB_PATH = 'sportsedge.db';
}
const { db, stmts } = initDatabase(DB_PATH);

// Limpeza única de integridade: só executa se nunca rodou (evita deletar tips legítimas no futuro)
try {
  const alreadyCleaned = db.prepare("SELECT 1 FROM settings WHERE key='odds_cleanup_v1' LIMIT 1").get();
  if (!alreadyCleaned) {
    const cleaned = db.prepare("DELETE FROM tips WHERE CAST(odds AS REAL) > 4.0").run();
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('odds_cleanup_v1', datetime('now'))").run();
    if (cleaned.changes > 0) log('INFO', 'BOOT', `Limpeza única: ${cleaned.changes} tip(s) com odds > 4.0 removidas`);
  }
} catch(e) { log('WARN', 'BOOT', `Limpeza odds: ${e.message}`); }

// ── Football Elo helper (1X2) ──
function getElo(team) {
  const row = stmts.getFootballElo.get(team);
  return row?.rating ? parseFloat(row.rating) : 1500;
}
function getEloGames(team) {
  const row = stmts.getFootballElo.get(team);
  return row?.games ? parseInt(row.games, 10) : 0;
}
function expectedScore(rA, rB) {
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}
function updateEloMatch(homeTeam, awayTeam, winner) {
  const K = parseFloat(process.env.FOOTBALL_ELO_K || '20') || 20;
  const homeAdvElo = parseFloat(process.env.FOOTBALL_ELO_HOME_ADV || '50') || 50; // ~6–8pp
  const rH = getElo(homeTeam);
  const rA = getElo(awayTeam);
  const eH = expectedScore(rH + homeAdvElo, rA);
  const eA = 1 - eH;

  const sH = (winner === homeTeam) ? 1 : (winner === 'Draw' ? 0.5 : 0);
  const sA = 1 - sH;

  const newH = rH + K * (sH - eH);
  const newA = rA + K * (sA - eA);

  const gH = getEloGames(homeTeam) + 1;
  const gA = getEloGames(awayTeam) + 1;
  stmts.upsertFootballElo.run(homeTeam, newH, gH);
  stmts.upsertFootballElo.run(awayTeam, newA, gA);
  return { homeTeam, awayTeam, before: { rH, rA }, after: { newH, newA }, K, homeAdvElo };
}

/** Escopo SQL: uma linha por partida (MAX(id)); evita duplicatas de match_id no dashboard/ROI */
function sqlTipsDedupeIdIn(alias, sportParam = '?') {
  return `${alias}.id IN (SELECT MAX(tdx.id) FROM tips tdx WHERE tdx.sport = ${sportParam} GROUP BY COALESCE(NULLIF(TRIM(tdx.match_id), ''), 'id:' || CAST(tdx.id AS TEXT)))`;
}

const { rollupLeague } = require('./lib/league-rollup');

/**
 * Sub-game filter p/ esportes "guarda-chuva" (esports=lol/dota, mma=mma/boxing).
 * Retorna '' se não se aplica — seguro para concatenar em qualquer WHERE.
 */
function sqlGameFilter(alias, sport, game) {
  if (!game) return '';
  const g = String(game).toLowerCase();
  if (sport === 'esports') {
    if (g === 'dota2' || g === 'dota') return ` AND ${alias}.match_id LIKE 'dota2_%'`;
    if (g === 'lol')                   return ` AND (${alias}.match_id IS NULL OR ${alias}.match_id NOT LIKE 'dota2_%')`;
  }
  if (sport === 'mma') {
    if (g === 'boxing' || g === 'boxe') return ` AND LOWER(COALESCE(${alias}.event_name,'')) LIKE '%boxing%'`;
    if (g === 'mma')                    return ` AND LOWER(COALESCE(${alias}.event_name,'')) NOT LIKE '%boxing%'`;
  }
  return '';
}

// ── Import dataset CSV (football matches 2024/2025) ──
function parseCsvRows(text) {
  const rows = [];
  let i = 0;
  let field = '';
  let row = [];
  let inQuotes = false;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') { field += '"'; i += 2; continue; }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function idxOf(headers, name) {
  const n = String(name || '').toLowerCase().trim();
  return headers.findIndex(h => String(h || '').toLowerCase().trim() === n);
}

async function importFootballMatchesCsvOnce() {
  const enabled = (process.env.FOOTBALL_DATASET_IMPORT ?? 'true') !== 'false';
  if (!enabled) return;
  const urlCsv = process.env.FOOTBALL_MATCHES_CSV_URL
    || 'https://raw.githubusercontent.com/tarekmasryo/Football-Matches-Results-2024-25-Dataset/main/data/football_matches_2024_2025.csv';
  const key = `football_matches_csv:${urlCsv}`;
  const exists = stmts.getDatasetImport.get(key);
  if (exists) return;

  try {
    const r = await cachedHttpGet(urlCsv, { provider: 'football_dataset', ttlMs: 24 * 60 * 60 * 1000 }).catch(() => null);
    if (!r || r.status !== 200) { log('WARN', 'IMPORT', `CSV football: HTTP ${r?.status || 'fail'}`); return; }
    const rows = parseCsvRows(String(r.body || ''));
    if (!rows.length || rows.length < 2) { log('WARN', 'IMPORT', 'CSV football: vazio'); return; }

    const headers = rows[0];
    const c = {
      // formato "tarekmasryo" antigo (planejado)
      competition_name: idxOf(headers, 'competition_name'),
      utc_date: idxOf(headers, 'utc_date'),
      home_team_name: idxOf(headers, 'home_team_name'),
      away_team_name: idxOf(headers, 'away_team_name'),
      ft_home: idxOf(headers, 'ft_home'),
      ft_away: idxOf(headers, 'ft_away'),
      ht_home: idxOf(headers, 'ht_home'),
      ht_away: idxOf(headers, 'ht_away'),
      outcome: idxOf(headers, 'outcome'),

      // formato atual (log): competition_name, date_utc, home_team, away_team, fulltime_home, fulltime_away, halftime_home, halftime_away, match_outcome
      date_utc: idxOf(headers, 'date_utc'),
      home_team: idxOf(headers, 'home_team'),
      away_team: idxOf(headers, 'away_team'),
      fulltime_home: idxOf(headers, 'fulltime_home'),
      fulltime_away: idxOf(headers, 'fulltime_away'),
      halftime_home: idxOf(headers, 'halftime_home'),
      halftime_away: idxOf(headers, 'halftime_away'),
      match_outcome: idxOf(headers, 'match_outcome'),

      match_id: idxOf(headers, 'match_id'),
    };

    const dateIdx = c.utc_date >= 0 ? c.utc_date : c.date_utc;
    const homeIdx = c.home_team_name >= 0 ? c.home_team_name : c.home_team;
    const awayIdx = c.away_team_name >= 0 ? c.away_team_name : c.away_team;
    if (c.match_id < 0 || dateIdx < 0 || homeIdx < 0 || awayIdx < 0) {
      log('WARN', 'IMPORT', `CSV football: colunas ausentes (headers=${headers.slice(0, 30).join(',')})`);
      return;
    }

    let imported = 0;
    const tx = db.transaction(() => {
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const mid = row[c.match_id];
        const date = row[dateIdx];
        const home = row[homeIdx];
        const away = row[awayIdx];
        if (!mid || !date || !home || !away) continue;

        const ftHIdx = c.ft_home >= 0 ? c.ft_home : c.fulltime_home;
        const ftAIdx = c.ft_away >= 0 ? c.ft_away : c.fulltime_away;
        const ftH = ftHIdx >= 0 ? parseInt(row[ftHIdx], 10) : null;
        const ftA = ftAIdx >= 0 ? parseInt(row[ftAIdx], 10) : null;
        const score = (Number.isFinite(ftH) && Number.isFinite(ftA)) ? `${ftH}-${ftA}` : '';

        let winner = 'Draw';
        if (Number.isFinite(ftH) && Number.isFinite(ftA)) {
          if (ftH > ftA) winner = home;
          else if (ftA > ftH) winner = away;
        } else {
          const outIdx = c.outcome >= 0 ? c.outcome : c.match_outcome;
          const out = outIdx >= 0 ? String(row[outIdx] || '').toUpperCase() : '';
          if (out === 'H') winner = home;
          else if (out === 'A') winner = away;
          else winner = 'Draw';
        }

        const league = (c.competition_name >= 0 ? String(row[c.competition_name] || '').trim() : '') || 'Dataset';
        const matchId = `fd_${String(mid).trim()}`;
        const resolvedAt = String(date).replace('T', ' ').slice(0, 19); // "YYYY-MM-DD HH:MM:SS"
        stmts.upsertMatchResultWithDate.run(matchId, 'football', String(home), String(away), String(winner), score, league, resolvedAt);
        imported++;
      }
    });
    tx();

    stmts.upsertDatasetImport.run(key, 'tarekmasryo/Football-Matches-Results-2024-25-Dataset', imported);
    log('INFO', 'IMPORT', `CSV football importado: ${imported} jogos (key=${key})`);
  } catch (e) {
    log('WARN', 'IMPORT', `CSV football import falhou: ${e.message}`);
  }
}

async function importTennisSackmannCsvForYear(year, tour) {
  const isWta = tour === 'wta';
  let urlCsv = isWta
    ? `https://raw.githubusercontent.com/JeffSackmann/tennis_wta/master/wta_matches_${year}.csv`
    : `https://raw.githubusercontent.com/JeffSackmann/tennis_atp/master/atp_matches_${year}.csv`;
  if (!isWta && process.env.TENNIS_MATCHES_CSV_URL) {
    const yOverride = parseInt(process.env.TENNIS_DATASET_YEAR || String(year), 10);
    if (year === yOverride) urlCsv = process.env.TENNIS_MATCHES_CSV_URL;
  }
  const key = `tennis_csv:${tour}:${year}:${urlCsv}`;
  if (stmts.getDatasetImport.get(key)) return;

  try {
    const r = await cachedHttpGet(urlCsv, { provider: 'tennis_dataset', ttlMs: 24 * 60 * 60 * 1000 }).catch(() => null);
    if (!r || r.status !== 200) {
      if (r?.status === 404) {
        log('INFO', 'IMPORT', `CSV tennis ${tour} ${year}: ainda não disponível no GitHub (404) — use ESPN sync`);
      } else {
        log('WARN', 'IMPORT', `CSV tennis ${tour} ${year}: HTTP ${r?.status || 'fail'}`);
      }
      return;
    }
    const rows = parseCsvRows(String(r.body || ''));
    if (!rows.length || rows.length < 2) { log('WARN', 'IMPORT', `CSV tennis ${tour} ${year}: vazio`); return; }

    const headers = rows[0];
    const c = {
      tourney_id: idxOf(headers, 'tourney_id'),
      tourney_name: idxOf(headers, 'tourney_name'),
      surface: idxOf(headers, 'surface'),
      tourney_level: idxOf(headers, 'tourney_level'),
      tourney_date: idxOf(headers, 'tourney_date'),
      match_num: idxOf(headers, 'match_num'),
      winner_name: idxOf(headers, 'winner_name'),
      loser_name: idxOf(headers, 'loser_name'),
      score: idxOf(headers, 'score'),
    };
    if (c.winner_name < 0 || c.loser_name < 0 || c.tourney_date < 0) {
      log('WARN', 'IMPORT', `CSV tennis ${tour} ${year}: colunas ausentes (headers=${headers.slice(0, 30).join(',')})`);
      return;
    }

    const tourLabel = isWta ? 'WTA' : 'ATP';
    const idPrefix = isWta ? 'tw_' : 'ta_';
    let imported = 0;
    const tx = db.transaction(() => {
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const w = row[c.winner_name];
        const l = row[c.loser_name];
        const d = row[c.tourney_date];
        if (!w || !l || !d) continue;
        const score = (c.score >= 0 ? String(row[c.score] || '').trim() : '');
        const tourneyName = (c.tourney_name >= 0 ? String(row[c.tourney_name] || '').trim() : '') || tourLabel;
        const surface = (c.surface >= 0 ? String(row[c.surface] || '').trim() : '') || '';
        const level = (c.tourney_level >= 0 ? String(row[c.tourney_level] || '').trim() : '') || '';
        const league = `${tourLabel} ${tourneyName}${surface ? ` (${surface})` : ''}${level ? ` [${level}]` : ''}`;

        const tid = (c.tourney_id >= 0 ? String(row[c.tourney_id] || '').trim() : '');
        const mnum = (c.match_num >= 0 ? String(row[c.match_num] || '').trim() : '');
        const matchIdRaw = [tid || `Y${year}`, d, mnum || String(i)].filter(Boolean).join('_');
        const matchId = `${idPrefix}${matchIdRaw}`.slice(0, 128);

        const resolvedAt = (String(d).length === 8)
          ? `${String(d).slice(0, 4)}-${String(d).slice(4, 6)}-${String(d).slice(6, 8)} 00:00:00`
          : `${String(d).slice(0, 10)} 00:00:00`;

        stmts.upsertMatchResultWithDate.run(matchId, 'tennis', String(w), String(l), String(w), score, league, resolvedAt);
        imported++;
      }
    });
    tx();

    stmts.upsertDatasetImport.run(key, `JeffSackmann/tennis_${tour}`, imported);
    log('INFO', 'IMPORT', `CSV tennis ${tour} ${year}: ${imported} jogos`);
  } catch (e) {
    log('WARN', 'IMPORT', `CSV tennis ${tour} ${year} falhou: ${e.message}`);
  }
}

async function importTennisMatchesCsvOnce() {
  const enabled = (process.env.TENNIS_DATASET_IMPORT ?? 'true') !== 'false';
  if (!enabled) return;
  const importWta = (process.env.TENNIS_IMPORT_WTA ?? 'true') !== 'false';
  const y0 = new Date().getFullYear();
  let years;
  const rawYears = (process.env.TENNIS_DATASET_YEARS || '').trim();
  if (rawYears) {
    years = [...new Set(rawYears.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n >= 1990 && n <= y0 + 1))];
  } else {
    // Sackmann publica ~ano anterior; 2025/2026 costumam 404 até existir no GitHub
    years = [y0 - 2, y0 - 1, y0].filter(y => y >= 1990);
  }
  for (const year of years) {
    await importTennisSackmannCsvForYear(year, 'atp');
    if (importWta) await importTennisSackmannCsvForYear(year, 'wta');
  }
}

// ── Import opcional: dados gol.gg (CSV) ──
// Usa CSV gerado por scrapers externos (ex: PandaTobi/League-of-Legends-ESports-Data)
// Objetivo: seed/merge em pro_champ_stats quando sync PandaScore estiver vazio
function parseCsvLoose(text) {
  const rows = [];
  let i = 0;
  let field = '';
  let row = [];
  let inQuotes = false;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') { field += '"'; i += 2; continue; }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function normHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function importGolGgCsvToProChampStats(csvPath) {
  try {
    if (!csvPath) return { ok: false, reason: 'no_path' };
    const abs = path.isAbsolute(csvPath) ? csvPath : path.resolve(csvPath);
    if (!fs.existsSync(abs)) return { ok: false, reason: 'not_found', path: abs };

    const mode = (process.env.GOLGG_IMPORT_MODE || 'seed').toLowerCase(); // seed|merge
    const champCount = db.prepare('SELECT COUNT(*) as cnt FROM pro_champ_stats').get();
    if (mode === 'seed' && (champCount?.cnt || 0) > 0) return { ok: false, reason: 'already_has_data', cnt: champCount.cnt };

    const raw = fs.readFileSync(abs, 'utf8');
    const rows = parseCsvLoose(raw);
    if (!rows.length) return { ok: false, reason: 'empty_csv' };

    const headers = rows[0].map(normHeader);
    const idx = (name) => headers.indexOf(name);
    const colChampion = idx('champion') >= 0 ? idx('champion') : idx('champ') >= 0 ? idx('champ') : idx('champion_name');
    const colRole = idx('role') >= 0 ? idx('role') : idx('position') >= 0 ? idx('position') : idx('lane');
    const colWins = idx('wins') >= 0 ? idx('wins') : idx('win') >= 0 ? idx('win') : -1;
    const colTotal = idx('total') >= 0 ? idx('total') : idx('games') >= 0 ? idx('games') : idx('matches');
    const colPatch = idx('patch');

    if (colChampion < 0 || colRole < 0 || colWins < 0 || colTotal < 0) {
      return { ok: false, reason: 'missing_columns', headers: headers.slice(0, 50) };
    }

    let imported = 0;
    const patchVal = process.env.LOL_PATCH || (process.env.LOL_PATCH_META || '').slice(0, 16) || null;
    const tx = db.transaction(() => {
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const champion = String(row[colChampion] || '').trim();
        const roleRaw = String(row[colRole] || '').trim().toLowerCase();
        const wins = parseInt(String(row[colWins] || '0').trim(), 10);
        const total = parseInt(String(row[colTotal] || '0').trim(), 10);
        if (!champion || !roleRaw || !Number.isFinite(wins) || !Number.isFinite(total) || total <= 0) continue;
        const role = roleRaw.replace('bot', 'bottom').replace('adc', 'bottom').replace('sup', 'support');
        const patch = (colPatch >= 0 ? String(row[colPatch] || '').trim() : '') || patchVal || null;
        stmts.addChampStat.run(champion, role, wins, total, patch);
        imported++;
      }
    });
    tx();

    log('INFO', 'BOOT', `gol.gg CSV import: ${imported} linha(s) para pro_champ_stats (${abs})`);
    return { ok: true, imported, path: abs };
  } catch(e) {
    log('WARN', 'BOOT', `gol.gg CSV import falhou: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

try {
  const csvPath = process.env.GOLGG_CSV_PATH || process.env.GOLGG_PATH || '';
  if (csvPath) importGolGgCsvToProChampStats(csvPath);
} catch(_) {}

// Apenas Esports suportado — sem scrapers externos

// ── Odds Cache ──
const oddsCache = {};
// Cache específico: ML por mapa (quando disponível via OddsPapi marketId 173+)
// key: `map_${fixtureId}_${mapNumber}` -> { t1, t2, bookmaker, fixtureId, marketId, mapNumber, ts }
const mapOddsCache = new Map();
let lastOddsUpdate = 0;
const ODDS_TTL = 4 * 60 * 60 * 1000; // 4h — conserves The Odds API monthly quota (500 req free tier)

// Esports odds: OddsPapi (free 250 req/mês). TTL 6h + tournament cache 24h ≈ 180 req/mês
let lastEsportsOddsUpdate = 0;
let lastApiResponse = ''; // Para diagnóstico
let esportsOddsFetching = false;
// TTL por ciclo (1 req por ciclo com round-robin de 6 lotes).
// Plano free OddsPapi: 250 req/mês ≈ 8/dia → ciclo mínimo = 3h
// Com 6 lotes e 3h por ciclo: todos os torneios cobertos a cada ~18h
// Configurável via ESPORTS_ODDS_TTL_H (horas) no Railway
const ESPORTS_ODDS_TTL = (parseInt(process.env.ESPORTS_ODDS_TTL_H || '') || 3) * 60 * 60 * 1000;

// Tournament ID cache: refresh once per 24h (saves 2 req/dia)
const TOURNAMENT_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

// Per-batch timestamp: quando cada lote foi buscado pela última vez
const batchLastFetchedTs = {}; // { batchIndex: timestamp }



let lastAnalysisAt = null; // ISO timestamp of last successful auto-analysis cycle


// ── LoL Esports ──
const LOL_BASE = 'https://esports-api.lolesports.com/persisted/gw';
const LOL_LEAGUES = new Set([
  // Ligas Tier 1
  'worlds', 'msi', 'lcs', 'lck', 'lec', 'lpl', 'cblol-brazil', 'lla', 'pcs',
  'lco', 'vcs', 'ljl-japan', 'lcp',
  // Ligas Tier 2 / Regionais
  'emea_masters', 'emea-masters', 'lfl', 'nlc', 'lta_n', 'lta_s', 'lta',
  'turkiye-sampiyonluk-ligi', 'tcl', 'first_stand', 'americas_cup', 'nacl',
  'lck_challengers_league', 'lck-challengers-league', 'lck-cl',
  'primeleague', 'prime-league-pro-division', 'prime-league',
  'liga_portuguesa', 'lplol', 'lit', 'les', 'lrn', 'lrs',
  'hitpoint_masters', 'hitpoint-masters', 'hitpoint-winter',
  'esports_balkan_league', 'esport-balkan-league', 'ebl',
  'hellenic_legends_league', 'lta_cross',
  // Ligas adicionais da lista OddsPapi
  'gll', 'road-of-legends', 'road_of_legends', 'roadoflegends', 'ultraliga', 'elite-series', 'njcs', 'kjl',
  'arabian-league', 'arabian_league', 'lvp-superliga', 'ldl', 'cblol-academy',
  'circuito-desafiante', 'cd', 'lcl', 'gll-pro-am', 'lfl-division-2',
  // Slugs alternativos usados pela Riot API (já cobertos via PandaScore, suprime WARN)
  'south_regional_league', 'rift_legends',
  'finnish-pro-league-winter', 'finnish-pro-league',
  'asia-masters', 'asia-invitational',
  // EWC / Esports World Cup
  'road_to_ewc', 'road_to_ewc_lpl', 'road_to_ewc_lck', 'road_to_ewc_lec',
  'road_to_ewc_lcs', 'road_to_ewc_cblol', 'road_to_ewc_lcp',
  'ewc', 'ewc_lpl', 'esports_world_cup', 'esports_world_cup_lpl', 'esports-world-cup',
  // Slugs extras configuráveis via .env (ex: LOL_EXTRA_LEAGUES=slug1,slug2)
  ...(process.env.LOL_EXTRA_LEAGUES || '').split(',').map(s => s.trim()).filter(Boolean),
]);

// Slugs vistos mas não reconhecidos — logados para diagnóstico
const unknownLolSlugs = new Set();

// ── Odds APIs ──
async function fetchOdds(sport) {
  if (sport === 'esports') return await fetchEsportsOdds();
}

// ── SX.Bet (orderbook) odds ──
// Base URL docs: https://docs.sx.bet/api-reference/get-best-odds
const SXBET_BASE_URL = process.env.SXBET_BASE_URL || 'https://api.sx.bet';
const SXBET_ENABLED = /^(1|true|yes)$/i.test(String(process.env.SXBET_ENABLED || ''));
let _sxSportsCache = null; // { ts, data }
let _sxMetadataCache = null; // { ts, data }

async function sxGetJson(path, { ttlMs = 15000 } = {}) {
  const url = `${SXBET_BASE_URL}${path}`;
  const r = await cachedHttpGet(url, { provider: 'sxbet', ttlMs }).catch(() => null);
  if (!r || r.status !== 200) return null;
  return safeParse(r.body, null);
}

async function sxGetSports() {
  const ttl = Math.max(30000, parseInt(process.env.SXBET_SPORTS_TTL_MS || '300000', 10) || 300000);
  if (_sxSportsCache && (Date.now() - _sxSportsCache.ts) < ttl) return _sxSportsCache.data;
  const j = await sxGetJson('/sports', { ttlMs: ttl }).catch(() => null);
  const data = j?.data || null;
  if (Array.isArray(data)) _sxSportsCache = { ts: Date.now(), data };
  return Array.isArray(data) ? data : null;
}

async function sxGetMetadata() {
  const ttl = Math.max(30000, parseInt(process.env.SXBET_METADATA_TTL_MS || '300000', 10) || 300000);
  if (_sxMetadataCache && (Date.now() - _sxMetadataCache.ts) < ttl) return _sxMetadataCache.data;
  const j = await sxGetJson('/metadata', { ttlMs: ttl }).catch(() => null);
  const data = j?.data || null;
  if (data) _sxMetadataCache = { ts: Date.now(), data };
  return data || null;
}

function sxPercentageOddsToDecimal(percentageOddsRaw) {
  // Docs: percentageOdds is implied probability * 1e20
  // https://docs.sx.bet/developers/odds-and-tokens.md
  try {
    const n = typeof percentageOddsRaw === 'string' ? BigInt(percentageOddsRaw) : BigInt(percentageOddsRaw);
    const PREC = 10n ** 20n;
    if (n <= 0n || n >= PREC) return null;
    const p = Number(n) / Number(PREC);
    if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
    const dec = 1 / p;
    if (!Number.isFinite(dec) || dec < 1.0001 || dec > 1000) return null;
    return dec;
  } catch(_) {
    return null;
  }
}

async function sxFindLoLSportId() {
  const sports = await sxGetSports().catch(() => null);
  if (!sports) return null;
  const pick = sports.find(s => {
    const lbl = String(s?.label || '').toLowerCase();
    return lbl.includes('league of legends') || lbl === 'lol' || lbl.includes('loL'.toLowerCase());
  }) || sports.find(s => {
    const lbl = String(s?.label || '').toLowerCase();
    return lbl.includes('esports') || lbl.includes('e sports') || lbl.replace(/\s+/g, '').includes('esports');
  });
  const sid = pick?.sportId;
  return (sid != null) ? parseInt(sid, 10) : null;
}

let _sxDotaSportIdCache = null;
async function sxFindDotaSportId() {
  if (_sxDotaSportIdCache != null) return _sxDotaSportIdCache;
  const sports = await sxGetSports().catch(() => null);
  if (!sports) return null;
  const pick = sports.find(s => {
    const lbl = String(s?.label || '').toLowerCase();
    return lbl.includes('dota 2') || lbl.includes('dota2') || lbl === 'dota';
  });
  const sid = pick?.sportId;
  _sxDotaSportIdCache = (sid != null) ? parseInt(sid, 10) : null;
  return _sxDotaSportIdCache;
}

function sxNameLike(a, b) {
  const clean = (s) => {
    let n = norm(String(s || ''));
    // remove sufixos comuns
    for (const suf of ['gaming', 'esports', 'team', 'club', 'academy', 'gg', 'esport']) {
      if (n.endsWith(suf) && n.length > suf.length + 3) n = n.slice(0, -suf.length);
    }
    return n;
  };
  const na = clean(a);
  const nb = clean(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  // prefix match (evita nomes compostos)
  if (na.length >= 6 && nb.length >= 6) {
    if (na.startsWith(nb.slice(0, 6)) || nb.startsWith(na.slice(0, 6))) return true;
  }
  return false;
}

let _tennisSettleRowsCache = { ts: 0, lookback: -1, rows: null };
function getTennisSettleRowsCached(lookbackDays) {
  const now = Date.now();
  const ttl = Math.min(120000, Math.max(15000, parseInt(process.env.TENNIS_SETTLE_CACHE_MS || '60000', 10) || 60000));
  if (_tennisSettleRowsCache.rows && _tennisSettleRowsCache.lookback === lookbackDays && (now - _tennisSettleRowsCache.ts) < ttl) {
    return _tennisSettleRowsCache.rows;
  }
  const rows = db.prepare(`
    SELECT match_id, team1, team2, winner, final_score, league, resolved_at
    FROM match_results
    WHERE game = 'tennis'
    AND datetime(resolved_at) >= datetime('now', '-' || ? || ' days')
    ORDER BY resolved_at DESC
    LIMIT 4000
  `).all(String(lookbackDays));
  _tennisSettleRowsCache = { ts: now, lookback: lookbackDays, rows };
  return rows;
}

function invalidateTennisSettleRowsCache() {
  _tennisSettleRowsCache = { ts: 0, lookback: -1, rows: null };
}

/** Evita liquidação com H2H antigo: só linhas com jogo terminado depois da tip (slack opcional p/ relógio). */
function tennisResolvedAtEligibleForSentTip(resolvedAtStr, tipMs) {
  const resMs = Date.parse(String(resolvedAtStr || '').replace(' ', 'T'));
  if (!Number.isFinite(resMs)) return false;
  if (!Number.isFinite(tipMs)) return true;
  const slackMs = Math.max(0, parseInt(process.env.TENNIS_SETTLE_BEFORE_TIP_SLACK_MS || '0', 10) || 0);
  return resMs >= tipMs - slackMs;
}

function pickBestTennisSettleRow(rows, p1, p2, tipMs) {
  let best = null;
  let bestDist = Infinity;
  for (const r of rows) {
    if (!tennisPairMatchesPlayers(p1, p2, r.team1, r.team2)) continue;
    if (!tennisResolvedAtEligibleForSentTip(r.resolved_at, tipMs)) continue;
    const resMs = Date.parse(String(r.resolved_at || '').replace(' ', 'T'));
    if (Number.isFinite(tipMs) && Number.isFinite(resMs)) {
      const dist = Math.abs(resMs - tipMs);
      if (dist < bestDist) {
        bestDist = dist;
        best = r;
      }
    } else if (Number.isFinite(resMs)) {
      const bestMs = best ? Date.parse(String(best.resolved_at || '').replace(' ', 'T')) : -Infinity;
      if (!best || resMs > bestMs) best = r;
    }
  }
  return best;
}

let _tennisEspnMatchSyncLastMs = 0;
const _tennisEspnWindowSyncAt = new Map();

function espnDateYmdUtc(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function utcDayAnchorMs(tipMs) {
  const d = new Date(tipMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function shouldSkipTennisEspnWindowSync(anchorKey) {
  const ttl = Math.min(300000, Math.max(20000, parseInt(process.env.TENNIS_ESPN_WINDOW_SYNC_MIN_MS || '90000', 10) || 90000));
  const k = String(anchorKey);
  const t = _tennisEspnWindowSyncAt.get(k);
  return t != null && (Date.now() - t) < ttl;
}

function markTennisEspnWindowSync(anchorKey) {
  _tennisEspnWindowSyncAt.set(String(anchorKey), Date.now());
}

/** Grava jogos com status post de um payload scoreboard ESPN (ATP/WTA). */
function upsertTennisPostCompetitionsFromEspnJson(j, slug) {
  let n = 0;
  for (const ev of (j?.events || [])) {
    const evName = String(ev?.name || '').trim() || slug.toUpperCase();
    for (const grp of (ev.groupings || [])) {
      for (const comp of (grp.competitions || [])) {
        if (String(comp?.status?.type?.state || '') !== 'post') continue;
        const comps = comp.competitors || [];
        if (comps.length < 2) continue;
        const winnerComp = comps.find(c => c.winner === true);
        if (!winnerComp) continue;
        const ath = c => String(c?.athlete?.displayName || c?.displayName || c?.name || '').trim();
        const t1 = ath(comps[0]);
        const t2 = ath(comps[1]);
        const winner = ath(winnerComp);
        if (!t1 || !t2 || !winner) continue;
        const compId = comp.id != null ? String(comp.id) : `${comp.date || ''}_${norm(t1)}_${norm(t2)}`;
        const matchId = `espn_${slug}_${compId}`.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
        const score = String(comp.status?.displayClock || comp.status?.type?.shortDetail || '').trim();
        const league = `${String(slug).toUpperCase()} ${evName}`.slice(0, 220);
        const dateIso = String(comp.date || '').trim();
        let resolvedAt = null;
        if (dateIso.includes('T')) {
          resolvedAt = dateIso.replace('T', ' ').replace(/\.\d{3}Z?$/, '').slice(0, 19);
        } else if (dateIso.length >= 10) {
          resolvedAt = `${dateIso.slice(0, 10)} 12:00:00`;
        }
        if (!resolvedAt) continue;
        try {
          stmts.upsertMatchResultWithDate.run(matchId, 'tennis', t1, t2, winner, score, league, resolvedAt);
          n++;
        } catch (_) { /* ignore row */ }
      }
    }
  }
  return n;
}

/** Busca scoreboard ESPN ATP+WTA em janela ao redor de sent_at (assimétrica: jogos costumam ser antes ou pouco depois da tip). */
async function syncTennisEspnCompletedAroundSentAt(sentAtRaw) {
  const sentRaw = String(sentAtRaw || '').trim();
  let tipMs = sentRaw
    ? Date.parse(sentRaw.includes('T') ? sentRaw : sentRaw.replace(' ', 'T'))
    : NaN;
  if (!Number.isFinite(tipMs)) tipMs = Date.now();
  const anchorKey = `day:${utcDayAnchorMs(tipMs)}`;
  if (shouldSkipTennisEspnWindowSync(anchorKey)) return 0;
  const beforeD = Math.min(50, Math.max(7, parseInt(process.env.TENNIS_ESPN_DATE_WINDOW_BEFORE_DAYS || '21', 10) || 21));
  const afterD = Math.min(50, Math.max(7, parseInt(process.env.TENNIS_ESPN_DATE_WINDOW_AFTER_DAYS || '21', 10) || 21));
  const start = new Date(tipMs - beforeD * 86400000);
  const end = new Date(tipMs + afterD * 86400000);
  const dates = `${espnDateYmdUtc(start)}-${espnDateYmdUtc(end)}`;
  const tennisData = require('./lib/tennis-data');
  let n = 0;
  for (const slug of ['atp', 'wta']) {
    const j = await tennisData.getScoreboard(slug, { dates }).catch(() => null);
    n += upsertTennisPostCompetitionsFromEspnJson(j, slug);
  }
  markTennisEspnWindowSync(anchorKey);
  invalidateTennisSettleRowsCache();
  return n;
}

/** Fallback: últimos N dias até amanhã (throttle próprio) — cobre tips com sent_at ruim ou buracos na janela. */
async function syncTennisEspnCompletedRecentSpan(spanDays) {
  const span = Math.min(90, Math.max(14, parseInt(String(spanDays), 10) || 45));
  const anchorKey = `recent:${span}`;
  if (shouldSkipTennisEspnWindowSync(anchorKey)) return 0;
  const now = Date.now();
  const start = new Date(now - span * 86400000);
  const end = new Date(now + 2 * 86400000);
  const dates = `${espnDateYmdUtc(start)}-${espnDateYmdUtc(end)}`;
  const tennisData = require('./lib/tennis-data');
  let n = 0;
  for (const slug of ['atp', 'wta']) {
    const j = await tennisData.getScoreboard(slug, { dates }).catch(() => null);
    n += upsertTennisPostCompetitionsFromEspnJson(j, slug);
  }
  markTennisEspnWindowSync(anchorKey);
  invalidateTennisSettleRowsCache();
  return n;
}

/** Grava jogos com status post do scoreboard ESPN ATP/WTA em match_results (não depende do CSV Sackmann). */
async function syncTennisEspnCompletedToMatchResults() {
  const tennisData = require('./lib/tennis-data');
  let n = 0;
  for (const slug of ['atp', 'wta']) {
    const j = await tennisData.getScoreboard(slug).catch(() => null);
    n += upsertTennisPostCompetitionsFromEspnJson(j, slug);
  }
  if (n > 0) invalidateTennisSettleRowsCache();
  return n;
}

async function maybeSyncTennisEspnMatchResults(force = false) {
  const minMs = Math.max(45_000, parseInt(process.env.TENNIS_ESPN_SYNC_MIN_MS || '90000', 10) || 90000);
  const now = Date.now();
  if (!force && (now - _tennisEspnMatchSyncLastMs) < minMs) {
    return { ok: true, throttled: true, upserted: 0 };
  }
  _tennisEspnMatchSyncLastMs = now;
  const upserted = await syncTennisEspnCompletedToMatchResults();
  if (upserted > 0) log('INFO', 'TENNIS-ESPN', `match_results: +${upserted} (ESPN scoreboard)`);
  return { ok: true, upserted };
}

async function sxFindMarketForMatch(t1, t2, { liveOnly = false, mapNumber = null, sportId: overrideSportId = null } = {}) {
  const sportId = overrideSportId ?? await sxFindLoLSportId().catch(() => null);
  if (!sportId) return null;

  const pageSize = Math.min(50, Math.max(5, parseInt(process.env.SXBET_MARKETS_PAGE_SIZE || '50', 10) || 50));
  const maxPages = Math.min(6, Math.max(1, parseInt(process.env.SXBET_MARKETS_MAX_PAGES || '3', 10) || 3));
  let nextKey = null;

  for (let i = 0; i < maxPages; i++) {
    const qs = [
      `sportIds=${encodeURIComponent(String(sportId))}`,
      `pageSize=${encodeURIComponent(String(pageSize))}`,
      liveOnly ? `liveOnly=true` : ``,
      nextKey ? `paginationKey=${encodeURIComponent(String(nextKey))}` : ``,
    ].filter(Boolean).join('&');
    const j = await sxGetJson(`/markets/active?${qs}`, { ttlMs: 2500 }).catch(() => null);
    const markets = j?.data?.markets || [];
    if (!Array.isArray(markets) || markets.length === 0) break;

    const wantedMap = mapNumber != null ? parseInt(mapNumber, 10) : null;
    const isMapWanted = (m) => {
      if (!wantedMap || wantedMap <= 0) return false;
      const o1 = String(m?.outcomeOneName || '');
      const o2 = String(m?.outcomeTwoName || '');
      const meta = JSON.stringify(m?.marketMeta || {});
      const needle = `map ${wantedMap}`;
      return `${o1} ${o2} ${meta}`.toLowerCase().includes(needle);
    };

    const pickCandidates = (requireLolLabel) => markets.filter(m => {
      const leagueLabel = String(m?.leagueLabel || m?.group1 || '').toLowerCase();
      if (requireLolLabel && leagueLabel && !(leagueLabel.includes('lol') || leagueLabel.includes('league of legends'))) return false;
      const a = m?.teamOneName || m?.outcomeOneName || '';
      const b = m?.teamTwoName || m?.outcomeTwoName || '';
      const okTeams = (sxNameLike(a, t1) && sxNameLike(b, t2)) || (sxNameLike(a, t2) && sxNameLike(b, t1));
      if (!okTeams) return false;
      if (wantedMap) return isMapWanted(m);
      // Prefer "12" (no draw) style markets
      const mt = parseInt(m?.type, 10);
      return [52, 226].includes(mt) || true;
    });
    let candidates = pickCandidates(true);
    if (!candidates.length) candidates = pickCandidates(false); // fallback: label não padronizado

    if (candidates.length) {
      // prefer liveEnabled when liveOnly is true
      const picked = [...candidates].sort((x, y) => {
        const xl = x?.liveEnabled ? 1 : 0;
        const yl = y?.liveEnabled ? 1 : 0;
        return (yl - xl);
      })[0];
      return picked || null;
    }
    nextKey = j?.data?.nextKey || null;
    if (!nextKey) break;
  }
  return null;
}

async function sxGetBestOddsForMarket(marketHash) {
  const md = await sxGetMetadata().catch(() => null);
  const baseToken = md?.addresses?.['4162']?.USDC || md?.addresses?.['4162']?.usdc || null;
  if (!baseToken) return null;
  const path = `/orders/odds/best?marketHashes=${encodeURIComponent(String(marketHash))}&baseToken=${encodeURIComponent(String(baseToken))}`;
  const j = await sxGetJson(path, { ttlMs: 1500 }).catch(() => null);
  const best = j?.data?.bestOdds?.[0];
  if (!best) return null;
  return best;
}

async function sxGetMatchWinnerOdds(t1, t2, { liveOnly = false, mapNumber = null, _debug = false, sportId = null } = {}) {
  if (!SXBET_ENABLED) return null;
  const m = await sxFindMarketForMatch(t1, t2, { liveOnly, mapNumber, sportId }).catch(() => null);
  if (!m?.marketHash) {
    if (_debug) log('DEBUG', 'SXBET', `Mercado não encontrado para ${t1} vs ${t2} (liveOnly=${liveOnly})`);
    return null;
  }
  if (_debug) log('DEBUG', 'SXBET', `Mercado encontrado: ${m.marketHash} (${m.outcomeOneName} vs ${m.outcomeTwoName})`);
  const best = await sxGetBestOddsForMarket(m.marketHash).catch(() => null);
  if (!best) {
    if (_debug) log('DEBUG', 'SXBET', `Sem melhores odds para marketHash=${m.marketHash}`);
    return null;
  }
  const o1 = sxPercentageOddsToDecimal(best?.outcomeOne?.percentageOdds);
  const o2 = sxPercentageOddsToDecimal(best?.outcomeTwo?.percentageOdds);
  if (!o1 || !o2) {
    if (_debug) log('DEBUG', 'SXBET', `Conversão de odds falhou: outcomeOne=${best?.outcomeOne?.percentageOdds} outcomeTwo=${best?.outcomeTwo?.percentageOdds}`);
    return null;
  }

  // Map outcome->team por matching de nome
  const aName = String(m?.outcomeOneName || m?.teamOneName || '');
  const bName = String(m?.outcomeTwoName || m?.teamTwoName || '');
  const isA1 = sxNameLike(aName, t1) && sxNameLike(bName, t2);
  const isA2 = sxNameLike(aName, t2) && sxNameLike(bName, t1);
  const t1Odd = isA1 ? o1 : isA2 ? o2 : o1;
  const t2Odd = isA1 ? o2 : isA2 ? o1 : o2;

  return {
    t1: t1Odd.toFixed(2),
    t2: t2Odd.toFixed(2),
    bookmaker: 'SX.Bet',
    sx: { marketHash: String(m.marketHash), liveOnly: !!liveOnly, mapNumber: mapNumber ? parseInt(mapNumber, 10) : null },
  };
}

async function fetchMapOddsByFixtureId(fixtureId, mapNumber) {
  if (!ODDSPAPI_KEY) return null;
  const fid = String(fixtureId || '');
  const n = parseInt(mapNumber, 10);
  if (!fid || !Number.isFinite(n) || n <= 0) return null;

  // marketId: 173/175/177/179/181
  const marketId = 173 + ((n - 1) * 2);
  const cacheKey = `map_${fid}_${n}`;
  const cached = mapOddsCache.get(cacheKey);
  const ttlMs = Math.max(2000, parseInt(process.env.ODDSPAPI_MAP_ODDS_TTL_MS || '8000', 10) || 8000);
  if (cached && (Date.now() - cached.ts) < ttlMs) return cached;

  const urls = [
    `https://api.oddspapi.io/v4/odds?fixtureId=${encodeURIComponent(fid)}&bookmakers=1xbet&marketId=${marketId}&oddsFormat=decimal&verbosity=5&apiKey=${ODDSPAPI_KEY}`,
    `https://api.oddspapi.io/v4/odds?fixtureId=${encodeURIComponent(fid)}&marketId=${marketId}&oddsFormat=decimal&verbosity=5&apiKey=${ODDSPAPI_KEY}`,
  ];
  let fixtureJson = null;
  for (const url of urls) {
    const r = await cachedHttpGet(url, { provider: 'oddspapi', ttlMs: 0 }).catch(() => null);
    if (r && r.status === 200) {
      fixtureJson = safeParse(r.body, null);
      if (fixtureJson) break;
    }
  }
  if (!fixtureJson) return null;

  const bkOdds = fixtureJson.bookmakerOdds || fixtureJson.bookmakersOdds || {};
  const bk = bkOdds['1xbet'] || bkOdds['1xBet'] || bkOdds['1XBET'] || null;
  const marketsObj = bk?.markets || {};
  const m = marketsObj[String(marketId)] || marketsObj[marketId] || null;
  if (!m) return null;

  const outcomesObj = m?.outcomes || {};
  const outcomes = Object.values(outcomesObj || {});
  if (!outcomes || outcomes.length < 2) return null;
  const pickPrice = (o) => {
    const players = o?.players || o?.playerOdds || {};
    const first = players['0'] || players[0] || Object.values(players || {})[0] || null;
    return extractPrice(first || o);
  };
  const p1 = pickPrice(outcomes[0]);
  const p2 = pickPrice(outcomes[1]);
  if (!p1 || !p2) return null;

  const out = {
    t1: String(p1),
    t2: String(p2),
    bookmaker: '1xBet',
    fixtureId: fid,
    marketId,
    mapNumber: n,
    ts: Date.now(),
  };
  mapOddsCache.set(cacheKey, out);
  return out;
}

// Cache de último resultado bem-sucedido de /football-matches (sobrevive ao esgotamento de quota)
let _footballMatchesCache = null; // { matches: Array, ts: number }
const FOOTBALL_MATCHES_CACHE_TTL = 8 * 60 * 60 * 1000; // 8h

// Cache de /tennis-matches — curto para suportar live polling agressivo (2min)
let _tennisMatchesCache = null; // { matches: Array, ts: number }
const TENNIS_MATCHES_CACHE_TTL = 90 * 1000; // 90s

// Backoff em caso de 429
let esportsBackoffUntil = 0;
const _serverStartTs = Date.now();
let _oddsBackoffLogTs = 0;
const _raw429Backoff = parseInt(process.env.ODDSPAPI_429_BACKOFF_MS || '', 10);
const ESPORTS_BACKOFF_TTL = Math.max(5 * 60 * 1000, Number.isFinite(_raw429Backoff) && _raw429Backoff > 0 ? _raw429Backoff : 2 * 60 * 60 * 1000);

// Cooldown por match para force refresh (anti-429)
const lastForceRefreshByPair = new Map(); // key -> ts
const FORCE_REFRESH_COOLDOWN_MS = (parseInt(process.env.ODDSPAPI_FORCE_COOLDOWN_S || '300', 10) || 300) * 1000; // 5min default

// Throttle global de force-refresh (evita rajadas em diferentes pares)
let _forceFetchChain = Promise.resolve();
let _forceFetchLastTs = 0;
const FORCE_FETCH_GAP_MS = Math.max(500, parseInt(process.env.FORCE_FETCH_GAP_MS || '2500', 10) || 2500);
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function enqueueForceFetchEsports() {
  const p = _forceFetchChain.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, FORCE_FETCH_GAP_MS - (now - _forceFetchLastTs));
    if (wait > 0) await _sleep(wait);
    _forceFetchLastTs = Date.now();
    lastEsportsOddsUpdate = 0;
    await fetchOdds('esports');
  });
  _forceFetchChain = p.catch(() => {}).then(() => {});
  return p;
}

// Timestamp do último bootstrap completo — force-refresh é bloqueado por BOOTSTRAP_GRACE_MS após o bootstrap
let lastBootstrapCompletedTs = 0;
const BOOTSTRAP_GRACE_MS = Math.max(30000, parseInt(process.env.ODDSPAPI_BOOTSTRAP_GRACE_MS || '60000', 10) || 60000); // 60s default

// Round-robin: rastreia qual lote buscar no próximo ciclo
let esportsBatchCursor = 0;

// Cache de tournament IDs (24h)
let cachedEsportsTids = null;
let cachedEsportsTidsTs = 0;

// ── Fila async (anti-429 / anti-spam) ──
function createAsyncQueue(concurrency = 1) {
  let running = 0;
  const q = [];
  const inFlightByKey = new Map();

  function pump() {
    while (running < concurrency && q.length) {
      const item = q.shift();
      if (!item) break;
      running++;
      Promise.resolve()
        .then(item.fn)
        .then(item.resolve, item.reject)
        .finally(() => {
          running--;
          inFlightByKey.delete(item.key);
          pump();
        });
    }
  }

  function enqueue(key, fn) {
    if (key && inFlightByKey.has(key)) return inFlightByKey.get(key);
    const p = new Promise((resolve, reject) => {
      q.push({ key, fn, resolve, reject });
      pump();
    });
    if (key) inFlightByKey.set(key, p);
    return p;
  }

  return { enqueue };
}

// OddsPapi (LoL esports) é agressivo em 429 → serializa requests
const oddsPapiQueue = createAsyncQueue(1);

// The Odds API (tennis/football/mma) — serializa + dedupe por URL
const theOddsQueue = createAsyncQueue(1);

// Odds-API.io — serializa + dedupe por URL
const oddsApiIoQueue = createAsyncQueue(1);

function clampStr(v, maxLen) {
  const s = (v == null ? '' : String(v)).trim();
  if (!s) return '';
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function parseFiniteNumber(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function badRequest(res, msg) {
  sendJson(res, { error: String(msg || 'invalid_payload') }, 400);
}

async function theOddsGet(theOddsUrl) {
  return await theOddsQueue.enqueue(`theodds:${theOddsUrl}`, async () => {
    const ttlMsRaw = parseInt(process.env.HTTP_CACHE_THEODDS_TTL_MS || '', 10);
    const ttlMs = Number.isFinite(ttlMsRaw) ? ttlMsRaw : 15 * 60 * 1000; // cache de 15 minutos por default!
    return await cachedHttpGet(theOddsUrl, { provider: 'theodds', ttlMs }).catch(() => ({ status: 500, body: '[]' }));
  });
}

async function oddsApiIoGet(oddsApiIoUrl, ttlMsDefault) {
  return await oddsApiIoQueue.enqueue(`oddsapiio:${oddsApiIoUrl}`, async () => {
    const ttlMsRaw = parseInt(process.env.HTTP_CACHE_ODDSAPIO_TTL_MS || '', 10);
    const ttlMs = Number.isFinite(ttlMsRaw)
      ? ttlMsRaw
      : (Number.isFinite(ttlMsDefault) ? ttlMsDefault : 10 * 60 * 1000);
    return await cachedHttpGet(oddsApiIoUrl, { provider: 'oddsapiio', ttlMs }).catch(() => ({ status: 500, body: '[]' }));
  });
}

// Cache local de /events (Odds-API.io) — reduzir requisições mensais (plano free)
let _oddsApiIoEventsCache = new Map(); // sportSlug -> { events, ts }
const ODDSAPIO_EVENTS_TTL = 10 * 60 * 1000;

async function fetchOddsApiIoEvents(sportSlug) {
  const slug = String(sportSlug || '').trim().toLowerCase();
  if (!slug || !ODDS_API_IO_KEY) return [];
  const now = Date.now();
  const cached = _oddsApiIoEventsCache.get(slug);
  if (cached && (now - cached.ts) < ODDSAPIO_EVENTS_TTL) return cached.events || [];
  const r = await oddsApiIoGet(
    `https://api.odds-api.io/v3/events?apiKey=${encodeURIComponent(ODDS_API_IO_KEY)}&sport=${encodeURIComponent(slug)}`,
    ODDSAPIO_EVENTS_TTL
  );
  const list = r && r.status === 200 ? safeParse(r.body, []) : [];
  const events = Array.isArray(list) ? list : (Array.isArray(list?.data) ? list.data : []);
  _oddsApiIoEventsCache.set(slug, { events, ts: now });
  return events;
}

async function fetchOddsApiIoEventOdds(eventId, bookmakersCsv) {
  if (!ODDS_API_IO_KEY) return null;
  const eid = String(eventId || '').trim();
  if (!eid) return null;
  const bks = String(bookmakersCsv || '').trim() || (process.env.ODDSAPIO_BOOKMAKERS || 'Pinnacle');
  const r = await oddsApiIoGet(
    `https://api.odds-api.io/v3/odds?apiKey=${encodeURIComponent(ODDS_API_IO_KEY)}&eventId=${encodeURIComponent(eid)}&bookmakers=${encodeURIComponent(bks)}`,
    2 * 60 * 1000
  );
  if (!r || r.status !== 200) return null;
  const obj = safeParse(r.body, null);
  return obj && typeof obj === 'object' ? obj : null;
}

function isWtaTennisOddsKey(k) {
  return /(^|_)wta(_|$)/i.test(String(k));
}

/** Chaves tennis_* (ATP + WTA). Com all=true a API devolve torneios fora de temporada — WTA deixa de sumir. */
async function fetchTheOddsTennisSportKeys() {
  if (!THE_ODDS_API_KEY) return [];
  const useAll = (process.env.TENNIS_ODDS_SPORTS_ALL ?? 'true') !== 'false';
  const q = useAll ? `apiKey=${THE_ODDS_API_KEY}&all=true` : `apiKey=${THE_ODDS_API_KEY}`;
  const sportsR = await theOddsGet(`https://api.the-odds-api.com/v4/sports/?${q}`);
  const allSports = safeParse(sportsR.body, []);
  const tennisSports = allSports.filter(s => s && typeof s.key === 'string' && s.key.startsWith('tennis_'));
  tennisSports.sort((a, b) => {
    const ai = a.active === false ? 1 : 0;
    const bi = b.active === false ? 1 : 0;
    if (ai !== bi) return ai - bi;
    return String(a.key).localeCompare(String(b.key));
  });
  return tennisSports.map(s => s.key);
}

/** Prioriza WTA (mínimo configurável) e completa com ATP em round-robin. */
function pickBalancedTennisKeys(tennisKeys, maxKeys) {
  const wtaKeys = tennisKeys.filter(isWtaTennisOddsKey);
  const atpKeys = tennisKeys.filter(k => !isWtaTennisOddsKey(k));
  const cap = Math.min(Math.max(2, maxKeys || 10), tennisKeys.length);
  const minWtaCfg = parseInt(process.env.TENNIS_MIN_WTA_KEYS || '5', 10);
  const minWta = Math.min(Math.max(0, Number.isFinite(minWtaCfg) ? minWtaCfg : 5), wtaKeys.length, cap);
  const allowedKeys = [];
  let wi = 0;
  let ai = 0;
  for (; wi < minWta; wi++) allowedKeys.push(wtaKeys[wi]);
  while (allowedKeys.length < cap && (ai < atpKeys.length || wi < wtaKeys.length)) {
    if (ai < atpKeys.length) allowedKeys.push(atpKeys[ai++]);
    if (allowedKeys.length >= cap) break;
    if (wi < wtaKeys.length) allowedKeys.push(wtaKeys[wi++]);
  }
  return { allowedKeys, wtaKeys, atpKeys };
}

// Torneios ordenados por prioridade:
// Lote 1 → T1 (LCS/LEC/LCK)
// Lote 2 → EU secundárias (Prime League, HLL, Road of Legends)
// Lote 3 → mais EU (LIT, Finnish, EMEA Masters)
// Lote 4 → CBLOL, NACL, LPL
// Lote 5 → LCK CL, LCP, outros
// Lote 6 → EWC e regionais restantes
const LOL_ACTIVE_TIDS = [
  // Lote 1 — T1
  2450,  // LCS
  2452,  // LEC
  2454,  // LCK
  // Lote 2 — EU secundárias prioritárias
  33814, // Prime League Pro Division (Alemanha)
  45623, // Hellenic Legends League (Grécia)
  45985, // Road of Legends (Portugal)
  // Lote 3 — mais EU
  50586, // LIT / LES (Itália / Espanha)
  50242, // Finnish Pro League (Finlândia)
  26590, // EMEA Masters
  // Lote 4 — América/Ásia
  26698, // CBLOL (Brasil)
  39009, // NACL
  46121, // LPL (China) 2026 — confirmado ativo (ex-39985 era temporada antiga, retornava 0 fixtures LPL)
  // Lote 5 — secundárias Ásia/Pacífico
  36997, // LCK CL
  45589, // LCP (APAC)
  46117, // LRN
  // Lote 6 — regionais restantes
  46119, // LRS
  47864, // Esports World Cup
  39997, // LPL 2026 alternativo (candidato — cobre WeiboGaming/NIP se em split diferente)
  40019, // LPL 2026 alternativo (candidato — idem)
];

// Lista completa de todos os torneios de LoL conhecidos (fallback abrangente)
const LOL_ALL_TIDS = [
  2450, 2452, 2454, 2527, 2549,
  15488, 15490, 20918, 21962, 25019,
  26590, 26698, 26706, 26708, 27372, 28520, 29023, 31835,
  33678, 33680, 33814, 34012, 34018, 34020, 34460, 34466, 34676, 34678,
  36889, 36997, 39009, 39985, 39997, 40019,
  42873, 42997, 43193, 44181, 44639, 44641, 44643, 44645, 44647, 44659, 44673, 44903,
  45081, 45337, 45397, 45589, 45617, 45619, 45621, 45623, 45855, 45985,
  46117, 46119, 46121, 46331, 47864, 48993,
  50242, 50586, 50756, 50952, 50972,
];

// Busca tournament IDs dinamicamente via API; fallback para lista hardcoded
async function getEsportsTournamentIds() {
  const now = Date.now();
  if (cachedEsportsTids && (now - cachedEsportsTidsTs) < TOURNAMENT_CACHE_TTL) {
    return cachedEsportsTids;
  }

  // sportId=18 é o valor real do LoL na OddsPapi (confirmado pela resposta da API)
  const sid = parseInt(process.env.ODDSPAPI_ESPORTS_SPORT_ID || '18');
  try {
    const url = `https://api.oddspapi.io/v4/tournaments?sportId=${sid}&apiKey=${ODDSPAPI_KEY}`;
    const r = await oddsPapiQueue.enqueue(`oddspapi:tournaments:${sid}`, async () => {
      const ttlMsRaw = parseInt(process.env.HTTP_CACHE_ODDSPAPI_TOURNAMENTS_TTL_MS || '', 10);
      const ttlMs = Number.isFinite(ttlMsRaw) ? ttlMsRaw : TOURNAMENT_CACHE_TTL;
      return await cachedHttpGet(url, { provider: 'oddspapi', ttlMs }).catch(() => null);
    });
    if (r && r.status === 200) {
      const data = safeParse(r.body, null);
      const list = data ? (Array.isArray(data) ? data : (Array.isArray(data.data) ? data.data : [])) : [];
      const ids = list
        .filter(t => (t.futureFixtures || 0) + (t.upcomingFixtures || 0) + (t.liveFixtures || 0) > 0)
        .map(t => t.tournamentId || t.id).filter(Boolean);
      if (ids.length) {
        log('INFO', 'ODDS', `Torneios ativos via sportId=${sid}: ${ids.length}`);
        cachedEsportsTids = ids;
        cachedEsportsTidsTs = now;
        return cachedEsportsTids;
      }
    }
  } catch(_) {}

  // Fallback: usa lista de torneios ativos verificada
  log('INFO', 'ODDS', `Usando lista hardcoded: ${LOL_ACTIVE_TIDS.length} torneios ativos`);
  cachedEsportsTids = LOL_ACTIVE_TIDS;
  cachedEsportsTidsTs = now;
  return LOL_ACTIVE_TIDS;
}

// Extrai price de um outcome seguindo estrutura: outcome.price OU outcome.players[key].price
function extractPrice(outcome) {
  if (!outcome) return null;
  const p = parseFloat(outcome.price);
  if (!isNaN(p) && p > 1) return p;
  const players = outcome.players || {};
  for (const playerData of Object.values(players)) {
    const pp = parseFloat(playerData?.price);
    if (!isNaN(pp) && pp > 1) return pp;
  }
  return null;
}

// Normaliza a resposta da OddsPapi em array plano de fixtures
// Cobre: array plano, { data: [...] }, e agrupado por torneio { tournamentId, fixtures: [...] }
function normalizeFixtures(raw) {
  if (!raw) return [];
  let list = Array.isArray(raw) ? raw : (Array.isArray(raw.data) ? raw.data : []);
  // Se cada item tem .fixtures = agrupado por torneio
  if (list.length > 0 && list[0]?.fixtures) {
    return list.flatMap(t => t.fixtures || []);
  }
  return list;
}

/** Incorpora fixtures OddsPapi ao oddsCache (merge — não apaga chaves antigas). */
function ingestEsportsFixtures(allFixtures) {
  let cachedCount = 0;
  for (const f of allFixtures) {
    if (!f.bookmakerOdds) continue;

    const bkData = f.bookmakerOdds['1xbet'] || f.bookmakerOdds['1xBet']
      || Object.values(f.bookmakerOdds)[0];
    if (!bkData || !bkData.bookmakerIsActive) continue;

    let p1Name = f.participant1Name || f.homeName || '';
    let p2Name = f.participant2Name || f.awayName || '';
    let combinedSlug = '';

    if (!p1Name || !p2Name) {
      const fixturePath = bkData.fixturePath || '';
      if (fixturePath) {
        const lastSeg = fixturePath.split('/').pop() || '';
        const bkFid = bkData.bookmakerFixtureId || '';
        const teamsSlug = bkFid
          ? lastSeg.replace(new RegExp(`^${bkFid}-`), '')
          : lastSeg.replace(/^\d+-/, '');
        if (teamsSlug) {
          combinedSlug = teamsSlug;
          const parts = teamsSlug.split('-');
          if (parts.length >= 2) {
            const mid = Math.ceil(parts.length / 2);
            p1Name = parts.slice(0, mid).join('-');
            p2Name = parts.slice(mid).join('-');
          }
        }
      }
    }

    if (!combinedSlug && p1Name && p2Name) {
      combinedSlug = `${p1Name}-${p2Name}`;
    }

    if (!combinedSlug && !p1Name) continue;

    const markets = bkData.markets || {};
    const validMarkets = Object.entries(markets)
      .map(([mid, mData]) => {
        const outcomes = Object.values(mData.outcomes || {});
        if (outcomes.length !== 1) return null;
        const price = extractPrice(outcomes[0]);
        if (!price) return null;
        return { marketId: parseInt(mid) || 0, price };
      })
      .filter(Boolean)
      .sort((a, b) => a.marketId - b.marketId);

    if (validMarkets.length < 2) continue;

    const price1 = validMarkets[0].price;
    const price2 = validMarkets[1].price;

    const key = `esports_${f.fixtureId || norm(combinedSlug)}`;
    oddsCache[key] = {
      t1: price1.toFixed(2),
      t2: price2.toFixed(2),
      bookmaker: '1xBet',
      t1Name: p1Name || combinedSlug,
      t2Name: p2Name || '',
      combinedSlug: norm(combinedSlug),
      fixtureId: f.fixtureId || null,
      tournamentId: f.tournamentId || null,
    };
    log('DEBUG', 'ODDS', `Ingest: slug="${norm(combinedSlug)}" t1="${p1Name}" t2="${p2Name}" fid=${f.fixtureId||'?'}`);
    cachedCount++;
  }
  return cachedCount;
}

async function fetchEsportsOddsOneBatch(batch, batchIndex0, totalBatches) {
  log('INFO', 'ODDS', `Buscando odds: lote ${batchIndex0 + 1}/${totalBatches} tids=[${batch.join(',')}] (round-robin)`);

  const url = `https://api.oddspapi.io/v4/odds-by-tournaments?bookmaker=1xbet&tournamentIds=${batch.join(',')}&oddsFormat=decimal&apiKey=${ODDSPAPI_KEY}`;
  const r = await oddsPapiQueue.enqueue(`oddspapi:odds:${batch.join(',')}`, async () => {
    const ttlMsRaw = parseInt(process.env.HTTP_CACHE_ODDSPAPI_ODDS_TTL_MS || '', 10);
    const ttlMs = Number.isFinite(ttlMsRaw) ? ttlMsRaw : 0;
    return await cachedHttpGet(url, { provider: 'oddspapi', ttlMs }).catch(e => ({ status: 500, body: e.message }));
  });

  log('DEBUG', 'ODDS', `Lote ${batchIndex0 + 1}: status=${r.status} body=${(r.body || '').slice(0, 100)}`);
  lastApiResponse = `Lote ${batchIndex0 + 1}/${totalBatches}: HTTP ${r.status} | ${(r.body || '').slice(0, 150)}`;

  const now = Date.now();
  if (r.status === 429) {
    esportsBackoffUntil = now + ESPORTS_BACKOFF_TTL;
    log('WARN', 'ODDS', '429 — backoff 2h ativado');
    return { ok: false, status: 429 };
  }
  // FIXT / no fixtures: evitar re-chamar em loop (force-fetch live)
  if (r.status === 404) {
    const bodyS = String(r.body || '');
    const isNoFixtures = bodyS.includes('FIXT') || bodyS.toLowerCase().includes('no fixtures found');
    if (isNoFixtures) {
      for (const tid of batch) esportsTidNoFixturesUntil.set(tid, now + ESPORTS_NO_FIXTURES_TTL);
      log('WARN', 'ODDS', `HTTP 404 (no fixtures) — backoff ${Math.round(ESPORTS_NO_FIXTURES_TTL/60000)}min tids=[${batch.join(',')}]`);
    } else {
      log('WARN', 'ODDS', `HTTP 404 — sem atualização de odds`);
    }
    return { ok: false, status: 404 };
  }
  if (r.status !== 200) {
    log('WARN', 'ODDS', `HTTP ${r.status} — sem atualização de odds`);
    return { ok: false, status: r.status };
  }

  const raw = safeParse(r.body, null);
  const allFixtures = raw ? normalizeFixtures(raw) : [];
  log('INFO', 'ODDS', `Fixtures recebidos: ${allFixtures.length} no lote ${batchIndex0 + 1}`);

  const cachedCount = ingestEsportsFixtures(allFixtures);
  log('INFO', 'ODDS', `Sync concluído: ${cachedCount}/${allFixtures.length} fixtures com odds`);
  return { ok: true, status: 200 };
}

// ── Fetch de odds LoL via Pinnacle guest API (substitui OddsPapi travada) ──
// Pinnacle sportId=12 (E-Sports), filtra por "League of Legends" no league.name.
// Ignora mercados "(Kills)" (total kills) — só queremos match winner.
let lastPinnacleLoLUpdate = 0;

async function fetchLoLOddsFromPinnacle() {
  if (process.env.PINNACLE_LOL !== 'true') return;
  try {
    const rows = await pinnacle.fetchSportMatchOdds(12, (m) => {
      const name = String(m?.league?.name || '').toLowerCase();
      if (!name.includes('league of legends')) return false;
      // Ignora matchups de "(Kills)" — só match winner da série
      const p1 = String(m?.participants?.[0]?.name || '');
      const p2 = String(m?.participants?.[1]?.name || '');
      if (/\(kills\)/i.test(p1) || /\(kills\)/i.test(p2)) return false;
      return true;
    });

    let cached = 0, liveCount = 0;
    for (const r of rows) {
      if (!r.team1 || !r.team2 || !r.oddsT1 || !r.oddsT2) continue;
      const slug = norm(r.team1 + r.team2);
      const isLive = r.status === 'live';
      if (isLive) liveCount++;
      const key = `esports_pin_${r.id}`;
      oddsCache[key] = {
        t1: r.oddsT1.toFixed(2),
        t2: r.oddsT2.toFixed(2),
        bookmaker: 'Pinnacle',
        t1Name: r.team1,
        t2Name: r.team2,
        combinedSlug: slug,
        fixtureId: `pin_${r.id}`,
        tournamentId: r.leagueId || null,
        league: r.league,
        startTime: r.startTime,
        isLive,           // flag explícito para roteamento live vs upcoming
        source: 'pinnacle',
      };
      cached++;
    }
    lastPinnacleLoLUpdate = Date.now();
    lastEsportsOddsUpdate = Date.now(); // também atualiza o timestamp geral para /health
    log('INFO', 'ODDS', `Pinnacle LoL: ${cached} partidas cacheadas (${liveCount} live, ${cached - liveCount} upcoming)`);
  } catch (e) {
    log('ERROR', 'ODDS', `Pinnacle LoL: ${e.message}`);
  }
}

let _oddspapiMissingLogged = false;
async function fetchEsportsOdds() {
  if (!ODDSPAPI_KEY) {
    // Quando Pinnacle LoL está ativo, OddsPapi é opcional — loga uma única vez no boot.
    if (!_oddspapiMissingLogged) {
      const viaPinnacle = process.env.PINNACLE_LOL === 'true';
      log('WARN', 'ODDS', `ODDS_API_KEY ausente — ${viaPinnacle ? 'OddsPapi desabilitado (Pinnacle LoL ativo)' : 'odds esports indisponíveis'}`);
      _oddspapiMissingLogged = true;
    }
    return;
  }
  if (esportsOddsFetching) return;
  const now = Date.now();
  if (now - lastEsportsOddsUpdate < ESPORTS_ODDS_TTL) return;
  if (now < esportsBackoffUntil) {
    if (now - _oddsBackoffLogTs > 10 * 60 * 1000) {
      _oddsBackoffLogTs = now;
      log('INFO', 'ODDS', 'Em backoff — aguardando');
    }
    return;
  }

  esportsOddsFetching = true;
  lastApiResponse = 'Iniciando busca...';
  try {
    let tids = await getEsportsTournamentIds();
    log('DEBUG', 'ODDS', `getEsportsTournamentIds() retornou ${Array.isArray(tids) ? tids.length : typeof tids} IDs`);

    if (!Array.isArray(tids) || tids.length === 0) {
      log('WARN', 'ODDS', 'Lista de torneios inválida/vazia — usando LOL_ACTIVE_TIDS como fallback direto');
      tids = LOL_ACTIVE_TIDS;
      cachedEsportsTids = LOL_ACTIVE_TIDS;
    }

    const BATCH_SIZE = Math.max(1, parseInt(process.env.ODDSPAPI_BATCH_SIZE || '3') || 3);
    const batches = [];
    for (let i = 0; i < tids.length; i += BATCH_SIZE) {
      batches.push(tids.slice(i, i + BATCH_SIZE));
    }

    if (!batches.length) {
      log('WARN', 'ODDS', 'batches vazio após split — usando LOL_ACTIVE_TIDS completo');
      batches.push(LOL_ACTIVE_TIDS.slice(0, BATCH_SIZE));
    }

    const batchIndex = esportsBatchCursor % batches.length;
    esportsBatchCursor++;
    let batch = batches[batchIndex];

    if (!batch || !batch.length) {
      log('WARN', 'ODDS', `Batch[${batchIndex}] vazio — usando primeiro lote de LOL_ACTIVE_TIDS`);
      batch = LOL_ACTIVE_TIDS.slice(0, BATCH_SIZE);
    }

    const { ok } = await fetchEsportsOddsOneBatch(batch, batchIndex, batches.length);
    if (ok) {
      lastEsportsOddsUpdate = now;
      batchLastFetchedTs[batchIndex] = now;
    }
  } catch(e) {
    log('ERROR', 'ODDS', `fetchEsportsOdds: ${e.message}`);
  } finally {
    esportsOddsFetching = false;
  }
}

/** Após deploy só existia 1 lote no cache → poucos match (ex: 3/25). Opcional no Railway. */
let esportsOddsBootstrapRunning = false;
async function bootstrapEsportsOddsExtraBatches() {
  if (process.env.ODDSPAPI_BOOTSTRAP !== 'true' || !ODDSPAPI_KEY) return;
  if (esportsOddsBootstrapRunning || esportsOddsFetching) return;
  if (Date.now() < esportsBackoffUntil) {
    log('WARN', 'ODDS', 'Bootstrap odds ignorado (backoff ativo)');
    return;
  }

  esportsOddsBootstrapRunning = true;
  try {
    let tids = await getEsportsTournamentIds();
    if (!Array.isArray(tids) || tids.length === 0) tids = LOL_ACTIVE_TIDS;

    const BATCH_SIZE = Math.max(1, parseInt(process.env.ODDSPAPI_BATCH_SIZE || '3') || 3);
    const batches = [];
    for (let i = 0; i < tids.length; i += BATCH_SIZE) batches.push(tids.slice(i, i + BATCH_SIZE));
    if (batches.length <= 1) {
      log('INFO', 'ODDS', 'Bootstrap: apenas 1 lote de torneios — nada extra a buscar');
      return;
    }

    log('INFO', 'ODDS', `ODDSPAPI_BOOTSTRAP=true: buscando mais ${batches.length - 1} lote(s) para preencher cache após deploy`);

    // Gap padrão aumentado para 5s (era 2.5s) para reduzir risco de 429
    const gapMs = Math.max(2000, parseInt(process.env.ODDSPAPI_BOOTSTRAP_MS || '5000', 10) || 5000);
    for (let i = 1; i < batches.length; i++) {
      if (Date.now() < esportsBackoffUntil) {
        log('WARN', 'ODDS', 'Bootstrap interrompido (backoff)');
        break;
      }
      await new Promise(r => setTimeout(r, gapMs));
      const { ok } = await fetchEsportsOddsOneBatch(batches[i], i, batches.length);
      if (!ok) break;
    }

    esportsBatchCursor = batches.length;
    lastEsportsOddsUpdate = Date.now();
    // Marca conclusão do bootstrap — bloqueia force-refresh por BOOTSTRAP_GRACE_MS (evita 429 imediato)
    lastBootstrapCompletedTs = Date.now();
    const n = Object.keys(oddsCache).filter(k => k.startsWith('esports_')).length;
    log('INFO', 'ODDS', `Bootstrap concluído — ~${n} entradas no cache esports (grace period: ${Math.round(BOOTSTRAP_GRACE_MS/1000)}s)`);
  } catch(e) {
    log('ERROR', 'ODDS', `bootstrapEsportsOdds: ${e.message}`);
  } finally {
    esportsOddsBootstrapRunning = false;
  }
}

// ── Backoff por tournamentId sem fixtures (OddsPapi 404 FIXT) ──
const esportsTidNoFixturesUntil = new Map(); // tid -> ts
const ESPORTS_NO_FIXTURES_TTL = Math.max(10 * 60 * 1000, parseInt(process.env.ODDSPAPI_NO_FIXTURES_TTL_MS || '7200000', 10) || 7200000); // default 2h
function _isNoFixturesBlocked(tid) {
  const until = esportsTidNoFixturesUntil.get(tid);
  if (!until) return false;
  if (Date.now() >= until) { esportsTidNoFixturesUntil.delete(tid); return false; }
  return true;
}

// ── Mapeamento slug de liga → tournament ID (para force-fetch em partidas ao vivo) ──
const SLUG_TO_TID = {
  'lcs': 2450,
  'lec': 2452,
  'lck': 2454,
  'primeleague': 33814, 'prime-league': 33814, 'prime-league-pro-division': 33814,
  'hellenic_legends_league': 45623,
  'road-of-legends': 45985, 'road_of_legends': 45985, 'roadoflegends': 45985,
  'lit': 50586, 'les': 50586,
  'finnish-pro-league': 50242, 'finnish-pro-league-winter': 50242,
  'emea_masters': 26590, 'emea-masters': 26590,
  'cblol-brazil': 26698,
  'nacl': 39009,
  'lpl': 46121, 'ldl': 39985,
  'lck_challengers_league': 36997, 'lck-challengers-league': 36997, 'lck-cl': 36997,
  'lcp': 45589,
  'lrn': 46117,
  'lrs': 46119,
  'ewc': 47864, 'esports_world_cup': 47864, 'esports-world-cup': 47864,
  'gll': 45855, 'ultraliga': 45617, 'njcs': 45619, 'kjl': 45621,
  'circuito-desafiante': 26708, 'cblol-academy': 26708,
};

/** Force-fetch de odds para torneios específicos (ignora round-robin TTL). Usado para live matches. */
async function fetchEsportsOddsForTids(tids) {
  if (!ODDSPAPI_KEY || !tids || !tids.length) return;
  if (Date.now() < esportsBackoffUntil) { log('INFO', 'ODDS', 'Force-fetch ignorado (backoff ativo)'); return; }
  // Filtra tournamentIds que retornaram 404 sem fixtures recentemente
  const filtered = tids.filter(tid => !_isNoFixturesBlocked(tid));
  if (!filtered.length) {
    log('INFO', 'ODDS', `Force-fetch ignorado (no-fixtures backoff em ${tids.length} tid(s))`);
    return;
  }
  const BATCH_SIZE = Math.max(1, parseInt(process.env.ODDSPAPI_BATCH_SIZE || '3') || 3);
  const batches = [];
  for (let i = 0; i < filtered.length; i += BATCH_SIZE) batches.push(filtered.slice(i, i + BATCH_SIZE));
  log('INFO', 'ODDS', `Force-fetch live: ${filtered.length} torneio(s) em ${batches.length} lote(s)`);
  for (let i = 0; i < batches.length; i++) {
    if (Date.now() < esportsBackoffUntil) break;
    const { ok } = await fetchEsportsOddsOneBatch(batches[i], i, batches.length);
    if (!ok) break;
    if (i < batches.length - 1) await new Promise(r => setTimeout(r, 500));
  }
}

// ── Map odds (LoL por mapa) via OddsPapi fixture markets ──
async function getMapMlOddsFromFixture(t1, t2, mapNumber) {
  const nt1 = norm(t1), nt2 = norm(t2);
  if (!nt1 || !nt2) return null;

  // Matching mais robusto (usa aliases e aceita ordem invertida)
  const expandWithAliases = n => {
    const variants = new Set([n]);
    for (const [key, aliases] of Object.entries(LOL_ALIASES)) {
      if (n.includes(key) || key.includes(n)) { aliases.forEach(a => variants.add(a)); variants.add(key); }
    }
    return [...variants];
  };
  const stripSuffixes = (n) => {
    let s = String(n || '');
    const suffixes = ['gaming', 'esports', 'team', 'academy', 'club', 'gg', 'esport']; // heurístico
    let changed = true;
    while (changed) {
      changed = false;
      for (const suf of suffixes) {
        if (s.endsWith(suf) && s.length > suf.length + 3) {
          s = s.slice(0, -suf.length);
          changed = true;
        }
      }
    }
    return s;
  };
  const expandLoose = (n) => {
    const base = String(n || '');
    const stripped = stripSuffixes(base);
    const variants = new Set([base, stripped]);
    const bases = [base, stripped].filter(Boolean);
    for (const b of bases) {
      if (b.length >= 8) variants.add(b.slice(0, 8));
      if (b.length >= 10) variants.add(b.slice(0, 10));
    }
    for (const [key, aliases] of Object.entries(LOL_ALIASES)) {
      for (const b of bases) {
        if (b.includes(key) || key.includes(b)) { aliases.forEach(a => variants.add(a)); variants.add(key); }
      }
    }
    return [...variants].filter(v => v && v.length >= 3);
  };
  const variants1 = expandLoose(nt1);
  const variants2 = expandLoose(nt2);
  const anyMatch = (variants, slug) => variants.some(v => v && (slug.includes(v) || v.includes(slug)));

  const entry = Object.values(oddsCache).find(v => {
    if (!v?.fixtureId) return false;
    const cs = v.combinedSlug || '';
    return (anyMatch(variants1, cs) && anyMatch(variants2, cs));
  });
  if (!entry?.fixtureId || !ODDSPAPI_KEY) return null;

  const fixtureId = String(entry.fixtureId);
  // Primeiro tenta cache/polling direto por fixtureId + mapNumber
  const direct = await fetchMapOddsByFixtureId(fixtureId, mapNumber).catch(() => null);
  if (direct?.t1 && direct?.t2) return { ...direct, mapMarket: true };

  const fixtureCandidates = [fixtureId];
  if (fixtureId.startsWith('id') && fixtureId.length > 4) fixtureCandidates.push(fixtureId.slice(2));
  if (!fixtureId.startsWith('id') && fixtureId.length > 4) fixtureCandidates.push('id' + fixtureId);
  const uniqCandidates = [...new Set(fixtureCandidates)];

  const ttlMsRaw = parseInt(process.env.HTTP_CACHE_ODDSPAPI_FIXTURE_TTL_MS || '', 10);
  const ttlMs = Number.isFinite(ttlMsRaw) ? ttlMsRaw : 0;

  // OddsPapi v4: odds por fixture via GET /v4/odds?fixtureId=...
  // (endpoint antigo /odds-by-fixtures pode retornar 404 dependendo do plano/versão)
  let r = null;
  let fixtureJson = null;
  for (const fid of uniqCandidates) {
    // OddsPapi LoL marketIds:
    // 171 (série), 173/175/177/179/181 (map1..5)
    const n = parseInt(mapNumber, 10);
    const mapMarketId = 171 + (2 * n);
    const urls = [
      // Preferência: bookmaker alvo + mercado alvo
      `https://api.oddspapi.io/v4/odds?fixtureId=${fid}&bookmakers=1xbet&marketId=${mapMarketId}&oddsFormat=decimal&verbosity=5&apiKey=${ODDSPAPI_KEY}`,
      // Fallback: sem bookmaker filter (alguns planos/contas ignoram/limitam)
      `https://api.oddspapi.io/v4/odds?fixtureId=${fid}&marketId=${mapMarketId}&oddsFormat=decimal&verbosity=5&apiKey=${ODDSPAPI_KEY}`,
      // Último fallback: sem filtro (usa seleção local por marketId)
      `https://api.oddspapi.io/v4/odds?fixtureId=${fid}&oddsFormat=decimal&verbosity=5&apiKey=${ODDSPAPI_KEY}`,
    ];
    for (const url of urls) {
      r = await cachedHttpGet(url, { provider: 'oddspapi', ttlMs }).catch(() => null);
      if (r && r.status === 200) {
        fixtureJson = safeParse(r.body, null);
        if (fixtureJson) { r.__fixtureIdUsed = fid; break; }
      }
    }
    if (fixtureJson) break;
  }
  if (!fixtureJson) return null;

  const bkOdds = fixtureJson.bookmakerOdds || fixtureJson.bookmakersOdds || {};
  const bk = bkOdds['1xbet'] || bkOdds['1xBet'] || bkOdds['1XBET'] || null;
  const marketsObj = bk?.markets || {};
  // Alguns bookmakers retornam markets como objeto { "<marketKey>": { ... } } sem bookmakerMarketId.
  // Preserva a chave para debug e matching heurístico.
  const markets = Object.entries(marketsObj || {}).map(([k, v]) => ({ ...(v || {}), _key: String(k) }));
  if (!markets.length) return null;

  const n = parseInt(mapNumber, 10);
  if (!Number.isFinite(n) || n <= 0) return null;

  // OddsPapi LoL marketIds (blog):
  // 171 = Match Winner (série)
  // 173/175/177/179/181 = Map 1..5 Winner
  const mapMarketId = 173 + ((n - 1) * 2);
  const byMarketId = markets.find(m => {
    const mid = (m?.marketId != null) ? parseInt(m.marketId, 10) : NaN;
    const key = (m?._key != null) ? parseInt(m._key, 10) : NaN;
    return (Number.isFinite(mid) && mid === mapMarketId) || (Number.isFinite(key) && key === mapMarketId);
  });

  const mkName = (m) => (m?.bookmakerMarketId || m?.marketId || m?._key || '').toString().toLowerCase();
  const isMapMarketFor = (name, mapN) => {
    if (!name) return false;
    if (!(name.includes('map') || name.includes('game'))) return false;
    return (
      name.includes(`map${mapN}`) || name.includes(`map ${mapN}`) || name.includes(`map/${mapN}`) || name.includes(`map-${mapN}`) ||
      name.includes(`game${mapN}`) || name.includes(`game ${mapN}`) || name.includes(`game/${mapN}`) || name.includes(`game-${mapN}`) ||
      name.includes(`#${mapN}`)
    );
  };

  const candidatesExact = byMarketId ? [byMarketId] : markets.filter(m => isMapMarketFor(mkName(m), n));
  const candidatesAnyMap = markets.filter(m => {
    const name = mkName(m);
    return name.includes('map') || name.includes('game');
  });
  const candidates = candidatesExact.length ? candidatesExact : candidatesAnyMap;
  if (!candidates.length) return null;

  const scoreMarket = (m) => {
    const name = mkName(m);
    const outcomesObj = m?.outcomes || {};
    const outcomes = Object.values(outcomesObj || {});
    const has2 = outcomes.length >= 2;
    return (
      (name.includes('winner') ? 5 : 0) +
      (name.includes('moneyline') || name.includes('ml') ? 3 : 0) +
      (has2 ? 1 : 0)
    );
  };
  const scored = [...candidates].map(m => ({ m, name: mkName(m), score: scoreMarket(m) }))
    .sort((a, b) => b.score - a.score);

  const extractHomeAway = (market) => {
    const outcomesObj = market?.outcomes || {};
    const outcomes = Object.values(outcomesObj || {});
    const pickPrice = (o) => {
      const players = o?.players || o?.playerOdds || {};
      const first = players['0'] || players[0] || Object.values(players || {})[0] || null;
      return extractPrice(first || o);
    };
    const pickKey = (o) => {
      const players = o?.players || o?.playerOdds || {};
      const first = players['0'] || players[0] || Object.values(players || {})[0] || null;
      return (first?.bookmakerOutcomeId || o?.bookmakerOutcomeId || '').toString().toLowerCase();
    };
    let home = null, away = null;
    for (const o of outcomes) {
      const k = pickKey(o);
      const p = pickPrice(o);
      if (!p) continue;
      if (!home && (k.includes('home') || k === '1')) home = p;
      else if (!away && (k.includes('away') || k === '2')) away = p;
    }
    if ((!home || !away) && outcomes.length >= 2) {
      home = home || pickPrice(outcomes[0]);
      away = away || pickPrice(outcomes[1]);
    }
    return { home, away };
  };

  for (const cand of scored) {
    const { home, away } = extractHomeAway(cand.m);
    if (!home || !away) continue;
    return { t1: String(home), t2: String(away), bookmaker: '1xBet', fixtureId: (r.__fixtureIdUsed || fixtureId), market: cand.name };
  }

  return null;
}

function _parseFormatMaxWins(formatStr) {
  const f = String(formatStr || '').toLowerCase();
  const m = f.match(/bo\s*(\d+)/i) || f.match(/bestof\s*(\d+)/i) || f.match(/bo(\d+)/i);
  const n = m ? parseInt(m[1], 10) : NaN;
  if (Number.isFinite(n) && n >= 1) return Math.ceil(n / 2);
  // default conservador
  return 2; // Bo3
}

function _seriesWinProbDP(p, aWins, bWins, maxWins) {
  const memo = new Map();
  const key = (a, b) => `${a}|${b}`;
  const go = (a, b) => {
    if (a >= maxWins) return 1;
    if (b >= maxWins) return 0;
    const k = key(a, b);
    if (memo.has(k)) return memo.get(k);
    const v = p * go(a + 1, b) + (1 - p) * go(a, b + 1);
    memo.set(k, v);
    return v;
  };
  return go(aWins, bWins);
}

function _invertToMapP(targetSeriesP, aWins, bWins, maxWins) {
  const t = Math.max(0.0001, Math.min(0.9999, targetSeriesP));
  let lo = 0.0001, hi = 0.9999;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const ps = _seriesWinProbDP(mid, aWins, bWins, maxWins);
    if (ps < t) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function estimateMapMlFromSeriesOdds(baseOdds, opts) {
  const o1 = parseFloat(baseOdds?.t1);
  const o2 = parseFloat(baseOdds?.t2);
  if (!o1 || !o2 || o1 <= 1 || o2 <= 1) return null;

  const aWins = Math.max(0, parseInt(opts?.score1 ?? 0, 10) || 0);
  const bWins = Math.max(0, parseInt(opts?.score2 ?? 0, 10) || 0);
  const maxWins = Math.max(1, parseInt(opts?.maxWins ?? 2, 10) || 2);

  // Converte odds série -> prob série (de-juice simples)
  const p1i = 1 / o1;
  const p2i = 1 / o2;
  const over = p1i + p2i;
  const pSeriesT1 = over > 0 ? (p1i / over) : 0.5;

  const pMapT1 = _invertToMapP(pSeriesT1, aWins, bWins, maxWins);
  const pMapT2 = 1 - pMapT1;
  return {
    t1: String((1 / pMapT1).toFixed(2)),
    t2: String((1 / pMapT2).toFixed(2)),
    bookmaker: baseOdds?.bookmaker || '1xBet',
    mapMarket: false,
    mapEstimated: true,
    mapP: { t1: pMapT1, t2: pMapT2 },
  };
}

// ── Suporte a Apelidos/Abreviações de Times ──
const LOL_ALIASES = {
  // LCK
  'nongshimredforce': ['ns', 'nongshim', 'nsredforce'],
  'hanwhalifeesports': ['hle', 'hanwha', 'hanwhalife'],
  'dpluskia': ['dk', 'dplus', 'dwg', 'damwon'],
  'kiwoomdrx': ['drx'],
  'ktrolster': ['kt'],
  'geng': ['gen', 'gengolden', 'gengaming'],
  't1': ['skt', 'skt1'],
  'hanwhajinbrion': ['brion', 'bro', 'hanjinbrion', 'jinbrion'],
  'brochallengers': ['bro', 'brion', 'hanwhajinbrion'],
  'dnsoopers': ['dns', 'soopers'],
  'dnschallengers': ['dns', 'dnsoopers'],
  'fearx': ['fearxesports', 'fx'],
  // LCS
  'cloud9': ['c9'],
  'teamliquid': ['tl', 'liquid'],
  'flyquest': ['fly', 'fq'],
  '100thieves': ['100t'],
  'digitalsports': ['dig', 'disguised', 'dsg'],
  'dignitas': ['dig', 'digs', 'team dignitas'],
  'disguised': ['dsg', 'dig'],
  'shopifyrebellion': ['sr', 'shopify', 'rebellion'],
  'sentinels': ['sen'],
  'lyongaming': ['lg', 'lyon'],
  // LEC
  'giantsgaming': ['gnt', 'giants'],
  'teamvitality': ['vit', 'vitality'],
  'fnatic': ['fnc'],
  'rogue': ['rog'],
  'movistarkoi': ['koi', 'movistar'],
  'natusvincere': ['navi', 'nv'],
  'skgaming': ['sk'],
  'teamheretics': ['th', 'heretics'],
  'giantx': ['gx'],
  'shifters': ['skgamingshifters'],
  'madlions': ['mad'],
  'bds': ['bdsgaming', 'bdsesport'],
  'g2esports': ['g2'],
  // LPL
  'jdggaming': ['jdg', 'jd'],
  'beijingjdgesports': ['jdg', 'jdggaming', 'jd'],
  'bilibiliblaze': ['blg', 'bilibili'],
  'bilibiligaming': ['blg', 'bilibili', 'bilibiliblaze'],
  'ninerosters': ['ninerosters'],
  'weibo': ['wbg', 'weiboesports', 'weibogaming'],
  'wbgesports': ['wbg', 'weibo', 'weibogaming'],
  'weibogaming': ['wbg', 'weiboesports', 'weibo'],
  'topesports': ['tes'],
  'invictusgaming': ['ig'],
  'anyoneslegend': ['al', 'anyone'],
  'longzhutigers': ['lgt', 'longzhu'],
  'funplusphoenix': ['fpx'],
  'edwardgaming': ['edg'],
  'royalnevergiveuprng': ['rng'],
  'royalnevergiveuphighschool': ['rng'],
  'lgdesports': ['lgd'],
  'omgesports': ['omg'],
  'vici': ['vg', 'vicigaming'],
  // LPL — Riot API usa prefixo de cidade, OddsPapi não
  'xianteamwe': ['teamwe', 'we'],
  'shenzhenninjasinpyjamas': ['ninjasinpyjamas', 'nip', 'ninjas', 'nipesports'],
  'ninjasinpyjamas': ['nip', 'shenzhenninjasinpyjamas', 'ninjas'],
  // CBLOL
  'paingaming': ['png', 'pain'],
  'redcanidskalunga': ['redcanids', 'red'],
  'fluxo': ['flx'],
  'kabum': ['kbm'],
  'loud': ['lod'],
  'isurus': ['isr'],
  'vivokeydstars': ['keydstars', 'keyd', 'vivo'],
  'keydstars': ['keyd', 'vivo', 'vivokeydstars'],
  // LLA / LTA
  'losleviatanesports': ['leviatan', 'losleviatan', 'los'],
  'leviatanesports': ['leviatan', 'losleviatan'],
  // Prime League (Alemanha)
  'berlininternationalgaming': ['big', 'berlin'],
  'g2nord': ['g2n'],
  'ewieeinfachesports': ['ewe', 'ewieeinfach'],
  'vfbstuttgart': ['vfb', 'stuttgart'],
  'vfbesports': ['vfb', 'stuttgart'],
  'eintrachtfrankfurt': ['sge', 'frankfurt', 'eintracht'],
  'eintrachtspandau': ['spandau', 'efs'],
  'kauflandhangryknights': ['hk', 'hangryknights'],
  'unicornsoflovesexyedition': ['uol', 'unicorns', 'unicornsoflove'],
  'rossmanncentaurs': ['centaurs', 'rossmann'],
  'teamorangegaming': ['tog', 'orange'],
  // Hellenic Legends League (Grécia)
  'goalesports': ['goal'],
  'theparadox': ['paradox'],
  // LoL Italian Tournament
  'gmblersesports': ['gmblers', 'gmb'],
  'aeternaesports': ['aeterna'],
  'colossalgaming': ['colossal', 'clg'],
  'zenaesports': ['zena'],
  'ekoesports': ['eko'],
  'stonehengeesports': ['stonehenge', 'shg'],
  'hmble': ['humble'],
  // Road of Legends (Portugal)
  'senshiesports': ['senshi'],
  'senshiesportsclub': ['senshi'],
  'fritesesportsclub': ['frites'],
  'mythesports': ['myth'],
  'onceuponateam': ['ouat'],
  // NACL
  'ccgesports': ['ccg', 'ccgesport'],
  'supernova': ['snv', 'supernovaesports', 'supernovagg'],
  'doradogaming': ['dorado'],
  'nrgesports': ['nrg'],
  'citadelgaming': ['citadel'],
  // LCP
  'relovedeepcrossgaming': ['deepcrossgaming', 'deepcross'],
  'groundzerogaming': ['gzg', 'gz'],
  'detonationfocusme': ['dfm'],
};

function findOdds(sport, t1, t2) {
  const nt1 = norm(t1), nt2 = norm(t2);
  if (!nt1 || !nt2) return null;

  // Expande um nome normalizado com seus aliases conhecidos
  const expandWithAliases = (n) => {
    const variants = new Set([n]);
    // Heurística: remove sufixos comuns (ex: "teamorangegaming" → "teamorange")
    const stripSuffixes = (raw) => {
      let s = String(raw || '');
      const suffixes = ['gaming', 'esports', 'team', 'academy', 'club', 'gg', 'esport'];
      let changed = true;
      while (changed) {
        changed = false;
        for (const suf of suffixes) {
          if (s.endsWith(suf) && s.length > suf.length + 3) {
            s = s.slice(0, -suf.length);
            changed = true;
          }
        }
      }
      return s;
    };
    const stripped = stripSuffixes(n);
    if (stripped && stripped !== n) variants.add(stripped);
    // Prefixos curtos para cobrir abreviações sem tabela (ex: "teamorange" vs "teamorangegaming")
    for (const v of [n, stripped]) {
      if (v && v.length >= 8) variants.add(v.slice(0, 8));
      if (v && v.length >= 10) variants.add(v.slice(0, 10));
    }
    for (const [key, aliases] of Object.entries(LOL_ALIASES)) {
      if (n.includes(key) || key.includes(n) || aliases.includes(n)) {
        aliases.forEach(a => variants.add(a));
        variants.add(key);
      }
    }
    return variants;
  };

  const variants1 = expandWithAliases(nt1);
  const variants2 = expandWithAliases(nt2);

  // Verifica se alguma variante do nome está contida no slug alvo
  const anyMatch = (variants, targetSlug) =>
    [...variants].some(v => v.length >= 2 && targetSlug.includes(v));

  // Ordena entries: live primeiro (para priorizar odds live quando houver), depois upcoming
  const entries = Object.entries(oddsCache)
    .filter(([k]) => k.startsWith(`${sport}_`))
    .sort(([, a], [, b]) => {
      const al = a?.isLive ? 1 : 0;
      const bl = b?.isLive ? 1 : 0;
      return bl - al; // true antes de false
    });
  for (const [cacheKey, val] of entries) {

    // ── Modo 1: combinedSlug (formato OddsPapi — sem nomes separados) ──
    if (val.combinedSlug) {
      const cs = val.combinedSlug;
      // Se tivermos t1Name/t2Name, tenta preservar ordem correta (evita odds invertida)
      if (val.t1Name && val.t2Name) {
        const vt1 = norm(val.t1Name);
        const vt2 = norm(val.t2Name);
        if (anyMatch(variants1, vt1) && anyMatch(variants2, vt2)) {
          return { t1: val.t1, t2: val.t2, bookmaker: val.bookmaker };
        }
        if (anyMatch(variants1, vt2) && anyMatch(variants2, vt1)) {
          return { t1: val.t2, t2: val.t1, bookmaker: val.bookmaker };
        }
      }
      // Se slug carrega ordem (concat), usa a posição do primeiro match para decidir swap
      const firstIdx = (variants, target) => {
        let best = Infinity;
        for (const v of variants) {
          if (!v || v.length < 2) continue;
          const idx = target.indexOf(v);
          if (idx >= 0 && idx < best) best = idx;
        }
        return best;
      };
      const i1 = firstIdx(variants1, cs);
      const i2 = firstIdx(variants2, cs);
      if (i1 !== Infinity && i2 !== Infinity && i1 !== i2) {
        // cs: "...<teamA>...<teamB>..." ⇒ t1=teamA, t2=teamB
        if (i1 < i2) return { t1: val.t1, t2: val.t2, bookmaker: val.bookmaker };
        return { t1: val.t2, t2: val.t1, bookmaker: val.bookmaker };
      }
      // Fallback: match sem garantia de ordem
      if (anyMatch(variants1, cs) && anyMatch(variants2, cs)) {
        return { t1: val.t1, t2: val.t2, bookmaker: val.bookmaker };
      }
      continue;
    }

    // ── Modo 2: nomes individuais (formato legado) ──
    if (!val.t1Name || !val.t2Name) continue;
    const vt1 = norm(val.t1Name);
    const vt2 = norm(val.t2Name);

    if (anyMatch(variants1, vt1) && anyMatch(variants2, vt2)) {
      return { t1: val.t1, t2: val.t2, bookmaker: val.bookmaker };
    }
    // Ordem invertida
    if (anyMatch(variants1, vt2) && anyMatch(variants2, vt1)) {
      return { t1: val.t2, t2: val.t1, bookmaker: val.bookmaker };
    }
  }
  return null;
}

// ── LoL Matches ──
function mapLoLEvent(e, status) {
  const t1 = e.match?.teams?.[0], t2 = e.match?.teams?.[1];
  const n1 = t1?.name || t1?.code || '', n2 = t2?.name || t2?.code || '';
  if (!n1 && !n2) return null;
  const slug = e.league?.slug || '';
  if (!LOL_LEAGUES.has(slug)) {
    // Loga slug desconhecido uma vez para facilitar diagnóstico
    if (slug && !unknownLolSlugs.has(slug)) {
      unknownLolSlugs.add(slug);
      log('WARN', 'LOL-SLUG', `Liga ignorada: slug="${slug}" nome="${e.league?.name || ''}" — adicione ao LOL_EXTRA_LEAGUES no .env se quiser cobrir`);
    }
    return null;
  }

  return {
    id: e.match?.id || Date.now().toString(),
    game: 'lol',
    league: e.league?.name || 'LoL Esports',
    leagueSlug: slug,
    team1: n1 || 'TBD',
    team2: n2 || 'TBD',
    score1: t1?.result?.gameWins ?? 0,
    score2: t2?.result?.gameWins ?? 0,
    status,
    time: e.startTime || '',
    format: e.match?.strategy?.type === 'bestOf' ? 'Bo' + e.match.strategy.count : '',
    winner: t1?.result?.outcome === 'win' ? n1 : t2?.result?.outcome === 'win' ? n2 : null
  };
}

async function getLoLMatchesArush() {
  // Fonte "lolesports-live": getSchedule + getLive (en-US e zh-CN para cobrir LPL)
  try {
    // Busca schedule e getLive em paralelo
    const [srResult, glrResult, glrCNResult] = await Promise.allSettled([
      httpGet(LOL_BASE + '/getSchedule?hl=en-US', LOL_HEADERS),
      httpGet(LOL_BASE + '/getLive?hl=en-US', LOL_HEADERS),
      httpGet(LOL_BASE + '/getLive?hl=zh-CN', LOL_HEADERS),
    ]);

    const evs = srResult.status === 'fulfilled'
      ? (safeParse(srResult.value?.body, {})?.data?.schedule?.events || [])
      : [];
    if (!Array.isArray(evs) || evs.length === 0) return [];

    // Live do schedule (state=inProgress)
    const liveMap = new Map();
    evs.filter(e => e.type === 'match' && e.match && e.state === 'inProgress')
      .map(e => mapLoLEvent(e, 'live')).filter(Boolean)
      .forEach(m => liveMap.set(String(m.id), m));

    // Fallback: Riot marca matches LPL como state=completed prematuramente
    // enquanto games ainda estão em progresso. Só promove se startTime já passou
    // (>=2min) e nenhum time atingiu winsNeeded nem tem outcome=win.
    const _nowArush = Date.now();
    evs.filter(e => {
      if (e.type !== 'match' || !e.match || e.state !== 'completed') return false;
      const t1 = e.match.teams?.[0], t2 = e.match.teams?.[1];
      if (t1?.result?.outcome === 'win' || t2?.result?.outcome === 'win') return false;
      const w1 = t1?.result?.gameWins || 0, w2 = t2?.result?.gameWins || 0;
      const boCount = e.match.strategy?.count || 3;
      const winsNeeded = Math.ceil(boCount / 2);
      if (w1 >= winsNeeded || w2 >= winsNeeded) return false;
      const startTs = e.startTime ? Date.parse(e.startTime) : NaN;
      if (!Number.isFinite(startTs)) return false;
      const elapsedMin = (_nowArush - startTs) / 60000;
      return elapsedMin >= 2 && elapsedMin < 300;
    }).map(e => mapLoLEvent(e, 'live')).filter(Boolean)
      .forEach(m => { if (!liveMap.has(String(m.id))) liveMap.set(String(m.id), m); });

    // Merge getLive en-US — captura partidas live não refletidas no schedule ainda
    if (glrResult.status === 'fulfilled') {
      const glEvts = safeParse(glrResult.value?.body, {})?.data?.schedule?.events || [];
      glEvts.filter(e => e.type === 'match' && e.match)
        .map(e => mapLoLEvent(e, 'live')).filter(Boolean)
        .forEach(m => { if (!liveMap.has(String(m.id))) liveMap.set(String(m.id), m); });
    }

    // Merge getLive zh-CN — LPL frequentemente só aparece aqui
    if (glrCNResult.status === 'fulfilled') {
      const glCNEvts = safeParse(glrCNResult.value?.body, {})?.data?.schedule?.events || [];
      glCNEvts.filter(e => e.type === 'match' && e.match)
        .map(e => mapLoLEvent(e, 'live')).filter(Boolean)
        .forEach(m => { if (!liveMap.has(String(m.id))) liveMap.set(String(m.id), m); });
    }

    const live = [...liveMap.values()];
    const liveIds = new Set(live.map(m => String(m.id)));

    const upcoming = evs
      .filter(e => e.type === 'match' && e.match && e.state === 'unstarted' && !liveIds.has(String(e.match?.id)))
      .map(e => mapLoLEvent(e, 'upcoming')).filter(Boolean);

    const combined = [...live, ...upcoming]
      .filter((m, i, a) => m && !(m.team1 === 'TBD' && m.team2 === 'TBD') && a.findIndex(x => x.id === m.id) === i)
      .sort((a, b) => {
        if (a.status === 'live' && b.status !== 'live') return -1;
        if (b.status === 'live' && a.status !== 'live') return 1;
        return new Date(a.time) - new Date(b.time);
      })
      .slice(0, 25);

    await fetchOdds('esports');
    combined.forEach(m => {
      const o = findOdds('esports', m.team1, m.team2);
      if (o) m.odds = o;
    });
    return combined;
  } catch(_) {
    return [];
  }
}

async function getLoLMatches() {
  try {
    let live = [], upcoming = [];
    let mainEvs = [], newerToken = null;

    // ── 1. getLive primeiro — fonte mais confiável para matches ao vivo (especialmente LPL) ──
    const liveLeagues = new Set();
    try {
      const glr = await httpGet(LOL_BASE + '/getLive?hl=en-US', LOL_HEADERS);
      const gld = safeParse(glr.body, {});
      const getLiveEvts = gld?.data?.schedule?.events || [];
      // Log bruto de TODOS os eventos do getLive para diagnóstico
      log('DEBUG', 'LOL', `getLive raw: ${getLiveEvts.length} eventos | ${getLiveEvts.map(e => `[${e.type}|${e.state}|${e.league?.slug}]`).join(' ')}`);
      getLiveEvts.filter(e => e.type === 'match' && e.match)
        .map(e => mapLoLEvent(e, 'live')).filter(Boolean)
        .forEach(m => { if (!live.find(l => l.id === m.id)) live.push(m); });
      getLiveEvts.filter(e => e.type === 'show' && e.state === 'inProgress')
        .forEach(e => { if (e.league?.name) liveLeagues.add(e.league.name); });
    } catch(e) { log('WARN', 'LOL', 'getLive err: ' + e.message); }

    // ── 1b. Também busca getLive com hl=zh-CN (LPL às vezes só aparece com locale chinês) ──
    try {
      const glrCN = await httpGet(LOL_BASE + '/getLive?hl=zh-CN', LOL_HEADERS);
      const gldCN = safeParse(glrCN.body, {});
      const getLiveCN = gldCN?.data?.schedule?.events || [];
      if (getLiveCN.length) {
        log('DEBUG', 'LOL', `getLive zh-CN raw: ${getLiveCN.length} eventos | ${getLiveCN.map(e => `[${e.type}|${e.state}|${e.league?.slug}]`).join(' ')}`);
        getLiveCN.filter(e => e.type === 'match' && e.match)
          .map(e => mapLoLEvent(e, 'live')).filter(Boolean)
          .forEach(m => { if (!live.find(l => l.id === m.id)) live.push(m); });
        getLiveCN.filter(e => e.type === 'show' && e.state === 'inProgress')
          .forEach(e => { if (e.league?.name) liveLeagues.add(e.league.name); });
      }
    } catch(e) { log('WARN', 'LOL', 'getLive zh-CN err: ' + e.message); }

    // ── 2. getSchedule — schedule completo ──
    try {
      const sr = await httpGet(LOL_BASE + '/getSchedule?hl=en-US', LOL_HEADERS);
      const sd = safeParse(sr.body, {});
      mainEvs = sd?.data?.schedule?.events || [];
      newerToken = sd?.data?.schedule?.pages?.newer;
    } catch(e) { log('WARN', 'LOL', 'Schedule err: ' + e.message); }

    // Log dos eventos LPL no schedule para diagnóstico
    const lplEvs = mainEvs.filter(e => e.league?.slug === 'lpl');
    if (lplEvs.length) log('DEBUG', 'LOL', `LPL no schedule: ${lplEvs.map(e => `[${e.type}|${e.state}|${e.match?.teams?.map(t=>t.code||t.name).join('v')||''}]`).join(' ')}`);
    else log('DEBUG', 'LOL', 'LPL no schedule: nenhum evento encontrado');

    // Adiciona liveLeagues do schedule (shows em progresso)
    mainEvs.filter(e => e.type === 'show' && e.state === 'inProgress' && LOL_LEAGUES.has(e.league?.slug))
      .forEach(e => { if (e.league?.name) liveLeagues.add(e.league.name); });

    // Matches explicitamente inProgress no schedule
    mainEvs.filter(e => e.type === 'match' && e.match && e.state === 'inProgress')
      .map(e => mapLoLEvent(e, 'live')).filter(Boolean)
      .forEach(m => { if (!live.find(l => l.id === m.id)) live.push(m); });

    // Fallback LPL: Riot marca state=completed prematuramente. Só promove se
    // startTime já passou (>=2min) e ninguém ainda ganhou a série.
    const _nowFbk = Date.now();
    mainEvs.filter(e => {
      if (e.type !== 'match' || !e.match || e.state !== 'completed') return false;
      const t1 = e.match.teams?.[0], t2 = e.match.teams?.[1];
      if (t1?.result?.outcome === 'win' || t2?.result?.outcome === 'win') return false;
      const w1 = t1?.result?.gameWins || 0, w2 = t2?.result?.gameWins || 0;
      const boCount = e.match.strategy?.count || 3;
      const winsNeeded = Math.ceil(boCount / 2);
      if (w1 >= winsNeeded || w2 >= winsNeeded) return false;
      const startTs = e.startTime ? Date.parse(e.startTime) : NaN;
      if (!Number.isFinite(startTs)) return false;
      const elapsedMin = (_nowFbk - startTs) / 60000;
      return elapsedMin >= 2 && elapsedMin < 300;
    }).map(e => mapLoLEvent(e, 'live')).filter(Boolean)
      .forEach(m => { if (!live.find(l => l.id === m.id)) live.push(m); });

    // Matches com score parcial em ligas com transmissão ao vivo = LIVE
    const now = Date.now();
    const liveFromShows = mainEvs.filter(e => {
      if (e.type !== 'match' || !e.match || e.state !== 'unstarted') return false;
      if (!liveLeagues.has(e.league?.name)) return false;
      const t1 = e.match.teams?.[0], t2 = e.match.teams?.[1];
      const w1 = t1?.result?.gameWins || 0, w2 = t2?.result?.gameWins || 0;
      // Detecta live: tem score OU startTime já passou (jogo começou mas score ainda 0-0)
      const startedAgo = e.startTime ? (now - new Date(e.startTime).getTime()) / 60000 : -1;
      const hasScore = w1 > 0 || w2 > 0;
      const timeStarted = startedAgo > 2 && startedAgo < 300; // entre 2min e 5h atrás
      if (!hasScore && !timeStarted) return false;
      const boCount = e.match.strategy?.count || 3;
      const winsNeeded = Math.ceil(boCount / 2);
      return !(w1 >= winsNeeded || w2 >= winsNeeded);
    }).map(e => mapLoLEvent(e, 'live')).filter(Boolean);
    liveFromShows.forEach(m => { if (!live.find(l => l.id === m.id)) live.push(m); });

    // Matches sem score dentro de transmissão ao vivo = draft
    const upcomingInShow = mainEvs.filter(e => {
      if (e.type !== 'match' || !e.match || e.state !== 'unstarted') return false;
      if (!liveLeagues.has(e.league?.name)) return false;
      const startedAgo = e.startTime ? (now - new Date(e.startTime).getTime()) / 60000 : -1;
      if (startedAgo > 2) return false; // já deveria ter começado — não é draft
      const t1 = e.match.teams?.[0], t2 = e.match.teams?.[1];
      return (t1?.result?.gameWins || 0) === 0 && (t2?.result?.gameWins || 0) === 0;
    }).map(e => mapLoLEvent(e, 'draft')).filter(Boolean);

    upcoming = mainEvs.filter(e =>
      e.type === 'match' && e.match && e.state === 'unstarted' && !liveLeagues.has(e.league?.name)
    ).map(e => mapLoLEvent(e, 'upcoming')).filter(Boolean);
    upcoming = [...upcomingInShow, ...upcoming];

    if (!upcoming.length && newerToken) {
      try {
        const nr = await httpGet(LOL_BASE + '/getSchedule?hl=en-US&pageToken=' + encodeURIComponent(newerToken), LOL_HEADERS);
        const nd = safeParse(nr.body, {});
        upcoming = (nd?.data?.schedule?.events || [])
          .filter(e => e.type === 'match' && e.match && e.state !== 'completed')
          .map(e => mapLoLEvent(e, 'upcoming')).filter(Boolean);
      } catch(_) {}
    }

    const result = [...live, ...upcoming]
      .filter((m, i, a) => m && !(m.team1 === 'TBD' && m.team2 === 'TBD') && a.findIndex(x => x.id === m.id) === i)
      .sort((a, b) => {
        if (a.status === 'live' && b.status !== 'live') return -1;
        if (b.status === 'live' && a.status !== 'live') return 1;
        if (a.status === 'draft' && b.status !== 'draft') return -1;
        if (b.status === 'draft' && a.status !== 'draft') return 1;
        return new Date(a.time) - new Date(b.time);
      })
      .slice(0, 25);

    await fetchOdds('esports');
    let oddsFound = 0;
    result.forEach(m => {
      const o = findOdds('esports', m.team1, m.team2);
      if (o) { m.odds = o; oddsFound++; }
    });

    // Force-fetch odds para partidas ao vivo / draft sem odds (ignora round-robin TTL)
    const liveNoOdds = result.filter(m => (m.status === 'live' || m.status === 'draft') && !m.odds);
    if (liveNoOdds.length > 0) {
      const tidsToFetch = new Set();
      for (const m of liveNoOdds) {
        // Tenta pelo slug da liga
        const tid = SLUG_TO_TID[m.leagueSlug];
        if (tid) tidsToFetch.add(tid);
        // Tenta pelo tournamentId já no cache (para partidas conhecidas)
        for (const v of Object.values(oddsCache)) {
          if (v.tournamentId && v.combinedSlug && (
            v.combinedSlug.includes(norm(m.team1)) || v.combinedSlug.includes(norm(m.team2))
          )) tidsToFetch.add(v.tournamentId);
        }
      }
      if (tidsToFetch.size > 0) {
        await fetchEsportsOddsForTids([...tidsToFetch]);
        liveNoOdds.forEach(m => {
          if (m.odds) return;
          const o = findOdds('esports', m.team1, m.team2);
          if (o) { m.odds = o; oddsFound++; }
        });
      }
    }

    const noOdds = result.filter(m => !m.odds).map(m => `${norm(m.team1)}v${norm(m.team2)}`);
    log('INFO', 'LOL', `${result.length} partidas (${live.length} live, ${upcoming.filter(m=>m.status==='draft').length} draft) | odds: ${oddsFound}/${result.length}${noOdds.length ? ` | sem match: ${noOdds.slice(0,3).join(', ')}` : ''}`);
    return result;
  } catch(e) {
    log('ERROR', 'LOL', e.message);
    return [];
  }
}

// ── PandaScore LoL (cobre torneios fora do lolesports.com, ex: EWC Qualifier China) ──
let _pandaBackoffUntil = 0;
let _pandaLast429LogTs = 0;
let _pandaCache = { data: [], ts: 0 };
const PANDA_CACHE_TTL = parseInt(process.env.PANDA_CACHE_TTL_MS || '60000', 10); // 60s default
async function getPandaScoreLolMatches() {
  if (!PANDASCORE_TOKEN || PANDASCORE_TOKEN === 'your-pandascore-token') return [];
  if (Date.now() < _pandaBackoffUntil) return [];
  // Cache TTL: evita chamar PandaScore em cada /lol-matches (chamado ~1/min pelo bot)
  if (_pandaCache.data.length && (Date.now() - _pandaCache.ts) < PANDA_CACHE_TTL) return _pandaCache.data;
  try {
    const headers = { 'Authorization': `Bearer ${PANDASCORE_TOKEN}` };
    const [runningRaw, upcomingRaw] = await Promise.all([
      httpGet('https://api.pandascore.co/lol/matches/running?per_page=20', headers).catch(() => ({ status: 0, body: '[]' })),
      httpGet('https://api.pandascore.co/lol/matches/upcoming?per_page=30&sort=begin_at', headers).catch(() => ({ status: 0, body: '[]' }))
    ]);

    function psMatchList(raw, fallbackLabel) {
      const status = raw?.status;
      const body = raw?.body;
      const p = safeParse(body, []);
      if (Array.isArray(p)) return p;

      if (p && typeof p === 'object') {
        const keys = Object.keys(p);
        const errMsg = (p?.error && (p.error.message || p.error)) || p?.message || '';
        if (keys.includes('error') || errMsg) {
          const msg = String(errMsg || '');
          const is429 = status === 429 || msg.toLowerCase().includes('too many') || String(body || '').toLowerCase().includes('too many requests');
          if (is429) {
            const ttl = Math.max(60 * 1000, parseInt(process.env.PANDASCORE_BACKOFF_MS || '900000', 10) || 900000); // default 15min
            _pandaBackoffUntil = Date.now() + ttl;
            const now = Date.now();
            if (now - _pandaLast429LogTs > 60 * 1000) {
              _pandaLast429LogTs = now;
              log('WARN', 'PANDASCORE', `${fallbackLabel}: 429 — backoff ${Math.round(ttl/60000)}min | msg=${msg.slice(0, 120) || '-'} body=${String(body || '').slice(0, 180)}`);
            }
          } else {
            log('WARN', 'PANDASCORE', `${fallbackLabel}: erro status=${status || '-'} msg=${msg.slice(0, 180) || '-'} body=${String(body || '').slice(0, 220)}`);
          }
          return [];
        }

        const direct =
          (Array.isArray(p.data) && p.data) ||
          (Array.isArray(p.results) && p.results) ||
          (Array.isArray(p.matches) && p.matches);
        if (direct) {
          log('INFO', 'PANDASCORE', `${fallbackLabel}: formato objeto detectado; chaves=${keys.join(',')}`);
          return direct;
        }

        // Alguns wrappers retornam { data: { matches: [...] } } ou { data: { results: [...] } }
        const dataObj = p.data && typeof p.data === 'object' ? p.data : null;
        const nested =
          (Array.isArray(dataObj?.matches) && dataObj.matches) ||
          (Array.isArray(dataObj?.results) && dataObj.results) ||
          (Array.isArray(dataObj?.data) && dataObj.data);
        if (nested) {
          const dataKeys = dataObj ? Object.keys(dataObj) : [];
          log('INFO', 'PANDASCORE', `${fallbackLabel}: formato data.* detectado; chaves=${keys.join(',')} | data=${dataKeys.join(',')}`);
          return nested;
        }

        log('WARN', 'PANDASCORE', `${fallbackLabel}: resposta não é lista; tipo=${typeof p}; chaves=${keys.join(',')}`);
        return [];
      }

      return [];
    }
    const running = psMatchList(runningRaw, 'running');
    const upcoming = psMatchList(upcomingRaw, 'upcoming');

    function mapPS(m, status) {
      const t1 = m.opponents?.[0]?.opponent, t2 = m.opponents?.[1]?.opponent;
      const n1 = t1?.name || 'TBD', n2 = t2?.name || 'TBD';
      if (n1 === 'TBD' && n2 === 'TBD') return null;
      const leagueName = m.league?.name || m.serie?.full_name || 'LoL';
      const format = m.number_of_games > 1 ? `Bo${m.number_of_games}` : '';

      // Placar a partir dos games
      let s1 = 0, s2 = 0;
      if (Array.isArray(m.games)) {
        for (const g of m.games) {
          if (!g.winner) continue;
          if (g.winner.id === t1?.id) s1++;
          else if (g.winner.id === t2?.id) s2++;
        }
      }

      return {
        id: `ps_${m.id}`,
        game: 'lol',
        league: leagueName,
        team1: n1, team2: n2,
        score1: s1, score2: s2,
        status,
        time: m.begin_at || '',
        format,
        winner: m.winner?.name || null,
        _source: 'pandascore'
      };
    }

    const live = running.map(m => mapPS(m, 'live')).filter(Boolean);
    const next = upcoming
      .filter(m => {
        const t = new Date(m.begin_at).getTime();
        return !isNaN(t) && t < Date.now() + 7 * 24 * 3600 * 1000; // próximos 7 dias
      })
      .map(m => mapPS(m, 'upcoming')).filter(Boolean);

    const psMatches = [...live, ...next];
    if (psMatches.length) {
      log('INFO', 'PANDASCORE', `${psMatches.length} partidas LoL (${live.length} live)`);
    }
    _pandaCache = { data: psMatches, ts: Date.now() };
    return psMatches;
  } catch(e) {
    log('WARN', 'PANDASCORE', 'Erro: ' + e.message);
    return _pandaCache.data; // retorna cache antigo em caso de erro
  }
}

// ── The Odds API — Dota 2 ──
let _dotaOddsCache = { data: [], ts: 0 };
const DOTA_ODDS_CACHE_TTL = parseInt(process.env.DOTA_ODDS_CACHE_TTL_MS || String(15 * 60 * 1000), 10);

async function getTheOddsDotaMatches() {
  if (!THE_ODDS_API_KEY) return [];
  if (_dotaOddsCache.data.length && (Date.now() - _dotaOddsCache.ts) < DOTA_ODDS_CACHE_TTL) {
    return _dotaOddsCache.data;
  }

  // Descobrir chaves Dota 2 disponíveis (inclui inativos para não perder torneios)
  const sportsR = await theOddsGet(`https://api.the-odds-api.com/v4/sports/?apiKey=${THE_ODDS_API_KEY}&all=true`);
  const allSports = safeParse(sportsR.body, []);
  const dotaKeys = allSports
    .filter(s => s && typeof s.key === 'string' && s.key.toLowerCase().includes('dota'))
    .map(s => s.key);

  if (!dotaKeys.length) {
    log('INFO', 'DOTA2', 'The Odds API: nenhuma chave Dota 2 encontrada');
    return [];
  }

  log('INFO', 'DOTA2', `The Odds API: chaves encontradas: ${dotaKeys.join(', ')}`);

  const now = Date.now();
  const matches = [];

  for (const key of dotaKeys) {
    if (!oddsApiAllowed('ODDS')) break;
    const url = `https://api.the-odds-api.com/v4/sports/${key}/odds/?apiKey=${THE_ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`;
    const r = await theOddsGet(url);
    if (r.status !== 200) continue;
    const events = safeParse(r.body, []);
    for (const e of events) {
      const commenceTs = new Date(e.commence_time).getTime();
      if (commenceTs < now) continue; // skip partidas passadas
      const bm = e.bookmakers?.[0];
      const market = bm?.markets?.find(m => m.key === 'h2h');
      const out = market?.outcomes || [];
      const o1 = out.find(o => o.name === e.home_team);
      const o2 = out.find(o => o.name === e.away_team);
      if (!o1 || !o2) continue;
      matches.push({
        id: `dota2_odds_${e.id}`,
        game: 'dota2',
        status: 'upcoming',
        team1: e.home_team,
        team2: e.away_team,
        league: e.sport_title || 'Dota 2',
        time: e.commence_time,
        sport_key: key,
        odds: { t1: String(o1.price), t2: String(o2.price), bookmaker: bm.title },
        score1: 0, score2: 0,
        format: 'Bo?',
        _source: 'theodds',
        _oddsId: e.id,
      });
    }
  }

  matches.sort((a, b) => new Date(a.time) - new Date(b.time));
  if (matches.length) {
    log('INFO', 'DOTA2', `The Odds API: ${matches.length} partidas Dota 2 com odds`);
    _dotaOddsCache = { data: matches, ts: Date.now() };
  }
  return matches;
}

// ── The Odds API — Table Tennis ──
let _ttOddsCache = { data: [], ts: 0 };
const TT_ODDS_CACHE_TTL = parseInt(process.env.TT_ODDS_CACHE_TTL_MS || String(5 * 60 * 1000), 10);
let _ttOddsKeysCache = { keys: [], ts: 0 };

async function getTheOddsTableTennisMatches() {
  if (!THE_ODDS_API_KEY) return [];
  if (_ttOddsCache.data.length && (Date.now() - _ttOddsCache.ts) < TT_ODDS_CACHE_TTL) {
    return _ttOddsCache.data;
  }

  // Cache das keys por 1h (mudam raramente)
  let ttKeys = _ttOddsKeysCache.keys;
  if (!ttKeys.length || (Date.now() - _ttOddsKeysCache.ts) > 60 * 60 * 1000) {
    const sportsR = await theOddsGet(`https://api.the-odds-api.com/v4/sports/?apiKey=${THE_ODDS_API_KEY}&all=true`).catch(() => ({ body: '[]' }));
    const all = safeParse(sportsR.body, []);
    ttKeys = (all || [])
      .filter(s => s && typeof s.key === 'string'
        && (/tabletennis|table.?tennis|ping.?pong/i.test(s.key)
            || /table.?tennis|ping.?pong/i.test(s.title || '')
            || /table.?tennis/i.test(s.group || '')))
      .map(s => s.key);
    _ttOddsKeysCache = { keys: ttKeys, ts: Date.now() };
    if (ttKeys.length) log('INFO', 'ODDS', `The Odds API TT keys: ${ttKeys.join(', ')}`);
    else log('INFO', 'ODDS', 'The Odds API: nenhuma key de Table Tennis retornada');
  }
  if (!ttKeys.length) return [];

  const now = Date.now();
  const matches = [];
  for (const key of ttKeys) {
    if (!oddsApiAllowed('ODDS')) break;
    const url = `https://api.the-odds-api.com/v4/sports/${key}/odds/?apiKey=${THE_ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`;
    const r = await theOddsGet(url).catch(() => null);
    if (!r || r.status !== 200) continue;
    const events = safeParse(r.body, []);
    for (const e of events) {
      const commenceTs = new Date(e.commence_time).getTime();
      // Aceita live (até 3h no passado) + upcoming
      if (commenceTs < now - 3 * 60 * 60 * 1000) continue;
      const bm = e.bookmakers?.[0];
      const market = bm?.markets?.find(m => m.key === 'h2h');
      const outcomes = market?.outcomes || [];
      const o1 = outcomes.find(o => o.name === e.home_team);
      const o2 = outcomes.find(o => o.name === e.away_team);
      if (!o1 || !o2) continue;
      matches.push({
        id: `ttennis_odds_${e.id}`,
        team1: e.home_team,
        team2: e.away_team,
        league: e.sport_title || 'Table Tennis',
        sport_key: key,
        status: commenceTs <= now ? 'live' : 'upcoming',
        time: e.commence_time,
        odds: { t1: String(o1.price), t2: String(o2.price), bookmaker: bm.title },
        _source: 'theodds',
      });
    }
  }

  matches.sort((a, b) => new Date(a.time) - new Date(b.time));
  if (matches.length) {
    log('INFO', 'ODDS', `The Odds API Table Tennis: ${matches.length} partidas`);
    _ttOddsCache = { data: matches, ts: Date.now() };
  }
  return matches;
}

// ── Pinnacle — Tennis (sportId=33) ──
// Suplementa The Odds API: cobre ATP/WTA/Challenger/ITF extensivamente.
// TTL adaptativo: 5min quando só upcoming; 90s quando ha partidas live (odds live movem rapido).
let _tennisPinnacleCache = { data: [], ts: 0 };
const TENNIS_PINNACLE_TTL_IDLE = 5 * 60 * 1000;
const TENNIS_PINNACLE_TTL_LIVE = 90 * 1000;

async function getPinnacleTennisMatches() {
  if (process.env.PINNACLE_TENNIS !== 'true') return [];
  const hadLive = _tennisPinnacleCache.data.some(m => m.status === 'live');
  const ttl = hadLive ? TENNIS_PINNACLE_TTL_LIVE : TENNIS_PINNACLE_TTL_IDLE;
  if (_tennisPinnacleCache.data.length && (Date.now() - _tennisPinnacleCache.ts) < ttl) {
    return _tennisPinnacleCache.data;
  }
  try {
    const rows = await pinnacle.fetchSportMatchOdds(33, (m) => {
      // Descarta mercados de kills/sets ("X 6-0" etc.) — só match winner
      const p1 = String(m?.participants?.[0]?.name || '');
      const p2 = String(m?.participants?.[1]?.name || '');
      if (/\(sets\)|\(games\)|\d+-\d+/i.test(p1 + p2)) return false;
      return true;
    });
    const _fetchedAt = Date.now();
    const matches = rows.map(r => ({
      id: `tennis_pin_${r.id}`,
      team1: r.team1,
      team2: r.team2,
      league: r.league,
      sport_key: (r.league || '').toLowerCase().includes('wta') ? 'tennis_wta' : 'tennis_atp',
      status: r.status === 'live' ? 'live' : 'upcoming',
      time: r.startTime,
      odds: { t1: String(r.oddsT1), t2: String(r.oddsT2), bookmaker: 'Pinnacle', _fetchedAt }
    }));
    _tennisPinnacleCache = { data: matches, ts: Date.now() };
    log('INFO', 'ODDS', `Pinnacle Tennis: ${matches.length} partidas cacheadas`);
    return matches;
  } catch (e) {
    log('ERROR', 'ODDS', `Pinnacle Tennis: ${e.message}`);
    return [];
  }
}

// ── Pinnacle — Table Tennis (sportId=32) ──
// Cobre WTT, Setka Cup, TT Elite Series, Czech TT League. Alto volume (~200/dia).
let _ttennisPinnacleCache = { data: [], ts: 0 };
const TTENNIS_PINNACLE_TTL = 3 * 60 * 1000; // 3min

async function getPinnacleTableTennisMatches() {
  // Pinnacle guest API funciona sem auth (mesmo padrão snooker/tennis).
  // Para desabilitar explicitamente: PINNACLE_TABLETENNIS=false
  if (process.env.PINNACLE_TABLETENNIS === 'false') return [];
  if (_ttennisPinnacleCache.data.length && (Date.now() - _ttennisPinnacleCache.ts) < TTENNIS_PINNACLE_TTL) {
    return _ttennisPinnacleCache.data;
  }
  try {
    const rows = await pinnacle.fetchSportMatchOdds(32, (m) => {
      const p1 = String(m?.participants?.[0]?.name || '');
      const p2 = String(m?.participants?.[1]?.name || '');
      // Filtra mercados de sets/games (só moneyline)
      if (/\(sets\)|\(games\)|\d+-\d+/i.test(p1 + p2)) return false;
      return true;
    });
    const matches = rows.map(r => ({
      id: `ttennis_pin_${r.id}`,
      team1: r.team1,
      team2: r.team2,
      league: r.league,
      sport_key: 'table_tennis',
      status: r.status === 'live' ? 'live' : 'upcoming',
      time: r.startTime,
      odds: { t1: String(r.oddsT1), t2: String(r.oddsT2), bookmaker: 'Pinnacle' }
    }));
    _ttennisPinnacleCache = { data: matches, ts: Date.now() };
    log('INFO', 'ODDS', `Pinnacle Table Tennis: ${matches.length} partidas cacheadas`);
    return matches;
  } catch (e) {
    log('ERROR', 'ODDS', `Pinnacle Table Tennis: ${e.message}`);
    return [];
  }
}

// ── Pinnacle — Dota 2 (esports) ──
// sportId=12 (E-Sports) filtrado por league.name contendo "Dota 2"
// Descarta matchups de kills e handicap (só queremos match winner série)
let _dotaPinnacleCache = { data: [], ts: 0 };
const DOTA_PINNACLE_TTL = 3 * 60 * 1000; // 3min (mesmo padrão snooker)

async function getPinnacleDotaMatches() {
  if (process.env.PINNACLE_DOTA !== 'true') return [];
  if (_dotaPinnacleCache.data.length && (Date.now() - _dotaPinnacleCache.ts) < DOTA_PINNACLE_TTL) {
    return _dotaPinnacleCache.data;
  }
  try {
    const rows = await pinnacle.fetchSportMatchOdds(12, (m) => {
      const name = String(m?.league?.name || '').toLowerCase();
      if (!name.includes('dota 2')) return false;
      const p1 = String(m?.participants?.[0]?.name || '');
      const p2 = String(m?.participants?.[1]?.name || '');
      // Descarta: (Kills) mercado de total kills + handicap de map ("X 0, Y 2 vs X 1, Y 2")
      if (/\(kills\)/i.test(p1) || /\(kills\)/i.test(p2)) return false;
      if (/\d+,\s*\w+\s+\d+/.test(p1) || /\d+,\s*\w+\s+\d+/.test(p2)) return false;
      return true;
    });
    const matches = rows.map(r => ({
      id: `pin_${r.id}`,
      team1: r.team1,
      team2: r.team2,
      league: r.league,
      status: r.status === 'live' ? 'live' : 'upcoming',
      time: r.startTime,
      odds: { t1: String(r.oddsT1), t2: String(r.oddsT2), bookmaker: 'Pinnacle' }
    }));
    _dotaPinnacleCache = { data: matches, ts: Date.now() };
    log('INFO', 'ODDS', `Pinnacle Dota 2: ${matches.length} partidas cacheadas`);
    return matches;
  } catch (e) {
    log('ERROR', 'ODDS', `Pinnacle Dota 2: ${e.message}`);
    return [];
  }
}

// ── Pinnacle — Counter-Strike 2 (sportId=12 E-Sports, league filter "Counter-Strike"|"CS2"|"CS:GO") ──
let _csPinnacleCache = { data: [], ts: 0 };
const CS_PINNACLE_TTL = 3 * 60 * 1000;

async function getPinnacleCsMatches() {
  if (_csPinnacleCache.data.length && (Date.now() - _csPinnacleCache.ts) < CS_PINNACLE_TTL) {
    return _csPinnacleCache.data;
  }
  try {
    const rows = await pinnacle.fetchSportMatchOdds(12, (m) => {
      const name = String(m?.league?.name || '').toLowerCase();
      if (!/(counter-?strike|cs\s*2|cs:?go|esea|esl|blast|iem|major)/i.test(name)) return false;
      if (!/(counter-?strike|cs\s*2|cs:?go)/i.test(name)) {
        // se league é torneio (BLAST/IEM/ESL) ainda exige menção CS para evitar misturar com LoL
        return false;
      }
      const p1 = String(m?.participants?.[0]?.name || '');
      const p2 = String(m?.participants?.[1]?.name || '');
      // Descarta mercados de map/round/handicap
      if (/\((kills|rounds|maps|handicap)\)/i.test(p1) || /\((kills|rounds|maps|handicap)\)/i.test(p2)) return false;
      if (/\d+,\s*\w+\s+\d+/.test(p1) || /\d+,\s*\w+\s+\d+/.test(p2)) return false;
      return true;
    });
    const matches = rows.map(r => ({
      id: `pin_cs_${r.id}`,
      team1: r.team1,
      team2: r.team2,
      league: r.league,
      status: r.status === 'live' ? 'live' : 'upcoming',
      time: r.startTime,
      odds: { t1: String(r.oddsT1), t2: String(r.oddsT2), bookmaker: 'Pinnacle' }
    }));
    _csPinnacleCache = { data: matches, ts: Date.now() };
    log('INFO', 'ODDS', `Pinnacle CS2: ${matches.length} partidas cacheadas`);
    return matches;
  } catch (e) {
    log('ERROR', 'ODDS', `Pinnacle CS2: ${e.message}`);
    return [];
  }
}

// ── Odds-API.io — Dota 2 (esports) ──
let _dotaOddsApiIoCache = { data: [], ts: 0 };

async function getOddsApiIoDotaMatches() {
  if (!ODDS_API_IO_KEY) return [];
  if (_dotaOddsApiIoCache.data.length && (Date.now() - _dotaOddsApiIoCache.ts) < DOTA_ODDS_CACHE_TTL) {
    return _dotaOddsApiIoCache.data;
  }

  const now = Date.now();
  const weekAhead = now + 7 * 24 * 60 * 60 * 1000;
  const LIVE_WINDOW_MS = parseInt(process.env.DOTA_LIVE_WINDOW_H || '6', 10) * 60 * 60 * 1000;
  const maxEventsCfg = parseInt(process.env.DOTA_MAX_EVENTS || '12', 10);
  const maxEvents = Math.min(30, Math.max(4, Number.isFinite(maxEventsCfg) ? maxEventsCfg : 12));
  const leagueRe = new RegExp(process.env.DOTA_LEAGUE_REGEX || 'dota', 'i');

  const events = await fetchOddsApiIoEvents('esports');
  const filtered = (events || [])
    .map(e => {
      const t = new Date(e.date || e.commence_time || e.start_time || e.time || '').getTime();
      const leagueName = (e.league?.name || e.league || '').toString();
      const sportName = (e.sport?.name || e.sport || '').toString();
      const sportSlug = (e.sport?.slug || '').toString();
      const hay = `${leagueName} ${sportName} ${sportSlug}`.trim();
      return { e, t, leagueName, hay };
    })
    // Alguns eventos vêm sem league; usa sport.* como fallback
    .filter(x => leagueRe.test(x.hay || x.leagueName || ''))
    .filter(x => Number.isFinite(x.t) && x.t <= weekAhead && (x.t > now || (x.t <= now && (now - x.t) <= LIVE_WINDOW_MS)))
    .sort((a, b) => a.t - b.t)
    .slice(0, maxEvents);

  const matches = [];
  for (const { e, t, leagueName } of filtered) {
    const oddsObj = await fetchOddsApiIoEventOdds(
      e.id,
      process.env.ODDSAPIO_DOTA_BOOKMAKERS || process.env.ODDSAPIO_BOOKMAKERS || 'Pinnacle'
    );
    const bmName = oddsObj?.bookmakers ? Object.keys(oddsObj.bookmakers)[0] : null;
    const mk = bmName ? (oddsObj.bookmakers?.[bmName] || []) : [];
    const ml = mk.find(m => String(m?.name || '').toLowerCase() === 'ml' || String(m?.name || '').toLowerCase() === 'h2h') || mk[0];
    const firstOdds = Array.isArray(ml?.odds) ? ml.odds[0] : null;
    const o1 = firstOdds?.home;
    const o2 = firstOdds?.away;
    const team1 = e.home || e.home_team || e.team1 || '';
    const team2 = e.away || e.away_team || e.team2 || '';
    if (!team1 || !team2) continue;
    if (!o1 || !o2) continue;
    matches.push({
      id: `dota2_oddsapiio_${e.id}`,
      game: 'dota2',
      status: (t <= now ? 'live' : 'upcoming'),
      team1,
      team2,
      league: leagueName || 'Dota 2',
      time: e.date || e.commence_time || e.time,
      odds: { t1: String(o1), t2: String(o2), bookmaker: bmName || 'Odds-API.io' },
      score1: 0, score2: 0,
      format: 'Bo?',
      _source: 'oddsapiio',
      _oddsId: e.id,
    });
  }

  matches.sort((a, b) => new Date(a.time) - new Date(b.time));
  if (matches.length) {
    log('INFO', 'DOTA2', `Odds-API.io: ${matches.length} partidas Dota 2 com odds`);
    _dotaOddsApiIoCache = { data: matches, ts: Date.now() };
  }
  return matches;
}

// ── PandaScore Dota 2 ──
let _pandaDotaCache = { data: [], ts: 0 };
const PANDA_DOTA_CACHE_TTL = parseInt(process.env.PANDA_DOTA_CACHE_TTL_MS || '90000', 10);

async function getPandaScoreDotaMatches() {
  if (!PANDASCORE_TOKEN || PANDASCORE_TOKEN === 'your-pandascore-token') return [];
  if (Date.now() < _pandaBackoffUntil) return [];
  if (_pandaDotaCache.data.length && (Date.now() - _pandaDotaCache.ts) < PANDA_DOTA_CACHE_TTL) return _pandaDotaCache.data;
  try {
    const headers = { 'Authorization': `Bearer ${PANDASCORE_TOKEN}` };
    const [runningRaw, upcomingRaw] = await Promise.all([
      httpGet('https://api.pandascore.co/dota2/matches/running?per_page=20', headers).catch(() => ({ status: 0, body: '[]' })),
      httpGet('https://api.pandascore.co/dota2/matches/upcoming?per_page=30&sort=begin_at', headers).catch(() => ({ status: 0, body: '[]' }))
    ]);
    const parsePsArr = (raw) => {
      const p = safeParse(raw?.body, []);
      return Array.isArray(p) ? p : [];
    };
    const running = parsePsArr(runningRaw);
    const upcoming = parsePsArr(upcomingRaw);

    const mapDota = (m, status) => {
      const t1 = m.opponents?.[0]?.opponent, t2 = m.opponents?.[1]?.opponent;
      const n1 = t1?.name || 'TBD', n2 = t2?.name || 'TBD';
      if (n1 === 'TBD' && n2 === 'TBD') return null;
      const leagueName = m.league?.name || m.serie?.full_name || 'Dota 2';
      const format = m.number_of_games > 1 ? `Bo${m.number_of_games}` : 'Bo1';
      let s1 = 0, s2 = 0;
      if (Array.isArray(m.games)) {
        for (const g of m.games) {
          if (!g.winner) continue;
          if (g.winner.id === t1?.id) s1++;
          else if (g.winner.id === t2?.id) s2++;
        }
      }
      return {
        id: `dota2_ps_${m.id}`,
        game: 'dota2',
        league: leagueName,
        leagueSlug: m.league?.slug || '',
        team1: n1, team2: n2,
        score1: s1, score2: s2,
        status,
        time: m.begin_at || '',
        format,
        winner: m.winner?.name || null,
        _psId: String(m.id),
        _source: 'pandascore'
      };
    };

    const live = running.map(m => mapDota(m, 'live')).filter(Boolean);
    const next = upcoming
      .filter(m => {
        const t = new Date(m.begin_at).getTime();
        return !isNaN(t) && t < Date.now() + 7 * 24 * 3600 * 1000;
      })
      .map(m => mapDota(m, 'upcoming')).filter(Boolean);

    const result = [...live, ...next];
    if (result.length) log('INFO', 'DOTA2', `PandaScore: ${result.length} partidas (${live.length} live)`);
    _pandaDotaCache = { data: result, ts: Date.now() };
    return result;
  } catch(e) {
    log('WARN', 'DOTA2', 'getPandaScoreDotaMatches: ' + e.message);
    return _pandaDotaCache.data;
  }
}

// ── PandaScore CS2 ──
let _pandaCsCache = { data: [], ts: 0 };
const PANDA_CS_CACHE_TTL = parseInt(process.env.PANDA_CS_CACHE_TTL_MS || '90000', 10);

async function getPandaScoreCsMatches() {
  if (!PANDASCORE_TOKEN || PANDASCORE_TOKEN === 'your-pandascore-token') return [];
  if (Date.now() < _pandaBackoffUntil) return [];
  if (_pandaCsCache.data.length && (Date.now() - _pandaCsCache.ts) < PANDA_CS_CACHE_TTL) return _pandaCsCache.data;
  try {
    const headers = { 'Authorization': `Bearer ${PANDASCORE_TOKEN}` };
    const [runningRaw, upcomingRaw] = await Promise.all([
      httpGet('https://api.pandascore.co/csgo/matches/running?per_page=20', headers).catch(() => ({ status: 0, body: '[]' })),
      httpGet('https://api.pandascore.co/csgo/matches/upcoming?per_page=30&sort=begin_at', headers).catch(() => ({ status: 0, body: '[]' }))
    ]);
    const parsePsArr = (raw) => {
      const p = safeParse(raw?.body, []);
      return Array.isArray(p) ? p : [];
    };
    const running = parsePsArr(runningRaw);
    const upcoming = parsePsArr(upcomingRaw);

    const mapCs = (m, status) => {
      const t1 = m.opponents?.[0]?.opponent, t2 = m.opponents?.[1]?.opponent;
      const n1 = t1?.name || 'TBD', n2 = t2?.name || 'TBD';
      if (n1 === 'TBD' && n2 === 'TBD') return null;
      const leagueName = m.league?.name || m.serie?.full_name || 'CS2';
      const format = m.number_of_games > 1 ? `Bo${m.number_of_games}` : 'Bo1';
      let s1 = 0, s2 = 0;
      if (Array.isArray(m.games)) {
        for (const g of m.games) {
          if (!g.winner) continue;
          if (g.winner.id === t1?.id) s1++;
          else if (g.winner.id === t2?.id) s2++;
        }
      }
      return {
        id: `cs_ps_${m.id}`,
        game: 'cs',
        league: leagueName,
        leagueSlug: m.league?.slug || '',
        team1: n1, team2: n2,
        score1: s1, score2: s2,
        status,
        time: m.begin_at || '',
        format,
        winner: m.winner?.name || null,
        _psId: String(m.id),
        _source: 'pandascore'
      };
    };

    const live = running.map(m => mapCs(m, 'live')).filter(Boolean);
    const next = upcoming
      .filter(m => {
        const t = new Date(m.begin_at).getTime();
        return !isNaN(t) && t < Date.now() + 7 * 24 * 3600 * 1000;
      })
      .map(m => mapCs(m, 'upcoming')).filter(Boolean);

    const result = [...live, ...next];
    if (result.length) log('INFO', 'CS', `PandaScore: ${result.length} partidas (${live.length} live)`);
    _pandaCsCache = { data: result, ts: Date.now() };
    return result;
  } catch(e) {
    log('WARN', 'CS', 'getPandaScoreCsMatches: ' + e.message);
    return _pandaCsCache.data;
  }
}

// ── Pinnacle — Valorant (sportId=12 E-Sports, league filter "valorant") ──
let _valorantPinnacleCache = { data: [], ts: 0 };
const VALORANT_PINNACLE_TTL = 3 * 60 * 1000;

async function getPinnacleValorantMatches() {
  if (_valorantPinnacleCache.data.length && (Date.now() - _valorantPinnacleCache.ts) < VALORANT_PINNACLE_TTL) {
    return _valorantPinnacleCache.data;
  }
  try {
    const rows = await pinnacle.fetchSportMatchOdds(12, (m) => {
      const name = String(m?.league?.name || '').toLowerCase();
      if (!name.includes('valorant')) return false;
      const p1 = String(m?.participants?.[0]?.name || '');
      const p2 = String(m?.participants?.[1]?.name || '');
      if (/\((kills|rounds|maps|handicap)\)/i.test(p1) || /\((kills|rounds|maps|handicap)\)/i.test(p2)) return false;
      if (/\d+,\s*\w+\s+\d+/.test(p1) || /\d+,\s*\w+\s+\d+/.test(p2)) return false;
      return true;
    });
    const matches = rows.map(r => ({
      id: `pin_valorant_${r.id}`,
      team1: r.team1,
      team2: r.team2,
      league: r.league,
      status: r.status === 'live' ? 'live' : 'upcoming',
      time: r.startTime,
      odds: { t1: String(r.oddsT1), t2: String(r.oddsT2), bookmaker: 'Pinnacle' }
    }));
    _valorantPinnacleCache = { data: matches, ts: Date.now() };
    log('INFO', 'ODDS', `Pinnacle Valorant: ${matches.length} partidas cacheadas`);
    return matches;
  } catch (e) {
    log('ERROR', 'ODDS', `Pinnacle Valorant: ${e.message}`);
    return [];
  }
}

// ── PandaScore Valorant ──
let _pandaValorantCache = { data: [], ts: 0 };
const PANDA_VALORANT_CACHE_TTL = parseInt(process.env.PANDA_VALORANT_CACHE_TTL_MS || '90000', 10);

async function getPandaScoreValorantMatches() {
  if (!PANDASCORE_TOKEN || PANDASCORE_TOKEN === 'your-pandascore-token') return [];
  if (Date.now() < _pandaBackoffUntil) return [];
  if (_pandaValorantCache.data.length && (Date.now() - _pandaValorantCache.ts) < PANDA_VALORANT_CACHE_TTL) return _pandaValorantCache.data;
  try {
    const headers = { 'Authorization': `Bearer ${PANDASCORE_TOKEN}` };
    const [runningRaw, upcomingRaw] = await Promise.all([
      httpGet('https://api.pandascore.co/valorant/matches/running?per_page=20', headers).catch(() => ({ status: 0, body: '[]' })),
      httpGet('https://api.pandascore.co/valorant/matches/upcoming?per_page=30&sort=begin_at', headers).catch(() => ({ status: 0, body: '[]' }))
    ]);
    const parsePsArr = (raw) => {
      const p = safeParse(raw?.body, []);
      return Array.isArray(p) ? p : [];
    };
    const running = parsePsArr(runningRaw);
    const upcoming = parsePsArr(upcomingRaw);

    const mapVal = (m, status) => {
      const t1 = m.opponents?.[0]?.opponent, t2 = m.opponents?.[1]?.opponent;
      const n1 = t1?.name || 'TBD', n2 = t2?.name || 'TBD';
      if (n1 === 'TBD' && n2 === 'TBD') return null;
      const leagueName = m.league?.name || m.serie?.full_name || 'Valorant';
      const format = m.number_of_games > 1 ? `Bo${m.number_of_games}` : 'Bo1';
      let s1 = 0, s2 = 0;
      let currentMap = null;
      if (Array.isArray(m.games)) {
        for (const g of m.games) {
          if (g.status === 'running' || g.status === 'not_started' && !currentMap) {
            if (g.status === 'running' && g.map?.name) currentMap = g.map.name;
          }
          if (!g.winner) continue;
          if (g.winner.id === t1?.id) s1++;
          else if (g.winner.id === t2?.id) s2++;
        }
      }
      return {
        id: `valorant_ps_${m.id}`,
        game: 'valorant',
        league: leagueName,
        leagueSlug: m.league?.slug || '',
        team1: n1, team2: n2,
        score1: s1, score2: s2,
        status,
        time: m.begin_at || '',
        format,
        winner: m.winner?.name || null,
        currentMap,
        _psId: String(m.id),
        _source: 'pandascore'
      };
    };

    const live = running.map(m => mapVal(m, 'live')).filter(Boolean);
    const next = upcoming
      .filter(m => {
        const t = new Date(m.begin_at).getTime();
        return !isNaN(t) && t < Date.now() + 7 * 24 * 3600 * 1000;
      })
      .map(m => mapVal(m, 'upcoming')).filter(Boolean);

    const result = [...live, ...next];
    if (result.length) log('INFO', 'VALORANT', `PandaScore: ${result.length} partidas (${live.length} live)`);
    _pandaValorantCache = { data: result, ts: Date.now() };
    return result;
  } catch(e) {
    log('WARN', 'VALORANT', 'getPandaScoreValorantMatches: ' + e.message);
    return _pandaValorantCache.data;
  }
}

// ── Admin Auth + Rate Limit (in-memory) ──
const ADMIN_KEY = (process.env.ADMIN_KEY || '').trim();
let _adminKeyWarnLogged = false;
function warnAdminKeyMissingOnce() {
  if (ADMIN_KEY || _adminKeyWarnLogged) return;
  _adminKeyWarnLogged = true;
  log('WARN', 'SEC', 'ADMIN_KEY não configurada — rotas admin abertas sem autenticação. Configure ADMIN_KEY em produção.');
}

function getClientIp(req) {
  const xf = (req.headers['x-forwarded-for'] || '').toString();
  const ip = xf.split(',')[0]?.trim();
  return ip || req.socket?.remoteAddress || 'unknown';
}

function isAdminRequest(req) {
  if (!ADMIN_KEY) return false;
  const xk = (req.headers['x-admin-key'] || '').toString().trim();
  if (xk && xk === ADMIN_KEY) return true;
  const auth = (req.headers['authorization'] || '').toString().trim();
  if (auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token && token === ADMIN_KEY) return true;
  }
  return false;
}

function requireAdmin(req, res) {
  if (!ADMIN_KEY) {
    warnAdminKeyMissingOnce();
    return true;
  }
  if (!isAdminRequest(req)) {
    sendJson(res, { ok: false, error: 'unauthorized' }, 401);
    return false;
  }
  return true;
}

const _rl = new Map(); // key -> { count, resetAt }
function rateLimit(req, res, limitPerMin, bucket) {
  const ip = getClientIp(req);
  const key = `${bucket}|${ip}`;
  const now = Date.now();
  const winMs = 60 * 1000;
  const cur = _rl.get(key);
  if (!cur || now >= cur.resetAt) {
    _rl.set(key, { count: 1, resetAt: now + winMs });
    return true;
  }
  if (cur.count >= limitPerMin) {
    const retryAfterSec = Math.max(1, Math.ceil((cur.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfterSec));
    sendJson(res, {
      ok: false,
      error: 'rate_limited',
      bucket,
      limitPerMin,
      retryAfterSec
    }, 429);
    return false;
  }
  cur.count++;
  return true;
}

const ADMIN_ROUTES_ANY = new Set([
  '/lol-raw',
  '/debug-odds',
  '/debug-teams',
  '/debug-match-odds',
  '/sync-pro-stats',
  '/sync-golgg-role-impact',
]);

const ADMIN_ROUTES_POST = new Set([
  '/record-analysis',
  '/save-user',
  '/record-tip',
  '/log-tip-factors',
  '/log-odds-history',
  '/resync-stats',
  '/reset-tips',
  '/settle',
  '/settle-manual',
  '/void-old-pending',
  '/set-bankroll',
  '/update-clv',
  '/update-open-tip',
  '/claude',
  '/ps-result',
  '/football-result',
]);

const EXPENSIVE_ROUTES = new Set([
  '/claude',
  '/odds',
  '/handicap-odds',
  '/mma-odds',
]);

/** Forma + H2H + histórico de odds gravado (mesma lógica que /team-form, /h2h, /odds-movement). */
function lolEnrichmentFromDb(t1, t2, game = 'lol') {
  const days = 45;
  const limit = 10;
  const formFor = (team) => {
    if (!team) return { wins: 0, draws: 0, losses: 0, winRate: 0, streak: '—', recent: [] };
    let rows = stmts.getTeamFormCustom.all(team, team, game, days, limit);
    if (!rows.length) {
      const fuzzy = `%${team}%`;
      rows = stmts.getTeamFormFuzzyCustom.all(fuzzy, fuzzy, game, days, limit);
    }
    if (!rows.length) return { wins: 0, draws: 0, losses: 0, winRate: 0, streak: '—', recent: [] };
    let wins = 0, losses = 0, draws = 0, streak = '', streakCount = 0;
    const recent = [];
    let streakActive = true;
    for (const r of rows) {
      const isDraw = r.winner && norm(r.winner) === 'draw';
      const won = !isDraw && norm(r.winner) === norm(team);
      const resChar = won ? 'W' : (isDraw ? 'D' : 'L');
      recent.push(resChar);
      if (won) wins++; else if (isDraw) draws++; else losses++;
      if (streakActive) {
        if (streak === '') { streak = resChar; streakCount = 1; }
        else if (streak === resChar) streakCount++;
        else streakActive = false;
      }
    }
    return { wins, draws, losses, winRate: Math.round((wins / rows.length) * 100), streak: `${streakCount}${streak}`, recent };
  };
  const form1 = formFor(t1);
  const form2 = formFor(t2);
  let rows = stmts.getH2HCustom.all(t1, t2, t2, t1, game, days, limit);
  if (!rows.length) {
    rows = stmts.getH2HFuzzyCustom.all(`%${t1}%`, `%${t2}%`, `%${t2}%`, `%${t1}%`, game, days, limit);
  }
  let t1w = 0, t2w = 0;
  for (const r of rows) {
    const isDraw = r.winner && norm(r.winner) === 'draw';
    if (norm(r.winner) === norm(t1)) t1w++;
    else if (!isDraw) t2w++;
  }
  const h2h = { totalMatches: rows.length, t1Wins: t1w, t2Wins: t2w };
  const matchKey = `${norm(t1)}_${norm(t2)}`;
  const history = stmts.getOddsMovement.all('esports', matchKey);
  const oddsMovement = {
    history: history.map(h => ({
      odds_t1: h.odds_p1,
      odds_t2: h.odds_p2,
      bookmaker: h.bookmaker,
      recorded_at: h.recorded_at
    }))
  };
  return { form1, form2, h2h, oddsMovement };
}

/** WR médio pro play por lado + linha por rota (espelha lógica do bot / champ-winrates). */
function lolCompScoreFromDraft(stmts, t1Champs, t2Champs) {
  const roleAliases = [
    ['top'],
    ['jungle', 'jg', 'jgl'],
    ['mid', 'middle'],
    ['bottom', 'adc', 'bot'],
    ['support', 'sup']
  ];
  const label = ['TOP', 'JGL', 'MID', 'ADC', 'SUP'];
  const pickStat = (champ, aliases) => {
    const c = String(champ || '').trim();
    if (!c) return null;
    for (const r of aliases) {
      const stat = stmts.getChampStat.get(c, r);
      if (stat && stat.total >= 5) return { stat, matchedRole: r };
    }
    const fall = stmts.getChampStatAnyRole.get(c);
    if (fall && fall.total >= 5) return { stat: fall, matchedRole: fall.role, fallback: true };
    return null;
  };
  const rolesDetail = [];
  let blueWR = 0, blueN = 0, redWR = 0, redN = 0, blueTot = 0, redTot = 0;
  for (let i = 0; i < 5; i++) {
    const c1 = t1Champs[i];
    const c2 = t2Champs[i];
    const aliases = roleAliases[i];
    const p1 = pickStat(c1, aliases);
    const p2 = pickStat(c2, aliases);
    rolesDetail.push({
      role: label[i],
      t1Champion: c1 || null,
      t2Champion: c2 || null,
      t1WinRate: p1 ? Math.round((p1.stat.wins / p1.stat.total) * 1000) / 10 : null,
      t1Total: p1 ? p1.stat.total : null,
      t1MatchedRole: p1 ? p1.matchedRole : null,
      t1Fallback: !!p1?.fallback,
      t2WinRate: p2 ? Math.round((p2.stat.wins / p2.stat.total) * 1000) / 10 : null,
      t2Total: p2 ? p2.stat.total : null,
      t2MatchedRole: p2 ? p2.matchedRole : null,
      t2Fallback: !!p2?.fallback
    });
    if (p1) {
      blueWR += (p1.stat.wins / p1.stat.total) * 100;
      blueTot += p1.stat.total;
      blueN++;
    }
    if (p2) {
      redWR += (p2.stat.wins / p2.stat.total) * 100;
      redTot += p2.stat.total;
      redN++;
    }
  }
  if (blueN > 0 && redN > 0) {
    const blueAvg = blueWR / blueN;
    const redAvg = redWR / redN;
    return {
      compScore: blueAvg - redAvg,
      t1Avg: Math.round(blueAvg * 10) / 10,
      t2Avg: Math.round(redAvg * 10) / 10,
      t1N: blueN,
      t2N: redN,
      t1Sample: Math.round(blueTot / blueN),
      t2Sample: Math.round(redTot / redN),
      rolesDetail
    };
  }
  return { compScore: null, t1N: blueN, t2N: redN, rolesDetail };
}

// ── HTTP Server ──
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  let p = parsed.pathname || '/';
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  // Global safety net — prevents hanging requests on unhandled async errors
  res.on('error', (e) => log('ERROR', 'RES', e.message));
  try {

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-key, x-sport'
    });
    res.end();
    return;
  }

  // Rate limit (antes de rotas pesadas)
  const bucket = EXPENSIVE_ROUTES.has(p) ? `expensive:${p}` : `general:${p}`;
  const limit = EXPENSIVE_ROUTES.has(p) ? 10 : 60;
  if (!rateLimit(req, res, limit, bucket)) return;

  // Admin guard
  const needsAdmin =
    ADMIN_ROUTES_ANY.has(p) ||
    (req.method === 'POST' && ADMIN_ROUTES_POST.has(p)) ||
    (p === '/odds' && parsed.query.force === '1');
  if (needsAdmin && !requireAdmin(req, res)) return;

  // ── Esports Endpoints (sem scrapers) ──
  if (p === '/lol-matches') {
    // Primário: getSchedule + getLive (arush); PandaScore sempre para live status (LPL)
    let riotMatches = await getLoLMatchesArush();
    let lolSource = 'arush_schedule';
    if (!riotMatches.length) { riotMatches = await getLoLMatches(); lolSource = 'riot_live+schedule'; }

    // PandaScore: SEMPRE busca para live status (não só como backoff de count)
    // Razão: Lolesports API falha em refletir LPL live — PS /running é a fonte correta
    const psMatches = await getPandaScoreLolMatches();
    const psBackoff = riotMatches.length < 10;
    log('INFO', 'LOL', `/lol-matches fonte=${lolSource} riot=${riotMatches.length} ps=${psMatches.length} psBackoff=${psBackoff ? 1 : 0}`);

    // Mescla: PandaScore não sobrescreve Riot, mas pode promover upcoming→live
    const combined = [...riotMatches];
    for (const pm of psMatches) {
      const n1 = norm(pm.team1), n2 = norm(pm.team2);
      const teamsMatch = (a, b) =>
        (a.includes(b) || b.includes(a));
      const riotIdx = combined.findIndex(r => {
        const r1 = norm(r.team1), r2 = norm(r.team2);
        const direct = teamsMatch(r1, n1) && teamsMatch(r2, n2);
        const swapped = teamsMatch(r1, n2) && teamsMatch(r2, n1);
        return direct || swapped;
      });
      if (riotIdx !== -1) {
        // PS diz que está live mas Riot mostra upcoming → promove status
        if (pm.status === 'live' && combined[riotIdx].status !== 'live') {
          combined[riotIdx].status = 'live';
          // Atualiza placar se PS tem dados mais recentes
          if (pm.score1 > 0 || pm.score2 > 0) {
            combined[riotIdx].score1 = pm.score1;
            combined[riotIdx].score2 = pm.score2;
          }
        }
      } else {
        // Partida não existe no Riot (só no PandaScore)
        const o = findOdds('esports', pm.team1, pm.team2);
        if (o) pm.odds = o;
        combined.push(pm);
      }
    }

    // Promoção por tempo: LPL/ligas asiáticas que a Riot API não atualiza para inProgress
    // Se startTime passou há mais de 2min e menos de 5h, e partida não está completa → live
    const nowMs = Date.now();
    const LIVE_LEAGUES_TIME_PROMOTE = new Set(['lpl', 'ldl', 'lck', 'lck_challengers_league', 'lck-cl', 'lck-challengers-league']);
    for (const m of combined) {
      if (m.status === 'live') continue;
      const startTs = m.time ? new Date(m.time).getTime() : 0;
      if (!startTs) continue;
      const elapsedMin = (nowMs - startTs) / 60000;
      if (elapsedMin < 2 || elapsedMin > 300) continue; // entre 2min e 5h
      if (m.winner) continue; // já terminou
      // Só promove ligas problemáticas (LPL é a principal)
      const slug = m.leagueSlug || '';
      if (!LIVE_LEAGUES_TIME_PROMOTE.has(slug)) continue;
      m.status = 'live';
    }

    // Reordena: live primeiro, depois por horário
    combined.sort((a, b) => {
      if (a.status === 'live' && b.status !== 'live') return -1;
      if (b.status === 'live' && a.status !== 'live') return 1;
      return new Date(a.time) - new Date(b.time);
    });

    sendJson(res, combined.slice(0, 30));
    return;
  }

  if (p === '/lol-slugs') {
    // Retorna slugs ativos (na whitelist) e slugs desconhecidos vistos no schedule
    sendJson(res, {
      allowed: [...LOL_LEAGUES],
      unknown_seen: [...unknownLolSlugs],
      hint: 'Adicione slugs desconhecidos ao LOL_EXTRA_LEAGUES no .env para cobri-los'
    });
    return;
  }

  if (p === '/lol-raw') {
    // Debug: retorna todos os eventos brutos do schedule (sem filtro de liga)
    try {
      const sr = await httpGet(LOL_BASE + '/getSchedule?hl=en-US', LOL_HEADERS);
      const sd = safeParse(sr.body, {});
      const evs = sd?.data?.schedule?.events || [];

      // Busca getLive também
      let liveEvs = [];
      try {
        const glr = await httpGet(LOL_BASE + '/getLive?hl=en-US', LOL_HEADERS);
        liveEvs = safeParse(glr.body, {})?.data?.schedule?.events || [];
      } catch(_) {}

      const allEvs = [...evs, ...liveEvs];

      // Agrupa por liga
      const byLeague = {};
      for (const e of allEvs) {
        const slug = e.league?.slug || '(sem slug)';
        const name = e.league?.name || '?';
        if (!byLeague[slug]) byLeague[slug] = { name, count: 0, states: {}, inWhitelist: LOL_LEAGUES.has(slug), sample: null };
        byLeague[slug].count++;
        byLeague[slug].states[e.state || 'unknown'] = (byLeague[slug].states[e.state || 'unknown'] || 0) + 1;
        if (!byLeague[slug].sample && e.type === 'match' && e.match) {
          const t1 = e.match.teams?.[0], t2 = e.match.teams?.[1];
          byLeague[slug].sample = `${t1?.name || t1?.code || 'TBD'} vs ${t2?.name || t2?.code || 'TBD'} [${e.state}]`;
        }
      }

      sendJson(res, { total_events: allEvs.length, by_league: byLeague });
    } catch(e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  if (p === '/live-gameids') {
    try {
      const raw = parsed.query.matchId;
      const matchId = raw ? String(raw).replace(/^lol_/, '').replace(/^ps_/, '') : '';
      const qt1 = String(parsed.query.team1 || '').trim();
      const qt2 = String(parsed.query.team2 || '').trim();
      const games = [];
      const normT = s => String(s||'').toLowerCase().replace(/[^a-z0-9]/g, '');
      const teamsMatch = (a, b, qa, qb) => {
        const na = normT(a), nb = normT(b), nqa = normT(qa), nqb = normT(qb);
        if (!nqa || !nqb) return false;
        const has = (x, y) => x && y && (x.includes(y) || y.includes(x));
        return (has(na, nqa) && has(nb, nqb)) || (has(na, nqb) && has(nb, nqa));
      };
      // Path 1: matchId direto (Riot format) — busca getEventDetails
      let addedFromMatchId = false;
      if (matchId && /^\d+$/.test(matchId)) {
        const dr = await httpGet(`${LOL_BASE}/getEventDetails?hl=en-US&id=${matchId}`, LOL_HEADERS);
        const dd = safeParse(dr.body, {});
        const match = dd?.data?.event?.match;
        if (match?.games) {
          const t1 = match.teams?.[0]?.name, t2 = match.teams?.[1]?.name;
          for (const g of match.games) {
            // NÃO filtrar por g.state — LPL/PS-only aparecem como "unstarted" mesmo quando live.
            // Também não filtrar "completed" agressivamente — livestats ainda funciona pós-match.
            if (!g.id) continue;
            games.push({ gameId: g.id, matchId, team1: t1, team2: t2, gameNumber: g.number, hasLiveData: g.state === 'inProgress' || g.state === 'unstarted' });
          }
          addedFromMatchId = games.length > 0;
        }
      }
      // Path 2: fallback por team names — varre getSchedule zh-CN + en-US procurando match
      if (!addedFromMatchId && qt1 && qt2) {
        const schedules = await Promise.all([
          httpGet(`${LOL_BASE}/getSchedule?hl=zh-CN`, LOL_HEADERS).catch(() => ({ body: '{}' })),
          httpGet(`${LOL_BASE}/getSchedule?hl=en-US`, LOL_HEADERS).catch(() => ({ body: '{}' })),
        ]);
        const events = [];
        for (const s of schedules) {
          const d = safeParse(s.body, {});
          const evs = d?.data?.schedule?.events || [];
          for (const e of evs) {
            if (e.type === 'match' && e.match) events.push(e);
          }
        }
        // Ordena por startTime desc (mais recente primeiro — mais provável de estar ao vivo)
        events.sort((a, b) => new Date(b.startTime || 0) - new Date(a.startTime || 0));
        const hit = events.find(e => {
          const teams = e.match?.teams || [];
          return teamsMatch(teams[0]?.name, teams[1]?.name, qt1, qt2);
        });
        if (hit?.match?.id) {
          const dr = await httpGet(`${LOL_BASE}/getEventDetails?hl=en-US&id=${hit.match.id}`, LOL_HEADERS);
          const dd = safeParse(dr.body, {});
          const m = dd?.data?.event?.match;
          if (m?.games) {
            const t1 = m.teams?.[0]?.name, t2 = m.teams?.[1]?.name;
            for (const g of m.games) {
              if (!g.id) continue;
              games.push({ gameId: g.id, matchId: hit.match.id, team1: t1, team2: t2, gameNumber: g.number, hasLiveData: g.state === 'inProgress' || g.state === 'unstarted', _resolvedByTeams: true });
            }
          }
        }
      }
      sendJson(res, games);
    } catch(e) {
      log('ERROR', 'LIVE-IDS', e.message);
      sendJson(res, []);
    }
    return;
  }

  // ── PandaScore: composições de LoL (para matches com id ps_xxx) ──
  if (p === '/ps-compositions') {
    const rawId = parsed.query.matchId || '';
    const psId = rawId.replace(/^ps_/, '');
    if (!psId || !PANDASCORE_TOKEN || PANDASCORE_TOKEN === 'your-pandascore-token') {
      sendJson(res, { hasCompositions: false, error: 'Token PandaScore não configurado' });
      return;
    }
    try {
      const headers = { 'Authorization': `Bearer ${PANDASCORE_TOKEN}` };
      const r = await httpGet(`https://api.pandascore.co/lol/matches/${psId}`, headers);
      if (r.status !== 200) {
        sendJson(res, { hasCompositions: false, error: `PS status ${r.status}` });
        return;
      }
      const m = safeParse(r.body, {});
      const ops = m.opponents || [];
      const t1 = ops[0]?.opponent, t2 = ops[1]?.opponent;
      const games = Array.isArray(m.games) ? m.games : [];

      // Pega o game em andamento ou o mais recente
      const activeGame = games.find(g => g.status === 'running') || games[games.length - 1];
      if (!activeGame) {
        sendJson(res, { hasCompositions: false, error: 'Nenhum game disponível' });
        return;
      }

      // Placar da série (quantos games cada time venceu)
      let s1 = 0, s2 = 0;
      for (const g of games) {
        if (!g.winner) continue;
        if (g.winner.id === t1?.id) s1++;
        else if (g.winner.id === t2?.id) s2++;
      }

      // Jogadores do game ativo — tenta match-level primeiro, fallback game-level se gold=0
      let players = Array.isArray(activeGame.players) ? activeGame.players : [];

      // Se game running mas sem gold, tenta /lol/games/{gameId} que pode ter dados mais frescos
      if (activeGame.status === 'running' && activeGame.id && !players.some(pl => pl.total_gold > 0)) {
        try {
          const gr = await httpGet(`https://api.pandascore.co/lol/games/${activeGame.id}`, headers);
          if (gr.status === 200) {
            const gd = safeParse(gr.body, {});
            const gPlayers = Array.isArray(gd.players) ? gd.players : [];
            if (gPlayers.some(pl => pl.total_gold > 0)) {
              players = gPlayers;
              log('INFO', 'PS-COMPS', `Game-level fallback ${activeGame.id}: gold found via /lol/games/`);
            }
          }
        } catch (_) {}
      }

      function buildTeam(teamObj, side) {
        const teamId = teamObj?.id;
        const teamPlayers = players
          .filter(pl => pl.team_id === teamId || pl.side === side)
          .map(pl => ({
            role: pl.role || '?',
            name: pl.player?.name || pl.name || '?',
            champion: pl.champion?.name || pl.champion_id || '?',
            kills: pl.kills || 0,
            deaths: pl.deaths || 0,
            assists: pl.assists || 0,
            gold: pl.total_gold || 0,
            cs: pl.minions_killed || 0
          }));
        return { name: teamObj?.name || side, players: teamPlayers };
      }

      const blueTeam = buildTeam(t1, 'blue');
      const redTeam = buildTeam(t2, 'red');

      // Stats do game ativo (se running)
      const hasLiveStats = activeGame.status === 'running' && players.some(pl => pl.total_gold > 0);
      const totalGoldBlue = blueTeam.players.reduce((s, pl) => s + pl.gold, 0);
      const totalGoldRed = redTeam.players.reduce((s, pl) => s + pl.gold, 0);

      sendJson(res, {
        matchId: rawId,
        hasCompositions: blueTeam.players.length > 0 || redTeam.players.length > 0,
        hasLiveStats,
        gameNumber: activeGame.position || 1,
        seriesScore: `${s1}-${s2}`,
        gameStatus: activeGame.status || 'unknown',
        blueTeam: { ...blueTeam, totalGold: totalGoldBlue, towerKills: 0, dragons: 0 },
        redTeam: { ...redTeam, totalGold: totalGoldRed, towerKills: 0, dragons: 0 },
        _source: 'pandascore'
      });
    } catch(e) {
      log('ERROR', 'PS-COMPS', e.message);
      sendJson(res, { hasCompositions: false, error: e.message });
    }
    return;
  }

  // ── Diagnóstico: varredura completa de livestats de um gameId específico ──
  if (p === '/debug-livestats') {
    const gameId = parsed.query.gameId;
    if (!gameId) { sendJson(res, { error: 'Missing gameId. Uso: /debug-livestats?gameId=X' }, 400); return; }
    try {
      const base = `https://feed.lolesports.com/livestats/v1/window/${gameId}`;
      const baseNoHdr = await httpGet(base, {});
      const baseWithKey = await httpGet(base, LOL_HEADERS);
      const scanDelays = [30, 45, 60, 90, 120, 150, 180, 240, 300, 420, 600, 900, 1200, 1800, 2400, 3600];
      const scan = [];
      let firstGold = null;
      for (const secAgo of scanDelays) {
        const ts = new Date(Math.floor((Date.now() - secAgo * 1000) / 10000) * 10000).toISOString();
        const r = await httpGet(`${base}?startingTime=${encodeURIComponent(ts)}`, LOL_HEADERS);
        const d = r.status === 200 ? safeParse(r.body, {}) : null;
        const framesCount = d?.frames?.length || 0;
        const anyGold = !!(d?.frames?.some(f => f.blueTeam?.totalGold > 0));
        const maxBlue = Math.max(0, ...(d?.frames?.map(f => f.blueTeam?.totalGold || 0) || [0]));
        const maxRed  = Math.max(0, ...(d?.frames?.map(f => f.redTeam?.totalGold  || 0) || [0]));
        const hasMeta = !!d?.gameMetadata;
        scan.push({ secAgo, ts, status: r.status, framesCount, anyGold, maxBlue, maxRed, hasMeta });
        if (anyGold && !firstGold) firstGold = { secAgo, maxBlue, maxRed, framesCount };
      }
      // Tenta /details também (player data)
      const detailsBase = `https://feed.lolesports.com/livestats/v1/details/${gameId}`;
      const detTs = new Date(Math.floor((Date.now() - 90000) / 10000) * 10000).toISOString();
      const detR = await httpGet(`${detailsBase}?startingTime=${encodeURIComponent(detTs)}`, LOL_HEADERS);
      const detD = detR.status === 200 ? safeParse(detR.body, {}) : null;
      sendJson(res, {
        gameId,
        apiKey: LOL_KEY ? `${LOL_KEY.slice(0, 8)}…${LOL_KEY.slice(-4)}` : 'none',
        baseNoHdr: baseNoHdr.status,
        baseWithKey: baseWithKey.status,
        firstGold,
        detailsStatus: detR.status,
        detailsFramesCount: detD?.frames?.length || 0,
        scan
      });
    } catch(e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  // ── OpenDota: live stats de Dota 2 (github.com/odota/core) ──
  if (p === '/opendota-live') {
    const t1 = String(parsed.query.team1 || '').trim();
    const t2 = String(parsed.query.team2 || '').trim();
    if (!t1 || !t2) { sendJson(res, { hasLiveStats: false, error: 'team1/team2 obrigatórios' }); return; }
    try {
      const apiKeyQs = process.env.OPENDOTA_API_KEY ? `?api_key=${encodeURIComponent(process.env.OPENDOTA_API_KEY)}` : '';
      const [liveR, heroesR] = await Promise.all([
        httpGet(`https://api.opendota.com/api/live${apiKeyQs}`, {}),
        (global.__odHeroesCache && (Date.now() - global.__odHeroesCache.ts) < 24*60*60*1000)
          ? Promise.resolve({ status: 200, body: JSON.stringify(global.__odHeroesCache.data) })
          : httpGet(`https://api.opendota.com/api/heroes${apiKeyQs}`, {}),
      ]);
      if (liveR.status !== 200) { sendJson(res, { hasLiveStats: false, error: `OpenDota status ${liveR.status}` }); return; }
      const heroes = safeParse(heroesR.body, []) || [];
      if (Array.isArray(heroes) && heroes.length) global.__odHeroesCache = { ts: Date.now(), data: heroes };
      const heroById = {};
      for (const h of (Array.isArray(heroes) ? heroes : [])) heroById[h.id] = h.localized_name || h.name;

      const live = safeParse(liveR.body, []) || [];
      if (!Array.isArray(live) || !live.length) { sendJson(res, { hasLiveStats: false, error: 'sem partidas ao vivo' }); return; }

      const normName = (s) => String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
      const n1 = normName(t1), n2 = normName(t2);
      const nameMatches = (a, b) => {
        // Ambos lados precisam ter ≥3 chars para evitar false-positive
        // (string vazia sempre está "contida", casaria partida errada)
        if (!a || !b || a.length < 3 || b.length < 3) return false;
        return a.includes(b) || b.includes(a);
      };

      // Bo3/Bo5 geram múltiplos matches simultâneos no OpenDota (games da série).
      // Pegar o MAIS RECENTE (maior game_time) pra bater com o game que está rolando agora.
      const candidates = [];
      for (const m of live) {
        const rn = normName(m.team_name_radiant || m.radiant_team?.team_name || m.radiant_team?.name);
        const dn = normName(m.team_name_dire    || m.dire_team?.team_name    || m.dire_team?.name);
        if (nameMatches(rn, n1) && nameMatches(dn, n2)) candidates.push({ m, swap: false });
        else if (nameMatches(rn, n2) && nameMatches(dn, n1)) candidates.push({ m, swap: true });
      }
      if (!candidates.length) { sendJson(res, { hasLiveStats: false, error: 'match não encontrado no OpenDota live' }); return; }
      // Prefere match com game_time válido e maior timestamp (mais recente iniciado)
      candidates.sort((a, b) => {
        const ga = a.m.game_time || 0, gb = b.m.game_time || 0;
        if (ga > 0 && gb <= 0) return -1;
        if (gb > 0 && ga <= 0) return 1;
        return (b.m.activate_time || 0) - (a.m.activate_time || 0);
      });
      const hit = candidates[0].m;
      const swap = candidates[0].swap;

      const players = Array.isArray(hit.players) ? hit.players : [];
      const buildSide = (teamFlag) => {
        const ps = players.filter(p => (teamFlag === 'radiant' ? p.team === 0 : p.team === 1))
          .map(p => ({
            name: p.name || p.personaname || '?',
            hero: heroById[p.hero_id] || (p.hero_id ? `hero${p.hero_id}` : '?'),
            kills: p.kills || 0,
            deaths: p.deaths || 0,
            assists: p.assists || 0,
            gold: p.net_worth || p.gold || 0,
            level: p.level || 0,
            lastHits: p.last_hits || 0,
          }));
        return {
          name: teamFlag === 'radiant'
            ? (hit.team_name_radiant || hit.radiant_team?.team_name || 'Radiant')
            : (hit.team_name_dire    || hit.dire_team?.team_name    || 'Dire'),
          players: ps,
          totalGold: ps.reduce((s, p) => s + (p.gold || 0), 0),
          totalKills: teamFlag === 'radiant' ? (hit.radiant_score || 0) : (hit.dire_score || 0),
        };
      };
      const radiant = buildSide('radiant');
      const dire = buildSide('dire');
      const blue = swap ? dire : radiant;
      const red  = swap ? radiant : dire;
      // BUG FIX 2026-04-15: OpenDota /api/live não retorna mais per-player net_worth/gold.
      // Antes usávamos totalGold (soma) que ficava sempre 0 → hasLiveStats sempre false.
      // Agora consideramos live se game_time > 0 (partida realmente rolando) OU kills agregados.
      let hasPlayerStats = (blue.totalGold + red.totalGold) > 0;
      const hasAggregateStats = (hit.game_time || 0) > 0 || (hit.radiant_score || 0) + (hit.dire_score || 0) > 0;

      // ── Enriquecimento Steam WebAPI (per-player gold/KDA/items) ──
      // Requer STEAM_WEBAPI_KEY no .env. Chave é gratuita em https://steamcommunity.com/dev/apikey
      // Endpoint docs: https://steamapi.xpaw.me/#IDOTA2MatchStats_570/GetRealtimeStats
      let steamSource = false;
      const steamKeyPresent = !!process.env.STEAM_WEBAPI_KEY;
      const steamSid = hit.server_steam_id || null;
      if (steamKeyPresent && steamSid) {
        try {
          const rt = await httpGet(
            `https://api.steampowered.com/IDOTA2MatchStats_570/GetRealtimeStats/v1/?server_steam_id=${encodeURIComponent(steamSid)}&key=${encodeURIComponent(process.env.STEAM_WEBAPI_KEY)}`,
            {}
          );
          log('INFO', 'STEAM-RT', `sid=${steamSid} → status=${rt.status} bodyLen=${(rt.body||'').length}`);
          if (rt.status === 200) {
            const rtd = safeParse(rt.body, {});
            const rtTeams = Array.isArray(rtd?.teams) ? rtd.teams : [];
            // Steam RT usa team_number: 2=radiant, 3=dire (não 0/1 como eu assumi).
            const rtRad = rtTeams.find(t => t.team_number === 2);
            const rtDir = rtTeams.find(t => t.team_number === 3);
            const mkPlayers = (rtTeam, ourSideTeamFlag) => {
              if (!rtTeam?.players?.length) return null;
              return rtTeam.players.map(p => ({
                name: p.name || p.accountid || '?',
                hero: heroById[p.heroid] || (p.heroid ? `hero${p.heroid}` : '?'),
                kills: p.kill_count || 0,
                deaths: p.death_count || 0,
                assists: p.assists_count || 0,
                gold: p.net_worth || 0,
                level: p.level || 0,
                lastHits: p.lh_count || 0,
                items: Array.isArray(p.items) ? p.items.filter(i => i > 0) : [],
              }));
            };
            const radPlayers = mkPlayers(rtRad);
            const dirPlayers = mkPlayers(rtDir);
            if (radPlayers && dirPlayers) {
              radiant.players = radPlayers;
              dire.players = dirPlayers;
              radiant.totalGold = rtRad.net_worth || radPlayers.reduce((s, p) => s + (p.gold || 0), 0);
              dire.totalGold    = rtDir.net_worth || dirPlayers.reduce((s, p) => s + (p.gold || 0), 0);
              radiant.totalKills = rtRad.score || radiant.totalKills;
              dire.totalKills    = rtDir.score || dire.totalKills;
              radiant.towerKills = rtRad.building_state ? undefined : radiant.towerKills;
              hasPlayerStats = true;
              steamSource = true;
              // Re-atribui blue/red após swap
              const nb = swap ? dire : radiant;
              const nr = swap ? radiant : dire;
              Object.assign(blue, nb);
              Object.assign(red, nr);
              log('INFO', 'STEAM-RT', `Dota RT ${hit.match_id}: per-player OK (${radPlayers.length}v${dirPlayers.length})`);
            }
          } else {
            log('INFO', 'STEAM-RT', `Dota RT ${hit.match_id}: status=${rt.status}`);
          }
        } catch (e) { log('WARN', 'STEAM-RT', `${hit.match_id}: ${e.message}`); }
      }

      const hasLiveStats = hasPlayerStats || hasAggregateStats;
      // Estimativa de gold a partir de radiant_lead + score quando per-player ausente.
      if (!hasPlayerStats && hasAggregateStats) {
        const lead = Math.abs(hit.radiant_lead || 0);
        // Net worth aproximado: ~25k/team aos 30min (benchmark pro). Escalável por game_time.
        const baseNetworth = Math.round(Math.max(2500, (hit.game_time || 0) / 60 * 800));
        const rLead = hit.radiant_lead || 0;
        const radNet = baseNetworth + (rLead > 0 ? Math.round(lead / 2) : -Math.round(lead / 2));
        const dirNet = baseNetworth - (rLead > 0 ? Math.round(lead / 2) : -Math.round(lead / 2));
        radiant.totalGold = Math.max(0, radNet);
        dire.totalGold = Math.max(0, dirNet);
        (swap ? [red, blue] : [blue, red]).forEach((t, i) => {
          t.totalGold = i === 0 ? radiant.totalGold : dire.totalGold;
          t._estimated = true;
        });
      }

      sendJson(res, {
        hasLiveStats,
        hasPlayerStats,
        hasAggregateStats,
        matchId: hit.match_id,
        gameTime: hit.game_time || 0,
        radiantLead: (swap ? -1 : 1) * (hit.radiant_lead || 0),
        blueTeam: blue,
        redTeam:  red,
        _source: steamSource ? 'opendota+steam-rt' : 'opendota',
        _debug: { steamKeyPresent, steamSid, steamSource }
      });
    } catch(e) {
      log('ERROR', 'OPENDOTA', e.message);
      sendJson(res, { hasLiveStats: false, error: e.message });
    }
    return;
  }

  // ── PandaScore: live stats de Dota 2 ──
  if (p === '/ps-dota-live') {
    const rawId = parsed.query.matchId || '';
    const psId = rawId.replace(/^ps_/, '');
    if (!psId || !PANDASCORE_TOKEN || PANDASCORE_TOKEN === 'your-pandascore-token') {
      sendJson(res, { hasLiveStats: false, error: 'Token PandaScore não configurado' });
      return;
    }
    try {
      const headers = { 'Authorization': `Bearer ${PANDASCORE_TOKEN}` };
      const r = await httpGet(`https://api.pandascore.co/dota2/matches/${psId}`, headers);
      if (r.status !== 200) {
        sendJson(res, { hasLiveStats: false, error: `PS status ${r.status}` });
        return;
      }
      const m = safeParse(r.body, {});
      const ops = m.opponents || [];
      const t1 = ops[0]?.opponent, t2 = ops[1]?.opponent;
      const games = Array.isArray(m.games) ? m.games : [];
      const activeGame = games.find(g => g.status === 'running') || games[games.length - 1];
      if (!activeGame) { sendJson(res, { hasLiveStats: false, error: 'Nenhum game disponível' }); return; }

      let s1 = 0, s2 = 0;
      for (const g of games) {
        if (!g.winner) continue;
        if (g.winner.id === t1?.id) s1++;
        else if (g.winner.id === t2?.id) s2++;
      }

      const players = Array.isArray(activeGame.players) ? activeGame.players : [];
      const buildTeam = (teamObj, side) => {
        const teamId = teamObj?.id;
        const tp = players
          .filter(pl => pl.team_id === teamId || pl.side === side)
          .map(pl => ({
            name: pl.player?.name || pl.name || '?',
            hero: pl.hero?.name || '?',
            kills: pl.kills || 0,
            deaths: pl.deaths || 0,
            assists: pl.assists || 0,
            gold: pl.total_gold || pl.gold || 0,
            lastHits: pl.last_hits || 0,
            level: pl.level || 0,
          }));
        return { name: teamObj?.name || side, players: tp };
      };
      const blueTeam = buildTeam(t1, 'radiant');
      const redTeam  = buildTeam(t2, 'dire');
      const hasLiveStats = activeGame.status === 'running' && players.some(pl => (pl.total_gold || pl.gold || 0) > 0);
      const totalGoldBlue = blueTeam.players.reduce((s, pl) => s + pl.gold, 0);
      const totalGoldRed  = redTeam.players.reduce((s, pl) => s + pl.gold, 0);
      const totalKillsBlue = blueTeam.players.reduce((s, pl) => s + pl.kills, 0);
      const totalKillsRed  = redTeam.players.reduce((s, pl) => s + pl.kills, 0);

      sendJson(res, {
        matchId: rawId,
        hasLiveStats,
        gameNumber: activeGame.position || 1,
        seriesScore: `${s1}-${s2}`,
        gameStatus: activeGame.status || 'unknown',
        blueTeam: { ...blueTeam, totalGold: totalGoldBlue, totalKills: totalKillsBlue },
        redTeam:  { ...redTeam,  totalGold: totalGoldRed,  totalKills: totalKillsRed },
        _source: 'pandascore'
      });
    } catch(e) {
      log('ERROR', 'PS-DOTA', e.message);
      sendJson(res, { hasLiveStats: false, error: e.message });
    }
    return;
  }

  if (p === '/live-game') {
    const gameId = parsed.query.gameId;
    if (!gameId) { sendJson(res, { error: 'Missing gameId' }, 400); return; }
    try {
      const base = `https://feed.lolesports.com/livestats/v1/window/${gameId}`;

      // 1) Buscar metadata do jogo (times, campeões, etc).
      //    BUG confirmado 2026-04-15: x-api-key causa 204 em jogos inProgress (LCK/LEC/etc).
      //    Sem key funciona. Para completed games, key funciona também — mas usar sem key é seguro.
      let wr = await httpGet(base, {});
      if (wr.status !== 200) wr = await httpGet(base, LOL_HEADERS); // fallback com key
      const raw = wr.status === 200 ? safeParse(wr.body, {}) : {};
      if (wr.status !== 200) {
        log('INFO', 'LIVE-GAME', `window/${gameId}: base status=${wr.status} — tentando varredura mesmo assim`);
      }

      // 2) Varredura paralela. DESCOBERTA 2026-04-15: Riot retém livestats em janela curta
      //    (~15-100s). Timestamps mais antigos retornam 204. Prioriza janelas recentes.
      //    Adicionado 5s/10s: janela de Riot pode ser ainda mais apertada (~5-30s).
      const scanDelays = [5, 10, 15, 20, 30, 45, 60, 75, 90, 120, 150, 180, 240, 300, 600, 1200];
      let frames = [];
      let usedTs = null;
      let statsDisabled = false;
      const scanResults = await Promise.all(scanDelays.map(async (secAgo) => {
        const ts = new Date(Math.floor((Date.now() - secAgo * 1000) / 10000) * 10000).toISOString();
        // Sem key: evita 204 em inProgress games
        const r = await httpGet(`${base}?startingTime=${encodeURIComponent(ts)}`, {}).catch(() => ({ status: 0, body: '' }));
        return { secAgo, status: r.status, body: r.body };
      }));
      const scanStatuses = scanResults.map(r => `${r.secAgo}s=${r.status}`);
      if (scanResults.some(r => r.status === 404 && /Stats are disabled/i.test(String(r.body || '')))) {
        statsDisabled = true;
      }
      if (!statsDisabled) {
        // Prefere o resultado com mais frames de gold real; preserva ordem (90s primeiro).
        let bestScore = -1;
        for (const r of scanResults) {
          if (r.status !== 200) continue;
          const d = safeParse(r.body, {});
          const hasGold = d.frames?.length && d.frames.some(f => f.blueTeam?.totalGold > 0);
          const score = hasGold ? 1000 + (d.frames.length || 0) : (d.frames?.length || 0);
          if (score > bestScore) {
            bestScore = score;
            frames = d.frames || [];
            usedTs = r.secAgo;
            if (!raw.gameMetadata && d.gameMetadata) raw.gameMetadata = d.gameMetadata;
          }
        }
        if (bestScore < 1000) usedTs = null; // sem gold real encontrado
      }
      const hasDraft = !!(raw.gameMetadata?.blueTeamMetadata?.participantMetadata?.length);
      if (statsDisabled) {
        // Riot desabilita feed público em muitas ligas tier-2 — limitação externa, sem ação possível.
        // Rebaixado pra DEBUG para não poluir log.
        log('DEBUG', 'LIVE-GAME', `window/${gameId}: Stats DISABLED pela Riot — draft=${hasDraft ? 'ok' : 'no'}`);
      } else if (usedTs === null) {
        // 204 em todas as janelas — provável liga sem feed público ou jogo ainda no draft
        const has200 = scanResults.filter(r => r.status === 200).length;
        const has204 = scanResults.filter(r => r.status === 204).length;
        const logLevel = has200 > 0 ? 'INFO' : 'DEBUG';
        log(logLevel, 'LIVE-GAME', `window/${gameId}: sem gold (200s=${has200} 204s=${has204} frames=${frames.length}, draft=${hasDraft ? 'ok' : 'no'}, melhor: ${scanStatuses.slice(0, 6).join(',')})`);
      } else {
        log('INFO', 'LIVE-GAME', `window/${gameId}: gold encontrado a ${usedTs}s atrás (${frames.length} frames)`);
      }

      // 4) Último recurso: usar frames iniciais
      if (!frames.length) frames = raw.frames || [];

      const blue = raw.gameMetadata?.blueTeamMetadata;
      const red = raw.gameMetadata?.redTeamMetadata;
      // Frame com mais gold = mais recente com dados reais
      const best = frames.length
        ? frames.reduce((b, f) => ((f.blueTeam?.totalGold || 0) > (b?.blueTeam?.totalGold || 0) ? f : b), frames[frames.length - 1])
        : null;
      const frameAge = best?.rfc460Timestamp
        ? Math.round((Date.now() - new Date(best.rfc460Timestamp).getTime()) / 1000)
        : null;
      const gameState = best?.gameState || 'in_progress';
      const hasLiveStats = !!(best?.blueTeam?.totalGold > 0);

      // Lookup de participantes por participantId (correto)
      function mkLookup(teamFrame) {
        const lk = {};
        (teamFrame?.participants || []).forEach(p => {
          if (p.participantId !== undefined) lk[p.participantId] = p;
        });
        return lk;
      }
      const blk = mkLookup(best?.blueTeam), rlk = mkLookup(best?.redTeam);

      function mp(meta, lk) {
        const s = lk[meta.participantId] || {};
        return {
          role: meta.role,
          name: meta.esportsPlayer?.summonerName || meta.summonerName || '?',
          champion: meta.championId,
          level: s.level || 0,
          kills: s.kills || 0,
          deaths: s.deaths || 0,
          assists: s.assists || 0,
          gold: s.totalGold || s.totalGoldEarned || 0,
          cs: s.creepScore || 0
        };
      }

      // Gold trajectory — ~15 pontos de dados
      const goldTrajectory = [];
      if (frames.length > 1) {
        const step = Math.max(1, Math.floor(frames.length / 15));
        for (let i = 0; i < frames.length; i += step) {
          const f = frames[i];
          const blueGold = f.blueTeam?.totalGold || 0;
          const redGold = f.redTeam?.totalGold || 0;
          if (blueGold > 0 || redGold > 0) {
            const gameTime = f.gameState === 'in_game'
              ? Math.round((new Date(f.rfc460Timestamp || 0).getTime() - new Date(frames[0]?.rfc460Timestamp || 0).getTime()) / 60000)
              : i;
            goldTrajectory.push({ minute: gameTime, diff: blueGold - redGold, blue: blueGold, red: redGold });
          }
        }
      }

      sendJson(res, {
        gameId,
        gameState,
        hasLiveStats,
        hasDraft,
        statsDisabled,
        framesTotal: frames.length,
        dataDelay: frameAge,
        goldTrajectory,
        blueTeam: {
          name: blue?.esportsTeam?.name || 'Blue',
          totalGold: best?.blueTeam?.totalGold || 0,
          towerKills: best?.blueTeam?.towers || 0,
          dragons: Array.isArray(best?.blueTeam?.dragons) ? best.blueTeam.dragons.length : (best?.blueTeam?.dragons || 0),
          dragonTypes: Array.isArray(best?.blueTeam?.dragons) ? best.blueTeam.dragons : [],
          barons: best?.blueTeam?.barons || 0,
          totalKills: best?.blueTeam?.totalKills || 0,
          inhibitors: best?.blueTeam?.inhibitors || 0,
          players: (blue?.participantMetadata || []).map(m => mp(m, blk))
        },
        redTeam: {
          name: red?.esportsTeam?.name || 'Red',
          totalGold: best?.redTeam?.totalGold || 0,
          towerKills: best?.redTeam?.towers || 0,
          dragons: Array.isArray(best?.redTeam?.dragons) ? best.redTeam.dragons.length : (best?.redTeam?.dragons || 0),
          dragonTypes: Array.isArray(best?.redTeam?.dragons) ? best.redTeam.dragons : [],
          barons: best?.redTeam?.barons || 0,
          totalKills: best?.redTeam?.totalKills || 0,
          inhibitors: best?.redTeam?.inhibitors || 0,
          players: (red?.participantMetadata || []).map(m => mp(m, rlk))
        }
      });
    } catch(e) {
      log('ERROR', 'LIVE-GAME', e.message);
      sendJson(res, { error: e.message, hasLiveStats: false }, 500);
    }
    return;
  }

  if (p === '/odds') {
    const t1 = parsed.query.team1 || parsed.query.p1 || '';
    const t2 = parsed.query.team2 || parsed.query.p2 || '';
    if (!t1 || !t2) { sendJson(res, { error: 'team1 e team2 obrigatórios' }, 400); return; }
    const gameParam = (parsed.query.game || '').toLowerCase();
    // Dota 2: LINE SHOPPING — busca SX.Bet + Pinnacle + TheOddsAPI em paralelo
    if (gameParam === 'dota2' || gameParam === 'dota') {
      const liveOnly = parsed.query.live === '1';
      const dotaMapNumber = parsed.query.map ? parseInt(parsed.query.map, 10) : null;
      const candidates = [];

      const normTeam = s => String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
      const n1 = normTeam(t1), n2 = normTeam(t2);
      const matchesTeams = (mt1, mt2) => {
        const mn1 = normTeam(mt1), mn2 = normTeam(mt2);
        return (mn1.includes(n1) || n1.includes(mn1)) && (mn2.includes(n2) || n2.includes(mn2));
      };

      // Busca em paralelo: SX.Bet + Pinnacle + TheOddsAPI cache
      const [sxResult, pinResult] = await Promise.all([
        // SX.Bet
        SXBET_ENABLED
          ? (async () => {
              const dotaSportId = await sxFindDotaSportId().catch(() => null);
              return sxGetMatchWinnerOdds(t1, t2, { sportId: dotaSportId, liveOnly, _debug: false }).catch(() => null);
            })()
          : null,
        // Pinnacle
        process.env.PINNACLE_DOTA === 'true'
          ? (async () => {
              const pinMatches = await getPinnacleDotaMatches().catch(() => []);
              const pinHit = pinMatches.find(m => matchesTeams(m.team1, m.team2));
              if (!pinHit) return null;
              const swap = !normTeam(pinHit.team1).includes(n1) && !n1.includes(normTeam(pinHit.team1));
              const pinMatchupId = String(pinHit.id || '').replace(/^pin_/, '');
              if (dotaMapNumber && dotaMapNumber > 0 && pinMatchupId) {
                const mapMl = await pinnacle.getMatchupMoneylineByPeriod(pinMatchupId, dotaMapNumber).catch(() => null);
                if (mapMl?.oddsHome && mapMl?.oddsAway) {
                  const [th, ta] = swap ? [mapMl.oddsAway, mapMl.oddsHome] : [mapMl.oddsHome, mapMl.oddsAway];
                  return { t1: String(th), t2: String(ta), bookmaker: 'Pinnacle', mapMarket: true, mapRequested: dotaMapNumber };
                }
              }
              if (pinHit.odds) {
                return { ...pinHit.odds, bookmaker: 'Pinnacle', seriesOnly: true };
              }
              return null;
            })()
          : null,
      ]);

      if (sxResult?.t1) candidates.push(sxResult);
      if (pinResult?.t1) candidates.push(pinResult);

      // TheOddsAPI cache (fallback, não precisa de await)
      if (THE_ODDS_API_KEY && !liveOnly && !dotaMapNumber) {
        const cached = _dotaOddsCache.data.find(m => matchesTeams(m.team1, m.team2));
        if (cached?.odds?.t1) candidates.push({ ...cached.odds, bookmaker: cached.odds.bookmaker || 'TheOddsAPI' });
      }

      if (!candidates.length) {
        sendJson(res, { error: `odds Dota 2 não encontradas${dotaMapNumber ? ` (mapa ${dotaMapNumber})` : ''}` });
        return;
      }

      // LINE SHOPPING: retorna melhor odd + sharp reference
      const best = candidates.reduce((a, b) => {
        const aMax = Math.max(parseFloat(a.t1) || 0, parseFloat(a.t2) || 0);
        const bMax = Math.max(parseFloat(b.t1) || 0, parseFloat(b.t2) || 0);
        return bMax > aMax ? b : a;
      });
      const pinCandidate = candidates.find(c => c.bookmaker === 'Pinnacle');
      if (pinCandidate) {
        best._sharp = { t1: pinCandidate.t1, t2: pinCandidate.t2, bookmaker: 'Pinnacle' };
      }
      if (candidates.length > 1) {
        best._allOdds = candidates.map(c => ({ t1: c.t1, t2: c.t2, bookmaker: c.bookmaker }));
        log('INFO', 'ODDS', `LINE SHOP Dota: ${t1} vs ${t2} → best=${best.bookmaker} (${candidates.map(c => `${c.bookmaker}:${c.t1}/${c.t2}`).join(' | ')})`);
      }
      sendJson(res, best);
      return;
    }
    const mapNumber = parsed.query.map ? parseInt(parsed.query.map, 10) : null;
    const score1 = parsed.query.score1 != null ? parseInt(parsed.query.score1, 10) : null;
    const score2 = parsed.query.score2 != null ? parseInt(parsed.query.score2, 10) : null;
    const format = parsed.query.format ? String(parsed.query.format) : '';
    // LoL: LINE SHOPPING — busca SX.Bet + Pinnacle em paralelo, retorna melhor preço
    if (gameParam === 'lol') {
      const liveOnly = !!(mapNumber && mapNumber > 0);
      const candidates = []; // { t1, t2, bookmaker, ... }

      // Busca em paralelo: SX.Bet + Pinnacle
      const pinEntry = (() => {
        const nt1 = norm(t1), nt2 = norm(t2);
        for (const [k, v] of Object.entries(oddsCache)) {
          if (!k.startsWith('esports_pin_')) continue;
          const vt1 = norm(v?.t1Name || ''), vt2 = norm(v?.t2Name || '');
          if ((vt1.includes(nt1) || nt1.includes(vt1)) && (vt2.includes(nt2) || nt2.includes(vt2))) return v;
          if ((vt1.includes(nt2) || nt2.includes(vt1)) && (vt2.includes(nt1) || nt1.includes(vt2))) return { ...v, _swap: true };
        }
        return null;
      })();

      const [sxResult, pinResult] = await Promise.all([
        // SX.Bet
        SXBET_ENABLED
          ? sxGetMatchWinnerOdds(t1, t2, { liveOnly, mapNumber: liveOnly ? mapNumber : null }).catch(() => null)
          : null,
        // Pinnacle
        (pinEntry?.fixtureId ? (async () => {
          const pinMatchupId = String(pinEntry.fixtureId).replace(/^pin_/, '');
          if (mapNumber && mapNumber > 0) {
            const mapMl = await pinnacle.getMatchupMoneylineByPeriod(pinMatchupId, mapNumber).catch(() => null);
            if (mapMl?.oddsHome && mapMl?.oddsAway) {
              const [th, ta] = pinEntry._swap ? [mapMl.oddsAway, mapMl.oddsHome] : [mapMl.oddsHome, mapMl.oddsAway];
              return { t1: String(th), t2: String(ta), bookmaker: 'Pinnacle', mapMarket: true, mapRequested: mapNumber };
            }
          }
          if (!mapNumber) {
            const seriesMl = await pinnacle.getMatchupMoneylineByPeriod(pinMatchupId, 0).catch(() => null);
            if (seriesMl?.oddsHome && seriesMl?.oddsAway) {
              const [th, ta] = pinEntry._swap ? [seriesMl.oddsAway, seriesMl.oddsHome] : [seriesMl.oddsHome, seriesMl.oddsAway];
              return { t1: String(th), t2: String(ta), bookmaker: 'Pinnacle', seriesOnly: true };
            }
            // Cache fallback
            if (pinEntry.t1 && pinEntry.t2) {
              return {
                t1: pinEntry._swap ? pinEntry.t2 : pinEntry.t1,
                t2: pinEntry._swap ? pinEntry.t1 : pinEntry.t2,
                bookmaker: 'Pinnacle', seriesOnly: true, fallback: 'pinnacle-cache'
              };
            }
          }
          return null;
        })() : null),
      ]);

      if (sxResult?.t1) candidates.push(sxResult);
      if (pinResult?.t1) candidates.push(pinResult);

      if (!candidates.length) {
        sendJson(res, { error: `odds LoL não encontradas${mapNumber ? ` (mapa ${mapNumber})` : ''}` });
        return;
      }

      // LINE SHOPPING: retorna melhor preço + sharp line (Pinnacle) separada
      const best = candidates.reduce((a, b) => {
        const aMax = Math.max(parseFloat(a.t1) || 0, parseFloat(a.t2) || 0);
        const bMax = Math.max(parseFloat(b.t1) || 0, parseFloat(b.t2) || 0);
        return bMax > aMax ? b : a;
      });
      // _sharp: odds Pinnacle como referência eficiente (se disponível)
      const pinCandidate = candidates.find(c => c.bookmaker === 'Pinnacle');
      if (pinCandidate) {
        best._sharp = { t1: pinCandidate.t1, t2: pinCandidate.t2, bookmaker: 'Pinnacle' };
      }
      if (candidates.length > 1) {
        best._allOdds = candidates.map(c => ({ t1: c.t1, t2: c.t2, bookmaker: c.bookmaker }));
        log('INFO', 'ODDS', `LINE SHOP LoL: ${t1} vs ${t2} → best=${best.bookmaker} (${candidates.map(c => `${c.bookmaker}:${c.t1}/${c.t2}`).join(' | ')})`);
      }
      sendJson(res, best);
      return;
    }
    // force=1: bypassa TTL do cache (usado para partidas iminentes < 2h)
    if (parsed.query.force === '1') {
      const serveFromCache = (reason) => {
        let oNow = null;
        if (mapNumber && mapNumber > 0) {
          return getMapMlOddsFromFixture(t1, t2, mapNumber).then(mo => {
            if (!mo) {
              const base = findOdds('esports', t1, t2);
              const est = base?.t1 && base?.t2
                ? estimateMapMlFromSeriesOdds(base, { score1, score2, maxWins: _parseFormatMaxWins(format) })
                : null;
              if (est?.t1 && est?.t2) {
                mo = { ...est, mapRequested: mapNumber };
              } else if (base?.t1 && base?.t2) {
                mo = { ...base, mapRequested: mapNumber, mapMarket: false };
              }
            } else { mo.mapRequested = mapNumber; mo.mapMarket = true; }
            sendJson(res, mo || { error: reason });
          });
        } else {
          oNow = findOdds('esports', t1, t2);
          sendJson(res, oNow || { error: reason });
          return Promise.resolve();
        }
      };

      // Se backoff ativo, nunca force (só aumenta spam e não atualiza mesmo)
      if (Date.now() < esportsBackoffUntil) {
        await serveFromCache('odds indisponíveis (backoff ativo)');
        return;
      }

      // Grace period pós-bootstrap: aguarda N segundos antes de permitir force-refresh
      // (evita 429 imediato logo após bootstrap que já consumiu vários requests)
      const graceRemaining = lastBootstrapCompletedTs > 0
        ? (lastBootstrapCompletedTs + BOOTSTRAP_GRACE_MS) - Date.now()
        : 0;
      if (graceRemaining > 0) {
        log('INFO', 'ODDS', `Force-fetch suprimido (grace ${Math.round(graceRemaining/1000)}s pós-bootstrap) — servindo cache para ${t1} vs ${t2}`);
        await serveFromCache('odds não encontradas');
        return;
      }

      // Evita spam/429: se já está buscando odds (ou bootstrap ativo), não reseta TTL de novo
      if (esportsOddsFetching || esportsOddsBootstrapRunning) {
        if (esportsOddsBootstrapRunning) {
          log('INFO', 'ODDS', `Force-fetch suprimido (bootstrap em andamento) — servindo cache para ${t1} vs ${t2}`);
        }
        await serveFromCache('odds não encontradas (fetch em andamento)');
        return;
      }

      // Cooldown por par de times (mesmo que o bot chame em loop)
      const pairKey = `${norm(t1)}v${norm(t2)}`;
      const lastTs = lastForceRefreshByPair.get(pairKey) || 0;
      if (lastTs && (Date.now() - lastTs) < FORCE_REFRESH_COOLDOWN_MS) {
        await serveFromCache('odds não encontradas');
        return;
      }
      lastForceRefreshByPair.set(pairKey, Date.now());
      log('INFO', 'ODDS', `Force refresh solicitado para ${t1} vs ${t2} (partida iminente)`);
      await enqueueForceFetchEsports().catch(() => {});
      const oNowAfter = findOdds('esports', t1, t2);
      if (oNowAfter && (!mapNumber || mapNumber <= 0)) {
        sendJson(res, oNowAfter);
        return;
      }
    }
    await fetchOdds('esports');
    let o = null;
    if (mapNumber && mapNumber > 0) {
      o = await getMapMlOddsFromFixture(t1, t2, mapNumber);
      if (!o) {
        const base = findOdds('esports', t1, t2);
        if (base?.t1 && base?.t2) {
          const est = estimateMapMlFromSeriesOdds(base, { score1, score2, maxWins: _parseFormatMaxWins(format) });
          o = est?.t1 && est?.t2
            ? { ...est, mapRequested: mapNumber }
            : { ...base, mapRequested: mapNumber, mapMarket: false };
        }
      } else {
        o.mapRequested = mapNumber;
        o.mapMarket = true;
      }
    } else {
      o = findOdds('esports', t1, t2);
    }
    // Fallback SX.Bet quando OddsPapi não tem odds (backoff ou partida não listada)
    if (!o && SXBET_ENABLED) {
      const liveOnly = !!(mapNumber && mapNumber > 0);
      o = await sxGetMatchWinnerOdds(t1, t2, { liveOnly, mapNumber: liveOnly ? mapNumber : null }).catch(() => null);
      if (o) log('INFO', 'ODDS', `SX.Bet fallback usado para ${t1} vs ${t2}${liveOnly ? ` (ao vivo mapa ${mapNumber})` : ''}`);
    }
    sendJson(res, o || { error: 'odds não encontradas' });
    return;
  }

  if (p === '/sx-status') {
    const t1q = q.get('t1') || '';
    const t2q = q.get('t2') || '';
    const result = { enabled: SXBET_ENABLED, base: SXBET_BASE_URL };
    if (!SXBET_ENABLED) { sendJson(res, result); return; }
    const sports = await sxGetSports().catch(() => null);
    result.sports_ok = Array.isArray(sports);
    result.sports_count = Array.isArray(sports) ? sports.length : 0;
    result.sports_sample = Array.isArray(sports) ? sports.slice(0, 5).map(s => ({ id: s.sportId, label: s.label })) : null;
    const sportId = await sxFindLoLSportId().catch(() => null);
    result.lol_sport_id = sportId;
    const md = await sxGetMetadata().catch(() => null);
    result.metadata_ok = !!md;
    result.sx_network_chain = md?.addresses ? Object.keys(md.addresses) : null;
    const usdc4162 = md?.addresses?.['4162']?.USDC || md?.addresses?.['4162']?.usdc || null;
    result.usdc_token = usdc4162 ? usdc4162.slice(0, 10) + '...' : null;
    if (t1q && t2q) {
      const odds = await sxGetMatchWinnerOdds(t1q, t2q, { _debug: true }).catch(() => null);
      result.test_t1 = t1q;
      result.test_t2 = t2q;
      result.test_odds = odds;
    }
    sendJson(res, result);
    return;
  }

  if (p === '/debug-odds') {
    const cacheEntries = Object.entries(oddsCache).filter(([k]) => k.startsWith('esports_'));
    const esportsAge = lastEsportsOddsUpdate > 0 ? Math.round((Date.now() - lastEsportsOddsUpdate) / 1000) : null;
    const backoffSec = esportsBackoffUntil > Date.now()
      ? Math.round((esportsBackoffUntil - Date.now()) / 1000)
      : 0;
    const BATCH_SIZE_DBG = Math.max(1, parseInt(process.env.ODDSPAPI_BATCH_SIZE || '3') || 3);
    const tidsForDbg = Array.isArray(cachedEsportsTids) ? cachedEsportsTids : LOL_ACTIVE_TIDS;
    const totalBatches = tidsForDbg.length > 0 ? Math.ceil(tidsForDbg.length / BATCH_SIZE_DBG) : 0;
    const nextBatchIdx = totalBatches > 0 ? esportsBatchCursor % totalBatches : 0;
    const ttlHours = (parseInt(process.env.ESPORTS_ODDS_TTL_H || '') || 3);
    const batchesLeft = totalBatches > 0 ? totalBatches - (esportsBatchCursor % totalBatches) : 0;
    sendJson(res, {
      count: cacheEntries.length,
      lastSync: lastEsportsOddsUpdate ? new Date(lastEsportsOddsUpdate).toISOString() : 'nunca',
      lastSyncAgoSec: esportsAge,
      backoffRemainingSeconds: backoffSec,
      tournamentIdsCache: tidsForDbg.length,
      ttlHours,
      roundRobin: {
        cursor: esportsBatchCursor,
        nextBatch: totalBatches > 0 ? nextBatchIdx + 1 : null,
        totalBatches: totalBatches || null,
        nextTids: tidsForDbg.slice(nextBatchIdx * BATCH_SIZE_DBG, (nextBatchIdx + 1) * BATCH_SIZE_DBG),
        cycleCompletesIn: totalBatches > 0 ? `${batchesLeft * ttlHours}h` : 'sem dados',
      },
      lastApiResponse: lastApiResponse.slice(0, 300),
      slugs: cacheEntries.map(([k, v]) => ({
        slug: v.combinedSlug || norm(v.t1Name || '') + norm(v.t2Name || ''),
        t1: v.t1,
        t2: v.t2
      }))
    });
    return;
  }

  if (p === '/dota-matches') {
    try {
      // ── Fonte primária: Pinnacle (se ativado) → Odds-API.io → The Odds API ──
      let oddsMatches = [];
      if (process.env.PINNACLE_DOTA === 'true') {
        oddsMatches = await getPinnacleDotaMatches().catch(() => []);
      }
      if (!oddsMatches.length) {
        oddsMatches = ODDS_API_IO_KEY
          ? await getOddsApiIoDotaMatches().catch(() => [])
          : (THE_ODDS_API_KEY ? await getTheOddsDotaMatches().catch(() => []) : []);
      }

      // ── Fonte secundária: PandaScore (partidas live + formato Bo3/Bo5) ──
      const psMatches = await getPandaScoreDotaMatches().catch(() => []);

      // Normaliza nome para matching entre fontes
      const normTeam = s => String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');

      // Enriquece The Odds API matches com formato e placar ao vivo do PandaScore
      for (const om of oddsMatches) {
        const n1 = normTeam(om.team1), n2 = normTeam(om.team2);
        const ps = psMatches.find(p => {
          const pn1 = normTeam(p.team1), pn2 = normTeam(p.team2);
          return (pn1.includes(n1) || n1.includes(pn1)) && (pn2.includes(n2) || n2.includes(pn2));
        });
        if (ps) {
          om.format = ps.format || om.format;
          om.leagueSlug = ps.leagueSlug || '';
          om._psId = ps._psId || null;
        }
      }

      // Inclui partidas ao vivo do PandaScore (sem odds The Odds API — live não disponível)
      const liveFromPs = psMatches.filter(p => {
        if (p.status !== 'live') return false;
        const pn1 = normTeam(p.team1), pn2 = normTeam(p.team2);
        return !oddsMatches.some(om => {
          const n1 = normTeam(om.team1), n2 = normTeam(om.team2);
          return (pn1.includes(n1) || n1.includes(pn1)) && (pn2.includes(n2) || n2.includes(pn2));
        });
      });

      // Para partidas ao vivo do PS sem odds The Odds, tenta SX.Bet como fallback
      if (SXBET_ENABLED && liveFromPs.length) {
        const dotaSportId = await sxFindDotaSportId().catch(() => null);
        if (dotaSportId) {
          for (const m of liveFromPs) {
            const o = await sxGetMatchWinnerOdds(m.team1, m.team2, { sportId: dotaSportId, liveOnly: true }).catch(() => null);
            if (o) m.odds = o;
          }
        }
      }

      const combined = [...liveFromPs, ...oddsMatches];
      combined.sort((a, b) => {
        const sa = a.status === 'live' ? 0 : 1;
        const sb = b.status === 'live' ? 0 : 1;
        if (sa !== sb) return sa - sb;
        return new Date(a.time) - new Date(b.time);
      });

      const oddsSrc = ODDS_API_IO_KEY ? 'Odds-API.io' : 'TheOdds';
      log('INFO', 'DOTA2', `/dota-matches: ${combined.length} total (${liveFromPs.length} live PS, ${oddsMatches.length} odds ${oddsSrc})`);
      sendJson(res, combined);
    } catch(e) {
      sendJson(res, []);
    }
    return;
  }

  if (p === '/cs-matches') {
    try {
      const [pinMatches, psMatches] = await Promise.all([
        getPinnacleCsMatches().catch(() => []),
        getPandaScoreCsMatches().catch(() => []),
      ]);

      const normTeam = s => String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');

      // Enriquece Pinnacle com formato/score do PandaScore
      for (const om of pinMatches) {
        const n1 = normTeam(om.team1), n2 = normTeam(om.team2);
        const ps = psMatches.find(p => {
          const pn1 = normTeam(p.team1), pn2 = normTeam(p.team2);
          return (pn1.includes(n1) || n1.includes(pn1)) && (pn2.includes(n2) || n2.includes(pn2));
        });
        if (ps) {
          om.format = ps.format;
          om.leagueSlug = ps.leagueSlug || '';
          om.score1 = ps.score1; om.score2 = ps.score2;
          om._psId = ps._psId || null;
        }
      }

      // Live PS sem odds Pinnacle → inclui mesmo assim
      const liveFromPs = psMatches.filter(p => {
        if (p.status !== 'live') return false;
        const pn1 = normTeam(p.team1), pn2 = normTeam(p.team2);
        return !pinMatches.some(om => {
          const n1 = normTeam(om.team1), n2 = normTeam(om.team2);
          return (pn1.includes(n1) || n1.includes(pn1)) && (pn2.includes(n2) || n2.includes(pn2));
        });
      });

      const combined = [...liveFromPs, ...pinMatches];
      combined.sort((a, b) => {
        const sa = a.status === 'live' ? 0 : 1;
        const sb = b.status === 'live' ? 0 : 1;
        if (sa !== sb) return sa - sb;
        return new Date(a.time) - new Date(b.time);
      });

      log('INFO', 'CS', `/cs-matches: ${combined.length} total (${liveFromPs.length} live PS, ${pinMatches.length} odds Pinnacle)`);
      sendJson(res, combined);
    } catch (e) {
      log('ERROR', 'CS', `/cs-matches: ${e.message}`);
      sendJson(res, []);
    }
    return;
  }

  if (p === '/valorant-matches') {
    try {
      const [pinMatches, psMatches] = await Promise.all([
        getPinnacleValorantMatches().catch(() => []),
        getPandaScoreValorantMatches().catch(() => []),
      ]);

      const normTeam = s => String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');

      for (const om of pinMatches) {
        const n1 = normTeam(om.team1), n2 = normTeam(om.team2);
        const ps = psMatches.find(p => {
          const pn1 = normTeam(p.team1), pn2 = normTeam(p.team2);
          return (pn1.includes(n1) || n1.includes(pn1)) && (pn2.includes(n2) || n2.includes(pn2));
        });
        if (ps) {
          om.format = ps.format;
          om.leagueSlug = ps.leagueSlug || '';
          om.score1 = ps.score1; om.score2 = ps.score2;
          om._psId = ps._psId || null;
        }
      }

      const liveFromPs = psMatches.filter(p => {
        if (p.status !== 'live') return false;
        const pn1 = normTeam(p.team1), pn2 = normTeam(p.team2);
        return !pinMatches.some(om => {
          const n1 = normTeam(om.team1), n2 = normTeam(om.team2);
          return (pn1.includes(n1) || n1.includes(pn1)) && (pn2.includes(n2) || n2.includes(pn2));
        });
      });

      const combined = [...liveFromPs, ...pinMatches];
      combined.sort((a, b) => {
        const sa = a.status === 'live' ? 0 : 1;
        const sb = b.status === 'live' ? 0 : 1;
        if (sa !== sb) return sa - sb;
        return new Date(a.time) - new Date(b.time);
      });

      log('INFO', 'VALORANT', `/valorant-matches: ${combined.length} total (${liveFromPs.length} live PS, ${pinMatches.length} odds Pinnacle)`);
      sendJson(res, combined);
    } catch (e) {
      log('ERROR', 'VALORANT', `/valorant-matches: ${e.message}`);
      sendJson(res, []);
    }
    return;
  }

  // Snapshot agregado para o dashboard: matches live de lol/dota/cs/valorant
  // com odds Pinnacle (quando houver) e um resumo de live stats. Projetado pra
  // ser consumido pelo dashboard via polling (~30s) — assim o user não precisa
  // perguntar "esse jogo tem live stats/odd Pinnacle?" a cada partida.
  if (p === '/live-snapshot') {
    try {
      const selfPort = (req.socket && req.socket.localPort) || PORT;
      const base = `http://127.0.0.1:${selfPort}`;
      const sources = [
        { sport: 'lol',      path: '/lol-matches' },
        { sport: 'dota',     path: '/dota-matches' },
        { sport: 'cs',       path: '/cs-matches' },
        { sport: 'valorant', path: '/valorant-matches' },
      ];

      const fetchMatches = async ({ sport, path: apiPath }) => {
        const r = await httpGet(`${base}${apiPath}`).catch(() => null);
        const items = (r && r.status === 200) ? safeParse(r.body, []) : [];
        return { sport, items: Array.isArray(items) ? items : [] };
      };

      const all = await Promise.all(sources.map(fetchMatches));
      const out = {};

      const nowMs = Date.now();
      const START_TOLERANCE_MS = 90 * 1000; // aceita até 90s antes do horário marcado
      for (const { sport, items } of all) {
        // Filtro duplo: status='live' E (horário já passou OU marcador de progresso).
        // Evita mostrar partidas que o feed marca prematuramente como live antes do kickoff.
        const live = items.filter(m => {
          if (!m || m.status !== 'live') return false;
          const t = m.time ? Date.parse(m.time) : NaN;
          const alreadyStarted = Number.isFinite(t) ? (t - nowMs) <= START_TOLERANCE_MS : true;
          const hasProgress = (m.score1 || 0) > 0 || (m.score2 || 0) > 0;
          return alreadyStarted || hasProgress;
        });
        const rows = [];
        for (const m of live) {
          const odds = m.odds || null;
          const bookmaker = odds ? String(odds.bookmaker || '').trim() : '';
          const pinnacle = /pinnacle/i.test(bookmaker)
            ? { t1: odds.t1, t2: odds.t2 }
            : null;

          const row = {
            matchId: m.id,
            league: m.league || null,
            leagueSlug: m.leagueSlug || null,
            team1: m.team1,
            team2: m.team2,
            format: m.format || null,
            score: (m.score1 != null || m.score2 != null) ? `${m.score1 || 0}-${m.score2 || 0}` : null,
            startTime: m.time || null,
            odds: odds ? { bookmaker: bookmaker || null, t1: odds.t1, t2: odds.t2 } : null,
            pinnacle,
            liveStats: { available: false, gameState: null, gameNumber: null, reason: null, summary: null },
          };

          // Live stats detalhado só pra LoL (livestats Riot + PandaScore compositions).
          if (sport === 'lol') {
            try {
              const idsR = await httpGet(`${base}/live-gameids?matchId=${encodeURIComponent(String(m.id))}`).catch(() => null);
              const ids = (idsR && idsR.status === 200) ? safeParse(idsR.body, []) : [];
              const current = Array.isArray(ids)
                ? (ids.find(x => x.hasLiveData) || ids[ids.length - 1] || null)
                : null;
              if (current?.gameId) {
                const gdR = await httpGet(`${base}/live-game?gameId=${current.gameId}`).catch(() => null);
                const gd = (gdR && gdR.status === 200) ? safeParse(gdR.body, {}) : null;
                if (gd?.statsDisabled) {
                  row.liveStats = { available: false, gameState: gd.gameState || null, gameNumber: current.gameNumber || null, reason: 'stats_disabled', summary: null };
                } else if (gd?.hasLiveStats) {
                  const b = gd.blueTeam || {}, r2 = gd.redTeam || {};
                  const bg = b.totalGold || 0, rg = r2.totalGold || 0;
                  row.liveStats = {
                    available: true,
                    gameState: gd.gameState || null,
                    gameNumber: current.gameNumber || null,
                    reason: null,
                    summary: {
                      blue: { name: b.name || '', gold: bg, kills: b.totalKills || 0, towers: b.towerKills || 0, dragons: (b.dragonTypes?.length ?? b.dragons ?? 0), barons: b.barons || 0, inhibs: b.inhibitors || 0 },
                      red:  { name: r2.name || '', gold: rg, kills: r2.totalKills || 0, towers: r2.towerKills || 0, dragons: (r2.dragonTypes?.length ?? r2.dragons ?? 0), barons: r2.barons || 0, inhibs: r2.inhibitors || 0 },
                      goldDiff: bg - rg,
                      dataDelay: gd.dataDelay || null,
                    },
                  };
                } else if (gd) {
                  row.liveStats = { available: false, gameState: gd.gameState || null, gameNumber: current.gameNumber || null, reason: 'no_live_data', summary: null };
                }
              } else {
                row.liveStats.reason = 'no_gameids';
              }
            } catch (e) {
              row.liveStats.reason = `error:${(e.message || '').slice(0, 60)}`;
            }
          } else if (sport === 'valorant') {
            // Enriquece com VLR.gg quando possível (mapa, lado, round atual).
            const hasScore = m.score1 != null || m.score2 != null;
            let enriched = null;
            try {
              const vlr = require('./lib/vlr');
              const found = await vlr.findLiveMatch(m.team1, m.team2).catch(() => null);
              if (found?.matchId) {
                const stats = await vlr.getMatchStats(found.matchId).catch(() => null);
                if (stats) enriched = vlr.summarizeLive(stats, m.team1, m.team2);
              }
            } catch (_) {}
            row.liveStats = enriched
              ? {
                  available: true,
                  gameState: enriched.isLive ? 'in_progress' : 'between_maps',
                  gameNumber: null,
                  reason: null,
                  summary: {
                    score: `${m.score1 || 0}-${m.score2 || 0}`,
                    currentMap: enriched.currentMap,
                    round: enriched.currentRound,
                    t1: { name: enriched.t1.name, score: enriched.t1.score, ct: enriched.t1.ct, atk: enriched.t1.atk, side: enriched.t1.side },
                    t2: { name: enriched.t2.name, score: enriched.t2.score, ct: enriched.t2.ct, atk: enriched.t2.atk, side: enriched.t2.side },
                    source: 'vlr.gg',
                  },
                }
              : {
                  available: hasScore,
                  gameState: hasScore ? 'in_progress' : null,
                  gameNumber: null,
                  reason: hasScore ? null : 'no_vlr_match',
                  summary: hasScore ? { score: `${m.score1 || 0}-${m.score2 || 0}` } : null,
                };
          } else {
            // Dota/CS — sem feed detalhado aqui; mostra score PS se presente.
            const hasScore = m.score1 != null || m.score2 != null;
            row.liveStats = {
              available: hasScore,
              gameState: hasScore ? 'in_progress' : null,
              gameNumber: null,
              reason: hasScore ? null : 'no_pandascore_data',
              summary: hasScore ? { score: `${m.score1 || 0}-${m.score2 || 0}` } : null,
            };
          }
          rows.push(row);
        }
        rows.sort((a, b) => (b.pinnacle ? 1 : 0) - (a.pinnacle ? 1 : 0));
        out[sport] = rows;
      }

      sendJson(res, { generatedAt: new Date().toISOString(), sports: out });
    } catch (e) {
      sendJson(res, { error: e.message, stack: e.stack }, 500);
    }
    return;
  }

  // Debug: testa o scraper VLR.gg pra um par de times Valorant live.
  //   GET /debug-vlr?team1=KRU%20Spark&team2=ShindeN
  if (p === '/debug-vlr') {
    try {
      const vlr = require('./lib/vlr');
      const team1 = String(parsed.query.team1 || '').trim();
      const team2 = String(parsed.query.team2 || '').trim();
      const matchIdQ = String(parsed.query.matchId || '').trim();
      if (!matchIdQ && (!team1 || !team2)) {
        sendJson(res, { error: 'team1+team2 ou matchId obrigatório' }, 400);
        return;
      }
      const found = matchIdQ ? { matchId: matchIdQ } : await vlr.findLiveMatch(team1, team2).catch(() => null);
      if (!found?.matchId) { sendJson(res, { found: null, reason: 'no_live_match' }); return; }
      const stats = await vlr.getMatchStats(found.matchId).catch(() => null);
      const summary = (team1 && team2) ? vlr.summarizeLive(stats, team1, team2) : null;
      sendJson(res, { found, stats, summary });
    } catch (e) {
      sendJson(res, { error: e.message, stack: e.stack }, 500);
    }
    return;
  }

  // Lista próximos jogos (upcoming) de lol/dota/cs/valorant com odds e horário.
  // Consumido pelo card "Próximos Jogos" do dashboard.
  if (p === '/upcoming-snapshot') {
    try {
      const selfPort = (req.socket && req.socket.localPort) || PORT;
      const base = `http://127.0.0.1:${selfPort}`;
      const sources = [
        { sport: 'lol',      path: '/lol-matches' },
        { sport: 'dota',     path: '/dota-matches' },
        { sport: 'cs',       path: '/cs-matches' },
        { sport: 'valorant', path: '/valorant-matches' },
      ];
      const horizonMs = Math.max(1, Math.min(48, parseInt(parsed.query.hours || '24', 10) || 24)) * 60 * 60 * 1000;
      const now = Date.now();

      const fetchMatches = async ({ sport, path: apiPath }) => {
        const r = await httpGet(`${base}${apiPath}`).catch(() => null);
        const items = (r && r.status === 200) ? safeParse(r.body, []) : [];
        return { sport, items: Array.isArray(items) ? items : [] };
      };
      const all = await Promise.all(sources.map(fetchMatches));

      const out = {};
      for (const { sport, items } of all) {
        const upcoming = items.filter(m => {
          if (!m || m.status !== 'upcoming') return false;
          const t = m.time ? Date.parse(m.time) : NaN;
          if (!Number.isFinite(t)) return false;
          return t > now && (t - now) <= horizonMs;
        });
        upcoming.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
        const rows = upcoming.slice(0, 40).map(m => {
          const odds = m.odds || null;
          const bk = odds ? String(odds.bookmaker || '').trim() : '';
          const pinnacle = /pinnacle/i.test(bk) ? { t1: odds.t1, t2: odds.t2 } : null;
          return {
            matchId: m.id,
            league: m.league || null,
            team1: m.team1,
            team2: m.team2,
            format: m.format || null,
            startTime: m.time,
            startsInMin: Math.round((Date.parse(m.time) - now) / 60000),
            odds: odds ? { bookmaker: bk || null, t1: odds.t1, t2: odds.t2 } : null,
            pinnacle,
          };
        });
        out[sport] = rows;
      }
      sendJson(res, { generatedAt: new Date().toISOString(), horizonHours: horizonMs / 3600000, sports: out });
    } catch (e) {
      sendJson(res, { error: e.message, stack: e.stack }, 500);
    }
    return;
  }

  // Lista todos os times retornados pela API Riot + PandaScore com status de odds
  if (p === '/debug-teams') {
    try {
      const [riotMatches, psMatches] = await Promise.all([
        getLoLMatches().catch(() => []),
        getPandaScoreLolMatches().catch(() => [])
      ]);
      const allMatches = [...riotMatches, ...psMatches];
      const cacheCount = Object.keys(oddsCache).filter(k => k.startsWith('esports_')).length;
      const teamMap = allMatches.map(m => ({
        source: riotMatches.includes(m) ? 'riot' : 'pandascore',
        league: m.league,
        team1: m.team1,
        team2: m.team2,
        team1norm: norm(m.team1),
        team2norm: norm(m.team2),
        hasOdds: !!m.odds,
        odds: m.odds ? { t1: m.odds.t1, t2: m.odds.t2 } : null
      }));
      sendJson(res, {
        total: allMatches.length,
        withOdds: teamMap.filter(m => m.hasOdds).length,
        cacheSize: cacheCount,
        matches: teamMap
      });
    } catch(e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  // Diagnóstico de matching: testa se um par de times encontra odds no cache
  if (p === '/debug-match-odds') {
    const t1 = parsed.query.team1 || '';
    const t2 = parsed.query.team2 || '';
    const nt1 = norm(t1), nt2 = norm(t2);
    const expandWithAliases = n => {
      const variants = new Set([n]);
      const stripSuffixes = (raw) => {
        let s = String(raw || '');
        const suffixes = ['gaming', 'esports', 'team', 'academy', 'club', 'gg', 'esport'];
        let changed = true;
        while (changed) {
          changed = false;
          for (const suf of suffixes) {
            if (s.endsWith(suf) && s.length > suf.length + 3) {
              s = s.slice(0, -suf.length);
              changed = true;
            }
          }
        }
        return s;
      };
      const stripped = stripSuffixes(n);
      if (stripped && stripped !== n) variants.add(stripped);
      for (const v of [n, stripped]) {
        if (v && v.length >= 8) variants.add(v.slice(0, 8));
        if (v && v.length >= 10) variants.add(v.slice(0, 10));
      }
      for (const [key, aliases] of Object.entries(LOL_ALIASES)) {
        if (n.includes(key) || key.includes(n)) { aliases.forEach(a => variants.add(a)); variants.add(key); }
      }
      return [...variants];
    };
    const v1 = expandWithAliases(nt1), v2 = expandWithAliases(nt2);
    const anyMatch = (variants, slug) => variants.some(v => v.length >= 2 && slug.includes(v));
    const cacheEntries = Object.entries(oddsCache).filter(([k]) => k.startsWith('esports_'));
    const checks = cacheEntries.map(([k, val]) => {
      const cs = val.combinedSlug || '';
      return {
        slug: cs,
        t1InSlug: v1.filter(v => v.length >= 2 && cs.includes(v)),
        t2InSlug: v2.filter(v => v.length >= 2 && cs.includes(v)),
        matched: anyMatch(v1, cs) && anyMatch(v2, cs)
      };
    });
    const result = findOdds('esports', t1, t2);
    sendJson(res, {
      query: { team1: t1, team2: t2 },
      normalized: { nt1, nt2 },
      variants1: v1, variants2: v2,
      found: result,
      cacheSize: cacheEntries.length,
      checks
    });
    return;
  }

  // Diagnóstico de odds por mapa (mercados de fixture)
  if (p === '/debug-map-odds') {
    const t1 = parsed.query.team1 || '';
    const t2 = parsed.query.team2 || '';
    const mapNumber = parsed.query.map ? parseInt(parsed.query.map, 10) : 1;
    try {
      const nt1 = norm(t1), nt2 = norm(t2);
      const stripSuffixes = (n) => {
        let s = String(n || '');
        const suffixes = ['gaming', 'esports', 'team', 'academy', 'club', 'gg', 'esport'];
        let changed = true;
        while (changed) {
          changed = false;
          for (const suf of suffixes) {
            if (s.endsWith(suf) && s.length > suf.length + 3) {
              s = s.slice(0, -suf.length);
              changed = true;
            }
          }
        }
        return s;
      };
      const expandLoose = (n) => {
        const base = String(n || '');
        const stripped = stripSuffixes(base);
        const variants = new Set([base, stripped]);
        const bases = [base, stripped].filter(Boolean);
        for (const b of bases) {
          if (b.length >= 8) variants.add(b.slice(0, 8));
          if (b.length >= 10) variants.add(b.slice(0, 10));
        }
        for (const [key, aliases] of Object.entries(LOL_ALIASES)) {
          for (const b of bases) {
            if (b.includes(key) || key.includes(b)) { aliases.forEach(a => variants.add(a)); variants.add(key); }
          }
        }
        return [...variants].filter(v => v && v.length >= 3);
      };
      const v1 = expandLoose(nt1), v2 = expandLoose(nt2);
      const anyMatch = (variants, slug) => variants.some(v => v && (slug.includes(v) || v.includes(slug)));
      const entry = Object.values(oddsCache).find(v => {
        if (!v?.fixtureId) return false;
        const cs = v.combinedSlug || '';
        return anyMatch(v1, cs) && anyMatch(v2, cs);
      });
      if (!entry?.fixtureId) { sendJson(res, { error: 'fixture_not_found' }); return; }
      const fixtureId = String(entry.fixtureId);
      const fixtureCandidates = [fixtureId];
      if (fixtureId.startsWith('id') && fixtureId.length > 4) fixtureCandidates.push(fixtureId.slice(2));
      if (!fixtureId.startsWith('id') && fixtureId.length > 4) fixtureCandidates.push('id' + fixtureId);
      const uniqCandidates = [...new Set(fixtureCandidates)];

      let r = null;
      let fixtureJson = null;
      for (const fid of uniqCandidates) {
        const url = `https://api.oddspapi.io/v4/odds?fixtureId=${fid}&oddsFormat=decimal&verbosity=5&apiKey=${ODDSPAPI_KEY}`;
        r = await cachedHttpGet(url, { provider: 'oddspapi', ttlMs: 0 }).catch(() => null);
        if (r && r.status === 200) {
          fixtureJson = safeParse(r.body, null);
          if (fixtureJson) break;
        }
      }
      if (!fixtureJson) { sendJson(res, { error: 'http_' + (r?.status || 'fail') }); return; }

      const bkOdds = fixtureJson.bookmakerOdds || fixtureJson.bookmakersOdds || {};
      const bk = bkOdds['1xbet'] || bkOdds['1xBet'] || bkOdds['1XBET'] || null;
      const marketsObj = bk?.markets || {};
      const entries = Object.entries(marketsObj || {});
      const names = entries.map(([k, m]) => String((m?.bookmakerMarketId || m?.marketId || k || '')).toString());
      const mapOdds = await getMapMlOddsFromFixture(t1, t2, mapNumber);
      sendJson(res, { fixtureId, map: mapNumber, mapOdds, markets: names.slice(0, 80) });
    } catch(e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  if (p === '/handicap-odds') {
    const t1 = parsed.query.team1 || '';
    const t2 = parsed.query.team2 || '';
    if (!t1 || !t2) { sendJson(res, { error: 'team1 e team2 obrigatórios' }, 400); return; }
    try {
      const nt1 = norm(t1), nt2 = norm(t2);
      const entry = Object.values(oddsCache).find(v => {
        const cs = v.combinedSlug || '';
        return cs.includes(nt1) && cs.includes(nt2);
      });
      if (!entry || !entry.fixtureId) { sendJson(res, { error: 'not_found' }); return; }
      const { fixtureId } = entry;
      const ttlMsRaw = parseInt(process.env.HTTP_CACHE_ODDSPAPI_FIXTURE_TTL_MS || '', 10);
      const ttlMs = Number.isFinite(ttlMsRaw) ? ttlMsRaw : 0;

      const fixtureIdStr = String(fixtureId);
      const fixtureCandidates = [fixtureIdStr];
      if (fixtureIdStr.startsWith('id') && fixtureIdStr.length > 4) fixtureCandidates.push(fixtureIdStr.slice(2));
      if (!fixtureIdStr.startsWith('id') && fixtureIdStr.length > 4) fixtureCandidates.push('id' + fixtureIdStr);
      const uniqCandidates = [...new Set(fixtureCandidates)];

      let r = null;
      let fixtureJson = null;
      for (const fid of uniqCandidates) {
        const url = `https://api.oddspapi.io/v4/odds?fixtureId=${fid}&oddsFormat=decimal&verbosity=5&apiKey=${ODDSPAPI_KEY}`;
        r = await cachedHttpGet(url, { provider: 'oddspapi', ttlMs }).catch(() => null);
        if (r && r.status === 200) {
          fixtureJson = safeParse(r.body, null);
          if (fixtureJson) break;
        }
      }
      if (!fixtureJson) { sendJson(res, { error: 'not_found' }); return; }

      const bkOdds = fixtureJson.bookmakerOdds || fixtureJson.bookmakersOdds || {};
      const bk = bkOdds['1xbet'] || bkOdds['1xBet'] || bkOdds['1XBET'] || null;
      const marketsObj = bk?.markets || {};
      const marketsRaw = Object.entries(marketsObj || {}).map(([k, v]) => ({ ...(v || {}), _key: String(k) }));

      const mkName = (m) => (m?.bookmakerMarketId || m?.marketId || m?._key || '').toString().toLowerCase();
      const pickPrice = (o) => {
        const players = o?.players || o?.playerOdds || {};
        const first = players['0'] || players[0] || Object.values(players || {})[0] || null;
        return extractPrice(first || o);
      };

      const handicapMarkets = marketsRaw.filter(m => {
        const name = mkName(m);
        return name.includes('handicap') || name.includes('map');
      });

      const markets = handicapMarkets.slice(0, 12).map(m => {
        const outcomesObj = m?.outcomes || {};
        const outcomes = Object.values(outcomesObj || {});
        return {
          name: m?.bookmakerMarketId || m?.marketId || '',
          t1Odds: outcomes[0] ? pickPrice(outcomes[0]) : null,
          t2Odds: outcomes[1] ? pickPrice(outcomes[1]) : null
        };
      });
      sendJson(res, { fixtureId: fixtureIdStr, markets });
    } catch(e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  if (p === '/mma-odds') {
    if (!THE_ODDS_API_KEY) { sendJson(res, { hasData: false, error: 'no_key' }); return; }
    const fighter1 = parsed.query.fighter1 || '';
    const fighter2 = parsed.query.fighter2 || '';
    const sport = parsed.query.sport || 'mma_mixed_martial_arts';
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${THE_ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`;
      const r = await theOddsGet(url);
      if (!r || r.status !== 200) { sendJson(res, { hasData: false }); return; }
      const events = safeParse(r.body, []);
      const nf1 = norm(fighter1), nf2 = norm(fighter2);
      let found = null;
      for (const ev of events) {
        const nh = norm(ev.home_team || ''), na = norm(ev.away_team || '');
        if ((nh.includes(nf1) || nf1.includes(nh)) && (na.includes(nf2) || nf2.includes(na))) {
          found = { home: ev.home_team, away: ev.away_team, bookmakers: ev.bookmakers };
          break;
        }
        if ((nh.includes(nf2) || nf2.includes(nh)) && (na.includes(nf1) || nf1.includes(na))) {
          found = { home: ev.away_team, away: ev.home_team, bookmakers: ev.bookmakers, swapped: true };
          break;
        }
      }
      if (!found) { sendJson(res, { hasData: false }); return; }
      const bk = (found.bookmakers || [])[0];
      const h2h = bk?.markets?.find(m => m.key === 'h2h');
      const outcomes = h2h?.outcomes || [];
      const homeOut = outcomes.find(o => norm(o.name) === norm(found.home));
      const awayOut = outcomes.find(o => norm(o.name) === norm(found.away));
      sendJson(res, {
        t1: homeOut?.price ?? null,
        t2: awayOut?.price ?? null,
        bookmaker: bk?.title || '',
        hasData: true
      });
    } catch(e) {
      sendJson(res, { hasData: false, error: e.message });
    }
    return;
  }

  if (p === '/health' || p === '/alerts') {
    const dbOk = (() => {
      try { db.prepare('SELECT 1').get(); return true; } catch(_) { return false; }
    })();
    const pendingBySport = (() => {
      try {
        const rows = db.prepare("SELECT sport, COUNT(*) as c FROM tips WHERE result IS NULL GROUP BY sport").all();
        return Object.fromEntries(rows.map(r => [r.sport, r.c]));
      } catch(_) { return {}; }
    })();
    const esportsOddsAgeMin = lastEsportsOddsUpdate > 0 ? Math.round((Date.now() - lastEsportsOddsUpdate) / 60000) : null;
    const oddspapiBackoffSec = esportsBackoffUntil > Date.now() ? Math.round((esportsBackoffUntil - Date.now()) / 1000) : 0;
    const theOddsQuota = oddsApiQuotaStatus();
    const stale = !lastAnalysisAt || (Date.now() - new Date(lastAnalysisAt).getTime() > 2 * 60 * 60 * 1000);

    // ── Alertas críticos (consumidos pelo bot via polling) ──
    const alerts = [];
    if (!dbOk) alerts.push({ id: 'db_error', severity: 'critical', msg: 'SQLite connection falhou' });
    // OddsPapi descontinuado — odds esports agora vêm de Pinnacle. Alerta suprimido
    // por padrão; reative setando ODDSPAPI_ALERT_ENABLED=true se voltar a usar OddsPapi.
    if (!ODDSPAPI_KEY && /^(1|true|yes)$/i.test(String(process.env.ODDSPAPI_ALERT_ENABLED || ''))) {
      alerts.push({ id: 'oddspapi_key_missing', severity: 'critical', msg: 'ODDS_API_KEY/ODDSPAPI_KEY ausente — odds esports indisponíveis' });
    }
    if (THE_ODDS_API_KEY && theOddsQuota.pct >= 80) {
      alerts.push({ id: 'theodds_quota_high', severity: theOddsQuota.pct >= 95 ? 'critical' : 'warning', msg: `The Odds API quota em ${theOddsQuota.pct}% (${theOddsQuota.used}/${theOddsQuota.cap})` });
    }
    if (oddspapiBackoffSec > 3600) {
      alerts.push({ id: 'oddspapi_backoff_long', severity: 'warning', msg: `OddsPapi 429 backoff ativo há ${Math.round(oddspapiBackoffSec/60)} min` });
    }
    if (ODDSPAPI_KEY && lastEsportsOddsUpdate === 0 && Date.now() - _serverStartTs > 30 * 60 * 1000) {
      alerts.push({ id: 'oddspapi_never_synced', severity: 'critical', msg: 'OddsPapi nunca sincronizou desde o boot (>30min) — verifique chave/quota' });
    }
    if (stale && lastAnalysisAt) {
      alerts.push({ id: 'analysis_stale', severity: 'warning', msg: `Nenhuma análise há >2h (última: ${lastAnalysisAt})` });
    }

    if (p === '/alerts') { sendJson(res, { alerts, ts: new Date().toISOString() }); return; }

    const status = !dbOk ? 'error' : (alerts.some(a => a.severity === 'critical') ? 'degraded' : (stale ? 'degraded' : 'ok'));
    sendJson(res, {
      status,
      db: dbOk ? 'connected' : 'error',
      lastAnalysis: lastAnalysisAt,
      pendingTips: pendingBySport,
      sources: {
        oddspapi: {
          keyConfigured: !!ODDSPAPI_KEY,
          lastSyncMinAgo: esportsOddsAgeMin,
          cacheSize: Object.keys(oddsCache).filter(k => k.startsWith('esports_')).length,
          backoffActive: oddspapiBackoffSec > 0,
          backoffRemainingSec: oddspapiBackoffSec,
        },
        theOddsApi: {
          keyConfigured: !!THE_ODDS_API_KEY,
          quota: theOddsQuota,
        },
        sxbet: { enabled: SXBET_ENABLED },
        apiFootball: { keyConfigured: !!(process.env.API_FOOTBALL_KEY || process.env.API_SPORTS_KEY || process.env.APISPORTS_KEY) },
      },
      alerts,
      metricsLite: getMetricsLite()
    });
    return;
  }

  if (p === '/metrics-lite') {
    sendJson(res, getMetricsLite());
    return;
  }

  if (p === '/record-analysis' && req.method === 'POST') {
    lastAnalysisAt = new Date().toISOString();
    sendJson(res, { ok: true });
    return;
  }

  if (p === '/match-result') {
    const raw = parsed.query.matchId || '';
    const matchId = String(raw).replace(/^lol_/, '');
    const game = parsed.query.game || 'lol';
    try {
      const sr = await httpGet(LOL_BASE + '/getSchedule?hl=en-US', LOL_HEADERS);
      const sd = safeParse(sr.body, {});
      const events = sd?.data?.schedule?.events || [];
      const ev = events.find(e => e.match?.id === matchId && e.state === 'completed');
      if (ev) {
        const t1 = ev.match.teams?.[0], t2 = ev.match.teams?.[1];
        const winner = t1?.result?.outcome === 'win' ? t1.name : t2?.result?.outcome === 'win' ? t2.name : null;
        if (winner) {
          // Persist com o mesmo ID recebido (mantém compatibilidade com tips já gravadas)
          stmts.upsertMatchResult.run(String(raw || matchId), 'lol', t1?.name||'', t2?.name||'', winner, `${t1?.result?.gameWins||0}-${t2?.result?.gameWins||0}`, ev.league?.name||'');
          sendJson(res, { matchId: String(raw || matchId), game, winner, resolved: true });
          return;
        }
      }
      sendJson(res, { matchId: String(raw || matchId), game, resolved: false });
    } catch(e) {
      sendJson(res, { matchId: String(raw || matchId), game, resolved: false, error: e.message });
    }
    return;
  }

  // ── Resultado PandaScore (settlement de tips ps_*) ──
  if (p === '/ps-result') {
    const rawId = parsed.query.matchId || '';
    const psId = rawId.replace('ps_', '');
    if (!psId) { sendJson(res, { resolved: false, error: 'matchId obrigatório' }, 400); return; }
    if (!PANDASCORE_TOKEN) { sendJson(res, { resolved: false, error: 'PANDASCORE_TOKEN não configurado' }); return; }
    try {
      const r = await httpGet(`https://api.pandascore.co/lol/matches/${psId}`, { 'Authorization': `Bearer ${PANDASCORE_TOKEN}` });
      const m = safeParse(r.body, {});
      const winner = m.winner?.name || null;
      if (winner) {
        const t1 = m.opponents?.[0]?.opponent?.name || '';
        const t2 = m.opponents?.[1]?.opponent?.name || '';
        stmts.upsertMatchResult.run(rawId, 'lol', t1, t2, winner, '', m.league?.name || '');
        sendJson(res, { matchId: rawId, winner, resolved: true });
      } else {
        sendJson(res, { matchId: rawId, resolved: false });
      }
    } catch(e) {
      sendJson(res, { matchId: rawId, resolved: false, error: e.message });
    }
    return;
  }

  // ── Resultado PandaScore Dota 2 (settlement de tips dota2_ps_*) ──
  if (p === '/dota-result') {
    const rawId = parsed.query.matchId || '';
    const psId = rawId.replace(/^dota2_ps_/, '').replace(/^ps_/, '');
    if (!psId) { sendJson(res, { resolved: false, error: 'matchId obrigatório' }, 400); return; }
    if (!PANDASCORE_TOKEN) { sendJson(res, { resolved: false, error: 'PANDASCORE_TOKEN não configurado' }); return; }
    try {
      const r = await httpGet(`https://api.pandascore.co/dota2/matches/${psId}`, { 'Authorization': `Bearer ${PANDASCORE_TOKEN}` });
      const m = safeParse(r.body, {});
      const winner = m.winner?.name || null;
      if (winner) {
        const t1 = m.opponents?.[0]?.opponent?.name || '';
        const t2 = m.opponents?.[1]?.opponent?.name || '';
        stmts.upsertMatchResult.run(rawId, 'dota2', t1, t2, winner, '', m.league?.name || '');
        sendJson(res, { matchId: rawId, winner, resolved: true });
      } else {
        sendJson(res, { matchId: rawId, resolved: false });
      }
    } catch(e) {
      sendJson(res, { matchId: rawId, resolved: false, error: e.message });
    }
    return;
  }

  // ── Resultado esports genérico (CS2 / Valorant) — settlement ──
  // Suporta match_id em 2 formas:
  //   <sport>_ps_<id>   → consulta direta PandaScore /<game>/matches/{id}
  //   pin_<sport>_<id>  → match por nomes nos últimos finalizados (Pinnacle ID ≠ PS ID)
  async function resolveEsportsResult({ sport, game, pandaPath, rawId, t1, t2, sentAt }) {
    if (!PANDASCORE_TOKEN) return { resolved: false, error: 'PANDASCORE_TOKEN missing' };
    // Tips podem ter sufixo _MAP{N} (per-phase tip) — usa o ID da série pra resolver.
    // Settlement per-map não é suportado (fonte PS paywall + VLR per-match); usa série winner
    // como best-effort. Pode ser incorreto quando map winner != series winner — aceitável
    // pq tip é de uma fase específica, e resultado final da série ainda informa calibração.
    const baseId = rawId.replace(/_MAP\d+$/, '');
    const psMatch = baseId.match(new RegExp('^' + sport + '_ps_(\\d+)$'));
    if (psMatch) {
      const r = await httpGet(`https://api.pandascore.co/${pandaPath}/matches/${psMatch[1]}`, { 'Authorization': `Bearer ${PANDASCORE_TOKEN}` });
      const m = safeParse(r.body, {});
      const winner = m.winner?.name || null;
      if (winner) {
        const p1 = m.opponents?.[0]?.opponent?.name || t1 || '';
        const p2 = m.opponents?.[1]?.opponent?.name || t2 || '';
        // Use baseId (sem _MAP) pra evitar Elo inflation quando múltiplas phase-tips
        // do mesmo match são settled — INSERT OR IGNORE dedupe series result.
        stmts.upsertMatchResult.run(baseId, game, p1, p2, winner, '', m.league?.name || '');
        return { resolved: true, winner };
      }
      return { resolved: false };
    }
    // Fallback por nomes — exige team1+team2
    if (!t1 || !t2) return { resolved: false, error: 'team1/team2 obrigatórios para match_id sem ps_' };
    const norm = s => String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
    const n1 = norm(t1), n2 = norm(t2);
    const sentMs = sentAt ? Date.parse(sentAt) : NaN;
    const sinceMs = Number.isFinite(sentMs) ? (sentMs - 12 * 3600 * 1000) : (Date.now() - 5 * 86400 * 1000);
    const sinceIso = new Date(sinceMs).toISOString().slice(0, 19);
    const untilIso = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 19);
    for (let page = 1; page <= 3; page++) {
      const url = `https://api.pandascore.co/${pandaPath}/matches/past?per_page=100&page=${page}&sort=-end_at&filter[finished]=true&range[end_at]=${encodeURIComponent(sinceIso)},${encodeURIComponent(untilIso)}`;
      const r = await httpGet(url, { 'Authorization': `Bearer ${PANDASCORE_TOKEN}` }).catch(() => null);
      if (!r || r.status !== 200) break;
      const arr = safeParse(r.body, []);
      if (!Array.isArray(arr) || !arr.length) break;
      for (const m of arr) {
        const a = m.opponents?.[0]?.opponent?.name || '';
        const b = m.opponents?.[1]?.opponent?.name || '';
        const na = norm(a), nb = norm(b);
        if (!na || !nb) continue;
        const matched =
          (na.includes(n1) && nb.includes(n2)) || (na.includes(n2) && nb.includes(n1)) ||
          (n1.includes(na) && n2.includes(nb)) || (n1.includes(nb) && n2.includes(na));
        if (!matched) continue;
        const winner = m.winner?.name;
        if (winner) {
          stmts.upsertMatchResult.run(baseId, game, a, b, winner, '', m.league?.name || '');
          return { resolved: true, winner };
        }
      }
      if (arr.length < 100) break;
      await new Promise(r => setTimeout(r, 200));
    }
    return { resolved: false };
  }

  if (p === '/cs-result') {
    const rawId = parsed.query.matchId || '';
    const t1 = parsed.query.team1 || '';
    const t2 = parsed.query.team2 || '';
    const sentAt = parsed.query.sentAt || '';
    if (!rawId) { sendJson(res, { resolved: false, error: 'matchId obrigatório' }, 400); return; }
    try {
      const r = await resolveEsportsResult({ sport: 'cs', game: 'cs', pandaPath: 'csgo', rawId, t1, t2, sentAt });
      sendJson(res, { matchId: rawId, ...r });
    } catch (e) {
      sendJson(res, { matchId: rawId, resolved: false, error: e.message });
    }
    return;
  }

  if (p === '/valorant-result') {
    const rawId = parsed.query.matchId || '';
    const t1 = parsed.query.team1 || '';
    const t2 = parsed.query.team2 || '';
    const sentAt = parsed.query.sentAt || '';
    if (!rawId) { sendJson(res, { resolved: false, error: 'matchId obrigatório' }, 400); return; }
    try {
      const r = await resolveEsportsResult({ sport: 'valorant', game: 'valorant', pandaPath: 'valorant', rawId, t1, t2, sentAt });
      sendJson(res, { matchId: rawId, ...r });
    } catch (e) {
      sendJson(res, { matchId: rawId, resolved: false, error: e.message });
    }
    return;
  }

  // ── Resultado Darts (settlement via Sofascore event status) ──
  if (p === '/darts-result') {
    const rawId = parsed.query.matchId || '';
    const sofaId = String(rawId).replace(/^darts_/, '');
    if (!sofaId) { sendJson(res, { resolved: false, error: 'matchId obrigatório' }, 400); return; }
    try {
      const r = await sofascoreDarts.getEventResult(sofaId);
      if (!r) { sendJson(res, { matchId: rawId, resolved: false, error: 'event não encontrado' }); return; }
      if (r.resolved && r.winner) {
        stmts.upsertMatchResult.run(rawId, 'darts', '', '', r.winner, r.score || '', '');
      }
      sendJson(res, { matchId: rawId, resolved: r.resolved, winner: r.winner, status: r.status, score: r.score });
    } catch (e) {
      sendJson(res, { matchId: rawId, resolved: false, error: e.message });
    }
    return;
  }

  // ── Resultado Snooker (settlement via Sofascore — matching por nomes + data) ──
  // match_id é `snooker_<pinMatchupId>` (Pinnacle). Sofascore tem ID próprio,
  // então buscamos via scheduled-events de snooker últimos 7 dias e casamos nomes.
  if (p === '/snooker-result') {
    const rawId = parsed.query.matchId || '';
    const t1 = parsed.query.team1 || '';
    const t2 = parsed.query.team2 || '';
    const sentAt = parsed.query.sentAt || '';
    if (!rawId || (!t1 && !t2)) { sendJson(res, { resolved: false, error: 'matchId + team1/team2 obrigatórios' }, 400); return; }

    // Normaliza pra comparação
    const normN = s => String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
    const nt1 = normN(t1), nt2 = normN(t2);

    // Janela de datas: últimos 7 dias (desde sent_at se disponível, senão desde 7d atrás)
    const startMs = sentAt ? Date.parse(sentAt.includes('T') ? sentAt : sentAt.replace(' ', 'T')) : (Date.now() - 7 * 86400000);
    const dayStrs = [];
    for (let d = 0; d <= 7; d++) {
      const ts = new Date(startMs + d * 86400000);
      dayStrs.push(ts.toISOString().slice(0, 10));
    }

    try {
      for (const dateStr of dayStrs) {
        const path = `/sport/snooker/scheduled-events/${dateStr}`;
        const proxyUrl = (process.env.SOFASCORE_PROXY_BASE || '').trim().replace(/\/+$/, '');
        const urls = [];
        if (proxyUrl) urls.push(`${proxyUrl}/schedule/snooker/${dateStr}/`);
        urls.push(`https://api.sofascore.com/api/v1${path}`);
        let found = null;
        for (const u of urls) {
          const r = await cachedHttpGet(u, {
            provider: 'sofascore', ttlMs: 30 * 60 * 1000,
            headers: {
              'User-Agent': 'Mozilla/5.0',
              'Accept': 'application/json',
              'Referer': 'https://www.sofascore.com/',
              'Origin': 'https://www.sofascore.com'
            },
            cacheKey: `sofa-snooker-sched:${dateStr}:${u}`
          }).catch(() => null);
          if (!r || r.status !== 200) continue;
          const j = safeParse(r.body, null);
          const events = j?.events || [];
          for (const ev of events) {
            if (ev?.status?.type !== 'finished') continue;
            const h = normN(ev?.homeTeam?.name);
            const a = normN(ev?.awayTeam?.name);
            const match =
              (h.includes(nt1) || nt1.includes(h)) && (a.includes(nt2) || nt2.includes(a)) ||
              (h.includes(nt2) || nt2.includes(h)) && (a.includes(nt1) || nt1.includes(a));
            if (match) { found = ev; break; }
          }
          if (found) break;
        }
        if (!found) continue;
        const wc = found.winnerCode;
        const winner = wc === 1 ? (found.homeTeam?.name || null)
                     : wc === 2 ? (found.awayTeam?.name || null)
                     : null;
        if (!winner) continue;
        const s1 = found.homeScore?.current ?? 0;
        const s2 = found.awayScore?.current ?? 0;
        stmts.upsertMatchResult.run(rawId, 'snooker', found.homeTeam?.name || t1, found.awayTeam?.name || t2, winner, `${s1}-${s2}`, '');
        sendJson(res, { matchId: rawId, resolved: true, winner, score: `${s1}-${s2}` });
        return;
      }
      sendJson(res, { matchId: rawId, resolved: false });
    } catch (e) {
      sendJson(res, { matchId: rawId, resolved: false, error: e.message });
    }
    return;
  }

  // ── Resultado Futebol (settlement via match_results DB + CSV dataset) ──
  if (p === '/football-result') {
    const matchId = (parsed.query.matchId || '').trim();
    const team1   = (parsed.query.team1   || '').trim();
    const team2   = (parsed.query.team2   || '').trim();
    const sentAt  = (parsed.query.sentAt  || '').trim();

    if (!team1 || !team2) {
      sendJson(res, { resolved: false, error: 'team1 e team2 obrigatórios' }, 400);
      return;
    }
    try {
      // 1) Tentativa por match_id exato (caso o ID já esteja indexado na DB)
      let row = matchId
        ? db.prepare("SELECT * FROM match_results WHERE match_id = ? AND game = 'football' LIMIT 1").get(matchId)
        : null;

      // 2) Fuzzy por nome dos times + janela de ±4 dias em torno de sentAt
      if (!row?.winner) {
        const t1Like = `%${team1}%`;
        const t2Like = `%${team2}%`;
        const stmt = sentAt
          ? db.prepare(`
              SELECT * FROM match_results
              WHERE game = 'football'
                AND ((lower(team1) LIKE lower(?) AND lower(team2) LIKE lower(?))
                  OR (lower(team1) LIKE lower(?) AND lower(team2) LIKE lower(?)))
                AND resolved_at BETWEEN datetime(?, '-4 days') AND datetime(?, '+6 days')
              ORDER BY resolved_at DESC LIMIT 1`)
          : db.prepare(`
              SELECT * FROM match_results
              WHERE game = 'football'
                AND ((lower(team1) LIKE lower(?) AND lower(team2) LIKE lower(?))
                  OR (lower(team1) LIKE lower(?) AND lower(team2) LIKE lower(?)))
              ORDER BY resolved_at DESC LIMIT 1`);

        row = sentAt
          ? stmt.get(t1Like, t2Like, t2Like, t1Like, sentAt, sentAt)
          : stmt.get(t1Like, t2Like, t2Like, t1Like);
      }

      if (row?.winner) {
        sendJson(res, { resolved: true, winner: row.winner, score: row.final_score || '' });
      } else {
        sendJson(res, { resolved: false });
      }
    } catch(e) {
      sendJson(res, { resolved: false, error: e.message });
    }
    return;
  }

  // ── Tennis Elo snapshot ──
  if (p === '/tennis-elo') {
    const p1   = parsed.query.p1 || '';
    const p2   = parsed.query.p2 || '';
    const surf = parsed.query.surface || 'dura';
    const imp1 = parseFloat(parsed.query.imp1 || '') || 0.5;
    const imp2 = parseFloat(parsed.query.imp2 || '') || 0.5;
    if (!p1 || !p2) { sendJson(res, { error: 'p1/p2 obrigatórios' }, 400); return; }
    try {
      const result = tennisML.getTennisElo(db, p1, p2, surf, imp1, imp2);
      sendJson(res, { p1, p2, surface: surf, ...result });
    } catch(e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  // ── Football Elo snapshot ──
  if (p === '/football-elo') {
    const home = parsed.query.home || '';
    const away = parsed.query.away || '';
    if (!home || !away) { sendJson(res, { error: 'home/away obrigatórios' }, 400); return; }
    try {
      const homeRating = getElo(home);
      const awayRating = getElo(away);
      const homeGames = getEloGames(home);
      const awayGames = getEloGames(away);
      sendJson(res, { home, away, homeRating, awayRating, homeGames, awayGames });
    } catch(e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  // ── Usuários ──
  if (p === '/users') {
    const subscribed = parsed.query.subscribed;
    const users = subscribed ? stmts.getSubscribedUsers.all() : db.prepare('SELECT * FROM users').all();
    sendJson(res, users);
    return;
  }

  if (p === '/save-user' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { userId, username, subscribed, sportPrefs } = safeParse(body, {});
        const uid = clampStr(userId, 80);
        if (!uid) { badRequest(res, 'userId obrigatório'); return; }
        const uname = clampStr(username, 80);
        const prefs = Array.isArray(sportPrefs) ? sportPrefs.slice(0, 50) : [];
        stmts.upsertUser.run(uid, uname, subscribed ? 1 : 0, JSON.stringify(prefs));
        sendJson(res, { ok: true });
      } catch(e) {
        sendJson(res, {
          error: e.message,
          code: e.code,
          provider: e.provider,
          retryAfterMs: e.retryAfterMs
        }, e.status || 500);
      }
    });
    return;
  }

  // ── Tips ──
  // Shadow tips: tips registradas mas que NÃO foram enviadas (modo auditoria)
  // Retorna resumo CLV / win rate para avaliação manual antes de promover o esporte
  if (p === '/shadow-tips') {
    const sport = parsed.query.sport || 'darts';
    const limit = Math.min(500, Math.max(10, parseInt(parsed.query.limit || '100', 10) || 100));
    try {
      const rows = db.prepare(
        `SELECT id, match_id, event_name, participant1, participant2, tip_participant,
                odds, open_odds, clv_odds, current_odds, ev, stake, confidence,
                model_p_pick, result, sent_at, settled_at, is_live
         FROM tips
         WHERE sport = ? AND is_shadow = 1
         ORDER BY sent_at DESC
         LIMIT ?`
      ).all(sport, limit);

      let wins = 0, losses = 0, voids = 0, pending = 0;
      let clvSum = 0, clvN = 0;
      for (const r of rows) {
        if (r.result === 'win') wins++;
        else if (r.result === 'loss') losses++;
        else if (r.result === 'void') voids++;
        else pending++;
        // CLV: odds no momento do tip vs odds de fechamento
        if (r.clv_odds && r.open_odds && r.clv_odds > 0 && r.open_odds > 0) {
          clvSum += (r.open_odds / r.clv_odds - 1) * 100;
          clvN++;
        }
      }
      const settled = wins + losses;
      const winRate = settled > 0 ? +(wins / settled * 100).toFixed(1) : null;
      const avgClvPct = clvN > 0 ? +(clvSum / clvN).toFixed(2) : null;
      sendJson(res, {
        sport,
        summary: { total: rows.length, wins, losses, voids, pending, winRate, avgClvPct, clvSamples: clvN },
        tips: rows
      });
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  if (p === '/unsettled-tips') {
    const sport = parsed.query.sport || 'esports';
    const days = parsed.query.days || '30';
    const tips = stmts.getUnsettledTips.all(sport, `-${days} days`);
    sendJson(res, tips.map(t => ({
      ...t,
      match_id: t.match_id,
      participant1: t.participant1,
      participant2: t.participant2,
      tip_participant: t.tip_participant,
    })));
    return;
  }

  // Reabre uma tip já liquidada (volta result → NULL) para re-liquidação futura
  if (p === '/reopen-tip' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const payload = safeParse(body, {});
        const sport   = payload.sport || parsed.query.sport || 'esports';
        const idStr   = String(payload.id || parsed.query.id || '').trim();
        const matchId = String(payload.matchId || parsed.query.matchId || '').trim();
        if (!idStr && !matchId) { sendJson(res, { error: 'id ou matchId obrigatório' }, 400); return; }

        let changes = 0;
        if (idStr) {
          const id = parseInt(idStr, 10);
          if (!Number.isFinite(id)) { sendJson(res, { error: 'id inválido' }, 400); return; }
          const r = db.prepare(`UPDATE tips SET result = NULL, settled_at = NULL, profit_reais = NULL WHERE id = ? AND sport = ?`).run(id, sport);
          changes = r.changes;
        } else {
          const r = db.prepare(`UPDATE tips SET result = NULL, settled_at = NULL, profit_reais = NULL WHERE match_id = ? AND sport = ? ORDER BY sent_at DESC LIMIT 1`).run(matchId, sport);
          changes = r.changes;
        }
        sendJson(res, { ok: true, changes });
      } catch (e) {
        sendJson(res, { error: e.message }, 500);
      }
    });
    return;
  }

  // Liquidação manual de tip por ID (Win ou Loss)
  if (p === '/settle-manual' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const payload = safeParse(body, {});
        const sport  = payload.sport || parsed.query.sport || 'esports';
        const idStr  = String(payload.id || parsed.query.id || '').trim();
        const result = String(payload.result || parsed.query.result || '').toLowerCase();
        if (!idStr) { sendJson(res, { error: 'id obrigatório' }, 400); return; }
        if (result !== 'win' && result !== 'loss') { sendJson(res, { error: 'result deve ser win ou loss' }, 400); return; }
        const id = parseInt(idStr, 10);
        if (!Number.isFinite(id)) { sendJson(res, { error: 'id inválido' }, 400); return; }

        const settled = db.transaction(() => {
          const tip = stmts.getTipById.get(id, sport);
          if (!tip) return { ok: false, error: 'tip não encontrada' };
          if (tip.result !== null) return { ok: false, error: 'tip já liquidada — use ↩ para reabrir primeiro' };

          db.prepare(`UPDATE tips SET result = ?, settled_at = datetime('now') WHERE id = ? AND sport = ?`).run(result, id, sport);

          const bk = stmts.getBankroll.get(sport);
          const uv = bk ? bk.current_banca / 100 : 1;
          const su = parseFloat(String(tip.stake || '1').replace('u', '')) || 1;
          const stakeR = tip.stake_reais || parseFloat((su * uv).toFixed(2));
          const odds = parseFloat(tip.odds) || 1;
          const profitR = result === 'win'
            ? parseFloat((stakeR * (odds - 1)).toFixed(2))
            : parseFloat((-stakeR).toFixed(2));
          db.prepare(`UPDATE tips SET stake_reais = ?, profit_reais = ? WHERE id = ?`).run(stakeR, profitR, id);

          if (bk && profitR !== 0) {
            const nova = parseFloat((bk.current_banca + profitR).toFixed(2));
            db.prepare(`UPDATE bankroll SET current_banca = ? WHERE sport = ?`).run(nova, sport);
          }
          return { ok: true, result, profitR };
        })();

        if (!settled.ok) { sendJson(res, { error: settled.error }, 400); return; }
        sendJson(res, settled);
      } catch (e) {
        sendJson(res, { error: e.message }, 500);
      }
    });
    return;
  }

  // Marca tip como VOID (odds errada / cancelada) para sair de "em andamento"
  if (p === '/void-tip') {
    const sport = parsed.query.sport || 'esports';
    const idStr = parsed.query.id || '';
    const matchId = parsed.query.matchId || parsed.query.match_id || '';
    if (!idStr && !matchId) { sendJson(res, { error: 'id ou matchId obrigatório' }, 400); return; }
    try {
      let changes = 0;
      if (idStr) {
        const id = parseInt(idStr, 10);
        if (!Number.isFinite(id)) { sendJson(res, { error: 'id inválido' }, 400); return; }
        const tip = stmts.getTipById.get(id, sport);
        const r = stmts.voidTipById.run(id, sport);
        changes = r?.changes || 0;
        if (changes > 0 && tip?.participant1 && tip?.participant2) {
          const p1n = norm(tip.participant1);
          const p2n = norm(tip.participant2);
          const mtype = (tip.market_type || 'ML').toString().slice(0, 20);
          stmts.addVoidedTip.run(sport, tip.match_id || null, p1n, p2n, mtype, 'odds_wrong');
        }
      } else {
        const tip = stmts.getTipByMatchId.get(String(matchId), sport);
        const r = stmts.voidTipByMatch.run(String(matchId), sport);
        changes = r?.changes || 0;
        if (changes > 0 && tip?.participant1 && tip?.participant2) {
          const p1n = norm(tip.participant1);
          const p2n = norm(tip.participant2);
          const mtype = (tip.market_type || 'ML').toString().slice(0, 20);
          stmts.addVoidedTip.run(sport, String(matchId), p1n, p2n, mtype, 'odds_wrong');
        }
      }
      sendJson(res, { ok: true, changes });
    } catch(e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  // Seed histórico de Dota 2 via OpenDota /api/proMatches.
  // Alimenta match_results (game='dota2') pra form/H2H endpoints.
  // POST /seed-dota?days=60&apply=1
  if (p === '/seed-dota' && req.method === 'POST') {
    try {
      const days = Math.max(1, Math.min(180, parseInt(parsed.query.days || '60', 10) || 60));
      const dryRun = parsed.query.apply !== '1' && parsed.query.apply !== 'true';
      const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
      const cutoffSec = Math.floor(cutoffMs / 1000);

      const matches = [];
      let lastMatchId = null;
      // Paginated scan — 100 proMatches por página. Para quando chega no cutoff.
      for (let i = 0; i < 30; i++) {
        const url = lastMatchId
          ? `https://api.opendota.com/api/proMatches?less_than_match_id=${lastMatchId}`
          : `https://api.opendota.com/api/proMatches`;
        const r = await httpGet(url, { 'User-Agent': 'Mozilla/5.0' }).catch(() => null);
        if (!r || r.status !== 200) break;
        const page = safeParse(r.body, []);
        if (!Array.isArray(page) || !page.length) break;
        let stop = false;
        for (const m of page) {
          if (!m.match_id || !m.radiant_name || !m.dire_name || m.radiant_win == null) continue;
          if ((m.start_time || 0) < cutoffSec) { stop = true; break; }
          matches.push(m);
        }
        lastMatchId = page[page.length - 1].match_id;
        if (stop) break;
        await new Promise(r => setTimeout(r, 300)); // rate limit soft
      }

      const upsert = db.prepare(`
        INSERT OR IGNORE INTO match_results (match_id, game, team1, team2, winner, final_score, league, resolved_at)
        VALUES (?, 'dota2', ?, ?, ?, ?, ?, ?)
      `);
      const existing = db.prepare(`SELECT COUNT(*) c FROM match_results WHERE game='dota2'`).get()?.c || 0;

      let inserted = 0;
      if (!dryRun) {
        const tx = db.transaction((rows) => {
          for (const m of rows) {
            const mid = `dota2_pro_${m.match_id}`;
            const winner = m.radiant_win ? m.radiant_name : m.dire_name;
            const score = `${m.radiant_score || 0}-${m.dire_score || 0}`;
            const resolvedAt = new Date((m.start_time + (m.duration || 0)) * 1000).toISOString().replace('T', ' ').slice(0, 19);
            const r = upsert.run(mid, m.radiant_name, m.dire_name, winner, score, m.league_name || 'Dota 2', resolvedAt);
            if (r.changes) inserted++;
          }
        });
        tx(matches);
      }

      sendJson(res, {
        ok: true,
        dryRun,
        daysScraped: days,
        matchesFound: matches.length,
        inserted,
        existingBefore: existing,
        sampleMatch: matches[0] ? {
          match_id: matches[0].match_id,
          teams: `${matches[0].radiant_name} vs ${matches[0].dire_name}`,
          winner: matches[0].radiant_win ? matches[0].radiant_name : matches[0].dire_name,
          league: matches[0].league_name,
        } : null,
      });
      if (!dryRun) log('INFO', 'ADMIN', `seed-dota: ${inserted} novos matches em ${days}d (existing antes: ${existing})`);
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  // Seed histórico de Table Tennis (bootstrap do Elo).
  // POST /seed-tabletennis?days=60  → varre Sofascore, insere matches finished em match_results.
  if (p === '/seed-tabletennis' && req.method === 'POST') {
    try {
      const days = Math.max(1, Math.min(180, parseInt(parsed.query.days || '60', 10) || 60));
      const dryRun = parsed.query.apply !== '1' && parsed.query.apply !== 'true';
      const sofaTT = require('./lib/sofascore-tabletennis');
      const matches = await sofaTT.fetchHistoricalMatches(days);

      const upsert = db.prepare(`
        INSERT OR IGNORE INTO match_results (match_id, game, team1, team2, winner, final_score, league, resolved_at)
        VALUES (?, 'tabletennis', ?, ?, ?, ?, ?, ?)
      `);
      const existing = db.prepare(
        `SELECT COUNT(*) c FROM match_results WHERE game='tabletennis'`
      ).get()?.c || 0;

      let inserted = 0;
      if (!dryRun) {
        const tx = db.transaction((rows) => {
          for (const m of rows) {
            const mid = `tt_${m.eventId || `${m.date}_${m.homeTeam}_${m.awayTeam}`.replace(/[^a-zA-Z0-9_]/g, '_')}`;
            const resolvedAt = m.startTimestamp
              ? new Date(m.startTimestamp * 1000).toISOString().replace('T', ' ').slice(0, 19)
              : `${m.date} 00:00:00`;
            const r = upsert.run(mid, m.homeTeam, m.awayTeam, m.winner, m.score || '', m.tournament || 'Table Tennis', resolvedAt);
            if (r.changes) inserted++;
          }
        });
        tx(matches);
      }

      // Invalida cache Elo pra refletir novo seed
      if (!dryRun && inserted > 0) {
        try { require('./lib/tabletennis-ml').invalidateEloCache(); } catch (_) {}
      }

      sendJson(res, {
        ok: true,
        dryRun,
        daysScraped: days,
        matchesFound: matches.length,
        inserted,
        existingBefore: existing,
        sampleMatch: matches[0] || null,
      });
      if (!dryRun) log('INFO', 'ADMIN', `seed-tabletennis: ${inserted} novos matches em ${days}d (total existing antes: ${existing})`);
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  // Seed CS via PandaScore — coleta últimos N matches finished
  if (p === '/seed-cs-history' && req.method === 'POST') {
    try {
      if (!PANDASCORE_TOKEN) { sendJson(res, { error: 'PANDASCORE_TOKEN missing' }, 400); return; }
      const days = Math.max(1, Math.min(180, parseInt(parsed.query.days || '90', 10) || 90));
      const dryRun = parsed.query.apply !== '1' && parsed.query.apply !== 'true';
      const headers = { 'Authorization': `Bearer ${PANDASCORE_TOKEN}` };
      const since = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 19);

      // PandaScore csgo/matches/past, paginado (max 100/page)
      const matches = [];
      let page = 1;
      while (page <= 50) {
        const url = `https://api.pandascore.co/csgo/matches/past?per_page=100&page=${page}&sort=-end_at&filter[finished]=true&range[end_at]=${encodeURIComponent(since)},${encodeURIComponent(new Date().toISOString().slice(0,19))}`;
        const r = await httpGet(url, headers).catch(() => null);
        if (!r || r.status !== 200) break;
        const arr = safeParse(r.body, []);
        if (!Array.isArray(arr) || arr.length === 0) break;
        for (const m of arr) {
          const t1 = m.opponents?.[0]?.opponent?.name;
          const t2 = m.opponents?.[1]?.opponent?.name;
          const winnerName = m.winner?.name;
          if (!t1 || !t2 || !winnerName) continue;
          const score1 = m.results?.find(x => x.team_id === m.opponents?.[0]?.opponent?.id)?.score ?? null;
          const score2 = m.results?.find(x => x.team_id === m.opponents?.[1]?.opponent?.id)?.score ?? null;
          matches.push({
            psId: m.id,
            team1: t1, team2: t2,
            winner: winnerName,
            score: (score1 != null && score2 != null) ? `${score1}-${score2}` : '',
            league: m.league?.name || 'CS2',
            endAt: m.end_at,
          });
        }
        if (arr.length < 100) break;
        page++;
        await new Promise(r => setTimeout(r, 250));
      }

      const upsert = db.prepare(`
        INSERT OR IGNORE INTO match_results (match_id, game, team1, team2, winner, final_score, league, resolved_at)
        VALUES (?, 'cs', ?, ?, ?, ?, ?, ?)
      `);
      const existing = db.prepare(`SELECT COUNT(*) c FROM match_results WHERE game='cs'`).get()?.c || 0;

      let inserted = 0;
      if (!dryRun) {
        const tx = db.transaction((rows) => {
          for (const m of rows) {
            const mid = `cs_ps_${m.psId}`;
            const resolvedAt = m.endAt
              ? new Date(m.endAt).toISOString().replace('T', ' ').slice(0, 19)
              : new Date().toISOString().replace('T', ' ').slice(0, 19);
            const r = upsert.run(mid, m.team1, m.team2, m.winner, m.score, m.league, resolvedAt);
            if (r.changes) inserted++;
          }
        });
        tx(matches);
        try { require('./lib/cs-ml').invalidateEloCache(); } catch (_) {}
      }

      sendJson(res, {
        ok: true,
        dryRun,
        daysScraped: days,
        matchesFound: matches.length,
        pagesScanned: page,
        inserted,
        existingBefore: existing,
        sample: matches[0] || null,
      });
      if (!dryRun) log('INFO', 'ADMIN', `seed-cs-history: ${inserted} novos matches em ${days}d (existing antes: ${existing})`);
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  if (p === '/seed-valorant-history' && req.method === 'POST') {
    try {
      if (!PANDASCORE_TOKEN) { sendJson(res, { error: 'PANDASCORE_TOKEN missing' }, 400); return; }
      const days = Math.max(1, Math.min(180, parseInt(parsed.query.days || '90', 10) || 90));
      const dryRun = parsed.query.apply !== '1' && parsed.query.apply !== 'true';
      const headers = { 'Authorization': `Bearer ${PANDASCORE_TOKEN}` };
      const since = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 19);

      const matches = [];
      const mapRows = [];
      let page = 1;
      while (page <= 50) {
        const url = `https://api.pandascore.co/valorant/matches/past?per_page=100&page=${page}&sort=-end_at&filter[finished]=true&range[end_at]=${encodeURIComponent(since)},${encodeURIComponent(new Date().toISOString().slice(0,19))}`;
        const r = await httpGet(url, headers).catch(() => null);
        if (!r || r.status !== 200) break;
        const arr = safeParse(r.body, []);
        if (!Array.isArray(arr) || arr.length === 0) break;
        for (const m of arr) {
          const t1Opp = m.opponents?.[0]?.opponent;
          const t2Opp = m.opponents?.[1]?.opponent;
          const t1 = t1Opp?.name;
          const t2 = t2Opp?.name;
          const winnerName = m.winner?.name;
          if (!t1 || !t2 || !winnerName) continue;
          const score1 = m.results?.find(x => x.team_id === t1Opp?.id)?.score ?? null;
          const score2 = m.results?.find(x => x.team_id === t2Opp?.id)?.score ?? null;
          matches.push({
            psId: m.id,
            team1: t1, team2: t2,
            winner: winnerName,
            score: (score1 != null && score2 != null) ? `${score1}-${score2}` : '',
            league: m.league?.name || 'Valorant',
            endAt: m.end_at,
          });

          // Map-level: extrai winner por game quando há map.name
          if (Array.isArray(m.games)) {
            for (const g of m.games) {
              if (!g?.winner?.id || g.status !== 'finished') continue;
              const mapName = g.map?.name || null;
              if (!mapName) continue;
              const winTeam = g.winner.id === t1Opp?.id ? t1 : (g.winner.id === t2Opp?.id ? t2 : null);
              if (!winTeam) continue;
              mapRows.push({
                psId: m.id,
                pos: g.position ?? 0,
                team1: t1, team2: t2,
                mapName,
                winner: winTeam,
                endAt: g.end_at || m.end_at,
              });
            }
          }
        }
        if (arr.length < 100) break;
        page++;
        await new Promise(r => setTimeout(r, 250));
      }

      const upsert = db.prepare(`
        INSERT OR IGNORE INTO match_results (match_id, game, team1, team2, winner, final_score, league, resolved_at)
        VALUES (?, 'valorant', ?, ?, ?, ?, ?, ?)
      `);
      const upsertMap = db.prepare(`
        INSERT OR IGNORE INTO valorant_map_results (match_id, game_pos, team1, team2, map_name, winner, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const existing = db.prepare(`SELECT COUNT(*) c FROM match_results WHERE game='valorant'`).get()?.c || 0;
      const existingMaps = db.prepare(`SELECT COUNT(*) c FROM valorant_map_results`).get()?.c || 0;

      let inserted = 0;
      let insertedMaps = 0;
      if (!dryRun) {
        const tx = db.transaction((rows, maps) => {
          for (const m of rows) {
            const mid = `valorant_ps_${m.psId}`;
            const resolvedAt = m.endAt
              ? new Date(m.endAt).toISOString().replace('T', ' ').slice(0, 19)
              : new Date().toISOString().replace('T', ' ').slice(0, 19);
            const r = upsert.run(mid, m.team1, m.team2, m.winner, m.score, m.league, resolvedAt);
            if (r.changes) inserted++;
          }
          for (const g of maps) {
            const mid = `valorant_ps_${g.psId}`;
            const resolvedAt = g.endAt
              ? new Date(g.endAt).toISOString().replace('T', ' ').slice(0, 19)
              : new Date().toISOString().replace('T', ' ').slice(0, 19);
            const r = upsertMap.run(mid, g.pos, g.team1, g.team2, g.mapName, g.winner, resolvedAt);
            if (r.changes) insertedMaps++;
          }
        });
        tx(matches, mapRows);
        try { require('./lib/valorant-ml').invalidateEloCache(); } catch (_) {}
      }

      sendJson(res, {
        ok: true,
        dryRun,
        daysScraped: days,
        matchesFound: matches.length,
        pagesScanned: page,
        inserted,
        existingBefore: existing,
        insertedMaps,
        existingMapsBefore: existingMaps,
        mapsFoundFromApi: mapRows.length,
        sample: matches[0] || null,
      });
      if (!dryRun) log('INFO', 'ADMIN', `seed-valorant-history: ${inserted} novos matches em ${days}d (existing antes: ${existing})`);
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  if (p === '/debug-valorant-ps-match') {
    try {
      if (!PANDASCORE_TOKEN) { sendJson(res, { error: 'no token' }, 400); return; }
      const id = parsed.query.id || '';
      const headers = { 'Authorization': `Bearer ${PANDASCORE_TOKEN}` };
      const path = id
        ? `/valorant/matches/${id}`
        : '/valorant/matches/past?per_page=1&sort=-end_at&filter[finished]=true';
      const r = await httpGet(`https://api.pandascore.co${path}`, headers);
      const body = safeParse(r.body, null);
      const sample = Array.isArray(body) ? body[0] : body;
      const firstGame = sample?.games?.[0] || null;

      // Se houver firstGame.id, puxa endpoint detalhado
      let gameDetail = null;
      let gameDetailKeys = [];
      if (firstGame?.id) {
        const gr = await httpGet(`https://api.pandascore.co/valorant/games/${firstGame.id}`, headers).catch(() => null);
        if (gr) {
          const gb = safeParse(gr.body, null);
          gameDetail = { status: gr.status, body: gb };
          if (gb && typeof gb === 'object') gameDetailKeys = Object.keys(gb);
        }
      }

      sendJson(res, {
        status: r.status,
        matchId: sample?.id,
        numGames: sample?.games?.length || 0,
        firstGameKeys: firstGame ? Object.keys(firstGame) : [],
        firstGameRaw: firstGame,
        gameDetailKeys,
        gameDetail,
      });
    } catch (e) {
      sendJson(res, { error: e.message, stack: e.stack }, 500);
    }
    return;
  }

  if (p === '/seed-valorant-maps-from-vlr' && req.method === 'POST') {
    try {
      const startPage = Math.max(1, Math.min(50, parseInt(parsed.query.startPage || '1', 10) || 1));
      const pages = Math.max(1, Math.min(10, parseInt(parsed.query.pages || '2', 10) || 2));
      const maxMatches = Math.max(5, Math.min(100, parseInt(parsed.query.max || '30', 10) || 30));
      const vlr = require('./lib/vlr');

      const seen = new Set();
      const allIds = [];
      for (let pg = startPage; pg < startPage + pages; pg++) {
        const ids = await vlr.fetchResults(pg).catch(() => []);
        for (const id of ids) {
          if (!seen.has(id)) { seen.add(id); allIds.push(id); }
        }
        if (allIds.length >= maxMatches) break;
        await new Promise(r => setTimeout(r, 1500));
      }

      const toProcess = allIds.slice(0, maxMatches);
      const upsertMap = db.prepare(`
        INSERT OR IGNORE INTO valorant_map_results (match_id, game_pos, team1, team2, map_name, winner, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);

      let insertedMaps = 0;
      let processedMatches = 0;
      let errors = 0;
      const samples = [];

      for (const vlrId of toProcess) {
        try {
          const data = await vlr.fetchMatchMaps(vlrId);
          if (data?.maps?.length) {
            for (const mp of data.maps) {
              if (!mp.winner) continue;
              const r = upsertMap.run(`vlr_${vlrId}_${mp.pos}`, mp.pos, data.team1, data.team2, mp.name, mp.winner, ts);
              if (r.changes) insertedMaps++;
            }
            processedMatches++;
            if (samples.length < 3) samples.push({ vlrId, ...data });
          }
        } catch (e) {
          errors++;
          log('WARN', 'VLR', `match ${vlrId}: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      const totalMaps = db.prepare(`SELECT COUNT(*) c FROM valorant_map_results`).get()?.c || 0;

      log('INFO', 'ADMIN', `seed-valorant-maps-from-vlr: processed=${processedMatches}, inserted=${insertedMaps}, errors=${errors}`);
      sendJson(res, {
        ok: true,
        pagesScanned: pages,
        matchIdsFound: allIds.length,
        processedMatches,
        insertedMaps,
        totalMapsAfter: totalMaps,
        errors,
        samples,
      });
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  if (p === '/debug-valorant-elo') {
    try {
      const { getValorantElo } = require('./lib/valorant-ml');
      const teamsParam = String(parsed.query.teams || '').trim();
      const totalRows = db.prepare(`SELECT COUNT(*) c FROM match_results WHERE game='valorant'`).get()?.c || 0;
      const distinctTeams = db.prepare(`SELECT COUNT(DISTINCT team) c FROM (SELECT team1 AS team FROM match_results WHERE game='valorant' UNION ALL SELECT team2 FROM match_results WHERE game='valorant')`).get()?.c || 0;
      const latest = db.prepare(`SELECT MAX(resolved_at) m FROM match_results WHERE game='valorant'`).get()?.m || null;

      let pairs = null;
      if (teamsParam) {
        const list = teamsParam.split(',').map(s => s.trim()).filter(Boolean);
        pairs = [];
        for (let i = 0; i < list.length; i += 2) {
          const t1 = list[i], t2 = list[i+1];
          if (!t2) break;
          const r = getValorantElo(db, t1, t2, 0.5, 0.5);
          pairs.push({ t1, t2, elo1: r.elo1, elo2: r.elo2, eloMatches1: r.eloMatches1, eloMatches2: r.eloMatches2, found1: r.found1, found2: r.found2, useEloEligible: r.found1 && r.found2 && Math.min(r.eloMatches1, r.eloMatches2) >= 5 });
        }
      }

      sendJson(res, {
        matchResultsRows: totalRows,
        distinctTeams,
        latestResolvedAt: latest,
        pairs,
      });
    } catch (e) {
      sendJson(res, { error: e.message, stack: e.stack }, 500);
    }
    return;
  }

  if (p === '/stake-multiplier') {
    try {
      const sport = String(parsed.query.sport || '').trim();
      const league = String(parsed.query.league || '').trim();
      if (!sport || !league) { sendJson(res, { error: 'sport/league obrigatórios' }, 400); return; }
      const { computeStakeMultiplier } = require('./lib/stake-adjuster');

      // Busca banca atual do esporte (pra daily stop-loss)
      const bk = db.prepare(`SELECT * FROM bankroll WHERE sport = ?`).get(sport);
      let currentBanca = 0;
      if (bk) {
        const profit = db.prepare(`
          SELECT COALESCE(SUM(profit_reais), 0) AS p FROM tips
          WHERE sport = ? AND result IN ('win', 'loss')
        `).get(sport)?.p || 0;
        currentBanca = (bk.initial_banca || 0) + profit;
      }

      const result = computeStakeMultiplier(db, sport, league, { currentBanca });
      sendJson(res, { sport, league, currentBanca: +currentBanca.toFixed(2), ...result });
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  // (definição única movida p/ depois do /roi — este stub só redireciona o fluxo)

  // Stats de calibração isotônica por esporte
  if (p === '/calibration-stats') {
    try {
      const calib = require('./lib/calibration');
      const sport = parsed.query.sport;
      const sports = sport ? [sport] : ['esports', 'mma', 'tennis', 'tabletennis', 'cs', 'darts', 'snooker', 'football'];
      const result = {};
      for (const s of sports) {
        result[s] = calib.getCalibrationStats(db, s);
      }
      sendJson(res, result);
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  // Retorna quantas tips pendentes existem por faixa de idade
  if (p === '/pending-age-info') {
    const sport = parsed.query.sport || 'esports';
    try {
      const thresholds = [3, 7, 14, 21, 30, 45, 60, 90];
      const buckets = thresholds.map(d => {
        const row = db.prepare(
          `SELECT COUNT(*) as c FROM tips WHERE sport = ? AND result IS NULL AND sent_at < datetime('now', ?)`
        ).get(sport, `-${d} days`);
        return { days: d, count: row?.c || 0 };
      }).filter(b => b.count > 0);
      // Sugestão: limiar onde a maioria das lutas já aconteceu (~10 dias)
      const suggestDays = 10;
      sendJson(res, { buckets, suggestDays });
    } catch(e) {
      sendJson(res, { buckets: [], suggestDays: 14 });
    }
    return;
  }

  // Recalcula `ev` (e `current_ev`) das tips pendentes usando o EV determinístico
  // `(model_p_pick × odds − 1) × 100`. Motivo: o bot passou a gravar EV do modelo em vez
  // do EV chutado pela IA — queremos alinhar tips antigas que ainda estão em aberto.
  //   POST /admin/recompute-ev-pending?apply=1            (persiste; sem apply = dry-run)
  //   POST /admin/recompute-ev-pending?sport=mma&apply=1  (filtra por esporte)
  if (p === '/admin/recompute-ev-pending' && req.method === 'POST') {
    try {
      const apply = parsed.query.apply === '1' || parsed.query.apply === 'true';
      const sportFilter = parsed.query.sport ? String(parsed.query.sport).trim().toLowerCase() : null;

      // Gates por esporte (alinhados com bot.js) — usados pra flagear tips que
      // ficariam abaixo do mínimo após o recálculo.
      const MIN_EV = { mma: 5, tennis: 7, esports: 2, dota: 5, cs: 5, valorant: 5, darts: 5, snooker: 5, tabletennis: 5, football: 5 };

      const params = [];
      let where = `result IS NULL AND model_p_pick IS NOT NULL AND model_p_pick > 0 AND model_p_pick < 1 AND odds IS NOT NULL AND odds > 1`;
      if (sportFilter) { where += ` AND LOWER(sport) = ?`; params.push(sportFilter); }

      const rows = db.prepare(`
        SELECT id, sport, participant1, participant2, tip_participant,
               odds, ev, current_odds, current_ev, model_p_pick, confidence, event_name, sent_at
        FROM tips
        WHERE ${where}
        ORDER BY sent_at DESC
      `).all(...params);

      let updated = 0;
      const items = [];
      const upd = db.prepare(`UPDATE tips SET ev = ?, current_ev = ? WHERE id = ?`);
      const tx = db.transaction((opsArr) => { for (const o of opsArr) upd.run(o.newEv, o.newCurEv, o.id); });

      const ops = [];
      for (const r of rows) {
        const odds = parseFloat(r.odds);
        const curOdds = Number.isFinite(parseFloat(r.current_odds)) ? parseFloat(r.current_odds) : odds;
        const p = parseFloat(r.model_p_pick);
        if (!Number.isFinite(p) || !Number.isFinite(odds) || p <= 0 || p >= 1 || odds <= 1) continue;

        const newEv = +((p * odds - 1) * 100).toFixed(1);
        const newCurEv = Number.isFinite(curOdds) && curOdds > 1 ? +((p * curOdds - 1) * 100).toFixed(1) : newEv;
        const oldEv = parseFloat(r.ev);
        const diff = Number.isFinite(oldEv) ? +(newEv - oldEv).toFixed(1) : null;
        const minGate = MIN_EV[String(r.sport).toLowerCase()] ?? 5;
        const belowGate = newEv < minGate;

        items.push({
          id: r.id, sport: r.sport,
          matchup: `${r.participant1} vs ${r.participant2}`,
          pick: r.tip_participant,
          odds, curOdds,
          p: +(p * 100).toFixed(1),
          oldEv: Number.isFinite(oldEv) ? oldEv : null,
          newEv,
          diff,
          oldCurEv: Number.isFinite(parseFloat(r.current_ev)) ? parseFloat(r.current_ev) : null,
          newCurEv,
          confidence: r.confidence,
          event: r.event_name,
          sentAt: r.sent_at,
          minGate,
          belowGate,
        });
        ops.push({ id: r.id, newEv, newCurEv });
      }

      if (apply && ops.length) {
        tx(ops);
        updated = ops.length;
        log('INFO', 'ADMIN', `recompute-ev-pending: sport=${sportFilter || 'all'} scanned=${rows.length} updated=${updated}`);
      }

      // Resumo por esporte
      const bySport = {};
      for (const it of items) {
        const k = it.sport;
        if (!bySport[k]) bySport[k] = { total: 0, belowGate: 0, avgDiff: 0, biggestDrop: 0, biggestRise: 0 };
        const b = bySport[k];
        b.total++;
        if (it.belowGate) b.belowGate++;
        if (it.diff != null) {
          b.avgDiff += it.diff;
          if (it.diff < b.biggestDrop) b.biggestDrop = it.diff;
          if (it.diff > b.biggestRise) b.biggestRise = it.diff;
        }
      }
      for (const k of Object.keys(bySport)) {
        bySport[k].avgDiff = +(bySport[k].avgDiff / Math.max(1, bySport[k].total)).toFixed(1);
      }

      sendJson(res, {
        ok: true,
        dryRun: !apply,
        sportFilter,
        scanned: rows.length,
        updated,
        bySport,
        items,
      });
    } catch (e) {
      sendJson(res, { error: e.message, stack: e.stack }, 500);
    }
    return;
  }

  // Reanalisa tips pendentes de tênis com os novos gates (2026-04-15) e anula as reprovadas.
  // Aceita ?apply=1 para executar; sem apply faz dry-run.
  // Critérios (sincronizados com bot.js auto-tennis):
  //   - Duplas (participant com "/") → reject (Elo só singles)
  //   - EV < 7% → reject (novo gate base)
  //   - EV 7-10% + conf BAIXA → reject (exige MÉDIA+)
  //   - EV ≥ 30% sem conf ALTA → reject (small-sample)
  if (p === '/void-bad-tennis' && req.method === 'POST') {
    try {
      const apply = parsed.query.apply === '1' || parsed.query.apply === 'true';
      const rows = db.prepare(
        "SELECT id, participant1, participant2, tip_participant, odds, ev, confidence, event_name, sent_at FROM tips WHERE sport='tennis' AND result IS NULL ORDER BY sent_at DESC"
      ).all();
      const evaluate = (t) => {
        const ev = parseFloat(t.ev);
        const conf = String(t.confidence || '').toUpperCase();
        const p1 = String(t.participant1 || '');
        const p2 = String(t.participant2 || '');
        const isDoubles = p1.includes('/') || p2.includes('/');
        const reasons = [];
        if (isDoubles) reasons.push('dupla');
        if (ev < 7.0) reasons.push(`EV ${ev.toFixed(1)}% < 7%`);
        if (ev >= 7.0 && ev < 10.0 && conf === 'BAIXA') reasons.push(`EV ${ev.toFixed(1)}% + conf BAIXA`);
        if (ev >= 30.0 && conf !== 'ALTA') reasons.push(`EV ${ev.toFixed(1)}% absurdo (small-sample)`);
        return { keep: reasons.length === 0, reasons };
      };
      const decided = rows.map(r => ({ ...r, _eval: evaluate(r) }));
      const toVoid = decided.filter(r => !r._eval.keep);
      let voided = 0;
      if (apply && toVoid.length) {
        const upd = db.prepare("UPDATE tips SET result='void', settled_at=datetime('now'), profit_reais=0 WHERE id=?");
        const tx = db.transaction(ids => { for (const id of ids) upd.run(id); });
        tx(toVoid.map(r => r.id));
        voided = toVoid.length;
        log('INFO', 'ADMIN', `void-bad-tennis: ${voided} tips anuladas`);
      }
      sendJson(res, {
        ok: true,
        dryRun: !apply,
        total: rows.length,
        wouldVoid: toVoid.length,
        voided,
        items: decided.map(r => ({
          id: r.id,
          matchup: `${r.participant1} vs ${r.participant2}`,
          pick: r.tip_participant,
          odds: r.odds, ev: r.ev, conf: r.confidence,
          keep: r._eval.keep,
          reasons: r._eval.reasons
        }))
      });
    } catch(e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  // Reanalisa tips Darts pendentes contra os gates atuais.
  //   - EV ≤ 0% → void (edge fechou)
  //   - EV < 5% → void (gate base alinhado com MMA; ajustável via DARTS_MIN_EV)
  //   - conf BAIXA + EV < 8% → void (single-factor tips só passam com EV forte)
  //   - EV ≥ 30% sem conf ALTA → void (sanity)
  //   - odds fora 1.20-6.00 → void
  if (p === '/void-bad-darts' && req.method === 'POST') {
    try {
      const apply = parsed.query.apply === '1' || parsed.query.apply === 'true';
      const rows = db.prepare(
        `SELECT id, participant1, participant2, tip_participant, odds, ev, current_ev,
                confidence, event_name, sent_at
         FROM tips
         WHERE sport='darts' AND result IS NULL
         ORDER BY sent_at DESC`
      ).all();
      const MIN_EV = parseFloat(process.env.DARTS_MIN_EV || '5');
      const BAIXA_MIN_EV = 8.0;
      const MIN_ODDS = 1.20, MAX_ODDS = 6.00, SANITY_MAX_EV = 30.0;
      const evaluate = (t) => {
        const reasons = [];
        const effectiveEv = Number.isFinite(parseFloat(t.current_ev)) ? parseFloat(t.current_ev) : parseFloat(t.ev);
        const odds = parseFloat(t.odds);
        const conf = String(t.confidence || '').toUpperCase();
        if (!Number.isFinite(effectiveEv) || effectiveEv <= 0) reasons.push(`EV atual ${effectiveEv.toFixed(1)}% ≤ 0 (edge fechou)`);
        else if (effectiveEv < MIN_EV) reasons.push(`EV atual ${effectiveEv.toFixed(1)}% < ${MIN_EV}%`);
        else if (conf === 'BAIXA' && effectiveEv < BAIXA_MIN_EV) reasons.push(`conf BAIXA com EV ${effectiveEv.toFixed(1)}% < ${BAIXA_MIN_EV}%`);
        if (effectiveEv >= SANITY_MAX_EV && conf !== 'ALTA') reasons.push(`EV ${effectiveEv.toFixed(1)}% ≥ ${SANITY_MAX_EV}% sem conf ALTA`);
        if (!Number.isFinite(odds) || odds < MIN_ODDS || odds > MAX_ODDS) reasons.push(`odds ${odds} fora de ${MIN_ODDS}-${MAX_ODDS}`);
        return { keep: reasons.length === 0, reasons, effectiveEv };
      };
      const decided = rows.map(r => ({ ...r, _eval: evaluate(r) }));
      const toVoid = decided.filter(r => !r._eval.keep);
      let voided = 0;
      if (apply && toVoid.length) {
        const upd = db.prepare("UPDATE tips SET result='void', settled_at=datetime('now'), profit_reais=0 WHERE id=?");
        const tx = db.transaction(ids => { for (const id of ids) upd.run(id); });
        tx(toVoid.map(r => r.id));
        voided = toVoid.length;
        log('INFO', 'ADMIN', `void-bad-darts: ${voided} tips anuladas`);
      }
      sendJson(res, {
        ok: true, dryRun: !apply,
        total: rows.length, wouldVoid: toVoid.length, voided,
        items: decided.map(r => ({
          id: r.id,
          matchup: `${r.participant1} vs ${r.participant2}`,
          pick: r.tip_participant, odds: r.odds,
          originalEv: r.ev, currentEv: r.current_ev ?? null,
          effectiveEv: +r._eval.effectiveEv.toFixed(2),
          conf: r.confidence,
          keep: r._eval.keep, reasons: r._eval.reasons,
        })),
      });
    } catch (e) { sendJson(res, { error: e.message }, 500); }
    return;
  }

  // Reanalisa tips MMA pendentes contra os gates atuais (2026-04-15).
  // Usa current_ev quando disponível (mercado move → edge pode desaparecer).
  //   - current_ev ≤ 0% → void (edge desapareceu)
  //   - current_ev < 5% → void (abaixo do gate mínimo atual)
  //   - current_ev entre 5-7% + conf BAIXA → void
  //   - current_ev ≥ 40% sem conf ALTA → void (small-sample / IA erro)
  //   - odds fora 1.40-5.00 → void
  if (p === '/void-bad-mma' && req.method === 'POST') {
    try {
      const apply = parsed.query.apply === '1' || parsed.query.apply === 'true';
      const rows = db.prepare(
        `SELECT id, participant1, participant2, tip_participant, odds, ev, current_ev,
                confidence, event_name, sent_at
         FROM tips
         WHERE sport='mma' AND result IS NULL
         ORDER BY sent_at DESC`
      ).all();

      const MIN_EV = 5.0;
      const MIN_ODDS = 1.40;
      const MAX_ODDS = 5.00;
      const SANITY_MAX_EV = 40.0;

      const evaluate = (t) => {
        const reasons = [];
        const effectiveEv = Number.isFinite(parseFloat(t.current_ev)) ? parseFloat(t.current_ev) : parseFloat(t.ev);
        const odds = parseFloat(t.odds);
        const conf = String(t.confidence || '').toUpperCase();
        if (!Number.isFinite(effectiveEv) || effectiveEv <= 0) reasons.push(`EV atual ${effectiveEv.toFixed(1)}% ≤ 0 (edge fechou)`);
        else if (effectiveEv < MIN_EV) reasons.push(`EV atual ${effectiveEv.toFixed(1)}% < ${MIN_EV}%`);
        else if (effectiveEv < 7.0 && conf === 'BAIXA') reasons.push(`EV ${effectiveEv.toFixed(1)}% + conf BAIXA`);
        if (effectiveEv >= SANITY_MAX_EV && conf !== 'ALTA') reasons.push(`EV ${effectiveEv.toFixed(1)}% ≥ ${SANITY_MAX_EV}% sem conf ALTA (provável erro IA)`);
        if (!Number.isFinite(odds) || odds < MIN_ODDS || odds > MAX_ODDS) reasons.push(`odds ${odds} fora de ${MIN_ODDS}-${MAX_ODDS}`);
        return { keep: reasons.length === 0, reasons, effectiveEv };
      };

      const decided = rows.map(r => ({ ...r, _eval: evaluate(r) }));
      const toVoid = decided.filter(r => !r._eval.keep);
      let voided = 0;
      if (apply && toVoid.length) {
        const upd = db.prepare("UPDATE tips SET result='void', settled_at=datetime('now'), profit_reais=0 WHERE id=?");
        const tx = db.transaction(ids => { for (const id of ids) upd.run(id); });
        tx(toVoid.map(r => r.id));
        voided = toVoid.length;
        log('INFO', 'ADMIN', `void-bad-mma: ${voided} tips anuladas`);
      }
      sendJson(res, {
        ok: true,
        dryRun: !apply,
        total: rows.length,
        wouldVoid: toVoid.length,
        voided,
        items: decided.map(r => ({
          id: r.id,
          matchup: `${r.participant1} vs ${r.participant2}`,
          pick: r.tip_participant,
          odds: r.odds,
          originalEv: r.ev,
          currentEv: r.current_ev ?? null,
          effectiveEv: +r._eval.effectiveEv.toFixed(2),
          conf: r.confidence,
          keep: r._eval.keep,
          reasons: r._eval.reasons,
        })),
      });
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  // Backfill: reidentifica organização (UFC/PFL/Bellator/KSW/Boxing...) em tips
  // de MMA cujo event_name caiu no genérico ("MMA", "Boxing" sem detalhes).
  // Atualiza event_name para "{org} — {eventName}" quando resolver encontra.
  //   POST /admin/backfill-mma-events?dryRun=1&limit=50
  if (p === '/admin/backfill-mma-events' && req.method === 'POST') {
    (async () => {
      try {
        const { resolveOrg } = require('./lib/mma-org-resolver');
        const limit = Math.max(1, Math.min(500, parseInt(parsed.query.limit || '100', 10) || 100));
        const dryRun = !(parsed.query.apply === '1' || parsed.query.apply === 'true');

        const rows = db.prepare(`
          SELECT id, participant1, participant2, event_name, sent_at
          FROM tips
          WHERE sport = 'mma'
            AND (event_name IS NULL OR TRIM(event_name) IN ('', 'MMA', 'Boxing'))
          ORDER BY id DESC
          LIMIT ?
        `).all(limit);

        const results = [];
        let updated = 0, unresolved = 0;
        for (const r of rows) {
          const resolved = await resolveOrg(r.participant1, r.participant2, r.sent_at).catch(() => null);
          if (!resolved?.org) {
            unresolved++;
            results.push({ id: r.id, matchup: `${r.participant1} vs ${r.participant2}`, from: r.event_name, to: null });
            continue;
          }
          const newEvent = resolved.eventName && resolved.eventName !== resolved.org
            ? `${resolved.org} — ${resolved.eventName}`
            : resolved.org;
          results.push({ id: r.id, matchup: `${r.participant1} vs ${r.participant2}`, from: r.event_name, to: newEvent });
          if (!dryRun) {
            db.prepare(`UPDATE tips SET event_name = ? WHERE id = ?`).run(newEvent, r.id);
            updated++;
          }
        }
        log('INFO', 'ADMIN', `backfill-mma-events: dryRun=${dryRun} scanned=${rows.length} resolved=${rows.length - unresolved} updated=${updated}`);
        sendJson(res, { ok: true, dryRun, scanned: rows.length, resolved: rows.length - unresolved, unresolved, updated, items: results });
      } catch (e) {
        sendJson(res, { error: e.message, stack: e.stack }, 500);
      }
    })();
    return;
  }

  // Anula em lote todas as tips pendentes mais antigas que N dias (padrão: 60)
  if (p === '/void-old-pending' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const payload = safeParse(body, {});
        const sport = payload.sport || parsed.query.sport || 'esports';
        const days = Math.max(1, Math.min(730, parseInt(payload.days || parsed.query.days || '60', 10) || 60));
        const r = db.prepare(
          `UPDATE tips SET result = 'void', settled_at = datetime('now'), profit_reais = 0
           WHERE sport = ? AND result IS NULL AND sent_at < datetime('now', ?)`
        ).run(sport, `-${days} days`);
        log('INFO', 'ADMIN', `void-old-pending: sport=${sport} days=${days} → ${r.changes} tips anuladas`);
        sendJson(res, { ok: true, voided: r.changes, sport, days });
      } catch(e) {
        sendJson(res, { error: e.message }, 500);
      }
    });
    return;
  }

  if (p === '/record-tip' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const sport = parsed.query.sport || 'esports';
        const t = safeParse(body, {});
        const matchId = clampStr(t.matchId, 128);
        if (!matchId) { badRequest(res, 'matchId obrigatório'); return; }
        const eventName = clampStr(t.eventName, 220);
        const p1 = clampStr(t.p1 || t.team1 || t.fighter1, 120);
        const p2 = clampStr(t.p2 || t.team2 || t.fighter2, 120);
        const tipParticipant = clampStr(t.tipParticipant || t.tipTeam, 120);
        const oddsN = parseFiniteNumber(t.odds);
        const evN = parseFiniteNumber(t.ev);
        if (!p1 || !p2) { badRequest(res, 'p1/p2 obrigatórios'); return; }
        if (!tipParticipant) { badRequest(res, 'tipParticipant obrigatório'); return; }
        if (oddsN == null || oddsN <= 1) { badRequest(res, 'odds inválidas'); return; }
        if (evN == null) { badRequest(res, 'ev inválido'); return; }
        // Guardrail: evita odds absurdas por bug de matching/mercado
        if (sport === 'esports') {
          const minOdds = parseFiniteNumber(process.env.LOL_MIN_ODDS) ?? 1.10;
          const maxOdds = parseFiniteNumber(process.env.LOL_MAX_ODDS) ?? 4.00;
          if (oddsN < minOdds || oddsN > maxOdds) {
            badRequest(res, `odds fora faixa esports (${minOdds}–${maxOdds})`);
            return;
          }
        }
        // Evitar tip duplicada para o mesmo match_id + sport
        const existing = stmts.tipExistsByMatch.get(String(matchId), sport);
        if (existing) { sendJson(res, { ok: true, skipped: true, reason: 'duplicate' }); return; }

        // Dedup secundário: mesmos times + sport nas últimas 2h (impede duplicata quando matchId muda entre fontes)
        // norm() remove espaços/acentos/pontuação, lower() do SQLite mantém espaços — usar REPLACE para match correto
        const p1n_ = norm(p1 || ''), p2n_ = norm(p2 || '');
        if (p1n_ && p2n_) {
          const recentDupe = db.prepare(
            `SELECT 1 FROM tips WHERE sport = ? AND result IS NULL
             AND sent_at > datetime('now', '-2 hours')
             AND ((REPLACE(REPLACE(lower(participant1),' ',''),'-','') LIKE ? AND REPLACE(REPLACE(lower(participant2),' ',''),'-','') LIKE ?)
               OR (REPLACE(REPLACE(lower(participant1),' ',''),'-','') LIKE ? AND REPLACE(REPLACE(lower(participant2),' ',''),'-','') LIKE ?))
             LIMIT 1`
          ).get(sport, `%${p1n_}%`, `%${p2n_}%`, `%${p2n_}%`, `%${p1n_}%`);
          if (recentDupe) { sendJson(res, { ok: true, skipped: true, reason: 'duplicate_pair' }); return; }
        }

        // Blacklist: se já foi VOID por odds errada, não gravar de novo
        const isVoided = stmts.isVoidedMatch.get(sport, String(matchId));
        if (isVoided) { sendJson(res, { ok: true, skipped: true, reason: 'voided_odds_wrong_match' }); return; }
        const p1n = norm(p1), p2n = norm(p2);
        const marketTypeStr = clampStr(t.market_type || 'ML', 20) || 'ML';
        const daysBack = process.env.VOID_TIP_PAIR_DAYS || '90 days';
        const isVoidedPair = stmts.isVoidedPairRecent.get(sport, marketTypeStr, p1n, p2n, p2n, p1n, `-${daysBack}`);
        if (isVoidedPair) { sendJson(res, { ok: true, skipped: true, reason: 'voided_odds_wrong_pair_recent' }); return; }
        const isLive = t.isLive ? 1 : 0;
        const modelP1 = t.modelP1 != null ? parseFiniteNumber(t.modelP1) : null;
        const modelP2 = t.modelP2 != null ? parseFiniteNumber(t.modelP2) : null;
        const modelPPick = t.modelPPick != null ? parseFiniteNumber(t.modelPPick) : null;
        const modelLabel = clampStr(t.modelLabel, 60) || null;
        const tipReason = clampStr(t.tipReason, 600) || null;
        const stakeStr = clampStr(t.stake, 20);
        const confidenceStr = clampStr(t.confidence || 'MÉDIA', 20) || 'MÉDIA';
        const botTokenStr = clampStr(t.botToken, 180);
        // marketTypeStr já definido acima
        const isShadow = t.isShadow ? 1 : 0;
        const result = stmts.insertTip.run({
          sport, matchId: String(matchId), eventName,
          p1, p2,
          tipParticipant, odds: oddsN,
          ev: evN, stake: stakeStr, confidence: confidenceStr,
          isLive, botToken: botTokenStr, market_type: marketTypeStr,
          model_p1: modelP1,
          model_p2: modelP2,
          model_p_pick: modelPPick,
          model_label: modelLabel,
          tip_reason: tipReason,
          isShadow,
          odds_fetched_at: t.oddsFetchedAt
            ? new Date(t.oddsFetchedAt).toISOString()
            : (t._oddsFetchedAt ? new Date(t._oddsFetchedAt).toISOString() : new Date().toISOString())
        });
        // Calcula stake em reais com base na banca atual (1u = 1% da banca atual)
        try {
          const bk = stmts.getBankroll.get(sport);
          if (bk && result.lastInsertRowid) {
            const unitValue = bk.current_banca / 100;
            const stakeUnits = parseFloat(String(t.stake || '1').replace('u','')) || 1;
            const stakeReais = parseFloat((stakeUnits * unitValue).toFixed(2));
            stmts.updateTipFinanceiro.run(stakeReais, null, result.lastInsertRowid);
          }
        } catch(_) {}
        // Grava odds de abertura para CLV tracking
        if (oddsN != null) {
          stmts.updateTipOpenOdds.run(oddsN, String(matchId), sport);
        }
        stmts.incrementApiUsage.run(sport, new Date().toISOString().slice(0,7));
        sendJson(res, { ok: true, tipId: result?.lastInsertRowid || null });
      } catch(e) { sendJson(res, { error: e.message }, 500); }
    });
    return;
  }

  if (p === '/log-tip-factors' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { tipId, factors, predictedDir } = safeParse(body, {});
        const id = parseInt(tipId, 10);
        const dir = clampStr(predictedDir, 10);
        if (!Number.isFinite(id) || id <= 0) { badRequest(res, 'tipId inválido'); return; }
        if (!Array.isArray(factors) || !factors.length) { sendJson(res, { ok: true, inserted: 0 }); return; }
        if (dir !== 't1' && dir !== 't2') { badRequest(res, 'predictedDir inválido'); return; }
        if (factors.length > 80) { badRequest(res, 'factors grande demais'); return; }
        let inserted = 0;
        for (const f of factors) {
          const factor = clampStr(f, 240);
          if (!factor) continue;
          try { stmts.logTipFactor.run(id, factor, dir, null); inserted++; } catch(_) {}
        }
        sendJson(res, { ok: true, inserted });
      } catch(e) { sendJson(res, { error: e.message }, 500); }
    });
    return;
  }

  if (p === '/log-odds-history' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const t = safeParse(body, {});
        const sport = parsed.query.sport || t.sport || 'esports';
        const matchKey = clampStr(t.matchKey, 128);
        const p1 = clampStr(t.p1, 120);
        const p2 = clampStr(t.p2, 120);
        const o1 = parseFiniteNumber(t.oddsP1);
        const o2 = parseFiniteNumber(t.oddsP2);
        const bm = clampStr(t.bookmaker, 60) || '?';
        if (!matchKey || !p1 || !p2 || !o1 || !o2) { sendJson(res, { ok: false }); return; }
        stmts.insertOddsHistory.run(sport, matchKey, p1, p2, o1, o2, bm);
        sendJson(res, { ok: true });
      } catch(e) { sendJson(res, { ok: false, error: e.message }); }
    });
    return;
  }

  if (p === '/resync-stats' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const payload = safeParse(body, {});
        const force = payload.force === true;
        log('INFO', 'ADMIN', `Re-sync de stats solicitado (force=${force})`);
        const result = await syncProStats({ forceResync: force });
        sendJson(res, result);
      } catch(e) { sendJson(res, { ok: false, error: e.message }, 500); }
    });
    return;
  }

  if (p === '/reset-tips' && req.method === 'POST') {
    const sport = parsed.query.sport || 'esports';
    const count = db.prepare("SELECT COUNT(*) as c FROM tips WHERE sport = ?").get(sport).c;
    db.prepare("DELETE FROM tips WHERE sport = ?").run(sport);
    db.prepare("UPDATE bankroll SET current_banca = initial_banca, updated_at = datetime('now') WHERE sport = ?").run(sport);
    log('INFO', 'ADMIN', `Tips resetadas: ${count} registros removidos (sport=${sport})`);
    sendJson(res, { ok: true, deleted: count });
    return;
  }

  if (p === '/tips-history') {
    const sport = parsed.query.sport || 'esports';
    const game  = parsed.query.game || '';
    const limitRaw = parseInt(parsed.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 20;

    // status: open/settled (alias para pending/settled)
    const status = String(parsed.query.status || '').toLowerCase();
    const filter = String(parsed.query.filter || '').toLowerCase();

    // live: 0/1/true/false
    const liveRaw = parsed.query.live;
    const live = (liveRaw === '1' || liveRaw === 1 || liveRaw === true || liveRaw === 'true')
      ? 1
      : (liveRaw === '0' || liveRaw === 0 || liveRaw === false || liveRaw === 'false')
        ? 0
        : null;

    // confidence: ALTA/MÉDIA/BAIXA
    const confRaw = String(parsed.query.confidence || '').toUpperCase().trim();
    const confidence = (confRaw === 'ALTA' || confRaw === 'MÉDIA' || confRaw === 'MEDIA' || confRaw === 'BAIXA')
      ? (confRaw === 'MEDIA' ? 'MÉDIA' : confRaw)
      : '';

    // busca simples: time/atleta/evento
    const q = String(parsed.query.q || '').trim().slice(0, 80);

    // sort: ev/odds/date (default date desc)
    const sort = String(parsed.query.sort || '').toLowerCase();
    const dir = String(parsed.query.dir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const sortCol = sort === 'ev'
      ? 't.ev'
      : sort === 'odds'
        ? 't.odds'
        : 't.sent_at';

    // desempenho: dashboard não usa match_time/match_date
    // se precisar no futuro, criar query separada com includeMatch=1
    let query = `
      SELECT t.*
      FROM tips t
      WHERE t.sport = ?
      AND ${sqlTipsDedupeIdIn('t', '?')}
      ${sqlGameFilter('t', sport, game)}
    `;
    const params = [sport, sport];

    if (status === 'settled') query += " AND t.result IN ('win', 'loss')";
    else if (status === 'open') query += " AND t.result IS NULL";
    else if (status === 'win') query += " AND t.result = 'win'";
    else if (status === 'loss') query += " AND t.result = 'loss'";
    else if (status === 'void') query += " AND t.result = 'void'";
    else if (filter === 'settled') query += " AND t.result IN ('win', 'loss')";
    else if (filter === 'pending') query += " AND t.result IS NULL";
    else if (filter === 'win') query += " AND t.result = 'win'";
    else if (filter === 'loss') query += " AND t.result = 'loss'";
    else query += " AND COALESCE(t.result, '') != 'void'";

    if (live !== null) { query += " AND t.is_live = ?"; params.push(live); }
    if (confidence) { query += " AND UPPER(t.confidence) = ?"; params.push(confidence); }
    if (q) {
      query += " AND (t.event_name LIKE ? OR t.participant1 LIKE ? OR t.participant2 LIKE ? OR t.tip_participant LIKE ?)";
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }

    query += ` ORDER BY ${sortCol} ${dir}, t.id ${dir} LIMIT ?`;
    params.push(limit);

    sendJson(res, db.prepare(query).all(params));
    return;
  }

  if (p === '/settle' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { matchId, winner, home, away } = safeParse(body, {});
        const sport = parsed.query.sport || 'esports';
        if (!matchId || !winner) { sendJson(res, { error: 'Missing matchId/winner' }, 400); return; }
        // Usa transaction para garantir atomicidade: SELECT + UPDATE acontecem juntos,
        // evitando que dois ciclos de settlement processem o mesmo tip simultaneamente.
        const tipsNeedingClv = [];
        const settleResult = db.transaction(() => {
          const tips = db.prepare("SELECT * FROM tips WHERE match_id = ? AND sport = ? AND result IS NULL").all(matchId, sport);
          let settled = 0;
          let bancaDelta = 0;
          for (const tip of tips) {
            let nameMatched, matchMethod, matchScore;
            if (sport === 'tennis') {
              nameMatched = tennisSinglePlayerNameMatch(tip.tip_participant, winner);
              matchMethod = nameMatched ? 'tennis' : 'none';
              matchScore = nameMatched ? 1.0 : 0;
            } else {
              const aliases = sport === 'esports' ? LOL_ALIASES : null;
              const r = nameMatches(tip.tip_participant, winner, { aliases });
              nameMatched = r.match;
              matchMethod = r.method;
              matchScore = r.score;
            }
            const result = nameMatched ? 'win' : 'loss';
            // substring_weak = match fraco — quarentena para evitar false positive/negative
            if (matchMethod === 'substring_weak') {
              log('WARN', 'SETTLE', `QUARANTINE ${sport} matchId=${matchId} tip="${tip.tip_participant}" vs winner="${winner}" → ${result} [method=${matchMethod} score=${matchScore}] — NÃO liquidado (requer /settle-manual)`);
              continue;
            }
            const logLevel = 'INFO';
            log(logLevel, 'SETTLE', `${sport} matchId=${matchId} tip="${tip.tip_participant}" vs winner="${winner}" → ${result} [method=${matchMethod} score=${matchScore}]`);
            stmts.settleTip.run(result, matchId, sport);
            // Atualiza profit_reais e acumula delta da banca
            const stakeR = tip.stake_reais || (() => {
              const bk = stmts.getBankroll.get(sport);
              const uv = bk ? bk.current_banca / 100 : 1;
              const su = parseFloat(String(tip.stake || '1').replace('u','')) || 1;
              return parseFloat((su * uv).toFixed(2));
            })();
            const odds = parseFloat(tip.odds) || 1;
            const profitR = result === 'win'
              ? parseFloat((stakeR * (odds - 1)).toFixed(2))
              : parseFloat((-stakeR).toFixed(2));
            db.prepare("UPDATE tips SET stake_reais = ?, profit_reais = ? WHERE id = ?")
              .run(stakeR, profitR, tip.id);
            // CLV: gravar odds de fecho se ainda não tiver (captura retroativa)
            if (!tip.clv_odds && tip.odds) {
              tipsNeedingClv.push({ id: tip.id, matchId: tip.match_id, sport, odds: tip.odds, p1: tip.participant1, p2: tip.participant2 });
            }
            bancaDelta += profitR;
            settled++;
          }
          return { settled, bancaDelta };
        })();
        let { settled, bancaDelta } = settleResult;
        // Atualiza banca total
        if (bancaDelta !== 0) {
          const bk = stmts.getBankroll.get(sport);
          if (bk) {
            const nova = parseFloat((bk.current_banca + bancaDelta).toFixed(2));
            stmts.updateBankroll.run(nova, sport);
            log('INFO', 'BANCA', `Settlement [${sport}]: delta R$${bancaDelta >= 0 ? '+' : ''}${bancaDelta.toFixed(2)} → banca agora R$${nova}`);
          }
        }
        // Atualiza Elo após settlement de futebol (só para mercados 1X2, não Over/Under)
        if (sport === 'football' && settled > 0 && winner && winner !== '__loss__') {
          const homeTeam = home || '';
          const awayTeam = away || '';
          const nw = norm(winner);
          const isTeamOrDraw = winner === 'Draw'
            || (homeTeam && nw && (nw.includes(norm(homeTeam)) || norm(homeTeam).includes(nw)))
            || (awayTeam && nw && (nw.includes(norm(awayTeam)) || norm(awayTeam).includes(nw)));
          if (homeTeam && awayTeam && isTeamOrDraw) {
            try { updateEloMatch(homeTeam, awayTeam, winner); }
            catch(e) { log('WARN', 'ELO', `Elo update falhou: ${e.message}`); }
          }
        }
        sendJson(res, { ok: true, settled, bancaDelta: parseFloat(bancaDelta.toFixed(2)) });

        // CLV retroativo: busca odds de fecho para tips que não tinham clv_odds
        // Executa fora da transaction, sem bloquear a resposta
        if (tipsNeedingClv.length > 0) {
          setImmediate(async () => {
            for (const t of tipsNeedingClv) {
              try {
                // Tenta buscar odds atuais para os mesmos times (serão as closing odds ou próximas disso)
                const game = t.sport === 'esports' ? 'lol' : (t.sport === 'dota2' ? 'dota2' : t.sport);
                const oddsUrl = `/odds?team1=${encodeURIComponent(t.p1 || '')}&team2=${encodeURIComponent(t.p2 || '')}&game=${game}`;
                const currentOdds = await new Promise((resolve) => {
                  const req = http.get({ hostname: '127.0.0.1', port: PORT, path: oddsUrl, timeout: 8000 }, (res) => {
                    let d = ''; res.on('data', c => d += c);
                    res.on('end', () => { try { resolve(JSON.parse(d)); } catch(_) { resolve(null); } });
                  });
                  req.on('error', () => resolve(null));
                  req.end();
                }).catch(() => null);

                if (currentOdds?.t1 && currentOdds?.t2) {
                  // CLV = odds no qual apostamos / odds de fecho
                  // Se apostamos em t1: clv_odds = currentOdds.t1
                  // Se apostamos em t2: clv_odds = currentOdds.t2
                  const tipNorm = norm(t.p1 || '');
                  const isT1 = norm(t.p1 || '').length > 0; // tip_participant matching
                  const closingOdd = parseFloat(isT1 ? currentOdds.t1 : currentOdds.t2);
                  if (closingOdd > 1) {
                    stmts.updateTipCLV.run(closingOdd, t.matchId, t.sport);
                    const clvPct = ((parseFloat(t.odds) / closingOdd - 1) * 100).toFixed(1);
                    log('INFO', 'CLV', `${t.sport} ${t.p1} vs ${t.p2}: closing=${closingOdd} tip=${t.odds} CLV=${clvPct}%`);
                  }
                }
              } catch (_) {}
            }
          });
        }
      } catch(e) { sendJson(res, { error: e.message }, 500); }
    });
    return;
  }

  // ── ROI e Estatísticas ──
  if (p === '/roi') {
    const sport = parsed.query.sport || 'esports';
    const game  = parsed.query.game || '';
    const dedupe = sqlTipsDedupeIdIn('t', '?');
    const gameSql = sqlGameFilter('t', sport, game);
    const row = db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN t.result='win' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN t.result='loss' THEN 1 ELSE 0 END) as losses,
        ROUND(AVG(t.ev), 2) as avg_ev,
        ROUND(AVG(t.odds), 2) as avg_odds
      FROM tips t
      WHERE t.sport = ? AND ${dedupe}
      AND t.result IS NOT NULL AND t.result != 'void'
      ${gameSql}
    `).get(sport, sport);
    const calibration = db.prepare(`
      SELECT t.confidence, COUNT(*) as total,
        SUM(CASE WHEN t.result='win' THEN 1 ELSE 0 END) as wins,
        ROUND(100.0 * SUM(CASE WHEN t.result='win' THEN 1 ELSE 0 END) / COUNT(*), 1) as win_rate
      FROM tips t
      WHERE t.sport = ? AND ${dedupe}
      AND t.result IS NOT NULL AND t.result != 'void'
      ${gameSql}
      GROUP BY t.confidence
    `).all(sport, sport);

    const tips = db.prepare(`
      SELECT t.odds, t.stake, t.result, t.ev, t.is_live, t.clv_odds, t.open_odds, t.model_p_pick
      FROM tips t
      WHERE t.sport = ? AND ${dedupe}
      AND t.result IS NOT NULL AND t.result != 'void'
      ${gameSql}
    `).all(sport, sport);
    let totalStaked = 0, totalProfit = 0;
    const liveTips = { wins: 0, losses: 0, total: 0, profit: 0, staked: 0 };
    const preTips  = { wins: 0, losses: 0, total: 0, profit: 0, staked: 0 };

    // CLV: calculado apenas em tips com clv_odds registrado
    let clvSum = 0, clvCount = 0, clvPositive = 0;
    const clvLive = { sum: 0, count: 0, positive: 0 };
    const clvPre  = { sum: 0, count: 0, positive: 0 };

    // Calibração probabilística: Brier Score e Log Loss
    let brierSum = 0, logLossSum = 0, calibCount = 0;

    for (const t of tips) {
      const stake = parseFloat(t.stake) || 1;
      const odds  = parseFloat(t.odds)  || 1;
      const profit = t.result === 'win' ? stake * (odds - 1) : -stake;
      totalStaked  += stake;
      totalProfit  += profit;
      const bucket = t.is_live ? liveTips : preTips;
      bucket.total++;
      bucket.staked += stake;
      bucket.profit += profit;
      if (t.result === 'win') bucket.wins++; else bucket.losses++;

      // CLV = (tipOdds / closingOdds - 1) × 100 → positivo = compramos melhor que o mercado fechou
      const clvOdds = parseFloat(t.clv_odds);
      if (clvOdds > 1) {
        const clv = (odds / clvOdds - 1) * 100;
        clvSum += clv;
        clvCount++;
        if (clv > 0) clvPositive++;
        const cb = t.is_live ? clvLive : clvPre;
        cb.sum += clv; cb.count++; if (clv > 0) cb.positive++;
      }

      // Brier Score e Log Loss: p derivado do EV e odds
      // EV armazenado como porcentagem (ex: 5.2 para 5.2%)
      // Fórmula: p = (1 + EV/100) / odds, onde EV em decimal = ev/100
      const ev = parseFloat(t.ev) || 0;
      if (odds > 1 && t.result) {
        const pStored = parseFloat(t.model_p_pick);
        let p = (isFinite(pStored) && pStored > 0 && pStored < 1)
          ? pStored
          : (ev > 0 ? (1 + ev / 100) / odds : 1 / odds);
        p = Math.max(0.01, Math.min(0.99, p));
        const o = t.result === 'win' ? 1 : 0;
        brierSum += (p - o) ** 2;
        logLossSum += -(o * Math.log(p) + (1 - o) * Math.log(1 - p));
        calibCount++;
      }
    }

    const roi = totalStaked > 0 ? ((totalProfit / totalStaked) * 100).toFixed(2) : '0.00';
    const calcBucketROI = b => b.staked > 0 ? ((b.profit / b.staked) * 100).toFixed(2) : '0.00';
    const calcCLV = c => c.count > 0 ? {
      avg: parseFloat((c.sum / c.count).toFixed(2)),
      positiveRate: Math.round(c.positive / c.count * 100),
      count: c.count
    } : null;

    // Dados da banca em reais — calcula current_banca a partir dos profits reais acumulados
    const bk = stmts.getBankroll.get(sport);
    let bancaInfo = null;

    if (bk) {
      // Backfill: tips arquivadas sem profit_reais calculado (coluna adicionada depois do settlement)
      const orphans = db.prepare(
        `SELECT t.id, t.result, t.odds, t.stake, t.stake_reais FROM tips t
         WHERE t.sport = ? AND ${sqlTipsDedupeIdIn('t', '?')}
         AND t.result IS NOT NULL AND t.result != 'void' AND t.profit_reais IS NULL`
      ).all(sport, sport);
      if (orphans.length > 0) {
        const unitValue = bk.initial_banca / 100;
        const backfill = db.prepare("UPDATE tips SET stake_reais = ?, profit_reais = ? WHERE id = ?");
        for (const t of orphans) {
          const stakeR = t.stake_reais || parseFloat(((parseFloat(String(t.stake || '1').replace('u','')) || 1) * unitValue).toFixed(2));
          const odds = parseFloat(t.odds) || 1;
          const profitR = t.result === 'win'
            ? parseFloat((stakeR * (odds - 1)).toFixed(2))
            : parseFloat((-stakeR).toFixed(2));
          backfill.run(stakeR, profitR, t.id);
        }
        log('INFO', 'BANCA', `[${sport}] Backfill: ${orphans.length} tips sem profit_reais recalculadas`);
      }

      const profitRow = db.prepare(
        `SELECT COALESCE(SUM(t.profit_reais), 0) as total_profit FROM tips t
         WHERE t.sport = ? AND ${sqlTipsDedupeIdIn('t', '?')}
         AND t.result IS NOT NULL AND t.result != 'void' AND t.profit_reais IS NOT NULL`
      ).get(sport, sport);
      const accumulatedProfit = parseFloat((profitRow?.total_profit || 0).toFixed(2));
      const currentBanca = parseFloat((bk.initial_banca + accumulatedProfit).toFixed(2));
      // Sincroniza o registro caso esteja desatualizado
      if (Math.abs(currentBanca - bk.current_banca) > 0.01) {
        stmts.updateBankroll.run(currentBanca, sport);
      }
      bancaInfo = {
        initialBanca: bk.initial_banca,
        currentBanca: currentBanca,
        unitValue: parseFloat((currentBanca / 100).toFixed(4)),
        profitReais: accumulatedProfit,
        growthPct: parseFloat((accumulatedProfit / bk.initial_banca * 100).toFixed(2)),
        updatedAt: bk.updated_at
      };
    } else {
      // Se não existe registro no bankroll, cria um com valores padrão
      db.prepare('INSERT OR IGNORE INTO bankroll (sport, initial_banca, current_banca) VALUES (?, 100.0, 100.0)').run(sport);
      const newBk = stmts.getBankroll.get(sport);
      if (newBk) {
        bancaInfo = {
          initialBanca: newBk.initial_banca,
          currentBanca: newBk.current_banca,
          unitValue: parseFloat((newBk.current_banca / 100).toFixed(4)),
          profitReais: 0,
          growthPct: 0,
          updatedAt: newBk.updated_at
        };
      }
    }

    const totalAllRow = db.prepare(
      `SELECT COUNT(*) as c FROM tips t WHERE t.sport = ? AND ${sqlTipsDedupeIdIn('t', '?')} AND COALESCE(t.result,'') != 'void' ${gameSql}`
    ).get(sport, sport);
    const pendingRow  = db.prepare(
      `SELECT COUNT(*) as c FROM tips t WHERE t.sport = ? AND ${sqlTipsDedupeIdIn('t', '?')} AND t.result IS NULL ${gameSql}`
    ).get(sport, sport);

    sendJson(res, {
      overall: {
        total: row?.total || 0, wins: row?.wins || 0, losses: row?.losses || 0,
        totalAll: totalAllRow?.c || 0, pending: pendingRow?.c || 0,
        roi, totalProfit: totalProfit.toFixed(2), totalStaked: totalStaked.toFixed(2),
        avg_ev: row?.avg_ev || 0, avg_odds: row?.avg_odds || 0
      },
      calibration: calibration.map(c => ({ ...c, win_rate: c.win_rate?.toFixed(1) || '0.0' })),
      byPhase: {
        live:    { ...liveTips, roi: calcBucketROI(liveTips) },
        preGame: { ...preTips,  roi: calcBucketROI(preTips)  }
      },
      clv: clvCount > 0 ? {
        avg: parseFloat((clvSum / clvCount).toFixed(2)),
        positiveRate: Math.round(clvPositive / clvCount * 100),
        count: clvCount,
        byPhase: { live: calcCLV(clvLive), preGame: calcCLV(clvPre) }
      } : null,
      calibration_metrics: calibCount >= 3 ? {
        brierScore: parseFloat((brierSum / calibCount).toFixed(4)),
        logLoss: parseFloat((logLossSum / calibCount).toFixed(4)),
        sampleSize: calibCount,
        interpretation: brierSum / calibCount < 0.20 ? 'boa' : brierSum / calibCount < 0.25 ? 'acima_da_media' : 'ruim'
      } : null,
      banca: bancaInfo
    });
    return;
  }

  // ── ROI por Liga (divisão usada pelo stake multiplier) ──
  if (p === '/league-roi') {
    const sport = parsed.query.sport || 'esports';
    const game  = parsed.query.game || '';
    const minRaw = parseInt(parsed.query.min, 10);
    const minTotal = Number.isFinite(minRaw) ? Math.max(1, Math.min(100, minRaw)) : 1;
    const gameSql = sqlGameFilter('tips', sport, game);
    try {
      const rows = db.prepare(`
        SELECT
          COALESCE(NULLIF(TRIM(event_name), ''), '(sem liga)') AS league,
          COALESCE(is_live, 0) AS is_live,
          UPPER(COALESCE(NULLIF(TRIM(confidence), ''), 'MÉDIA')) AS conf,
          COUNT(*) AS total,
          SUM(CASE WHEN result='win'  THEN 1 ELSE 0 END) AS wins,
          SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) AS losses,
          ROUND(SUM(COALESCE(stake_reais, 0)), 2)  AS staked,
          ROUND(SUM(COALESCE(profit_reais, 0)), 2) AS profit
        FROM tips
        WHERE sport = ? AND result IN ('win','loss')
        ${gameSql}
        GROUP BY league, is_live, conf
      `).all(sport);

      // Mapa league → { all, pre, live, byConf } (mesmas faixas de multiplicador de lib/stake-adjuster.js)
      const roiOf = (staked, profit) => staked > 0 ? +((profit / staked) * 100).toFixed(2) : 0;
      const multOf = (roi, total) => {
        if (total < 20) return null; // insuficiente
        if (roi >= 15)  return 1.20;
        if (roi >= 5)   return 1.10;
        if (roi >= -5)  return 1.00;
        if (roi >= -15) return 0.75;
        if (roi >= -25) return 0.50;
        return 0;
      };

      const emptyBucket = () => ({ total: 0, wins: 0, losses: 0, staked: 0, profit: 0 });
      const normConf = (c) => {
        const s = String(c || '').toUpperCase().trim();
        if (s === 'ALTA') return 'ALTA';
        if (s === 'BAIXA') return 'BAIXA';
        if (s === 'MEDIA' || s === 'MÉDIA') return 'MÉDIA';
        return 'MÉDIA';
      };

      const byLeague = new Map();
      for (const r of rows) {
        const key = rollupLeague(sport, r.league);
        if (!byLeague.has(key)) {
          byLeague.set(key, {
            league: key,
            all:  emptyBucket(),
            pre:  emptyBucket(),
            live: emptyBucket(),
            byConf: { ALTA: emptyBucket(), 'MÉDIA': emptyBucket(), BAIXA: emptyBucket() },
          });
        }
        const agg = byLeague.get(key);
        const phaseBucket = r.is_live ? agg.live : agg.pre;
        const confBucket = agg.byConf[normConf(r.conf)];
        const apply = (b) => {
          b.total  += r.total  || 0;
          b.wins   += r.wins   || 0;
          b.losses += r.losses || 0;
          b.staked += r.staked || 0;
          b.profit += r.profit || 0;
        };
        apply(phaseBucket);
        apply(confBucket);
        apply(agg.all);
      }

      const finalize = (b) => ({
        total: b.total,
        wins: b.wins,
        losses: b.losses,
        staked: +b.staked.toFixed(2),
        profit: +b.profit.toFixed(2),
        roi: roiOf(b.staked, b.profit),
      });

      const leagues = [...byLeague.values()]
        .filter(x => x.all.total >= minTotal)
        .map(x => {
          const all = finalize(x.all);
          return {
            league: x.league,
            all,
            pre:  finalize(x.pre),
            live: finalize(x.live),
            byConf: {
              ALTA:    finalize(x.byConf.ALTA),
              'MÉDIA': finalize(x.byConf['MÉDIA']),
              BAIXA:   finalize(x.byConf.BAIXA),
            },
            multiplier: multOf(all.roi, all.total), // null = amostra insuficiente
            active: all.total >= 20,
          };
        })
        .sort((a, b) => b.all.total - a.all.total);

      sendJson(res, {
        sport,
        leagues,
        thresholds: [
          { from:  15, mult: 1.20 },
          { from:   5, mult: 1.10 },
          { from:  -5, mult: 1.00 },
          { from: -15, mult: 0.75 },
          { from: -25, mult: 0.50 },
          { from: null, mult: 0 },
        ],
        minSample: 20,
      });
    } catch(e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  if (p === '/dashboard' || p === '/') {
    const htmlPath = path.join(__dirname, 'public', 'dashboard.html');
    try {
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache'
      });
      res.end(html);
    } catch(_) {
      res.writeHead(404); res.end('Dashboard not found');
    }
    return;
  }

  // ── Logs dashboard (migrado de scripts/logs-dashboard.js) ──
  // HTML servido sem admin; endpoints JSON exigem x-admin-key (enviado pelo JS da página).
  if (p === '/logs') {
    const htmlPath = path.join(__dirname, 'public', 'logs.html');
    try {
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch (_) { res.writeHead(404); res.end('logs.html not found'); }
    return;
  }
  if (p === '/logs/status') {
    if (!requireAdmin(req, res)) return;
    sendJson(res, dashboard.computeStatus());
    return;
  }
  if (p === '/logs/tips') {
    if (!requireAdmin(req, res)) return;
    const limit = parseInt(parsed.query.limit || '60', 10);
    sendJson(res, dashboard.extractTips(limit));
    return;
  }
  if (p === '/logs/live-matches') {
    if (!requireAdmin(req, res)) return;
    sendJson(res, dashboard.extractLiveMatches());
    return;
  }
  if (p === '/logs/history') {
    if (!requireAdmin(req, res)) return;
    sendJson(res, dashboard.getClassifiedBuffer());
    return;
  }
  if (p === '/logs/stream') {
    if (!requireAdmin(req, res)) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':ok\n\n');
    addLogClient(res);
    const ka = setInterval(() => { try { res.write(':ka\n\n'); } catch(_) {} }, 15000);
    req.on('close', () => { clearInterval(ka); removeLogClient(res); });
    return;
  }
  // Ingest de logs externos (chamado pelo start.js a partir do stdout do bot.js).
  // Aceita loopback (127.0.0.1/::1) sem admin key — é IPC interno.
  if (p === '/logs/ingest' && req.method === 'POST') {
    const ra = String(req.socket?.remoteAddress || '');
    const isLoopback = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
    if (!isLoopback && !requireAdmin(req, res)) return;
    let body = '';
    req.on('data', c => { if (body.length < 500_000) body += c; });
    req.on('end', () => {
      try {
        const j = JSON.parse(body || '{}');
        const lines = Array.isArray(j.lines) ? j.lines : (j.line ? [j.line] : []);
        for (const ln of lines) ingestExternalLog(ln);
        sendJson(res, { ok: true, ingested: lines.length });
      } catch (e) {
        sendJson(res, { ok: false, error: e.message }, 400);
      }
    });
    return;
  }

  if (p === '/agents/live-scout') {
    if (!requireAdmin(req, res)) return;
    const base = `http://127.0.0.1:${PORT}`;
    dashboard.runLiveScout(base).then(data => sendJson(res, data))
      .catch(e => sendJson(res, { ok: false, error: e.message }, 500));
    return;
  }
  if (p === '/agents/feed-medic') {
    if (!requireAdmin(req, res)) return;
    const base = `http://127.0.0.1:${PORT}`;
    dashboard.runFeedMedic(base).then(data => sendJson(res, data))
      .catch(e => sendJson(res, { ok: false, error: e.message }, 500));
    return;
  }
  if (p === '/agents/roi-analyst') {
    if (!requireAdmin(req, res)) return;
    try { sendJson(res, dashboard.runRoiAnalyst(db, parsed.query.days || '30')); }
    catch (e) { sendJson(res, { ok: false, error: e.message }, 500); }
    return;
  }

  if (p === '/calibration') {
    const sport = parsed.query.sport || 'esports';
    const game  = parsed.query.game || '';
    try {
      const limitRaw = parseInt(parsed.query.limit);
      const limit = Number.isFinite(limitRaw)
        ? Math.max(20, Math.min(3000, limitRaw))
        : (parseInt(process.env.CALIBRATION_LIMIT || '800', 10) || 800);

      const minBinRaw = parseInt(parsed.query.minBin);
      const minBin = Number.isFinite(minBinRaw)
        ? Math.max(5, Math.min(200, minBinRaw))
        : (parseInt(process.env.CALIBRATION_MIN_BIN || '12', 10) || 12);

      const phase = String(parsed.query.phase || 'all'); // all | live | pre
      const gameSql = sqlGameFilter('t', sport, game);

      const tips = db.prepare(
        `SELECT t.odds, t.ev, t.result, t.is_live, t.model_p_pick, t.sent_at, t.settled_at
         FROM tips t
         WHERE t.sport = ? AND ${sqlTipsDedupeIdIn('t', '?')}
         AND t.result IN ('win','loss')
         ${gameSql}
         ORDER BY COALESCE(t.settled_at, t.sent_at) DESC
         LIMIT ?`
      ).all(sport, sport, limit);

      function tipToP(t) {
        const odds = parseFloat(t.odds) || 0;
        if (odds <= 1) return null;
        const ev = parseFloat(String(t.ev || '0').replace('%','').replace('+','')) / 100;
        const pStored = parseFloat(t.model_p_pick);
        const pRaw = (isFinite(pStored) && pStored > 0 && pStored < 1)
          ? pStored
          : ((ev + 1) / odds);
        const p = Math.max(0.01, Math.min(0.99, pRaw));
        const o = t.result === 'win' ? 1 : 0;
        return { p, o, is_live: !!t.is_live };
      }

      function buildAdaptiveBuckets(rows) {
        const pts = [];
        let brierSum = 0, logLossSum = 0, n = 0;
        for (const t of rows) {
          const x = tipToP(t);
          if (!x) continue;
          pts.push(x);
          brierSum += (x.p - x.o) ** 2;
          logLossSum += -(x.o * Math.log(x.p) + (1 - x.o) * Math.log(1 - x.p));
          n++;
        }
        if (!pts.length) return { buckets: [], brierScore: null, logLoss: null, total: 0, binSize: 0 };
        pts.sort((a, b) => a.p - b.p);

        const binSize = Math.max(minBin, Math.ceil(pts.length / 8)); // alvo ~6–10 bins
        const buckets = [];
        for (let i = 0; i < pts.length; i += binSize) {
          const slice = pts.slice(i, i + binSize);
          if (!slice.length) continue;
          const pAvg = slice.reduce((s, x) => s + x.p, 0) / slice.length;
          const winRate = slice.reduce((s, x) => s + x.o, 0) / slice.length;
          const lo = slice[0].p;
          const hi = slice[slice.length - 1].p;
          buckets.push({
            bucket: `${Math.round(lo * 100)}-${Math.round(hi * 100)}%`,
            predicted: parseFloat((pAvg * 100).toFixed(1)),
            wins: slice.reduce((s, x) => s + x.o, 0),
            total: slice.length,
            actual: parseFloat((winRate * 100).toFixed(1))
          });
        }
        return {
          buckets,
          brierScore: n > 0 ? (brierSum / n) : null,
          logLoss: n > 0 ? (logLossSum / n) : null,
          total: n,
          binSize
        };
      }

      const all = buildAdaptiveBuckets(tips);
      const live = buildAdaptiveBuckets(tips.filter(t => !!t.is_live));
      const pre  = buildAdaptiveBuckets(tips.filter(t => !t.is_live));

      const out =
        phase === 'live' ? live :
        phase === 'pre' ? pre :
        all;

      sendJson(res, {
        sport,
        phase,
        limit,
        minBin,
        binSize: out.binSize,
        buckets: out.buckets,
        brierScore: out.brierScore,
        logLoss: out.logLoss,
        total: out.total,
        byPhase: {
          live: { buckets: live.buckets, brierScore: live.brierScore, logLoss: live.logLoss, total: live.total, binSize: live.binSize },
          preGame: { buckets: pre.buckets, brierScore: pre.brierScore, logLoss: pre.logLoss, total: pre.total, binSize: pre.binSize },
        }
      });
    } catch(e) { sendJson(res, { error: e.message }, 500); }
    return;
  }

  // ── Bankroll endpoints ──
  if (p === '/bankroll') {
    const sport = parsed.query.sport || 'esports';
    const bk = stmts.getBankroll.get(sport);
    if (!bk) { sendJson(res, { error: 'Bankroll não inicializado' }, 500); return; }
    const profitRow = db.prepare(
      "SELECT COALESCE(SUM(profit_reais), 0) as total_profit FROM tips WHERE sport = ? AND result IS NOT NULL AND result != 'void' AND profit_reais IS NOT NULL"
    ).get(sport);
    const accumulatedProfit = parseFloat((profitRow?.total_profit || 0).toFixed(2));
    const currentBanca = parseFloat((bk.initial_banca + accumulatedProfit).toFixed(2));
    sendJson(res, {
      initialBanca: bk.initial_banca,
      currentBanca: currentBanca,
      unitValue: parseFloat((currentBanca / 100).toFixed(4)),
      profitReais: accumulatedProfit,
      growthPct: parseFloat((accumulatedProfit / bk.initial_banca * 100).toFixed(2)),
      updatedAt: bk.updated_at
    });
    return;
  }

  // ── Global Risk Snapshot (cross-sport) ──
  if (p === '/risk-snapshot') {
    try {
      const sports = ['esports', 'mma', 'tennis', 'tabletennis', 'cs', 'darts', 'snooker', 'football'];
      const bySport = {};
      let totalBanca = 0;
      let totalPendingReais = 0;

      for (const s of sports) {
        const bk = stmts.getBankroll.get(s);
        // Reusa lógica de /bankroll para currentBanca
        let currentBanca = bk?.current_banca;
        if (bk) {
          const profitRow = db.prepare(
            "SELECT COALESCE(SUM(profit_reais), 0) as total_profit FROM tips WHERE sport = ? AND result IS NOT NULL AND profit_reais IS NOT NULL"
          ).get(s);
          const accumulatedProfit = parseFloat((profitRow?.total_profit || 0).toFixed(2));
          currentBanca = parseFloat((bk.initial_banca + accumulatedProfit).toFixed(2));
        }
        currentBanca = parseFloat(currentBanca) || 0;

        const pending = db.prepare(
          "SELECT COALESCE(SUM(stake_reais), 0) as pending_reais, COUNT(*) as n FROM tips WHERE sport = ? AND result IS NULL"
        ).get(s);
        const pendingReais = parseFloat((pending?.pending_reais || 0).toFixed(2));

        bySport[s] = {
          currentBanca,
          pendingReais,
          pendingCount: pending?.n || 0,
          unitValue: parseFloat((currentBanca / 100).toFixed(4))
        };
        totalBanca += currentBanca;
        totalPendingReais += pendingReais;
      }

      sendJson(res, {
        totalBanca: parseFloat(totalBanca.toFixed(2)),
        totalPendingReais: parseFloat(totalPendingReais.toFixed(2)),
        bySport
      });
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  if (p === '/set-bankroll' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { valor, sport: sportParam } = safeParse(body, {});
        const sport = (sportParam || parsed.query.sport || 'esports');
        const v = parseFloat(valor);
        if (!v || v <= 0) { sendJson(res, { error: 'valor inválido' }, 400); return; }
        stmts.resetBankroll.run(v, v, sport);
        log('INFO', 'BANCA', `Banca [${sport}] redefinida para R$${v.toFixed(2)}`);
        sendJson(res, { ok: true, currentBanca: v, unitValue: parseFloat((v / 100).toFixed(4)) });
      } catch(e) { sendJson(res, { error: e.message }, 500); }
    });
    return;
  }

  // ── Champion WR pro play ──
  if (p === '/champ-winrates') {
    const champList = (parsed.query.champs || '').split(',').map(s => s.trim()).filter(Boolean);
    const roleList  = (parsed.query.roles  || '').split(',').map(s => s.trim()).filter(Boolean);
    const result = {};
    for (let i = 0; i < champList.length; i++) {
      const champ = champList[i];
      const role  = roleList[i] || 'unknown';
      let stat = stmts.getChampStat.get(champ, role);
      if (!stat) stat = stmts.getChampStatAnyRole.get(champ); // fallback: any role
      if (stat && stat.total >= 5) {
        result[champ] = { role: stat.role, winRate: Math.round(stat.wins / stat.total * 100), total: stat.total };
      }
    }
    sendJson(res, result);
    return;
  }

  // ── Player+champ WR pro play ──
  if (p === '/player-champ-stats') {
    const players = (parsed.query.players || '').split(',').map(s => s.trim()).filter(Boolean);
    const champs  = (parsed.query.champs  || '').split(',').map(s => s.trim()).filter(Boolean);
    const result = {};
    for (let i = 0; i < players.length; i++) {
      const player = players[i];
      const champ  = champs[i];
      if (!player) continue;
      if (champ) {
        const stat = stmts.getPlayerChampStat.get(player, champ);
        if (stat && stat.total >= 3) {
          result[`${player}/${champ}`] = { winRate: Math.round(stat.wins / stat.total * 100), total: stat.total };
        }
      } else {
        // Retorna top champs do jogador
        const rows = stmts.getPlayerChampStats.all(player);
        result[player] = rows.filter(r => r.total >= 3).map(r => ({
          champion: r.champion,
          winRate: Math.round(r.wins / r.total * 100),
          total: r.total
        }));
      }
    }
    sendJson(res, result);
    return;
  }

  // ── LoL EV manual: ligas e campeões (DB) ──
  if (p === '/lol/ev-manual-meta') {
    try {
      const leagueRows = db.prepare(`
        SELECT league AS name, COUNT(*) AS n FROM match_results
        WHERE game = 'lol' AND league IS NOT NULL AND TRIM(league) != ''
        GROUP BY league ORDER BY n DESC LIMIT 300
      `).all();
      const champRows = db.prepare(`
        SELECT DISTINCT champion FROM pro_champ_stats ORDER BY champion COLLATE NOCASE
      `).all();
      let champions = champRows.map(r => r.champion).filter(Boolean);

      // Fallback: se DB está vazio, usa lista oficial (Data Dragon)
      if (!champions.length) {
        const ttl7d = 7 * 24 * 60 * 60 * 1000;
        const vR = await cachedHttpGet('https://ddragon.leagueoflegends.com/api/versions.json', { provider: 'ddragon', ttlMs: ttl7d }).catch(() => null);
        const vers = safeParse(vR && vR.body, null);
        const v = Array.isArray(vers) && vers.length ? String(vers[0]) : '';
        if (v) {
          const cjR = await cachedHttpGet(`https://ddragon.leagueoflegends.com/cdn/${encodeURIComponent(v)}/data/en_US/champion.json`, { provider: 'ddragon', ttlMs: ttl7d }).catch(() => null);
          const cj = safeParse(cjR && cjR.body, null);
          const data = cj && cj.data ? cj.data : null;
          if (data && typeof data === 'object') {
            champions = Object.keys(data)
              .map(k => data[k] && data[k].name ? String(data[k].name) : '')
              .filter(Boolean)
              .sort((a, b) => String(a).localeCompare(String(b)));
          }
        }
      }
      sendJson(res, {
        ok: true,
        leagues: leagueRows.map(r => r.name),
        champions
      });
    } catch (e) {
      sendJson(res, { ok: false, error: e.message }, 500);
    }
    return;
  }

  if (p === '/lol/ev-manual-teams') {
    try {
      const league = String(parsed.query.league || '').trim();
      let rows;
      if (league) {
        rows = db.prepare(`
          SELECT DISTINCT t FROM (
            SELECT team1 AS t FROM match_results WHERE game = 'lol' AND league = ?
            UNION
            SELECT team2 AS t FROM match_results WHERE game = 'lol' AND league = ?
          )
          WHERE t IS NOT NULL AND TRIM(t) != ''
          ORDER BY t COLLATE NOCASE
        `).all(league, league);

        // Fallback: se DB tiver poucos times, completa com jogos atuais (Riot/PandaScore)
        if ((rows || []).length < 20) {
          const want = league.toLowerCase();
          const seen = new Set((rows || []).map(r => String(r.t || '').trim()).filter(Boolean));
          const addTeam = (t) => {
            const s = String(t || '').trim();
            if (!s) return;
            seen.add(s);
          };
          const addMatch = (m) => {
            if (!m) return;
            const lg = String(m.league || '').toLowerCase();
            if (!lg) return;
            if (lg === want || lg.includes(want)) {
              addTeam(m.team1);
              addTeam(m.team2);
            }
          };

          // Riot schedule + PandaScore (cacheado)
          try {
            const [riotA, riotB, ps] = await Promise.all([
              getLoLMatchesArush().catch(() => []),
              getLoLMatches().catch(() => []),
              getPandaScoreLolMatches().catch(() => []),
            ]);
            [...riotA, ...riotB, ...ps].forEach(addMatch);
          } catch (_) {}

          // Riot schedule bruto (pega times mesmo sem /lol-matches exibir)
          try {
            const sr = await httpGet(LOL_BASE + '/getSchedule?hl=en-US', LOL_HEADERS);
            const sd = safeParse(sr.body, {});
            const evs = sd?.data?.schedule?.events || [];
            for (const e of evs) {
              const lName = String(e.league?.name || '').toLowerCase();
              const lSlug = String(e.league?.slug || '').toLowerCase();
              if (!(lName === want || lSlug === want || lName.includes(want) || lSlug.includes(want))) continue;
              const t1 = e.match?.teams?.[0];
              const t2 = e.match?.teams?.[1];
              addTeam(t1?.name || t1?.code || '');
              addTeam(t2?.name || t2?.code || '');
            }
          } catch (_) {}

          rows = [...seen].sort((a, b) => a.localeCompare(b)).map(t => ({ t }));
        }
      } else {
        rows = db.prepare(`
          SELECT team AS t, COUNT(*) AS c FROM (
            SELECT team1 AS team FROM match_results WHERE game = 'lol'
            UNION ALL
            SELECT team2 FROM match_results WHERE game = 'lol'
          ) AS u
          WHERE team IS NOT NULL AND TRIM(team) != ''
          GROUP BY team ORDER BY c DESC LIMIT 600
        `).all();
      }
      sendJson(res, { ok: true, teams: rows.map(r => r.t) });
    } catch (e) {
      sendJson(res, { ok: false, error: e.message }, 500);
    }
    return;
  }

  // ── Sync pro stats (PandaScore → pro_champ_stats + match_results) ──
  if (p === '/sync-pro-stats') {
    if (!PANDASCORE_TOKEN) { sendJson(res, { ok: false, error: 'PANDASCORE_TOKEN não configurado' }); return; }
    syncProStats().then(r => sendJson(res, r)).catch(e => sendJson(res, { ok: false, error: e.message }));
    return;
  }

  // ── Sync gol.gg Role Impact (PandaTobi repo CSV) ──
  if (p === '/sync-golgg-role-impact') {
    if (!requireAdmin(req, res)) return;
    try {
      const out = await syncGolggRoleImpact();
      if (!out.ok) { sendJson(res, out, 502); return; }
      sendJson(res, out);
    } catch (e) {
      sendJson(res, { ok: false, error: e.message }, 500);
    }
    return;
  }

  // ── LoL Match Winner: EV com odds manuais (sem API de odds) ──
  if (p === '/lol/ev-manual') {
    const serveEvManualPage = () => {
      const htmlPath = path.join(__dirname, 'public', 'lol-ev-manual.html');
      try {
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Arquivo public/lol-ev-manual.html ausente ou ilegível.');
      }
    };

    const ROLE_KEYS = ['TOP', 'JGL', 'MID', 'ADC', 'SUP'];
    const draftSidesFromPayload = (payload) => {
      const d = payload.draft && typeof payload.draft === 'object' ? payload.draft : {};
      const side = (key) => ROLE_KEYS.map((r) => String(d[key]?.[r] ?? '').trim());
      return { t1: side('t1'), t2: side('t2') };
    };

    const objectivesFromPayload = (payload) => {
      const o = payload.objectives && typeof payload.objectives === 'object' ? payload.objectives : {};
      const readSide = (k) => {
        const s = o[k] && typeof o[k] === 'object' ? o[k] : {};
        const f = (x) => {
          const n = parseFloat(String(x ?? '').replace(',', '.'));
          return Number.isFinite(n) ? n : null;
        };
        return {
          gold: f(s.gold),
          towers: f(s.towers),
          drakes: f(s.drakes),
          barons: f(s.barons),
        };
      };
      const t1 = readSide('t1');
      const t2 = readSide('t2');
      const gdRaw = (() => {
        const n = parseFloat(String(o.goldDiff ?? '').replace(',', '.'));
        return Number.isFinite(n) ? n : null;
      })();
      const goldDiff = (gdRaw != null)
        ? gdRaw
        : (t1.gold != null && t2.gold != null) ? (t1.gold - t2.gold) : null;
      const any =
        goldDiff != null ||
        t1.gold != null || t2.gold != null ||
        t1.towers != null || t2.towers != null ||
        t1.drakes != null || t2.drakes != null ||
        t1.barons != null || t2.barons != null;
      return any ? { t1, t2, goldDiff } : null;
    };

    const runManualEv = async (payload) => {
      try {
        const team1 = String(payload.team1 || payload.t1 || '').trim();
        const team2 = String(payload.team2 || payload.t2 || '').trim();
        const oRaw1 = payload.odd1 ?? payload.o1 ?? payload.odds1;
        const oRaw2 = payload.odd2 ?? payload.o2 ?? payload.odds2;
        const o1 = parseFloat(String(oRaw1 ?? '').replace(',', '.'));
        const o2 = parseFloat(String(oRaw2 ?? '').replace(',', '.'));
        const game = String(payload.game || 'lol').trim() || 'lol';
        const formatRaw = payload.format != null ? String(payload.format).trim() : '';
        const leagueRaw = payload.league != null ? String(payload.league).trim() : '';
        if (!team1 || !team2) { sendJson(res, { error: 'team1 e team2 obrigatórios' }, 400); return; }
        if (!Number.isFinite(o1) || !Number.isFinite(o2) || o1 <= 1.0 || o2 <= 1.0) {
          sendJson(res, { error: 'odd1 e odd2 devem ser decimais > 1' }, 400); return;
        }
        const { t1: t1Champs, t2: t2Champs } = draftSidesFromPayload(payload);
        const objectives = objectivesFromPayload(payload);
        const draftAnalysis = lolCompScoreFromDraft(stmts, t1Champs, t2Champs);
        const compScore = draftAnalysis.compScore;
        const enrich = lolEnrichmentFromDb(team1, team2, game);
        const roleImpact = (() => {
          try { return db.prepare('SELECT role, sample_games, winrate, gpm, dmg_pct, kda FROM golgg_role_impact ORDER BY role').all(); }
          catch(_) { return []; }
        })();
        const match = { team1, team2, game, format: formatRaw || null, league: leagueRaw || null };
        const odds = { t1: String(o1), t2: String(o2) };
        const mlResult = esportsPreFilter(match, odds, enrich, false, '', compScore, stmts);
        const ev1 = (mlResult.modelP1 * o1 - 1) * 100;
        const ev2 = (mlResult.modelP2 * o2 - 1) * 100;
        const kFrac = parseFloat(payload.kellyFrac);
        const kellyFrac = Number.isFinite(kFrac) && kFrac > 0 && kFrac <= 1 ? kFrac : (1 / 6);
        const stake1 = calcKellyWithP(mlResult.modelP1, o1, kellyFrac);
        const stake2 = calcKellyWithP(mlResult.modelP2, o2, kellyFrac);
        let suggestion = null;
        if (ev1 >= ev2 && ev1 > 0) suggestion = { side: 't1', team: team1, odd: o1, evPercent: Math.round(ev1 * 10) / 10, stake: stake1 };
        else if (ev2 > ev1 && ev2 > 0) suggestion = { side: 't2', team: team2, odd: o2, evPercent: Math.round(ev2 * 10) / 10, stake: stake2 };

        // IA (DeepSeek): análise curta do cálculo
        const wantAi = String(payload.ai || '').toLowerCase();
        const useAi = (wantAi === '1' || wantAi === 'true' || wantAi === 'yes' || wantAi === 'on');
        let ai = null;
        if (useAi && DEEPSEEK_KEY) {
          const prompt =
            'Você é analista de apostas em LoL.\n' +
            'Explique em pt-BR, direto, sem enrolação.\n' +
            'Use bullets curtos.\n\n' +
            `Partida: ${team1} vs ${team2}\n` +
            `Odds: ${o1} / ${o2}\n` +
            `Prob modelo: ${(mlResult.modelP1 * 100).toFixed(1)}% / ${(mlResult.modelP2 * 100).toFixed(1)}%\n` +
            `EV: ${ev1.toFixed(1)}% / ${ev2.toFixed(1)}%\n` +
            `Sugestão: ${suggestion ? `${suggestion.team} @ ${suggestion.odd} (EV ${suggestion.evPercent}%, Kelly ${suggestion.stake})` : 'nenhuma'}\n` +
            `Forma t1/t2: ${enrich?.form1?.winRate ?? '—'}% / ${enrich?.form2?.winRate ?? '—'}%\n` +
            `H2H jogos: ${enrich?.h2h?.totalMatches ?? 0}\n` +
            `Draft compScore(pp): ${compScore != null && Number.isFinite(compScore) ? compScore.toFixed(2) : '—'}\n\n` +
            `Role impact (gol.gg via PandaTobi): ${Array.isArray(roleImpact) && roleImpact.length ? roleImpact.map(r => `${r.role} WR ${(r.winrate != null ? Math.round(r.winrate*1000)/10 : '—')}%`).join(' | ') : '—'}\n\n` +
            `Objetivos ao vivo: ${objectives ? `goldDiff=${objectives.goldDiff ?? '—'} towers=${objectives.t1.towers ?? '—'}-${objectives.t2.towers ?? '—'} drakes=${objectives.t1.drakes ?? '—'}-${objectives.t2.drakes ?? '—'} barons=${objectives.t1.barons ?? '—'}-${objectives.t2.barons ?? '—'}` : '—'}\n\n` +
            'Inclua:\n' +
            '- Por que lado tem edge\n' +
            '- Riscos/alertas\n' +
            '- O que observar ao vivo\n';

          try {
            const dsPayload = {
              model: 'deepseek-chat',
              max_tokens: 350,
              messages: [
                { role: 'system', content: 'Responda em pt-BR. Seja conciso.' },
                { role: 'user', content: prompt }
              ]
            };
            const r = await aiPost('deepseek', 'https://api.deepseek.com/chat/completions', dsPayload, {
              'Authorization': `Bearer ${DEEPSEEK_KEY}`
            }, { timeoutMs: 20000, retry: { maxAttempts: 3 } });
            const j = safeParse(r && r.body, null);
            const text = j?.choices?.[0]?.message?.content || '';
            ai = { ok: true, provider: 'deepseek', model: dsPayload.model, text: String(text || '').trim() };
          } catch (e) {
            ai = { ok: false, provider: 'deepseek', error: e.message || String(e) };
          }
        }

        sendJson(res, {
          match,
          oddsDecimal: { t1: o1, t2: o2 },
          draftAnalysis,
          enrichSummary: {
            form1: enrich.form1,
            form2: enrich.form2,
            h2h: enrich.h2h,
            oddsMovementPoints: enrich.oddsMovement?.history?.length || 0
          },
          roleImpact,
          objectives,
          mlPrefilter: {
            pass: mlResult.pass,
            direction: mlResult.direction,
            score: mlResult.score,
            t1Edge: mlResult.t1Edge,
            t2Edge: mlResult.t2Edge,
            modelP1: mlResult.modelP1,
            modelP2: mlResult.modelP2,
            impliedP1: mlResult.impliedP1,
            impliedP2: mlResult.impliedP2,
            factorCount: mlResult.factorCount,
            factorActive: mlResult.factorActive || []
          },
          evPercent: { t1: Math.round(ev1 * 10) / 10, t2: Math.round(ev2 * 10) / 10 },
          kellyStakeUnits: { t1: stake1, t2: stake2, kellyFrac: kellyFrac },
          suggestion,
          ai
        });
      } catch (e) {
        sendJson(res, { error: e.message }, 500);
      }
    };

    if (req.method === 'GET') {
      const q = parsed.query || {};
      const bare = !q.team1 && !q.odd1 && !q.o1 && q.view !== 'json';
      if (bare) { serveEvManualPage(); return; }
      runManualEv(q);
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        const json = safeParse(body, {});
        runManualEv({ ...parsed.query, ...json });
      });
      return;
    }
    sendJson(res, { error: 'Method not allowed' }, 405);
    return;
  }

  // ── LoL EV manual: extrair print Bet365 e analisar ──
  if (p === '/lol/ev-manual-365' && req.method === 'POST') {
    let body = ''; req.on('data', d => { body += d; });
    req.on('end', async () => {
      try {
        if (!DEEPSEEK_KEY) { sendJson(res, { ok: false, error: 'DEEPSEEK_API_KEY ausente' }, 401); return; }
        const json = safeParse(body, null);
        const ocrText = String(json?.ocrText || '').trim();
        const ocrTextClean = String(json?.ocrTextClean || '').trim();
        if (!ocrText) {
          sendJson(res, {
            ok: false,
            error: 'ocrText obrigatório (DeepSeek API não suporta imagem direta)'
          }, 400);
          return;
        }

        const prompt =
          'Extraia dados de um texto OCR de uma captura da Bet365 (LoL) e retorne JSON puro.\n' +
          'Ignore completamente: KDA, kills, deaths, assists, stats do jogo, timers, nomes de campeões.\n' +
          'Foque só em: time1, time2, odd1, odd2, league, format.\n' +
          'Odds: números decimais típicos 1.01–20.00 (pode vir com vírgula).\n' +
          'Campos:\n' +
          '{ team1, team2, odd1, odd2, league, format }\n' +
          '- odd1/odd2 como número decimal (ex 1.85)\n' +
          '- league/format podem ser null\n' +
          'Se não achar algum campo, use null.\n' +
          'Depois do JSON, escreva análise curta em pt-BR.\n' +
          'Formato resposta:\n' +
          'JSON em uma linha.\n' +
          '---\n' +
          'Texto análise.\n\n' +
          'Texto OCR (limpo):\n' +
          (ocrTextClean || ocrText).slice(0, 12000) +
          '\n\nTexto OCR (bruto):\n' +
          ocrText.slice(0, 12000);

        const dsPayload = {
          model: 'deepseek-chat',
          max_tokens: 900,
          temperature: 0.2,
          messages: [
            {
              role: 'user',
              content: prompt
            }
          ]
        };

        const r = await aiPost('deepseek', 'https://api.deepseek.com/v1/chat/completions', dsPayload, {
          'Authorization': `Bearer ${DEEPSEEK_KEY}`
        }, { timeoutMs: 30000, retry: { maxAttempts: 3 } });

        const j = safeParse(r && r.body, null);
        const content = String(j?.choices?.[0]?.message?.content || '').trim();
        const parts = content.split(/(?:\n)?---(?:\n)?/);
        const left = String(parts[0] || '').trim();
        const analysisText = String(parts.slice(1).join('---') || '').trim();

        let extracted = null;
        if (left) {
          // 1) JSON em linha única
          extracted = safeParse(left, null);
          // 2) JSON embutido em texto
          if (!extracted) {
            const s = left;
            const i0 = s.indexOf('{');
            const i1 = s.lastIndexOf('}');
            if (i0 >= 0 && i1 > i0) extracted = safeParse(s.slice(i0, i1 + 1), null);
          }
        }

        const contentPreview = content ? content.slice(0, 900) : (String(r?.body || '').slice(0, 900) || '');
        const ok = !!(extracted || analysisText || content);

        sendJson(res, {
          ok,
          extracted,
          ai: ok
            ? { ok: true, provider: 'deepseek', model: dsPayload.model, text: analysisText || content }
            : { ok: false, provider: 'deepseek', model: dsPayload.model, error: 'sem_resposta' },
          debug: { contentPreview }
        });
      } catch (e) {
        sendJson(res, { ok: false, error: e.message }, 500);
      }
    });
    return;
  }

  // ── Form e H2H ──
  if (p === '/team-form' || p === '/form') {
    const team = parsed.query.team || parsed.query.name || '';
    const game = parsed.query.game || 'lol';
    const days = parseInt(parsed.query.days) || 45;
    const limit = parseInt(parsed.query.limit) || 10;
    if (!team) { sendJson(res, { error: 'team param required' }, 400); return; }

    // Tentativa 1: match exato
    let rows = stmts.getTeamFormCustom.all(team, team, game, days, limit);

    // Tentativa 2: match parcial (LIKE) — captura divergências de nome como
    // "Hanwha Life" vs "Hanwha Life Esports" ou "T1" vs "T1 Academy"
    if (!rows.length) {
      const fuzzy = `%${team}%`;
      rows = stmts.getTeamFormFuzzyCustom.all(fuzzy, fuzzy, game, days, limit);
    }

    if (!rows.length) { sendJson(res, { wins: 0, draws: 0, losses: 0, winRate: 0, streak: '—', recent: [] }); return; }
    let wins = 0, losses = 0, draws = 0, streak = '', streakCount = 0;
    const recent = [];
    let streakActive = true;
    for (const r of rows) {
      const isDraw = r.winner && norm(r.winner) === 'draw';
      const won = !isDraw && norm(r.winner) === norm(team);
      const resChar = won ? 'W' : (isDraw ? 'D' : 'L');
      recent.push(resChar);

      if (won) wins++; else if (isDraw) draws++; else losses++;
      
      if (streakActive) {
        if (streak === '') { streak = resChar; streakCount = 1; }
        else if (streak === resChar) streakCount++;
        else streakActive = false;
      }
    }
    sendJson(res, { wins, draws, losses, winRate: Math.round((wins / rows.length) * 100), streak: `${streakCount}${streak}`, recent });
    return;
  }

  if (p === '/h2h') {
    const t1 = parsed.query.team1 || '', t2 = parsed.query.team2 || '';
    const game = parsed.query.game || 'lol';
    const days = parseInt(parsed.query.days) || 45;
    const limit = parseInt(parsed.query.limit) || 10;
    if (!t1 || !t2) { sendJson(res, { totalMatches: 0, t1Wins: 0, t2Wins: 0 }); return; }

    // Tentativa 1: match exato
    let rows = stmts.getH2HCustom.all(t1, t2, t2, t1, game, days, limit);

    // Tentativa 2: match parcial
    if (!rows.length) {
      rows = stmts.getH2HFuzzyCustom.all(`%${t1}%`, `%${t2}%`, `%${t2}%`, `%${t1}%`, game, days, limit);
    }

    let t1w = 0, t2w = 0;
    const results = rows.map(r => {
      const isDraw = r.winner && norm(r.winner) === 'draw';
      if (norm(r.winner) === norm(t1)) t1w++;
      else if (!isDraw) t2w++;

      let hG = 0, aG = 0;
      if (r.final_score && r.final_score.includes('-')) {
        const parts = r.final_score.split('-');
        hG = parseInt(parts[0]) || 0;
        aG = parseInt(parts[1]) || 0;
      }
      return { home: r.team1, away: r.team2, homeGoals: hG, awayGoals: aG, date: r.resolved_at };
    });
    sendJson(res, { totalMatches: rows.length, t1Wins: t1w, t2Wins: t2w, results });
    return;
  }

  if (p === '/odds-movement') {
    const t1 = parsed.query.team1 || '', t2 = parsed.query.team2 || '';
    const sport = parsed.query.sport || 'esports';
    const matchKey = `${norm(t1)}_${norm(t2)}`;
    const history = stmts.getOddsMovement.all(sport, matchKey);
    sendJson(res, { match: `${t1} vs ${t2}`, history: history.map(h => ({
      odds_t1: h.odds_p1, odds_t2: h.odds_p2, bookmaker: h.bookmaker, recorded_at: h.recorded_at
    })) });
    return;
  }

  // ── GRID (LoL) — forma + H2H oficiais quando há chave e plano com LoL ──
  if (p === '/grid-enrich') {
    const t1 = parsed.query.team1 || '';
    const t2 = parsed.query.team2 || '';
    const game = (parsed.query.game || 'lol').toLowerCase();
    if (game !== 'lol') {
      sendJson(res, { ok: false, skipped: true, reason: 'only lol' });
      return;
    }
    if (!t1 || !t2) {
      sendJson(res, { error: 'team1 and team2 required' }, 400);
      return;
    }
    if (!GRID_API_KEY) {
      sendJson(res, { ok: false, disabled: true, reason: 'GRID_API_KEY ausente' });
      return;
    }
    fetchGridEnrichForMatch(GRID_API_KEY, t1, t2)
      .then((out) => sendJson(res, out))
      .catch((e) => {
        log('WARN', 'GRID', `/grid-enrich: ${e.message}`);
        sendJson(res, { ok: false, error: e.message }, 500);
      });
    return;
  }

  // ── DB Status ──
  if (p === '/db-status') {
    const sport = parsed.query.sport || 'esports';
    try {
      const s = stmts.getDBStatus.get(sport, sport, sport, sport, sport, sport);
      sendJson(res, s || {});
    } catch(e) { sendJson(res, { error: e.message }, 500); }
    return;
  }

  if (p === '/ml-weights') {
    try {
      const rows = stmts.getAllFactorWeights.all();
      sendJson(res, { weights: rows.length ? rows : 'usando padrão', defaults: { forma: 0.25, h2h: 0.30, comp: 0.35 } });
    } catch(e) { sendJson(res, { error: e.message }, 500); }
    return;
  }

  // ── ML Dashboard — weights, walk-forward accuracy, upcoming predictions ──
  if (p === '/ml-dashboard') {
    try {
      const _sig = x => 1 / (1 + Math.exp(-x));

      // Weights from DB
      const weightRows = stmts.getAllFactorWeights.all();
      const wMap = {};
      for (const w of weightRows) wMap[w.factor] = w;
      const w_forma = wMap.forma?.weight ?? 0.25;
      const w_h2h   = wMap.h2h?.weight   ?? 0.30;

      // Factor accuracy from tip_factor_log (last 45d)
      let factorAcc = [];
      try {
        factorAcc = stmts.getFactorAccuracyLast45d.all().map(r => ({
          factor: r.factor, wins: r.wins, total: r.total,
          acc: r.total > 0 ? parseFloat((r.wins / r.total * 100).toFixed(1)) : null
        }));
      } catch (_) {}

      // Match count + last result date
      const countRow = db.prepare("SELECT COUNT(*) as n, MAX(resolved_at) as last FROM match_results WHERE game='lol'").get();
      const totalMatches = countRow?.n ?? 0;
      const lastMatch    = countRow?.last ?? null;

      // Monthly walk-forward (last 30% of dataset, no look-ahead)
      const allLol = db.prepare(
        "SELECT team1, team2, winner, resolved_at FROM match_results WHERE game='lol' ORDER BY resolved_at ASC"
      ).all();

      const monthly = {};
      let overallCorrect = 0, overallTotal = 0;
      const startIdx = Math.max(50, Math.floor(allLol.length * 0.7));

      for (let i = startIdx; i < allLol.length; i++) {
        const m  = allLol[i];
        const t1 = m.team1.toLowerCase(), t2 = m.team2.toLowerCase();
        const cut = m.resolved_at;
        const d   = new Date(cut);

        const fCut = new Date(d); fCut.setDate(fCut.getDate() - 45);
        const hCut = new Date(d); hCut.setDate(hCut.getDate() - 90);
        const fStr = fCut.toISOString().slice(0, 19).replace('T', ' ');
        const hStr = hCut.toISOString().slice(0, 19).replace('T', ' ');

        const prior = allLol.slice(0, i);
        const f1 = prior.filter(mm => (mm.team1.toLowerCase()===t1||mm.team2.toLowerCase()===t1) && mm.resolved_at>=fStr && mm.resolved_at<cut);
        const f2 = prior.filter(mm => (mm.team1.toLowerCase()===t2||mm.team2.toLowerCase()===t2) && mm.resolved_at>=fStr && mm.resolved_at<cut);
        if (f1.length < 2 || f2.length < 2) continue;

        const wr1 = f1.filter(mm=>mm.winner?.toLowerCase()===t1).length / f1.length * 100;
        const wr2 = f2.filter(mm=>mm.winner?.toLowerCase()===t2).length / f2.length * 100;
        const h2h = prior.filter(mm => {
          const mt1=mm.team1.toLowerCase(), mt2=mm.team2.toLowerCase();
          return ((mt1===t1&&mt2===t2)||(mt1===t2&&mt2===t1)) && mm.resolved_at>=hStr && mm.resolved_at<cut;
        });
        const h2hT1  = h2h.filter(mm=>mm.winner?.toLowerCase()===t1).length;
        const f_h2h  = h2h.length ? ((h2hT1/h2h.length)-0.5)*100 : 0;
        const p1     = _sig(((wr1-wr2)*w_forma + f_h2h*w_h2h) * 0.05);
        const actual = m.winner?.toLowerCase();
        if (!actual) continue;

        const month = cut.slice(0, 7);
        if (!monthly[month]) monthly[month] = { correct:0, total:0 };
        monthly[month].total++;
        overallTotal++;
        if ((p1>=0.5?t1:t2) === actual) { monthly[month].correct++; overallCorrect++; }
      }

      const monthlyArr = Object.entries(monthly)
        .sort(([a],[b]) => a<b?-1:1)
        .map(([month, v]) => ({
          month, correct: v.correct, total: v.total,
          accuracy: v.total > 0 ? parseFloat((v.correct/v.total*100).toFixed(1)) : 0
        }));

      // Upcoming predictions
      const predictions = [];
      try {
        const upcoming = db.prepare(`
          SELECT participant1_name as t1, participant2_name as t2, event_name as league, match_time
          FROM matches WHERE sport='esports' AND winner IS NULL
            AND (match_time IS NULL OR match_time >= datetime('now','-2 hours'))
          ORDER BY match_time ASC LIMIT 10
        `).all();

        for (const m of upcoming) {
          if (!m.t1 || !m.t2) continue;
          const t1 = m.t1.toLowerCase(), t2 = m.t2.toLowerCase();
          const f1 = db.prepare(`SELECT winner FROM match_results WHERE (lower(team1)=lower(?) OR lower(team2)=lower(?)) AND game='lol' AND resolved_at>=datetime('now','-45 days') ORDER BY resolved_at DESC LIMIT 10`).all(m.t1, m.t1);
          const f2 = db.prepare(`SELECT winner FROM match_results WHERE (lower(team1)=lower(?) OR lower(team2)=lower(?)) AND game='lol' AND resolved_at>=datetime('now','-45 days') ORDER BY resolved_at DESC LIMIT 10`).all(m.t2, m.t2);
          const wr1 = f1.length ? f1.filter(r=>r.winner?.toLowerCase()===t1).length/f1.length*100 : 50;
          const wr2 = f2.length ? f2.filter(r=>r.winner?.toLowerCase()===t2).length/f2.length*100 : 50;
          const h2h = db.prepare(`SELECT winner FROM match_results WHERE ((lower(team1)=lower(?) AND lower(team2)=lower(?)) OR (lower(team1)=lower(?) AND lower(team2)=lower(?))) AND game='lol' AND resolved_at>=datetime('now','-90 days') LIMIT 10`).all(m.t1,m.t2,m.t2,m.t1);
          const h2hT1 = h2h.filter(r=>r.winner?.toLowerCase()===t1).length;
          const f_h2h = h2h.length ? ((h2hT1/h2h.length)-0.5)*100 : 0;
          const p1    = _sig(((wr1-wr2)*w_forma + f_h2h*w_h2h) * 0.05);
          predictions.push({
            t1: m.t1, t2: m.t2, league: m.league, match_time: m.match_time,
            p1: parseFloat((p1*100).toFixed(1)),
            p2: parseFloat(((1-p1)*100).toFixed(1)),
            pick: p1>=0.5 ? m.t1 : m.t2,
            wr1: parseFloat(wr1.toFixed(1)), wr2: parseFloat(wr2.toFixed(1)),
            f1n: f1.length, f2n: f2.length, h2hn: h2h.length
          });
        }
      } catch (_) {}

      sendJson(res, {
        weights: weightRows,
        factorAccuracy: factorAcc,
        totalMatches, lastMatch,
        overallAccuracy: overallTotal > 0 ? parseFloat((overallCorrect/overallTotal*100).toFixed(1)) : null,
        overallN: overallTotal,
        monthlyAccuracy: monthlyArr,
        predictions
      });
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  // ── LoL role impact (gol.gg via PandaTobi repo) ──
  if (p === '/lol-role-impact') {
    try {
      const rows = db.prepare('SELECT * FROM golgg_role_impact ORDER BY role').all();
      sendJson(res, { ok: true, roles: rows });
    } catch (e) {
      sendJson(res, { ok: false, error: e.message }, 500);
    }
    return;
  }

  // ── AI Proxy (DeepSeek apenas) ──
  if (p === '/claude' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const payload = safeParse(body, null);
        if (!payload) { sendJson(res, { error: 'Invalid JSON' }, 400); return; }

        if (!DEEPSEEK_KEY) { sendJson(res, { error: 'DEEPSEEK_API_KEY ausente' }, 401); return; }

        // ── DeepSeek (OpenAI-compatible) ──
        const dsPayload = {
          model: payload.model?.startsWith('deepseek') ? payload.model : 'deepseek-chat',
          max_tokens: payload.max_tokens || 1800,
          messages: payload.messages
        };
        const r = await aiPost('deepseek', 'https://api.deepseek.com/chat/completions', dsPayload, {
          'Authorization': `Bearer ${DEEPSEEK_KEY}`,
          'content-type': 'application/json'
        }, { timeoutMs: 45000, retry: { baseDelayMs: 2000, maxDelayMs: 15000, minDelayMs: 1500 } });
        if (!r || r.status !== 200) {
          log('WARN', 'AI', `DeepSeek HTTP ${r?.status || 'fail'} body=${String(r?.body || '').slice(0, 900)}`);
        }
        const ds = safeParse(r.body, {});
        const text = ds.choices?.[0]?.message?.content || '';
        if (!text) {
          const errMsg = ds.error?.message || ds.error?.code || '';
          log('WARN', 'AI', `DeepSeek vazio: status=${r?.status} err=${errMsg || '-'} body=${String(r?.body || '').slice(0, 900)}`);
          sendJson(res, { error: errMsg || 'DeepSeek sem resposta' }, r.status || 502);
          return;
        }
        // Normaliza para o formato Claude (content[].text) para compatibilidade com bot.js
        sendJson(res, { content: [{ type: 'text', text }], model: dsPayload.model, provider: 'deepseek' });
      } catch(e) {
        log('WARN', 'AI', `DeepSeek exception: ${e.code || '-'} ${e.message || String(e)}`);
        sendJson(res, { error: e.message }, e.status || 500);
      }
    });
    return;
  }

  // ── CLV e Abertura ──
  if (p === '/update-clv' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const sport = parsed.query.sport || 'esports';
        const { matchId, clvOdds } = safeParse(body, {});
        const mid = clampStr(matchId, 128);
        const clv = parseFiniteNumber(clvOdds);
        if (!mid) { badRequest(res, 'matchId obrigatório'); return; }
        if (clv == null || clv <= 1) { badRequest(res, 'clvOdds inválido'); return; }
        stmts.updateTipCLV.run(clv, mid, sport);
        sendJson(res, { ok: true });
      } catch(e) { sendJson(res, { error: e.message }, 500); }
    });
    return;
  }

  if (p === '/update-open-tip' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const sport = parsed.query.sport || 'esports';
        const { matchId, currentOdds, currentEV, currentConfidence, markNotified } = safeParse(body, {});
        const mid = clampStr(matchId, 128);
        if (!mid) { badRequest(res, 'matchId obrigatório'); return; }
        const o = parseFiniteNumber(currentOdds);
        const ev = parseFiniteNumber(currentEV);
        const conf = clampStr(currentConfidence, 24) || null;
        if (o == null || o <= 1) { badRequest(res, 'currentOdds inválido'); return; }
        if (ev == null) { badRequest(res, 'currentEV inválido'); return; }
        if (markNotified) stmts.updateTipCurrentAndNotified.run(o, ev, conf, String(mid), sport);
        else stmts.updateTipCurrent.run(o, ev, conf, String(mid), sport);
        sendJson(res, { ok: true });
      } catch(e) { sendJson(res, { error: e.message }, 500); }
    });
    return;
  }

  if (p === '/mma-matches') {
    if (!THE_ODDS_API_KEY) { sendJson(res, []); return; }
    try {
      const now = Date.now();
      const parseFights = (raw, gameTag) => raw
        .filter(e => new Date(e.commence_time).getTime() > now)
        .map(e => {
          const bm = e.bookmakers?.[0];
          const market = bm?.markets?.find(m => m.key === 'h2h');
          const out = market?.outcomes || [];
          const o1 = out.find(o => o.name === e.home_team);
          const o2 = out.find(o => o.name === e.away_team);
          return {
            id: e.id,
            game: gameTag,
            status: 'upcoming',
            team1: e.home_team,
            team2: e.away_team,
            league: e.sport_title || (gameTag === 'boxing' ? 'Boxing' : 'MMA'),
            time: e.commence_time,
            odds: (o1 && o2) ? { t1: String(o1.price), t2: String(o2.price), bookmaker: bm.title } : null
          };
        })
        .filter(f => f.odds);

      const [rMma, rBox] = await Promise.all([
        theOddsGet(`https://api.the-odds-api.com/v4/sports/mma_mixed_martial_arts/odds/?apiKey=${THE_ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`),
        theOddsGet(`https://api.the-odds-api.com/v4/sports/boxing_boxing/odds/?apiKey=${THE_ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`)
      ]);

      const mmaFights = rMma.status === 200 ? parseFights(safeParse(rMma.body, []), 'mma') : [];
      const boxFights = rBox.status === 200 ? parseFights(safeParse(rBox.body, []), 'boxing') : [];

      const fights = [...mmaFights, ...boxFights].sort((a, b) => new Date(a.time) - new Date(b.time));
      sendJson(res, fights);
    } catch(e) {
      sendJson(res, []);
    }
    return;
  }

  if (p === '/tennis-matches') {
    // Preferência: Pinnacle (se ativado) → The Odds API → Odds-API.io
    const hasPinnacle = process.env.PINNACLE_TENNIS === 'true';
    if (!hasPinnacle && !THE_ODDS_API_KEY && !ODDS_API_IO_KEY) { sendJson(res, []); return; }
    try {
      const now = Date.now();

      // Pinnacle first: merge com cache existente (suplementa, não substitui)
      let pinMatches = [];
      if (hasPinnacle) {
        pinMatches = await getPinnacleTennisMatches().catch(() => []);
      }

      // Serve do cache se ainda válido (evita 17 chamadas à API por cada pressão de botão)
      // Guard: se Pinnacle ativo mas retornou vazio, pode ser race/falha transiente —
      // força re-fetch (fluxo completo) pra não servir cache empobrecido.
      const pinEmpty = hasPinnacle && pinMatches.length === 0;
      if (!pinEmpty && _tennisMatchesCache && now - _tennisMatchesCache.ts < TENNIS_MATCHES_CACHE_TTL) {
        const cached = _tennisMatchesCache.matches.filter(m => {
          const t = new Date(m.time).getTime();
          const LIVE_WINDOW_MS = parseInt(process.env.TENNIS_LIVE_WINDOW_H || '6', 10) * 60 * 60 * 1000;
          return t > now || (t <= now && (now - t) <= LIVE_WINDOW_MS);
        });
        // Merge Pinnacle matches que não casam com cached (por nome normalizado)
        const normKey = m => `${(m.team1||'').toLowerCase().replace(/[^a-z0-9]/g,'')}_${(m.team2||'').toLowerCase().replace(/[^a-z0-9]/g,'')}`;
        const cachedKeys = new Set(cached.map(normKey));
        const extraPin = pinMatches.filter(m => !cachedKeys.has(normKey(m)) && !cachedKeys.has(normKey({team1:m.team2,team2:m.team1})));
        sendJson(res, [...cached, ...extraPin]);
        return;
      }
      if (pinEmpty) log('DEBUG', 'TENNIS', 'Pinnacle vazio — descartando cache e refetching');

      // Se só Pinnacle está ativo (sem The Odds API / Odds-API.io), usa direto
      if (hasPinnacle && !THE_ODDS_API_KEY && !ODDS_API_IO_KEY) {
        sendJson(res, pinMatches);
        return;
      }

      // Fallback via Odds-API.io (1 request /events + N /odds; manter N baixo)
      if (!THE_ODDS_API_KEY && ODDS_API_IO_KEY) {
        const LIVE_WINDOW_MS = parseInt(process.env.TENNIS_LIVE_WINDOW_H || '6', 10) * 60 * 60 * 1000;
        const weekAhead = now + 7 * 24 * 60 * 60 * 1000;
        const maxEventsCfg = parseInt(process.env.ODDSAPIO_TENNIS_MAX_EVENTS || '14', 10);
        const maxEvents = Math.min(30, Math.max(4, Number.isFinite(maxEventsCfg) ? maxEventsCfg : 14));

        const events = await fetchOddsApiIoEvents('tennis');
        const filtered = (events || [])
          .map(e => {
            const t = new Date(e.date || e.commence_time || e.start_time || e.time || '').getTime();
            return { e, t };
          })
          .filter(x => Number.isFinite(x.t) && x.t <= weekAhead && (x.t > now || (x.t <= now && (now - x.t) <= LIVE_WINDOW_MS)))
          .sort((a, b) => a.t - b.t)
          .slice(0, maxEvents);

        const matches = [];
        for (const { e, t } of filtered) {
          const oddsObj = await fetchOddsApiIoEventOdds(
            e.id,
            process.env.ODDSAPIO_TENNIS_BOOKMAKERS || process.env.ODDSAPIO_BOOKMAKERS || 'Pinnacle'
          );
          const bmName = oddsObj?.bookmakers ? Object.keys(oddsObj.bookmakers)[0] : null;
          const mk = bmName ? (oddsObj.bookmakers?.[bmName] || []) : [];
          const ml = mk.find(m => String(m?.name || '').toLowerCase() === 'ml' || String(m?.name || '').toLowerCase() === 'h2h') || mk[0];
          const firstOdds = Array.isArray(ml?.odds) ? ml.odds[0] : null;
          const o1 = firstOdds?.home;
          const o2 = firstOdds?.away;
          if (!o1 || !o2) continue;
          matches.push({
            id: e.id,
            game: 'tennis',
            status: (t <= now ? 'live' : 'upcoming'),
            team1: e.home || e.home_team || e.team1 || '',
            team2: e.away || e.away_team || e.team2 || '',
            league: e.league?.name || e.league || 'Tennis',
            time: e.date || e.commence_time || e.time,
            odds: { t1: String(o1), t2: String(o2), bookmaker: bmName || 'Odds-API.io' }
          });
        }
        matches.sort((a, b) => {
          if (a.status === 'live' && b.status !== 'live') return -1;
          if (b.status === 'live' && a.status !== 'live') return 1;
          return new Date(a.time) - new Date(b.time);
        });
        if (matches.length) _tennisMatchesCache = { matches: matches.slice(), ts: now };
        sendJson(res, matches);
        return;
      }

      const weekAhead = now + 7 * 24 * 60 * 60 * 1000;
      const LIVE_WINDOW_MS = parseInt(process.env.TENNIS_LIVE_WINDOW_H || '6', 10) * 60 * 60 * 1000; // default 6h

      // 1) Lista tennis_* com all=true para incluir WTA (muitas chaves vêm active=false fora do pico)
      if (!oddsApiAllowed('ODDS')) {
        // Quota esgotada: retorna cache expirado se disponível
        const fallback = _tennisMatchesCache?.matches?.filter(m => new Date(m.time).getTime() > now) || [];
        sendJson(res, fallback);
        return;
      }
      const tennisKeys = await fetchTheOddsTennisSportKeys();

      if (!tennisKeys.length) { sendJson(res, []); return; }

      // 2) Busca odds (cada torneio = 1 request). Cota mínima WTA via TENNIS_MIN_WTA_KEYS
      const maxKeysCfg = parseInt(process.env.TENNIS_MAX_KEYS || '16', 10);
      const maxKeys = Math.min(Math.max(2, maxKeysCfg || 16), tennisKeys.length);

      const { allowedKeys, wtaKeys, atpKeys } = pickBalancedTennisKeys(tennisKeys, maxKeys);

      log('INFO', 'TENNIS', `Sports keys: total=${tennisKeys.length} atp=${atpKeys.length} wta=${wtaKeys.length} usando=${allowedKeys.length} (minWTA=${process.env.TENNIS_MIN_WTA_KEYS || '5'})`);

      const matches = [];
      for (const k of allowedKeys) {
        if (!oddsApiAllowed('ODDS')) break;
        const urlOdds = `https://api.the-odds-api.com/v4/sports/${k}/odds/?apiKey=${THE_ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`;
        const r2 = await theOddsGet(urlOdds);
        if (!r2 || r2.status !== 200) continue;
        const raw = safeParse(r2.body, []);
        for (const e of raw) {
          const t = new Date(e.commence_time).getTime();
          // upcoming: agora → 7d
          // live: começou há <= LIVE_WINDOW_MS (The Odds API pode manter o evento por um tempo)
          if (t > weekAhead) continue;
          if (t <= now && (now - t) > LIVE_WINDOW_MS) continue;
          const bm = e.bookmakers?.[0];
          const market = bm?.markets?.find(m => m.key === 'h2h');
          const out = market?.outcomes || [];
          const o1 = out.find(o => o.name === e.home_team);
          const o2 = out.find(o => o.name === e.away_team);
          if (!o1 || !o2) continue;
          // Completed events são descartados — não queremos analisar partidas já finalizadas
          if (e.completed) continue;
          matches.push({
            id: e.id,
            game: 'tennis',
            sport_key: k,
            status: (t <= now ? 'live' : 'upcoming'),
            team1: e.home_team,
            team2: e.away_team,
            league: e.sport_title || 'Tennis',
            time: e.commence_time,
            odds: { t1: String(o1.price), t2: String(o2.price), bookmaker: bm.title }
          });
        }
      }
      matches.sort((a, b) => {
        if (a.status === 'live' && b.status !== 'live') return -1;
        if (b.status === 'live' && a.status !== 'live') return 1;
        return new Date(a.time) - new Date(b.time);
      });
      // Merge Pinnacle (mesmo que cache hit faz) — evita servir resposta empobrecida
      const normKey = m => `${(m.team1||'').toLowerCase().replace(/[^a-z0-9]/g,'')}_${(m.team2||'').toLowerCase().replace(/[^a-z0-9]/g,'')}`;
      const mKeys = new Set(matches.map(normKey));
      const extraPin = pinMatches.filter(m => !mKeys.has(normKey(m)) && !mKeys.has(normKey({team1:m.team2,team2:m.team1})));
      const merged = [...matches, ...extraPin];
      merged.sort((a, b) => {
        if (a.status === 'live' && b.status !== 'live') return -1;
        if (b.status === 'live' && a.status !== 'live') return 1;
        return new Date(a.time) - new Date(b.time);
      });
      // Salva no cache para reutilização por pressões de botão
      if (merged.length) _tennisMatchesCache = { matches: merged.slice(), ts: now };
      sendJson(res, merged);
    } catch(e) {
      const fallback = _tennisMatchesCache?.matches?.filter(m => new Date(m.time).getTime() > Date.now()) || [];
      sendJson(res, fallback);
    }
    return;
  }

  if (p === '/sync-tennis-espn-results') {
    (async () => {
      try {
        const force = String(parsed.query.force || '') === '1';
        const out = await maybeSyncTennisEspnMatchResults(force);
        sendJson(res, out);
      } catch (e) {
        sendJson(res, { ok: false, error: e.message }, 500);
      }
    })();
    return;
  }

  if (p === '/tennis-db-result') {
    const p1 = parsed.query.p1 || '';
    const p2 = parsed.query.p2 || '';
    const sentAt = parsed.query.sentAt || '';
    if (!p1 || !p2) { sendJson(res, { resolved: false, error: 'p1/p2 obrigatórios' }, 400); return; }
    const lookbackDays = Math.min(800, Math.max(14, parseInt(process.env.TENNIS_SETTLE_LOOKBACK_DAYS || '600', 10) || 600));
    try {
      const rows = getTennisSettleRowsCached(lookbackDays);

      const sentRaw = String(sentAt || '').trim();
      const tipMs = sentRaw
        ? Date.parse(sentRaw.includes('T') ? sentRaw : sentRaw.replace(' ', 'T'))
        : NaN;

      let best = pickBestTennisSettleRow(rows, p1, p2, tipMs);

      if (best?.winner) {
        sendJson(res, {
          resolved: true,
          winner: best.winner,
          match_id: best.match_id,
          league: best.league,
          final_score: best.final_score,
          resolved_at: best.resolved_at
        });
        return;
      }

      await syncTennisEspnCompletedAroundSentAt(sentAt);
      const rows2 = getTennisSettleRowsCached(lookbackDays);
      best = pickBestTennisSettleRow(rows2, p1, p2, tipMs);
      if (best?.winner) {
        sendJson(res, {
          resolved: true,
          winner: best.winner,
          match_id: best.match_id,
          league: best.league,
          final_score: best.final_score,
          resolved_at: best.resolved_at
        });
        return;
      }

      const spanCfg = Math.min(90, Math.max(21, parseInt(process.env.TENNIS_ESPN_RECENT_FALLBACK_DAYS || '50', 10) || 50));
      await syncTennisEspnCompletedRecentSpan(spanCfg);
      const rows3 = getTennisSettleRowsCached(lookbackDays);
      best = pickBestTennisSettleRow(rows3, p1, p2, tipMs);
      if (best?.winner) {
        sendJson(res, {
          resolved: true,
          winner: best.winner,
          match_id: best.match_id,
          league: best.league,
          final_score: best.final_score,
          resolved_at: best.resolved_at
        });
        return;
      }
      sendJson(res, { resolved: false });
    } catch (e) {
      sendJson(res, { resolved: false, error: e.message }, 500);
    }
    return;
  }

  if (p === '/tennis-scores') {
    if (!THE_ODDS_API_KEY) { sendJson(res, []); return; }
    try {
      const daysFrom = Math.min(3, Math.max(1, parseInt(u.searchParams.get('daysFrom') || '3', 10) || 3));

      if (!oddsApiAllowed('ODDS')) { sendJson(res, []); return; }
      const tennisKeys = await fetchTheOddsTennisSportKeys();

      if (!tennisKeys.length) { sendJson(res, []); return; }

      const maxKeysCfg = parseInt(process.env.TENNIS_MAX_KEYS || '16', 10);
      const maxKeys = Math.min(Math.max(2, maxKeysCfg || 16), tennisKeys.length);
      const { allowedKeys } = pickBalancedTennisKeys(tennisKeys, maxKeys);

      const results = [];
      for (const k of allowedKeys) {
        if (!oddsApiAllowed('ODDS')) break;
        const urlScores = `https://api.the-odds-api.com/v4/sports/${k}/scores/?apiKey=${THE_ODDS_API_KEY}&daysFrom=${daysFrom}&dateFormat=iso`;
        const r2 = await theOddsGet(urlScores);
        if (!r2 || r2.status !== 200) continue;
        const raw = safeParse(r2.body, []);
        for (const e of raw) {
          results.push({
            id: e.id,
            sport_key: e.sport_key,
            sport_title: e.sport_title,
            commence_time: e.commence_time,
            completed: !!e.completed,
            home_team: e.home_team,
            away_team: e.away_team,
            scores: Array.isArray(e.scores) ? e.scores : null,
            last_update: e.last_update
          });
        }
      }

      sendJson(res, results);
    } catch(e) {
      sendJson(res, []);
    }
    return;
  }

  // ── Darts: lista de eventos via Sofascore (fonte única para odds + stats) ──
  if (p === '/darts-matches') {
    try {
      const events = await sofascoreDarts.listLiveAndUpcoming().catch(e => {
        log('WARN', 'DARTS', `listLiveAndUpcoming falhou: ${e.message}`);
        return [];
      });
      const matches = [];
      let noOdds = 0;
      for (const ev of events) {
        const odds = await sofascoreDarts.getOdds(ev.id).catch(() => null);
        if (!odds?.t1 || !odds?.t2) { noOdds++; continue; }
        const status = ev?.status?.type === 'inprogress' ? 'live' : 'upcoming';
        matches.push({
          id: `darts_${ev.id}`,
          sofaEventId: ev.id,
          game: 'darts',
          status,
          team1: ev?.homeTeam?.name || '',
          team2: ev?.awayTeam?.name || '',
          playerId1: ev?.homeTeam?.id,
          playerId2: ev?.awayTeam?.id,
          league: ev?.tournament?.uniqueTournament?.name || ev?.tournament?.name || 'Darts',
          time: ev?.startTimestamp ? new Date(ev.startTimestamp * 1000).toISOString() : null,
          odds
        });
      }
      matches.sort((a, b) => {
        if (a.status === 'live' && b.status !== 'live') return -1;
        if (b.status === 'live' && a.status !== 'live') return 1;
        return new Date(a.time || 0).getTime() - new Date(b.time || 0).getTime();
      });
      log('INFO', 'DARTS', `/darts-matches: ${matches.length} partidas com odds (descartados sem odds: ${noOdds})`);
      sendJson(res, matches);
    } catch (e) {
      log('ERROR', 'DARTS', e.message);
      sendJson(res, []);
    }
    return;
  }

  // Debug: retorna o que TheOddsAPI lista como sport keys TT
  if (p === '/debug-ttennis-sources') {
    try {
      const out = { theOddsApiKey: !!THE_ODDS_API_KEY, pinnacle: 0, theOddsSports: null };
      const pinRows = await getPinnacleTableTennisMatches();
      out.pinnacle = pinRows.length;
      if (THE_ODDS_API_KEY) {
        const sportsR = await theOddsGet(`https://api.the-odds-api.com/v4/sports/?apiKey=${THE_ODDS_API_KEY}&all=false`);
        out.theOddsStatus = sportsR.status;
        out.theOddsBody = String(sportsR.body || '').slice(0, 500);
        if (sportsR.status === 200) {
          const sports = safeParse(sportsR.body, []);
          out.theOddsSports = (Array.isArray(sports) ? sports : [])
            .filter(s => /table.?tennis/i.test(s.title || '') || /table.?tennis|tt_/i.test(s.key || ''))
            .map(s => ({ key: s.key, title: s.title, active: s.active }));
        }
      }
      sendJson(res, out);
    } catch (e) { sendJson(res, { error: e.message }, 500); }
    return;
  }

  // ── Snooker: odds via Pinnacle guest API (funciona do BR) ──
  if (p === '/debug-cs-elo') {
    try {
      const { getCsElo, computeEloFromDB } = require('./lib/cs-ml');
      const teamsParam = String(parsed.query.teams || '').trim();
      const totalRows = db.prepare(`SELECT COUNT(*) c FROM match_results WHERE game='cs'`).get()?.c || 0;
      const distinctTeams = db.prepare(`SELECT COUNT(DISTINCT team) c FROM (SELECT team1 AS team FROM match_results WHERE game='cs' UNION ALL SELECT team2 FROM match_results WHERE game='cs')`).get()?.c || 0;
      const latest = db.prepare(`SELECT MAX(resolved_at) m FROM match_results WHERE game='cs'`).get()?.m || null;

      let pairs = null;
      if (teamsParam) {
        const list = teamsParam.split(',').map(s => s.trim()).filter(Boolean);
        pairs = [];
        for (let i = 0; i < list.length; i += 2) {
          const t1 = list[i], t2 = list[i+1];
          if (!t2) break;
          const r = getCsElo(db, t1, t2, 0.5, 0.5);
          pairs.push({ t1, t2, elo1: r.elo1, elo2: r.elo2, eloMatches1: r.eloMatches1, eloMatches2: r.eloMatches2, found1: r.found1, found2: r.found2, useEloEligible: r.found1 && r.found2 && Math.min(r.eloMatches1, r.eloMatches2) >= 5 });
        }
      }

      sendJson(res, {
        matchResultsRows: totalRows,
        distinctTeams,
        latestResolvedAt: latest,
        pairs,
      });
    } catch (e) {
      sendJson(res, { error: e.message, stack: e.stack }, 500);
    }
    return;
  }

  if (p === '/debug-cs-hltv') {
    try {
      const hltv = require('./lib/hltv');
      const proxyEnv = (process.env.HLTV_PROXY_BASE || '').trim();
      const enabled = hltv._enabled();
      const team1 = parsed.query.team1 || 'Natus Vincere';
      const team2 = parsed.query.team2 || 'FaZe';
      const [tid1, tid2] = await Promise.all([
        hltv.findTeamId(team1).catch(e => ({ err: e.message })),
        hltv.findTeamId(team2).catch(e => ({ err: e.message })),
      ]);
      let enrich = null, scoreboardProbe = null;
      if (tid1?.teamId && tid2?.teamId) {
        enrich = await hltv.enrichMatch(team1, team2).catch(e => ({ err: e.message }));
      }
      const matchInfo = await hltv.getHltvMatchId(team1, team2).catch(e => ({ err: e.message }));
      if (matchInfo?.matchId) {
        scoreboardProbe = await hltv.getScoreboard(matchInfo.matchId, 5).catch(e => ({ err: e.message }));
      }
      sendJson(res, {
        proxyEnv: proxyEnv || '(not set)',
        enabled,
        team1: { query: team1, found: tid1 },
        team2: { query: team2, found: tid2 },
        matchInfo,
        enrichSummary: enrich ? { form1: enrich.form1, form2: enrich.form2, h2h: enrich.h2h } : null,
        scoreboardSummary: scoreboardProbe ? (hltv.summarizeScoreboard(scoreboardProbe) || scoreboardProbe) : null,
      });
    } catch (e) {
      sendJson(res, { error: e.message, stack: e.stack });
    }
    return;
  }
  if (p === '/debug-tt-theodds') {
    try {
      if (!THE_ODDS_API_KEY) { sendJson(res, { error: 'no_key' }); return; }
      const sportsR = await theOddsGet(`https://api.the-odds-api.com/v4/sports/?apiKey=${THE_ODDS_API_KEY}&all=true`);
      const all = safeParse(sportsR.body, []);
      const tt = (all || []).filter(s => /table.?tennis|tabletennis|ping.?pong/i.test(
        (s.key||'') + ' ' + (s.title||'') + ' ' + (s.group||'')
      ));
      const groups = [...new Set((all||[]).map(s => s.group).filter(Boolean))].sort();
      sendJson(res, {
        totalSports: all.length,
        ttSports: tt,
        allGroups: groups,
        allKeys: (all||[]).map(s => ({ key: s.key, title: s.title, group: s.group, active: s.active })),
      });
    } catch (e) {
      sendJson(res, { error: e.message });
    }
    return;
  }

  if (p === '/tabletennis-matches') {
    try {
      if (!global.__ttennisCache) global.__ttennisCache = { ts: 0, data: [] };
      const TTL = 3 * 60 * 1000;
      if (Date.now() - global.__ttennisCache.ts < TTL && global.__ttennisCache.data.length) {
        sendJson(res, global.__ttennisCache.data);
        return;
      }
      // 1) Pinnacle (frequentemente sem matches TT — matchupCount=0 observado)
      let rows = await getPinnacleTableTennisMatches();
      // 2) The Odds API (plano pago do user) — deve cobrir Setka Cup/WTT/TT Elite
      if (!rows.length) {
        rows = await getTheOddsTableTennisMatches().catch(() => []);
      }
      // 3) 1xBet via hltv-proxy (experimental, 1xBet bloqueia IP Railway em geral)
      if (!rows.length) {
        try {
          const onexbet = require('./lib/sportsbook-1xbet');
          const oneXRows = await onexbet.getTableTennisMatches().catch(() => []);
          if (oneXRows.length) {
            rows = oneXRows;
            log('INFO', 'ODDS', `1xBet Table Tennis: ${rows.length} partidas`);
          }
        } catch (e) {
          log('WARN', 'ODDS', `1xBet TT fallback: ${e.message}`);
        }
      }
      // 4) Fallback Sofascore — lista matches sem odds (ao menos o botão Próximas funciona)
      // Sofascore cobre Setka Cup/WTT/TT Elite Series/etc (13k+ matches/dia).
      if (!rows.length) {
        try {
          const sofaTT = require('./lib/sofascore-tabletennis');
          const today = new Date().toISOString().slice(0, 10);
          const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          const [todaySched, tomSched] = await Promise.all([
            sofaTT.fetchHistoricalMatches(0).catch(() => []), // hoje
            // helper direto via scheduleUrls não exposto; reutiliza fetchHistoricalMatches que só pega finished
            (async () => [])(),
          ]);
          // fetchHistoricalMatches só retorna finished. Precisa buscar upcoming separadamente via schedule.
          // Workaround: faz request direto ao schedule e filtra por status notStarted/inProgress.
          const { cachedHttpGet, safeParse: _safeParse } = require('./lib/utils');
          const proxy = (process.env.SOFASCORE_PROXY_BASE || '').trim().replace(/\/+$/, '');
          const urls = [];
          for (const d of [today, tomorrow]) {
            if (proxy) urls.push(`${proxy}/schedule/table-tennis/${d}/`);
            urls.push(`https://api.sofascore.com/api/v1/sport/table-tennis/scheduled-events/${d}`);
          }
          const fromSofa = [];
          const seenIds = new Set();
          for (const url of urls) {
            try {
              const r = await cachedHttpGet(url, {
                ttlMs: 5 * 60 * 1000, provider: 'sofascore',
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                  Accept: 'application/json', Origin: 'https://www.sofascore.com', Referer: 'https://www.sofascore.com/',
                  'ngrok-skip-browser-warning': 'true',
                },
                cacheKey: `ttennis-schedule:${url}`,
              }).catch(() => null);
              if (!r || r.status !== 200) continue;
              const d = _safeParse(r.body, {});
              for (const ev of (d.events || [])) {
                if (seenIds.has(ev.id)) continue;
                const st = ev?.status?.type;
                if (st !== 'notstarted' && st !== 'inprogress' && st !== 'live') continue;
                seenIds.add(ev.id);
                const t = ev.startTimestamp ? new Date(ev.startTimestamp * 1000).toISOString() : null;
                fromSofa.push({
                  id: `ttennis_sofa_${ev.id}`,
                  game: 'tabletennis',
                  status: (st === 'inprogress' || st === 'live') ? 'live' : 'upcoming',
                  team1: ev.homeTeam?.name || '?',
                  team2: ev.awayTeam?.name || '?',
                  league: ev.tournament?.name || 'Table Tennis',
                  time: t,
                  odds: null, // Sofascore não tem odds
                });
              }
            } catch (_) {}
          }
          if (fromSofa.length) {
            log('INFO', 'ODDS', `Sofascore TT schedule (sem odds): ${fromSofa.length} partidas`);
            rows = fromSofa;
          }
        } catch (e) { log('WARN', 'TTENNIS', `Sofascore schedule: ${e.message}`); }
      }

      // 3) Fallback TheOddsAPI: descobre sport keys TT dinamicamente via /v4/sports
      if (!rows.length && THE_ODDS_API_KEY) {
        try {
          let ttKeys = [];
          const sportsR = await theOddsGet(`https://api.the-odds-api.com/v4/sports/?apiKey=${THE_ODDS_API_KEY}&all=false`);
          if (sportsR.status === 200) {
            const sports = safeParse(sportsR.body, []);
            ttKeys = (Array.isArray(sports) ? sports : [])
              .filter(s => /table.?tennis/i.test(s.title || '') || /table.?tennis|tt_/i.test(s.key || ''))
              .map(s => s.key);
            if (ttKeys.length) log('INFO', 'TTENNIS', `TheOddsAPI sport keys TT: ${ttKeys.join(',')}`);
          }
          if (!ttKeys.length) log('WARN', 'TTENNIS', 'TheOddsAPI: nenhum sport key TT ativo');
          const fromOdds = [];
          for (const sk of ttKeys) {
            const r = await theOddsGet(`https://api.the-odds-api.com/v4/sports/${sk}/odds/?apiKey=${THE_ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`);
            if (r.status !== 200) continue;
            const data = safeParse(r.body, []);
            if (!Array.isArray(data) || !data.length) continue;
            for (const e of data) {
              if (new Date(e.commence_time).getTime() < Date.now() - 2 * 60 * 60 * 1000) continue;
              const bm = e.bookmakers?.[0];
              const market = bm?.markets?.find(m => m.key === 'h2h');
              const outs = market?.outcomes || [];
              const o1 = outs.find(o => o.name === e.home_team);
              const o2 = outs.find(o => o.name === e.away_team);
              if (!o1 || !o2) continue;
              fromOdds.push({
                id: `ttennis_odds_${e.id}`,
                game: 'tabletennis',
                status: 'upcoming',
                team1: e.home_team,
                team2: e.away_team,
                league: e.sport_title || 'Table Tennis',
                time: e.commence_time,
                odds: { t1: String(o1.price), t2: String(o2.price), bookmaker: bm.title },
              });
            }
          }
          if (fromOdds.length) {
            log('INFO', 'ODDS', `TheOddsAPI TT: ${fromOdds.length} partidas`);
            rows = fromOdds;
          }
        } catch (e) { log('WARN', 'TTENNIS', `TheOddsAPI fallback: ${e.message}`); }
      }
      const now = Date.now();
      const matches = rows.map(r => {
        // Se já veio com id/game (TheOddsAPI), não remapeia
        if (r.game === 'tabletennis') return r;
        const t = r.time ? new Date(r.time).getTime() : 0;
        const isLive = r.status === 'live' || (t > 0 && t <= now);
        return {
          id: r.id,
          game: 'tabletennis',
          status: isLive ? 'live' : 'upcoming',
          team1: r.team1,
          team2: r.team2,
          league: r.league,
          time: r.time,
          odds: r.odds,
        };
      });
      matches.sort((a, b) => {
        if (a.status === 'live' && b.status !== 'live') return -1;
        if (b.status === 'live' && a.status !== 'live') return 1;
        return new Date(a.time || 0).getTime() - new Date(b.time || 0).getTime();
      });
      global.__ttennisCache = { ts: Date.now(), data: matches };
      sendJson(res, matches);
    } catch (e) {
      log('ERROR', 'TTENNIS', e.message);
      sendJson(res, []);
    }
    return;
  }

  if (p === '/snooker-matches') {
    try {
      if (!global.__snookerCache) global.__snookerCache = { ts: 0, data: [] };
      const TTL = 3 * 60 * 1000; // 3 min (Pinnacle tem rate limit soft)
      if (Date.now() - global.__snookerCache.ts < TTL && global.__snookerCache.data.length) {
        sendJson(res, global.__snookerCache.data);
        return;
      }
      const rows = await pinnacleSnooker.fetchSnookerMatchOdds();
      const now = Date.now();
      const matches = rows.map(r => {
        const t = r.startTime ? new Date(r.startTime).getTime() : 0;
        const isLive = r.status === 'live' || (t > 0 && t <= now);
        return {
          id: `snooker_${r.id}`,
          pinMatchupId: r.id,
          game: 'snooker',
          status: isLive ? 'live' : 'upcoming',
          team1: r.team1,
          team2: r.team2,
          league: r.league,
          leagueGroup: r.group,
          time: r.startTime,
          odds: { t1: String(r.oddsT1), t2: String(r.oddsT2), bookmaker: 'Pinnacle' }
        };
      });
      matches.sort((a, b) => {
        if (a.status === 'live' && b.status !== 'live') return -1;
        if (b.status === 'live' && a.status !== 'live') return 1;
        return new Date(a.time || 0).getTime() - new Date(b.time || 0).getTime();
      });
      global.__snookerCache = { ts: Date.now(), data: matches };
      log('INFO', 'SNOOKER', `/snooker-matches: ${matches.length} partidas (Pinnacle)`);
      sendJson(res, matches);
    } catch (e) {
      log('ERROR', 'SNOOKER', e.message);
      sendJson(res, []);
    }
    return;
  }

  if (p === '/football-matches') {
    try {
      const now = Date.now();
      const weekAhead = now + 7 * 24 * 60 * 60 * 1000;

      const defaultLeagues = [
        'soccer_brazil_serie_b',
        'soccer_brazil_serie_c',
        'soccer_england_league1',
        'soccer_england_league2',
        'soccer_germany_3_liga',
        'soccer_france_ligue_2',
        'soccer_italy_serie_b',
        'soccer_spain_segunda_division',
        'soccer_portugal_segunda_liga',
        'soccer_netherlands_eerste_divisie',
        'soccer_belgium_first_division_b',
        'soccer_turkey_1_lig',
        'soccer_sweden_superettan',
        'soccer_norway_obos_ligaen',
      ].join(',');

      const configured = (process.env.FOOTBALL_LEAGUES || defaultLeagues)
        .split(',').map(s => s.trim()).filter(Boolean);

      let matches = [];
      let oddsSource = 'none';

      // ── Fonte 1: TheOddsAPI (odds reais) ──
      if (THE_ODDS_API_KEY && oddsApiPeek()) {
        for (const k of configured) {
          if (!oddsApiAllowed('ODDS')) break;
          const urlOdds = `https://api.the-odds-api.com/v4/sports/${k}/odds/?apiKey=${THE_ODDS_API_KEY}&regions=eu&markets=h2h,totals&oddsFormat=decimal`;
          const r2 = await theOddsGet(urlOdds);
          if (!r2 || r2.status !== 200) continue;
          const raw = safeParse(r2.body, []);
          for (const e of raw) {
            const t = new Date(e.commence_time).getTime();
            if (t <= now || t > weekAhead) continue;
            const bm = e.bookmakers?.[0];
            if (!bm) continue;
            const h2hMarket = bm.markets?.find(m => m.key === 'h2h');
            const totalsMarket = bm.markets?.find(m => m.key === 'totals');
            const out = h2hMarket?.outcomes || [];
            const oH = out.find(o => o.name === e.home_team);
            const oD = out.find(o => o.name === 'Draw');
            const oA = out.find(o => o.name === e.away_team);
            if (!oH || !oD || !oA) continue;
            const over = totalsMarket?.outcomes?.find(o => o.name === 'Over');
            const under = totalsMarket?.outcomes?.find(o => o.name === 'Under');
            const odds = { h: String(oH.price), d: String(oD.price), a: String(oA.price), bookmaker: bm.title };
            if (over && under) odds.ou25 = { over: String(over.price), under: String(under.price), point: over.point };
            matches.push({
              id: e.id, game: 'football', sport_key: k, status: 'upcoming',
              team1: e.home_team, team2: e.away_team,
              league: e.sport_title || 'Football', time: e.commence_time, odds
            });
          }
        }
        if (matches.length) {
          oddsSource = 'theodds';
          _footballMatchesCache = { matches: matches.slice(), ts: now };
        }
      }

      // ── Fonte 2: cache da última resposta com odds (quando quota esgotada) ──
      if (!matches.length && _footballMatchesCache && now - _footballMatchesCache.ts < FOOTBALL_MATCHES_CACHE_TTL) {
        matches = _footballMatchesCache.matches.filter(m => new Date(m.time).getTime() > now);
        oddsSource = 'cache';
        log('INFO', 'AUTO-FOOTBALL', `Usando cache de partidas com odds (${matches.length} partidas, idade=${Math.round((now - _footballMatchesCache.ts) / 60000)}min)`);
      }

      // ── Fonte 3: fixtures sem odds (quando cache também vazio) ──
      // football-data.org cobre ligas mapeadas, api-football cobre o resto
      if (!matches.length) {
        const fixtureMatches = [];
        const hasFdToken = !!(process.env.FOOTBALL_DATA_TOKEN || process.env.FOOTBALL_DATA_KEY);

        for (const k of configured) {
          // football-data.org
          if (hasFdToken) {
            const compCode = footballData.getCompetitionCode(k);
            if (compCode) {
              const fx = await footballData.getUpcomingFixtures(compCode, { sportKey: k, daysAhead: 7 }).catch(() => []);
              fixtureMatches.push(...fx);
              continue; // liga já coberta
            }
          }
          // api-football como fallback de cobertura
          const leagueId = apiFootball.getLeagueId(k);
          if (leagueId && apiFootball.apiFootballAllowed()) {
            const fx = await apiFootball.getUpcomingFixtures(leagueId, { sportKey: k, daysAhead: 7 }).catch(() => []);
            fixtureMatches.push(...fx);
          }
        }

        // Deduplicação por time1+time2+dia
        const seen = new Set();
        for (const m of fixtureMatches) {
          if (!m.team1 || !m.team2 || !m.time) continue;
          const t = new Date(m.time).getTime();
          if (t <= now || t > weekAhead) continue;
          const key = `${m.team1}|${m.team2}|${String(m.time).slice(0, 10)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          matches.push(m);
        }

        if (matches.length) {
          oddsSource = 'fixtures';
          log('INFO', 'AUTO-FOOTBALL', `Fixtures sem odds: ${matches.length} partida(s) de football-data.org/api-football`);
        }
      }

      matches.sort((a, b) => new Date(a.time) - new Date(b.time));
      log('INFO', 'AUTO-FOOTBALL', `/football-matches: ${matches.length} partidas (fonte=${oddsSource})`);
      sendJson(res, matches);
    } catch(e) {
      // Em caso de erro total, serve cache se disponível
      const fallback = _footballMatchesCache?.matches?.filter(m => new Date(m.time).getTime() > Date.now()) || [];
      sendJson(res, fallback);
    }
    return;
  }

  if (p === '/roi-by-market') {
    const sport = parsed.query.sport || 'esports';
    try {
      const rows = stmts.getRoiByMarket.all(sport);
      sendJson(res, rows);
    } catch(e) {
      sendJson(res, []);
    }
    return;
  }

  // ── Radar Sport API (scraping) — endpoint de teste/controlado ──
  // Exemplo:
  // /radar?type=info&book=betfair&region=Europe:Berlin&method=stats_season_meta&value=76415
  // /radar?type=path&book=betfair&path=en/America:Montevideo/gismo/config_tree_mini/41/0/16
  if (p === '/radar') {
    try {
      const type = String(parsed.query.type || 'info');
      const book = String(parsed.query.book || 'betfair');
      const ttlMs = Math.max(30 * 1000, parseInt(String(parsed.query.ttlMs || ''), 10) || (5 * 60 * 1000));
      const minDelayMs = Math.max(200, parseInt(String(parsed.query.minDelayMs || ''), 10) || 900);

      if (type === 'path') {
        const pathQ = String(parsed.query.path || '');
        const data = await radarGetByPath({ book, path: pathQ, ttlMs, minDelayMs });
        sendJson(res, { ok: true, type, book, data });
        return;
      }

      const region = String(parsed.query.region || 'Europe:Berlin');
      const method = String(parsed.query.method || '');
      const valueRaw = parsed.query.value;
      const value = (valueRaw != null && String(valueRaw).match(/^\d+$/)) ? parseInt(String(valueRaw), 10) : String(valueRaw || '');
      const data = await radarGetInfo({ book, region, method, value, ttlMs, minDelayMs });
      sendJson(res, { ok: true, type: 'info', book, region, method, value, data });
    } catch (e) {
      sendJson(res, { ok: false, error: e.message }, 500);
    }
    return;
  }

  sendJson(res, { error: 'Not found' }, 404);
  } catch(e) {
    log('ERROR', 'SERVER', `Unhandled in ${p}: ${e.message}`);
    if (!res.headersSent) sendJson(res, { error: e.message }, 500);
  }
});

// ── Re-fetch proativo de odds stale para partidas próximas (lotes tardios) ──
// Problema: lotes 4-6 podem ficar 15-18h sem refresh no round-robin de 3h.
// Solução: a cada 1h verifica se há odds > 6h no cache E partidas nas próximas 8h.
// Se sim, força um ciclo imediato sem gastar chamada extra além do round-robin normal.
let staleOddsCheckTs = 0;
async function checkStaleOddsForUpcoming() {
  if (!ODDSPAPI_KEY) return;
  if (esportsOddsFetching) return;
  const now = Date.now();
  if (now - staleOddsCheckTs < 60 * 60 * 1000) return; // no máximo 1x/h
  if (now < esportsBackoffUntil) return;
  staleOddsCheckTs = now;

  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const EIGHT_HOURS = 8 * 60 * 60 * 1000;

  // Verifica se alguma entrada do cache de odds está > 6h
  let hasStale = false;
  for (const [key, entry] of Object.entries(oddsCache)) {
    if (!key.startsWith('esports_')) continue;
    if (entry.ts && (now - entry.ts) > SIX_HOURS) { hasStale = true; break; }
  }
  if (!hasStale) return;

  // Verifica se há partidas nas próximas 8h — só vale re-fetch se há jogo iminente
  let hasUpcoming = false;
  try {
    const r = await httpGet(`http://127.0.0.1:${PORT}/lol-matches`).catch(() => null);
    if (r && r.status === 200) {
      const matches = safeParse(r.body, []);
      if (Array.isArray(matches)) {
        hasUpcoming = matches.some(m => {
          const t = m.time ? new Date(m.time).getTime() : 0;
          return t > now && t - now < EIGHT_HOURS;
        });
      }
    }
  } catch(_) {}

  if (!hasUpcoming) return;

  log('INFO', 'ODDS', 'Odds > 6h detectadas com partidas nas próximas 8h — forçando re-fetch adicional');
  const saved = lastEsportsOddsUpdate;
  lastEsportsOddsUpdate = 0; // bypass TTL para este ciclo
  await fetchEsportsOdds().catch(e => {
    log('ERROR', 'ODDS', `Stale re-fetch falhou: ${e.message}`);
    lastEsportsOddsUpdate = saved; // restaura se falhou
  });
}

// ── Sync de stats pro via PandaScore ──
async function syncProStats({ forceResync = false } = {}) {
  if (!PANDASCORE_TOKEN) return { ok: false, error: 'sem token' };
  const headers = { 'Authorization': `Bearer ${PANDASCORE_TOKEN}` };
  const cutoff = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const cutoffEnd = new Date().toISOString().slice(0, 10);

  // Busca até 4 páginas (400 partidas) para cobrir todos os times relevantes
  const MAX_PAGES = 4;
  const PER_PAGE = 100;
  const allMatches = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://api.pandascore.co/lol/matches?filter[status]=finished&sort=-begin_at&per_page=${PER_PAGE}&page=${page}&range[begin_at]=${cutoff},${cutoffEnd}`;
    const listR = await httpGet(url, headers).catch(() => null);
    if (!listR || listR.status !== 200) break;
    const batch = safeParse(listR.body, []);
    if (!Array.isArray(batch) || batch.length === 0) break;
    allMatches.push(...batch);
    if (batch.length < PER_PAGE) break; // última página
    await new Promise(r => setTimeout(r, 300));
  }
  const matches = allMatches;
  log('INFO', 'SYNC', `PandaScore: ${matches.length} partidas finalizadas coletadas (últimos 45 dias)`);

  // Em forceResync: limpa tabelas para evitar acúmulo de dados stale e garantir re-fetch real
  if (forceResync && matches.length > 0) {
    try {
      db.prepare('DELETE FROM pro_champ_stats').run();
      db.prepare('DELETE FROM pro_player_champ_stats').run();
      db.prepare("DELETE FROM synced_matches WHERE game = 'lol'").run();
      log('INFO', 'SYNC', 'forceResync: pro_champ_stats, pro_player_champ_stats e synced_matches(lol) limpos para re-população');
    } catch(e) {
      log('WARN', 'SYNC', `forceResync cleanup falhou: ${e.message}`);
    }
  }

  let matchCount = 0, champEntries = 0, playerEntries = 0, skipped = 0;
  const champAgg = {}; // { "Champion_role": { wins, total } }
  const playerAgg = {}; // { "player_Champion": { wins, total } }

  const currentPatch = (process.env.LOL_PATCH_META || '').match(/\d+\.\d+/)?.[0] || 'current';

  const champNameOf = (pl) => {
    const c = pl?.champion;
    if (!c) return null;
    if (typeof c === 'string') return c;
    return c.name || c.slug || c.id || null;
  };
  const roleOf = (pl) => {
    const r = pl?.role || pl?.position || pl?.lane || pl?.player_role || pl?.playerRole;
    if (!r) return null;
    return String(r).toLowerCase();
  };
  const playerNameOf = (pl) => {
    const p = pl?.player;
    return p?.name || p?.slug || pl?.name || pl?.nickname || null;
  };

  for (const m of matches) {
    const psId = `ps_${m.id}`;
    if (!forceResync && stmts.isMatchSynced.get(psId)) { skipped++; continue; }

    const t1 = m.opponents?.[0]?.opponent;
    const t2 = m.opponents?.[1]?.opponent;
    const winnerName = m.winner?.name || null;
    if (!t1 || !t2) { stmts.markMatchSynced.run(psId, 'lol'); continue; }

    // Popula match_results (form dos times)
    if (winnerName) {
      stmts.upsertMatchResult.run(psId, 'lol', t1.name, t2.name, winnerName, '', m.league?.name || '');
      matchCount++;
    }

    // Busca detalhes do jogo para picks de campeões
    try {
      // PandaScore: precisa de include para popular players/champions em alguns planos/versões
      const include = 'games.teams.players.player,games.teams.players.champion,games.winner';
      const detR = await httpGet(`https://api.pandascore.co/lol/matches/${m.id}?include=${encodeURIComponent(include)}`, headers);
      if (detR.status === 200) {
        const det = safeParse(detR.body, {});
        // m.games pode já estar populado na resposta lista ou precisar do detalhe
        const games = Array.isArray(det.games) ? det.games
          : (Array.isArray(m.games) ? m.games : []);
        for (const g of games) {
          // winner pode ser objeto {id, type} ou null
          const winnerId = g.winner?.id ?? g.winner_id ?? null;
          if (!winnerId) continue;

          // Estratégia 1: g.teams[].players (estrutura mais comum no plano pago)
          const teams = Array.isArray(g.teams) ? g.teams : [];
          let parsedPlayers = 0;
          for (const teamObj of teams) {
            const teamId = teamObj.team?.id ?? teamObj.id;
            const won = teamId !== undefined && teamId === winnerId;
            // players pode ser array direto ou {data: []}
            const players = Array.isArray(teamObj.players)
              ? teamObj.players
              : (Array.isArray(teamObj?.players?.data) ? teamObj.players.data : []);
            for (const pl of players) {
              const champ = champNameOf(pl);
              const roleRaw = roleOf(pl);
              const player = playerNameOf(pl);
              const role = roleRaw ? roleRaw.replace(/[^a-z0-9]/g, '') : null;
              if (!champ || !role) continue;
              parsedPlayers++;

              const cKey = `${champ}_${role}`;
              if (!champAgg[cKey]) champAgg[cKey] = { champion: champ, role, wins: 0, total: 0 };
              champAgg[cKey].total++;
              if (won) champAgg[cKey].wins++;

              if (player) {
                const pKey = `${player}_${champ}`;
                if (!playerAgg[pKey]) playerAgg[pKey] = { player, champion: champ, wins: 0, total: 0 };
                playerAgg[pKey].total++;
                if (won) playerAgg[pKey].wins++;
              }
            }
          }

          // Estratégia 2: fallback para g.players quando teams está vazio
          // (Plano free PandaScore retorna g.players em vez de g.teams.players)
          if (parsedPlayers === 0) {
            const flatPlayers = Array.isArray(g.players)
              ? g.players
              : (Array.isArray(g?.players?.data) ? g.players.data : []);
            for (const pl of flatPlayers) {
              const champ = champNameOf(pl);
              const roleRaw = roleOf(pl);
              const player = playerNameOf(pl);
              const role = roleRaw ? roleRaw.replace(/[^a-z0-9]/g, '') : null;
              // winner_team_id ou team_id para determinar vitória no flat array
              const plTeamId = pl?.team?.id ?? pl?.team_id ?? null;
              const won = plTeamId !== null && plTeamId === winnerId;
              if (!champ || !role) continue;

              const cKey = `${champ}_${role}`;
              if (!champAgg[cKey]) champAgg[cKey] = { champion: champ, role, wins: 0, total: 0 };
              champAgg[cKey].total++;
              if (won) champAgg[cKey].wins++;

              if (player) {
                const pKey = `${player}_${champ}`;
                if (!playerAgg[pKey]) playerAgg[pKey] = { player, champion: champ, wins: 0, total: 0 };
                playerAgg[pKey].total++;
                if (won) playerAgg[pKey].wins++;
              }
            }
          }
        }
      }
    } catch(_) {}

    stmts.markMatchSynced.run(psId, 'lol');
    await new Promise(r => setTimeout(r, 200)); // rate-limit gentil (aumentado de 150ms)
  }

  // Upsert champ stats
  for (const s of Object.values(champAgg)) {
    stmts.addChampStat.run(s.champion, s.role, s.wins, s.total, currentPatch);
    champEntries++;
  }
  // Upsert player+champ stats
  for (const s of Object.values(playerAgg)) {
    stmts.addPlayerChampStat.run(s.player, s.champion, s.wins, s.total, currentPatch);
    playerEntries++;
  }

  try { stmts.cleanOldSynced.run(); } catch(_) {}
  // Registra timestamp da tentativa (mesmo com 0 champs) para evitar loop de resync a cada restart
  try {
    stmts.upsertDatasetImport.run('pro_champ_sync_attempt', 'syncProStats', champEntries);
  } catch(_) {}
  log('INFO', 'SYNC', `Pro stats: ${matchCount} resultados, ${champEntries} champs, ${playerEntries} player+champ (${skipped} já sincronizados)`);
  return { ok: true, matchCount, champEntries, playerEntries, skipped };
}

// ── Validação de variáveis de ambiente (server) ──
async function syncGolggRoleImpact() {
  const CSV_URL = 'https://raw.githubusercontent.com/PandaTobi/League-of-Legends-ESports-Data/master/Role%20Impact/league_pro_play_data.csv';
  const r = await cachedHttpGet(CSV_URL, { provider: 'golgg', ttlMs: 0 }).catch(() => null);
  if (!r || r.status !== 200) return { ok: false, error: `HTTP ${r?.status || 'fail'}` };
  const body = String(r.body || '');
  const rows = body.split('\n').map(l => l.trim()).filter(Boolean);

  const percentToFloat = (p) => {
    const s = String(p || '').trim();
    if (!s) return null;
    const n = parseFloat(s.replace('%', ''));
    return Number.isFinite(n) ? (n / 100) : null;
  };
  const num = (v) => {
    const n = parseFloat(String(v || '').trim());
    return Number.isFinite(n) ? n : null;
  };

  const roleGames = {};
  const agg = { winrate: {}, gpm: {}, dmg: {}, kda: {} };
  const add = (role, games, stat, bucket) => {
    if (!bucket[role]) bucket[role] = 0;
    bucket[role] += games * stat;
  };

  for (const line of rows) {
    const parts = line.split(',');
    if (parts.length < 11) continue;
    const role = String(parts[1] || '').trim().toUpperCase();
    const games = num(parts[2]);
    const winr = percentToFloat(parts[3]);
    const kda = num(parts[4]);
    const gpm = num(parts[9]);
    const dmg = num(parts[10]);
    if (!role || !games || !gpm) continue;

    roleGames[role] = (roleGames[role] || 0) + games;
    if (winr != null) add(role, games, winr, agg.winrate);
    if (gpm != null) add(role, games, gpm, agg.gpm);
    if (dmg != null) add(role, games, dmg, agg.dmg);
    if (kda != null) add(role, games, kda, agg.kda);
  }

  const upsert = db.prepare(`
    INSERT INTO golgg_role_impact (role, sample_games, winrate, gpm, dmg_pct, kda, source, updated_at)
    VALUES (@role, @sample_games, @winrate, @gpm, @dmg_pct, @kda, 'gol.gg', datetime('now'))
    ON CONFLICT(role) DO UPDATE SET
      sample_games=excluded.sample_games,
      winrate=excluded.winrate,
      gpm=excluded.gpm,
      dmg_pct=excluded.dmg_pct,
      kda=excluded.kda,
      source=excluded.source,
      updated_at=excluded.updated_at
  `);

  let written = 0;
  for (const [role, games] of Object.entries(roleGames)) {
    const g = games || 0;
    if (g <= 0) continue;
    upsert.run({
      role,
      sample_games: g,
      winrate: agg.winrate[role] != null ? (agg.winrate[role] / g) : null,
      gpm: agg.gpm[role] != null ? (agg.gpm[role] / g) : null,
      dmg_pct: agg.dmg[role] != null ? (agg.dmg[role] / g) : null,
      kda: agg.kda[role] != null ? (agg.kda[role] / g) : null,
    });
    written++;
  }
  return { ok: true, written, source: 'gol.gg', csv: CSV_URL };
}

(function validateServerEnv() {
  const checks = [
    ['DEEPSEEK_API_KEY', DEEPSEEK_KEY,       'chamadas à IA desativadas — /claude retornará erro'],
    ['ODDS_API_KEY',     ODDSPAPI_KEY,        'odds esports (OddsPapi) indisponíveis'],
    ['PANDASCORE_TOKEN', PANDASCORE_TOKEN,    'dados PandaScore indisponíveis'],
    ['THE_ODDS_API_KEY', THE_ODDS_API_KEY,    'odds tênis/MMA via TheOdds indisponíveis'],
  ];
  for (const [key, val, reason] of checks) {
    if (!val) log('WARN', 'ENV', `${key} ausente — ${reason}`);
  }
  warnAdminKeyMissingOnce();
})();

server.listen(PORT, '0.0.0.0', () => {
  log('INFO', 'SERVER', `SportsEdge API em http://0.0.0.0:${PORT}`);
  log('INFO', 'SERVER', `Esportes: LoL (Riot API + LoLEsports)`);
  if (SXBET_ENABLED) log('INFO', 'ODDS', `SX.Bet ativo: base=${SXBET_BASE_URL}`);
  if (GRID_API_KEY) log('INFO', 'GRID', 'GRID_API_KEY configurada — /grid-enrich ativo (LoL)');

  // Import automático de dataset futebol (CSV 2024/2025) para alimentar match_results (form/H2H)
  importFootballMatchesCsvOnce().catch(() => {});
  // Import automático de dataset tênis (ATP) para alimentar match_results (form/H2H)
  importTennisMatchesCsvOnce().catch(() => {});
  maybeSyncTennisEspnMatchResults(true).catch(() => {});

  // Inicialização e Loop de Cache de Odds (OddsPapi 1xBet)
  // Atraso opcional no boot evita rajada paralela com sync tênis/CSV no Railway.
  (async () => {
    const startDelay = Math.max(0, parseInt(process.env.ODDSPAPI_START_DELAY_MS || '4000', 10) || 4000);
    if (startDelay) await new Promise(r => setTimeout(r, startDelay));
    await fetchEsportsOdds();
    const bootGap = Math.max(0, parseInt(process.env.ODDSPAPI_BOOTSTRAP_GAP_AFTER_FIRST_MS || '6000', 10) || 6000);
    if (bootGap) await new Promise(r => setTimeout(r, bootGap));
    await bootstrapEsportsOddsExtraBatches();
    // Após OddsPapi (que pode falhar/backoff), puxa Pinnacle LoL como fonte independente
    await fetchLoLOddsFromPinnacle();
  })().catch(e => log('ERROR', 'ODDS', e.message));
  const refreshMin = Math.max(15, parseInt(process.env.ODDSPAPI_REFRESH_MIN || '60', 10) || 60);
  setInterval(() => {
    fetchEsportsOdds();
  }, refreshMin * 60 * 1000); // Default 60 min (OddsPapi free tier: 250 req total)

  // Pinnacle LoL refresh — independente do OddsPapi (sem quota, só rate limit soft)
  // Dois intervalos: refresh completo (pre-match, default 10min) + refresh rápido de live (default 2min)
  if (process.env.PINNACLE_LOL === 'true') {
    const pinRefreshMin = Math.max(5, parseInt(process.env.PINNACLE_LOL_REFRESH_MIN || '10', 10) || 10);
    const pinLiveMin = Math.max(1, parseInt(process.env.PINNACLE_LOL_LIVE_REFRESH_MIN || '2', 10) || 2);
    setInterval(() => {
      fetchLoLOddsFromPinnacle();
    }, pinRefreshMin * 60 * 1000);
    // Refresh rápido apenas quando há matches live cacheados (odds live mudam rápido)
    setInterval(() => {
      const hasLive = Object.values(oddsCache).some(v => v?.source === 'pinnacle' && v?.isLive);
      if (hasLive) fetchLoLOddsFromPinnacle();
    }, pinLiveMin * 60 * 1000);
    log('INFO', 'ODDS', `Pinnacle LoL: refresh full=${pinRefreshMin}min, live=${pinLiveMin}min (quando há live)`);
  }

  // Live odds (polling por fixtureId + marketId mapa).
  // Ativa só com ODDSPAPI_LIVE_POLL=1 para não estourar quota.
  if (process.env.ODDSPAPI_LIVE_POLL === '1') {
    const pollMs = Math.max(1500, parseInt(process.env.ODDSPAPI_LIVE_POLL_MS || '6000', 10) || 6000);
    setInterval(async () => {
      try {
        // percorre fixtures recentes no oddsCache; tenta manter maps 1..5 aquecidos
        const fids = [...new Set(Object.values(oddsCache).map(v => v?.fixtureId).filter(Boolean).map(String))];
        const maxFixtures = Math.max(1, parseInt(process.env.ODDSPAPI_LIVE_MAX_FIXTURES || '6', 10) || 6);
        const maxMaps = Math.max(1, parseInt(process.env.ODDSPAPI_LIVE_MAX_MAPS || '3', 10) || 3);
        const slice = fids.slice(0, maxFixtures);
        for (const fid of slice) {
          for (let m = 1; m <= maxMaps; m++) {
            await fetchMapOddsByFixtureId(fid, m).catch(() => null);
          }
        }
      } catch(_) {}
    }, pollMs);
    log('INFO', 'ODDS', `Live polling ativo: ${pollMs}ms`);
  }

  // Stale odds check: 1x/h, força re-fetch se odds > 6h com partidas próximas
  setInterval(() => checkStaleOddsForUpcoming().catch(() => {}), 60 * 60 * 1000);

  // Sync inicial de stats pro + job recorrente a cada 12h
  if (PANDASCORE_TOKEN) {
    setTimeout(async () => {
      try {
        // Auto-detect: se pro_champ_stats está vazio mas synced_matches já tem entradas,
        // o DB foi recriado sem repopular os stats — força resync completo
        // MAS: só se o último resync foi há mais de 6h (evita loop a cada restart)
        const champCount = db.prepare('SELECT COUNT(*) as cnt FROM pro_champ_stats').get();
        const syncedCount = db.prepare('SELECT COUNT(*) as cnt FROM synced_matches').get();
        const lastAttempt = stmts.getDatasetImport.get('pro_champ_sync_attempt');
        const lastAttemptAge = lastAttempt
          ? (Date.now() - new Date(lastAttempt.imported_at).getTime())
          : Infinity;
        const PRO_SYNC_COOLDOWN_MS = Math.max(60 * 60 * 1000, parseInt(process.env.PRO_SYNC_COOLDOWN_H || '6', 10) * 60 * 60 * 1000);
        const forceResync = (champCount?.cnt ?? 0) === 0
          && (syncedCount?.cnt ?? 0) > 0
          && lastAttemptAge > PRO_SYNC_COOLDOWN_MS;
        if (forceResync) {
          log('WARN', 'SYNC', `pro_champ_stats vazio mas ${syncedCount.cnt} matches já marcados como synced — forçando resync completo`);
        } else if ((champCount?.cnt ?? 0) === 0 && lastAttemptAge <= PRO_SYNC_COOLDOWN_MS) {
          const agoMin = Math.round(lastAttemptAge / 60000);
          log('INFO', 'SYNC', `pro_champ_stats vazio mas último resync há ${agoMin}min — cooldown ativo (próximo em ${Math.round((PRO_SYNC_COOLDOWN_MS - lastAttemptAge)/3600000)}h)`);
        }
        await syncProStats({ forceResync });
      } catch(e) { log('ERROR', 'SYNC', e.message); }
    }, 5000);
    setInterval(() => syncProStats().catch(e => log('ERROR', 'SYNC', e.message)), 12 * 60 * 60 * 1000);
  }

  // gol.gg Role Impact: sync no boot (30s) + diário
  setTimeout(() => {
    syncGolggRoleImpact()
      .then(r => r.ok
        ? log('INFO', 'GOLGG', `Role impact sync: ${r.written} linha(s)`)
        : log('WARN', 'GOLGG', `Sync falhou: ${r.error}`))
      .catch(e => log('ERROR', 'GOLGG', e.message));
  }, 30 * 1000);
  setInterval(() => {
    syncGolggRoleImpact()
      .then(r => r.ok
        ? log('INFO', 'GOLGG', `Role impact sync diário: ${r.written} linha(s)`)
        : log('WARN', 'GOLGG', `Sync diário falhou: ${r.error}`))
      .catch(e => log('ERROR', 'GOLGG', e.message));
  }, 24 * 60 * 60 * 1000);

  // Cleanup de DB
  setInterval(() => {
    try { stmts.cleanOldOdds.run(); } catch(_) {}
  }, 6 * 60 * 60 * 1000);

  // Weekly ML weight recalculation
  const { recalcWeights, settleFactorLogs } = require('./lib/ml-weights');
  // Settle factor logs diariamente (depende do settlement das tips).
  setInterval(() => {
    settleFactorLogs(stmts, log);
  }, 24 * 60 * 60 * 1000); // daily

  // Recalcula pesos semanalmente.
  setInterval(() => {
    settleFactorLogs(stmts, log);
    recalcWeights(stmts, log);
  }, 7 * 24 * 60 * 60 * 1000); // weekly

  // Boot: settle rápido + recalc após 5 min
  setTimeout(() => { settleFactorLogs(stmts, log); recalcWeights(stmts, log); }, 5 * 60 * 1000);
});

// fetchEsportsOddsV1 removida — código legado com odds falsas hardcoded (1.80/1.90)


module.exports = { server, db, stmts, fetchOdds, findOdds, oddsCache, lastEsportsOddsUpdate };
