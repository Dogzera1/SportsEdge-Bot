/**
 * tennis-ml.js — Surface-adjusted Elo model for tennis
 * Built from Sackmann historical data in match_results (game='tennis')
 *
 * Architecture:
 *   computeEloFromDB(db) → builds in-memory Elo ratings per surface + overall
 *   getTennisElo(player1, player2, surface) → returns ML result for pollTennis
 *
 * Surface labels (from league field):
 *   "(Hard)" or "(Carpet)" → 'dura'
 *   "(Clay)"               → 'saibro'
 *   "(Grass)"              → 'grama'
 *
 * Blend: 60% surface Elo + 40% overall Elo (or 100% overall when < 5 surface games)
 */

const K_BASE    = 32;
const K_MIN     = 10;
const K_SCALE   = 40;   // games until K reaches minimum
const ELO_INIT  = 1500;
const CACHE_TTL = 60 * 60 * 1000; // 1h

let _cache = null; // { data: { players, lastUpdated }, exp: ts }

/**
 * Extract surface label from league string.
 * Examples: "ATP Roland Garros (Clay) [G]" → 'saibro'
 *           "ATP Wimbledon (Grass) [G]"    → 'grama'
 *           "ATP Us Open (Hard) [G]"       → 'dura'
 */
function extractSurface(league) {
  const m = String(league || '').match(/\((Hard|Carpet|Clay|Grass)\)/i);
  if (!m) return 'dura';
  const raw = m[1].toLowerCase();
  if (raw === 'clay') return 'saibro';
  if (raw === 'grass') return 'grama';
  return 'dura'; // hard / carpet
}

function eloExpected(rA, rB) {
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}

function kFactor(games) {
  // Decreasing K: K_BASE at 0 games, K_MIN at K_SCALE+ games
  const ratio = Math.min(1, games / K_SCALE);
  return K_BASE - (K_BASE - K_MIN) * ratio;
}

/**
 * Build Elo ratings from all tennis rows in match_results.
 * Returns a Map: playerName → { overall, dura, saibro, grama,
 *                                gamesAll, gamesDura, gamesSaibro, gamesGrama }
 */
function computeEloFromDB(db) {
  // Order by match date (ascending) so Elo updates flow forward in time
  // match_results has team1/team2/winner — derive loser from winner
  const rows = db.prepare(`
    SELECT team1, team2, winner, league, resolved_at AS time
    FROM match_results
    WHERE game = 'tennis' AND winner IS NOT NULL AND winner != ''
      AND team1 IS NOT NULL AND team1 != '' AND team2 IS NOT NULL AND team2 != ''
    ORDER BY time ASC
  `).all();

  const players = new Map();

  function get(name) {
    if (!players.has(name)) {
      players.set(name, {
        overall: ELO_INIT, dura: ELO_INIT, saibro: ELO_INIT, grama: ELO_INIT,
        gamesAll: 0, gamesDura: 0, gamesSaibro: 0, gamesGrama: 0,
      });
    }
    return players.get(name);
  }

  for (const row of rows) {
    // Determine loser: whichever of team1/team2 is NOT the winner
    const winnerNorm = _norm(row.winner);
    const t1Norm     = _norm(row.team1);
    const t2Norm     = _norm(row.team2);
    const winnerName = (t1Norm === winnerNorm || row.team1 === row.winner) ? row.team1 : row.team2;
    const loserName  = winnerName === row.team1 ? row.team2 : row.team1;

    const w = get(winnerName);
    const l = get(loserName);
    const surface = extractSurface(row.league);

    const surfKey  = surface;       // 'dura' | 'saibro' | 'grama'
    const gamesKey = surface === 'dura'   ? 'gamesDura'
                   : surface === 'saibro' ? 'gamesSaibro'
                   : 'gamesGrama';

    // ── Overall Elo update ──
    const expW_all = eloExpected(w.overall, l.overall);
    const kW_all   = kFactor(w.gamesAll);
    const kL_all   = kFactor(l.gamesAll);
    w.overall += kW_all * (1 - expW_all);
    l.overall += kL_all * (0 - (1 - expW_all));
    w.gamesAll++;
    l.gamesAll++;

    // ── Surface Elo update ──
    const expW_surf = eloExpected(w[surfKey], l[surfKey]);
    const kW_surf   = kFactor(w[gamesKey]);
    const kL_surf   = kFactor(l[gamesKey]);
    w[surfKey] += kW_surf * (1 - expW_surf);
    l[surfKey] += kL_surf * (0 - (1 - expW_surf));
    w[gamesKey]++;
    l[gamesKey]++;
  }

  return players;
}

/**
 * Load (or return cached) Elo ratings.
 * @param {object} db - better-sqlite3 db instance
 */
function getEloMap(db) {
  if (_cache && Date.now() < _cache.exp) return _cache.data;
  const players = computeEloFromDB(db);
  _cache = { data: players, exp: Date.now() + CACHE_TTL };
  return players;
}

/** Force cache invalidation (call after settlement). */
function invalidateEloCache() {
  _cache = null;
}

/**
 * Normalize player name for fuzzy matching.
 */
function _norm(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '').trim();
}

