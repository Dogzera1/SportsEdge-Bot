'use strict';

/**
 * oracleselixir-player-features.js — agregadores player-level a partir
 * de oracleselixir_players. Usado por sub-models e features de retrain.
 *
 * API:
 *   getPlayerRollingStats(db, playerName, opts) → stats de 1 jogador
 *   getTeamRosterStats(db, teamName, opts)      → agrega 5 jogadores
 *
 * Cache TTL 15min. Lookup fuzzy via LIKE.
 */

function normName(s) {
  return String(s || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, '').trim();
}

const _playerCache = new Map();
const _teamCache = new Map();
const CACHE_TTL = 15 * 60 * 1000;

/**
 * @param {object} db
 * @param {string} playerName
 * @param {object} [opts]
 * @param {number} [opts.sinceDays=60]
 * @param {number} [opts.minGames=10]
 * @returns {{ games, kda, dmgShare, goldShare, dpm, vspm, avgGd15, position, teamname } | null}
 */
function getPlayerRollingStats(db, playerName, opts = {}) {
  const n = normName(playerName);
  if (!n) return null;
  const sinceDays = opts.sinceDays ?? 60;
  const minGames = opts.minGames ?? 10;
  const key = `${n}|${sinceDays}`;
  const hit = _playerCache.get(key);
  if (hit && (Date.now() - hit.ts) < CACHE_TTL) return hit.data;

  let rows;
  try {
    rows = db.prepare(`
      SELECT position, teamname, kills, deaths, assists, damageshare,
             earnedgoldshare, dpm, vspm, golddiffat15
      FROM oracleselixir_players
      WHERE date >= datetime('now', '-${sinceDays} days')
        AND (lower(playername) = ? OR lower(playername) LIKE ?)
      ORDER BY date DESC
    `).all(n, `%${n}%`);
  } catch (_) { return null; }

  if (rows.length < minGames) {
    _playerCache.set(key, { ts: Date.now(), data: null });
    return null;
  }

  let k = 0, d = 0, a = 0;
  let dmgN = 0, dmg = 0;
  let goldN = 0, gold = 0;
  let dpmN = 0, dpmSum = 0;
  let vspmN = 0, vspmSum = 0;
  let gd15N = 0, gd15 = 0;
  const posCount = {};
  const teamCount = {};
  for (const r of rows) {
    k += r.kills || 0; d += r.deaths || 0; a += r.assists || 0;
    if (Number.isFinite(r.damageshare)) { dmg += r.damageshare; dmgN++; }
    if (Number.isFinite(r.earnedgoldshare)) { gold += r.earnedgoldshare; goldN++; }
    if (Number.isFinite(r.dpm)) { dpmSum += r.dpm; dpmN++; }
    if (Number.isFinite(r.vspm)) { vspmSum += r.vspm; vspmN++; }
    if (Number.isFinite(r.golddiffat15)) { gd15 += r.golddiffat15; gd15N++; }
    if (r.position) posCount[r.position] = (posCount[r.position] || 0) + 1;
    if (r.teamname) teamCount[r.teamname] = (teamCount[r.teamname] || 0) + 1;
  }
  const n_g = rows.length;
  const position = Object.entries(posCount).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const teamname = Object.entries(teamCount).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const data = {
    games: n_g,
    kda: d > 0 ? +((k + a) / d).toFixed(2) : +((k + a)).toFixed(2), // inf → usa raw
    kills: +(k / n_g).toFixed(2),
    deaths: +(d / n_g).toFixed(2),
    assists: +(a / n_g).toFixed(2),
    dmgShare: dmgN ? +(dmg / dmgN).toFixed(3) : null,
    goldShare: goldN ? +(gold / goldN).toFixed(3) : null,
    dpm: dpmN ? +(dpmSum / dpmN).toFixed(0) : null,
    vspm: vspmN ? +(vspmSum / vspmN).toFixed(2) : null,
    avgGd15: gd15N ? +(gd15 / gd15N).toFixed(0) : null,
    position, teamname,
  };
  _playerCache.set(key, { ts: Date.now(), data });
  return data;
}

