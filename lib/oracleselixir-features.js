'use strict';

/**
 * oracleselixir-features.js — agregadores rolling a partir de oracleselixir_games.
 *
 * Fornece stats granulares game-level (complementares ao split-aggregate do gol.gg).
 * Usado como fonte de features pro modelo LoL e contexto do enrich.
 *
 * API principal:
 *   getTeamOEStats(db, team, { sinceDays = 60, minGames = 5 })
 *     → { games, winRate, avgGdAt15, avgXpdAt15, avgCsdAt15,
 *         firstBloodRate, firstDragonRate, firstBaronRate, firstTowerRate,
 *         blueWR, redWR, avgGameLen, avgDpm, avgGspd }
 *     ou null se insuficiente.
 */

function normTeam(s) {
  return String(s || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, '').trim();
}

// Cache por (team, sinceDays). TTL curto (team-level stats mudam com cada game).
const _cache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min

function _cacheKey(team, sinceDays) {
  return `${normTeam(team)}|${sinceDays}`;
}

/**
 * Rolling stats pra um time ao longo dos últimos N dias via oracleselixir_games.
 *
 * @param {object} db - better-sqlite3
 * @param {string} team - nome do time (fuzzy match via LIKE + norm)
 * @param {object} [opts]
 * @param {number} [opts.sinceDays=60]
 * @param {number} [opts.minGames=5]
 * @returns {object|null}
 */
function getTeamOEStats(db, team, opts = {}) {
  const sinceDays = opts.sinceDays ?? 60;
  const minGames = opts.minGames ?? 5;
  const key = _cacheKey(team, sinceDays);
  const hit = _cache.get(key);
  if (hit && (Date.now() - hit.ts) < CACHE_TTL_MS) return hit.data;

  // Fuzzy lookup: normalização + LIKE fallback.
  const n = normTeam(team);
  // 1. Match exato normalizado
  let rows = _queryOE(db, team, sinceDays);
  if (rows.length < minGames) {
    // 2. Fallback fuzzy: LIKE %team% (sem overhead norm em SQL)
    const wildcard = `%${team}%`;
    rows = db.prepare(`
      SELECT * FROM oracleselixir_games
      WHERE LOWER(teamname) LIKE LOWER(?)
        AND date >= datetime('now', '-${sinceDays} days')
      ORDER BY date DESC
    `).all(wildcard);
  }
  if (rows.length < minGames) {
    _cache.set(key, { ts: Date.now(), data: null });
    return null;
  }

  const agg = _aggregate(rows);
  _cache.set(key, { ts: Date.now(), data: agg });
  return agg;
}

function _queryOE(db, team, sinceDays) {
  try {
    return db.prepare(`
      SELECT * FROM oracleselixir_games
      WHERE teamname = ?
        AND date >= datetime('now', '-${sinceDays} days')
      ORDER BY date DESC
    `).all(team);
  } catch (_) { return []; }
}

function _aggregate(rows) {
  const n = rows.length;
  let sumGd15 = 0, sumXpd15 = 0, sumCsd15 = 0;
  let wins = 0, fbWins = 0, fdWins = 0, fbaronWins = 0, ftWins = 0;
  let blueGames = 0, blueWins = 0, redGames = 0, redWins = 0;
  let sumLen = 0, sumDpm = 0, sumGspd = 0;
  let gd15N = 0, xpd15N = 0, csd15N = 0, dpmN = 0, gspdN = 0, lenN = 0;

  for (const r of rows) {
    wins += r.result || 0;
    if (r.firstblood === 1) fbWins++;
    if (r.firstdragon === 1) fdWins++;
    if (r.firstbaron === 1) fbaronWins++;
    if (r.firsttower === 1) ftWins++;

    if (r.side === 'Blue') { blueGames++; blueWins += r.result || 0; }
    else if (r.side === 'Red') { redGames++; redWins += r.result || 0; }

    if (Number.isFinite(r.golddiffat15)) { sumGd15 += r.golddiffat15; gd15N++; }
    if (Number.isFinite(r.xpdiffat15)) { sumXpd15 += r.xpdiffat15; xpd15N++; }
    if (Number.isFinite(r.csdiffat15)) { sumCsd15 += r.csdiffat15; csd15N++; }
    if (Number.isFinite(r.dpm)) { sumDpm += r.dpm; dpmN++; }
    if (Number.isFinite(r.gspd)) { sumGspd += r.gspd; gspdN++; }
    if (Number.isFinite(r.gamelength)) { sumLen += r.gamelength; lenN++; }
  }

  return {
    games: n,
    winRate: wins / n,
    avgGdAt15: gd15N ? sumGd15 / gd15N : null,
    avgXpdAt15: xpd15N ? sumXpd15 / xpd15N : null,
    avgCsdAt15: csd15N ? sumCsd15 / csd15N : null,
    firstBloodRate: fbWins / n,
    firstDragonRate: fdWins / n,
    firstBaronRate: fbaronWins / n,
    firstTowerRate: ftWins / n,
    blueWR: blueGames ? blueWins / blueGames : null,
    redWR: redGames ? redWins / redGames : null,
    blueGames, redGames,
    avgGameLen: lenN ? sumLen / lenN : null,
    avgDpm: dpmN ? sumDpm / dpmN : null,
    avgGspd: gspdN ? sumGspd / gspdN : null,
  };
}

function invalidateOECache() { _cache.clear(); }

module.exports = {
  getTeamOEStats,
  invalidateOECache,
  // exposto pra testing
  _aggregate,
};