/**
 * Find a player in the Elo map using fuzzy matching.
 * Priority: exact → includes → last-name match.
 */
function findPlayer(players, name) {
  if (!name) return null;
  const norm = _norm(name);
  if (players.has(name)) return players.get(name);

  // Try exact norm match
  for (const [k, v] of players) {
    if (_norm(k) === norm) return v;
  }
  // Try includes
  for (const [k, v] of players) {
    const nk = _norm(k);
    if (nk.includes(norm) || norm.includes(nk)) return v;
  }
  // Try last name match (last word)
  const last = norm.split(' ').pop();
  if (last && last.length >= 4) {
    for (const [k, v] of players) {
      if (_norm(k).split(' ').pop() === last) return v;
    }
  }
  return null;
}

/**
 * Blend surface Elo with overall Elo.
 * If few surface games: lean on overall.
 * @param {object} p   - player entry from Elo map
 * @param {string} surf - 'dura' | 'saibro' | 'grama'
 */
function blendElo(p, surf) {
  const surfKey  = surf;
  const gamesKey = surf === 'dura'   ? 'gamesDura'
                 : surf === 'saibro' ? 'gamesSaibro'
                 : 'gamesGrama';
  const gSurf = p[gamesKey] || 0;

  // Confidence in surface Elo: ramp from 0→60% over first 15 surface games
  const surfWeight = Math.min(0.60, gSurf / 15 * 0.60);
  const allWeight  = 1 - surfWeight;

  return p[surfKey] * surfWeight + p.overall * allWeight;
}

/**
 * Main entry: get Elo-based ML result for a tennis match.
 *
 * @param {object} db
 * @param {string} player1  - home/player 1 name
 * @param {string} player2  - away/player 2 name
 * @param {string} surface  - 'dura' | 'saibro' | 'grama'
 * @returns {{
 *   pass: boolean,
 *   modelP1: number, modelP2: number,
 *   elo1: number, elo2: number,
 *   eloMatches1: number, eloMatches2: number,
 *   surfMatches1: number, surfMatches2: number,
 *   edge1: number, edge2: number,
 *   factorCount: number,
 *   score: number,
 *   direction: 'p1'|'p2'|'none',
 *   found1: boolean, found2: boolean,
 * }}
 */
function getTennisElo(db, player1, player2, surface, impliedP1, impliedP2) {
  const players = getEloMap(db);
  const p1Entry  = findPlayer(players, player1);
  const p2Entry  = findPlayer(players, player2);

  const found1 = !!p1Entry;
  const found2 = !!p2Entry;

  // Default to init Elo when not found (neutral, low confidence)
  const elo1 = found1 ? blendElo(p1Entry, surface) : ELO_INIT;
  const elo2 = found2 ? blendElo(p2Entry, surface) : ELO_INIT;

  const eloP1 = eloExpected(elo1, elo2); // 0..1
  const eloP2 = 1 - eloP1;

  const eloMatches1 = p1Entry?.gamesAll || 0;
  const eloMatches2 = p2Entry?.gamesAll || 0;

  const surfGamesKey = surface === 'dura'   ? 'gamesDura'
                     : surface === 'saibro' ? 'gamesSaibro'
                     : 'gamesGrama';
  const surfMatches1 = p1Entry?.[surfGamesKey] || 0;
  const surfMatches2 = p2Entry?.[surfGamesKey] || 0;

  // Confidence weight: how many games do both players have?
  const minGames   = Math.min(eloMatches1, eloMatches2);
  const eloWeight  = Math.min(1.0, minGames / 20); // Full weight at 20+ games each

  // Final model probability: blend Elo prediction with implied (prior)
  // When few games: rely more on market; when many: rely on Elo
  const imp1 = (impliedP1 || 0.5);
  const imp2 = (impliedP2 || 0.5);
  const modelP1 = eloP1 * eloWeight + imp1 * (1 - eloWeight);
  const modelP2 = eloP2 * eloWeight + imp2 * (1 - eloWeight);

  const edge1 = (modelP1 - imp1) * 100; // pp edge for p1
  const edge2 = (modelP2 - imp2) * 100;

  // Score = max absolute edge (positive = model disagrees with market)
  const maxEdge = Math.max(edge1, edge2);
  const score   = maxEdge;
  const direction = edge1 > edge2 && edge1 > 0.5 ? 'p1'
                  : edge2 > edge1 && edge2 > 0.5 ? 'p2'
                  : 'none';

  // factorCount: how many meaningful signals we have
  const factorCount = (found1 ? 1 : 0) + (found2 ? 1 : 0)
    + (surfMatches1 >= 5 ? 1 : 0) + (surfMatches2 >= 5 ? 1 : 0);

  // pass when we have at least one player in DB and some edge
  const pass = (found1 || found2) && score >= 1.0;

  return {
    pass,
    modelP1, modelP2,
    elo1: Math.round(elo1), elo2: Math.round(elo2),
    eloMatches1, eloMatches2,
    surfMatches1, surfMatches2,
    edge1, edge2,
    factorCount,
    score,
    direction,
    found1, found2,
  };
}

module.exports = { extractSurface, getTennisElo, invalidateEloCache, computeEloFromDB };