/**
 * Agrega stats dos 5 jogadores (top/jng/mid/bot/sup) de um time.
 * Útil pra comparar times via "carry strength" (max KDA), balance (variance),
 * avg form etc.
 *
 * @returns {{ nPlayers, roster: {pos→stats}, avgKda, maxKda, kdaVariance,
 *             totalDpm, avgGoldShare, starPower } | null}
 */
function getTeamRosterStats(db, teamName, opts = {}) {
  const n = normName(teamName);
  if (!n) return null;
  const sinceDays = opts.sinceDays ?? 60;
  const minGamesPerPlayer = opts.minGamesPerPlayer ?? 10;
  const key = `${n}|${sinceDays}|${minGamesPerPlayer}`;
  const hit = _teamCache.get(key);
  if (hit && (Date.now() - hit.ts) < CACHE_TTL) return hit.data;

  let players;
  try {
    // Matching em camadas: 1) exato/normalizado (evita confundir T1 com "T1 Academy");
    //   2) LIKE só se exato não achar, excluindo feeder teams (academy/challengers/youth).
    const nStripped = n.replace(/\s+/g, '');
    players = db.prepare(`
      SELECT playername, position, COUNT(*) AS g
      FROM oracleselixir_players
      WHERE date >= datetime('now', '-${sinceDays} days')
        AND (
          lower(teamname) = ?
          OR LOWER(REPLACE(REPLACE(REPLACE(teamname, '.', ''), ' ', ''), '-', '')) = ?
        )
      GROUP BY playername, position
      ORDER BY g DESC
      LIMIT 10
    `).all(n, nStripped);
    if (!players.length) {
      players = db.prepare(`
        SELECT playername, position, COUNT(*) AS g
        FROM oracleselixir_players
        WHERE date >= datetime('now', '-${sinceDays} days')
          AND lower(teamname) LIKE ?
          AND lower(teamname) NOT LIKE '%academy%'
          AND lower(teamname) NOT LIKE '%challengers%'
          AND lower(teamname) NOT LIKE '%rookies%'
          AND lower(teamname) NOT LIKE '%youth%'
          AND lower(teamname) NOT LIKE '%prime%'
        GROUP BY playername, position
        ORDER BY g DESC
        LIMIT 10
      `).all(`%${n}%`);
    }
  } catch (_) { return null; }

  // Filtra pelos 5 de posições únicas (top/jng/mid/bot/sup)
  const posSlots = new Map();
  for (const p of players) {
    if (!p.position || posSlots.has(p.position)) continue;
    if (p.g < minGamesPerPlayer) continue;
    posSlots.set(p.position, p.playername);
  }

  if (posSlots.size < 3) { // se nem 3 posições → insuficiente
    _teamCache.set(key, { ts: Date.now(), data: null });
    return null;
  }

  const roster = {};
  const kdas = [];
  const dpms = [];
  const goldShares = [];
  for (const [pos, pname] of posSlots) {
    const s = getPlayerRollingStats(db, pname, { sinceDays, minGames: minGamesPerPlayer });
    if (!s) continue;
    roster[pos] = s;
    if (Number.isFinite(s.kda)) kdas.push(s.kda);
    if (Number.isFinite(s.dpm)) dpms.push(s.dpm);
    if (Number.isFinite(s.goldShare)) goldShares.push(s.goldShare);
  }

  if (kdas.length < 3) {
    _teamCache.set(key, { ts: Date.now(), data: null });
    return null;
  }

  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = (arr, m) => arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length;

  const avgKda = avg(kdas);
  const maxKda = Math.max(...kdas);
  const kdaVar = variance(kdas, avgKda);
  const totalDpm = dpms.length ? dpms.reduce((a, b) => a + b, 0) : null;

  // Star power: ≥1 player com KDA > 5 significa carry. ≥2 com KDA > 4 é dupla carry.
  const starCount = kdas.filter(k => k > 5).length;
  const strongCount = kdas.filter(k => k > 4).length;
  const starPower = starCount >= 1 ? (starCount >= 2 ? 'dual_carry' : 'single_carry')
    : strongCount >= 2 ? 'balanced' : 'weak';

  const data = {
    nPlayers: kdas.length,
    roster,
    avgKda: +avgKda.toFixed(2),
    maxKda: +maxKda.toFixed(2),
    kdaVariance: +kdaVar.toFixed(2),
    totalDpm,
    avgGoldShare: goldShares.length ? +(avg(goldShares)).toFixed(3) : null,
    starPower,
    teamname: players[0]?.playername ? undefined : null, // coletado via playername
  };
  _teamCache.set(key, { ts: Date.now(), data });
  return data;
}

