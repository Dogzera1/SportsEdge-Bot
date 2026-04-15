/**
 * tabletennis-ml.js — Elo model para tênis de mesa.
 *
 * Fork simplificado do tennis-ml.js — sem superfície (TT é só indoor).
 *
 * Architecture:
 *   computeEloFromDB(db) → builds in-memory Elo ratings de match_results (game='tabletennis')
 *   getTableTennisElo(db, p1, p2, impliedP1, impliedP2) → ML result
 *
 * DB seed: tabela match_results é populada via settlement automático
 * (quando resolvemos tips). Primeiras semanas = sem sample → ML passa pouco;
 * conforme DB acumula, Elo ganha confiança.
 */

const K_BASE    = 32;
const K_MIN     = 10;
const K_SCALE   = 40;
const ELO_INIT  = 1500;
const CACHE_TTL = 60 * 60 * 1000; // 1h

let _cache = null;

function eloExpected(rA, rB) {
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}

function kFactor(games) {
  const ratio = Math.min(1, games / K_SCALE);
  return K_BASE - (K_BASE - K_MIN) * ratio;
}

function _norm(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '').trim();
}

function computeEloFromDB(db) {
  const rows = db.prepare(`
    SELECT team1, team2, winner, resolved_at AS time
    FROM match_results
    WHERE game = 'tabletennis' AND winner IS NOT NULL AND winner != ''
      AND team1 IS NOT NULL AND team1 != '' AND team2 IS NOT NULL AND team2 != ''
    ORDER BY time ASC
  `).all();

  const players = new Map();

  function get(name) {
    if (!players.has(name)) {
      players.set(name, { elo: ELO_INIT, games: 0 });
    }
    return players.get(name);
  }

  for (const row of rows) {
    const winnerNorm = _norm(row.winner);
    const t1Norm     = _norm(row.team1);
    const winnerName = (t1Norm === winnerNorm || row.team1 === row.winner) ? row.team1 : row.team2;
    const loserName  = winnerName === row.team1 ? row.team2 : row.team1;

    const w = get(winnerName);
    const l = get(loserName);

    const expW = eloExpected(w.elo, l.elo);
    const kW = kFactor(w.games);
    const kL = kFactor(l.games);
    w.elo += kW * (1 - expW);
    l.elo += kL * (0 - (1 - expW));
    w.games++;
    l.games++;
  }

  return players;
}

function getEloMap(db) {
  if (_cache && Date.now() < _cache.exp) return _cache.data;
  const players = computeEloFromDB(db);
  _cache = { data: players, exp: Date.now() + CACHE_TTL };
  return players;
}

function invalidateEloCache() {
  _cache = null;
}

function findPlayer(players, name) {
  if (!name) return null;
  const norm = _norm(name);
  if (players.has(name)) return players.get(name);
  for (const [k, v] of players) {
    if (_norm(k) === norm) return v;
  }
  for (const [k, v] of players) {
    const nk = _norm(k);
    if (nk.includes(norm) || norm.includes(nk)) return v;
  }
  const last = norm.split(' ').pop();
  if (last && last.length >= 4) {
    for (const [k, v] of players) {
      if (_norm(k).split(' ').pop() === last) return v;
    }
  }
  return null;
}

/**
 * @returns {{
 *   pass, modelP1, modelP2, elo1, elo2,
 *   eloMatches1, eloMatches2, edge1, edge2,
 *   factorCount, score, direction, found1, found2
 * }}
 */
function getTableTennisElo(db, player1, player2, impliedP1, impliedP2) {
  const players = getEloMap(db);
  const p1Entry = findPlayer(players, player1);
  const p2Entry = findPlayer(players, player2);

  const found1 = !!p1Entry;
  const found2 = !!p2Entry;

  const elo1 = found1 ? p1Entry.elo : ELO_INIT;
  const elo2 = found2 ? p2Entry.elo : ELO_INIT;

  const eloP1 = eloExpected(elo1, elo2);
  const eloP2 = 1 - eloP1;

  const eloMatches1 = p1Entry?.games || 0;
  const eloMatches2 = p2Entry?.games || 0;

  // Mesmo guard do tênis: piso 5 jogos, full weight em 20+
  const minGames = Math.min(eloMatches1, eloMatches2);
  const eloWeight = minGames < 5 ? 0 : Math.min(1.0, (minGames - 5) / 15);

  const imp1 = (impliedP1 || 0.5);
  const imp2 = (impliedP2 || 0.5);
  const modelP1 = eloP1 * eloWeight + imp1 * (1 - eloWeight);
  const modelP2 = eloP2 * eloWeight + imp2 * (1 - eloWeight);

  const edge1 = (modelP1 - imp1) * 100;
  const edge2 = (modelP2 - imp2) * 100;

  const maxEdge = Math.max(edge1, edge2);
  const score = maxEdge;
  const direction = edge1 > edge2 && edge1 > 0.5 ? 'p1'
                  : edge2 > edge1 && edge2 > 0.5 ? 'p2'
                  : 'none';

  const factorCount = (found1 ? 1 : 0) + (found2 ? 1 : 0);

  const pass = (found1 && found2) && score >= 1.0;

  return {
    pass,
    modelP1, modelP2,
    elo1: Math.round(elo1), elo2: Math.round(elo2),
    eloMatches1, eloMatches2,
    edge1, edge2,
    factorCount,
    score,
    direction,
    found1, found2,
  };
}

module.exports = { getTableTennisElo, invalidateEloCache, computeEloFromDB };