/**
 * Retorna o "roster esperado" de um time — top 5 jogadores por posição
 * nos últimos N dias, por número de games jogados.
 *
 * @returns {{ expected: {pos: playerName}, sample: {pos: games}, lastSeenDate } | null}
 */
function getExpectedRoster(db, teamName, opts = {}) {
  const n = normName(teamName);
  if (!n) return null;
  const sinceDays = opts.sinceDays ?? 30;
  const minGames = opts.minGames ?? 3;

  try {
    const nStripped = n.replace(/\s+/g, '');
    let players = db.prepare(`
      SELECT playername, position, COUNT(*) AS g, MAX(date) AS last
      FROM oracleselixir_players
      WHERE date >= datetime('now', '-${sinceDays} days')
        AND (
          lower(teamname) = ?
          OR LOWER(REPLACE(REPLACE(REPLACE(teamname, '.', ''), ' ', ''), '-', '')) = ?
        )
      GROUP BY playername, position
      ORDER BY g DESC
      LIMIT 20
    `).all(n, nStripped);
    if (!players.length) {
      players = db.prepare(`
        SELECT playername, position, COUNT(*) AS g, MAX(date) AS last
        FROM oracleselixir_players
        WHERE date >= datetime('now', '-${sinceDays} days')
          AND lower(teamname) LIKE ?
          AND lower(teamname) NOT LIKE '%academy%'
          AND lower(teamname) NOT LIKE '%challengers%'
          AND lower(teamname) NOT LIKE '%rookies%'
          AND lower(teamname) NOT LIKE '%youth%'
          AND lower(teamname) NOT LIKE '%prime%'
        GROUP BY playername, position
        ORDER BY g DESC
        LIMIT 20
      `).all(`%${n}%`);
    }
    if (!players.length) return null;

    const expected = {};
    const sample = {};
    let lastSeen = null;
    for (const p of players) {
      if (!p.position) continue;
      if (expected[p.position]) continue; // já pegamos top
      if (p.g < minGames) continue;
      expected[p.position] = p.playername;
      sample[p.position] = p.g;
      if (!lastSeen || p.last > lastSeen) lastSeen = p.last;
    }
    if (Object.keys(expected).length < 3) return null;
    return { expected, sample, lastSeenDate: lastSeen };
  } catch (_) { return null; }
}

/**
 * Compara lineup atual (nomes de jogadores do PandaScore live) vs roster
 * esperado (últimos 30d). Retorna { hasSub, subCount, missing, substitutes }.
 *
 * hasSub = true se ≥1 player do expected não aparece na lineup atual.
 *
 * @param {Array<string>} currentLineup - array de nomes de players live
 * @param {Object} expectedRoster - output de getExpectedRoster
 * @returns {{ hasSub, subCount, missing: string[], substitutes: string[], total }}
 */
function detectRosterSub(currentLineup, expectedRoster) {
  if (!expectedRoster?.expected || !Array.isArray(currentLineup)) {
    return { hasSub: false, subCount: 0, missing: [], substitutes: [], total: 0 };
  }
  const norm = (s) => String(s || '').toLowerCase().trim().replace(/\s+/g, '');
  const currentNorm = new Set(currentLineup.map(norm).filter(Boolean));
  const expectedNames = Object.values(expectedRoster.expected);
  const expectedNorm = new Set(expectedNames.map(norm));

  const missing = expectedNames.filter(n => !currentNorm.has(norm(n)));
  const substitutes = currentLineup.filter(n => !expectedNorm.has(norm(n)));

  return {
    hasSub: missing.length > 0,
    subCount: missing.length,
    missing, substitutes,
    total: expectedNames.length,
  };
}

function invalidateCache() { _playerCache.clear(); _teamCache.clear(); }

module.exports = {
  getPlayerRollingStats,
  getTeamRosterStats,
  getExpectedRoster,
  detectRosterSub,
  invalidateCache,
};
