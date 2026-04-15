/**
 * cs-ml.js — Elo model para Counter-Strike 2.
 *
 * Fork direto do tabletennis-ml.js (sem superfície, time-vs-time).
 * Reutiliza match_results WHERE game='cs'.
 *
 * Sem sample inicial → ML não passa; conforme DB acumula via settlement
 * (ou seed via /seed-cs-history), Elo ganha confiança.
 */

const K_BASE    = 32;
const K_MIN     = 10;
const K_SCALE   = 40;
const ELO_INIT  = 1500;
const CACHE_TTL = 60 * 60 * 1000;

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
    WHERE game = 'cs' AND winner IS NOT NULL AND winner != ''
      AND team1 IS NOT NULL AND team1 != '' AND team2 IS NOT NULL AND team2 != ''
    ORDER BY time ASC
  `).all();

  const teams = new Map();
  function get(name) {
    if (!teams.has(name)) teams.set(name, { elo: ELO_INIT, games: 0 });
    return teams.get(name);
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
    w.games++; l.games++;
  }
  return teams;
}

function getEloMap(db) {
  if (_cache && Date.now() < _cache.exp) return _cache.data;
  _cache = { data: computeEloFromDB(db), exp: Date.now() + CACHE_TTL };
  return _cache.data;
}

function invalidateEloCache() { _cache = null; }

function findTeam(teams, name) {
  if (!name) return null;
  const norm = _norm(name);
  if (teams.has(name)) return teams.get(name);
  for (const [k, v] of teams) if (_norm(k) === norm) return v;
  for (const [k, v] of teams) {
    const nk = _norm(k);
    if (nk.includes(norm) || norm.includes(nk)) return v;
  }
  return null;
}

function getCsElo(db, team1, team2, impliedP1, impliedP2) {
  const teams = getEloMap(db);
  const t1Entry = findTeam(teams, team1);
  const t2Entry = findTeam(teams, team2);
  const found1 = !!t1Entry;
  const found2 = !!t2Entry;

  const elo1 = found1 ? t1Entry.elo : ELO_INIT;
  const elo2 = found2 ? t2Entry.elo : ELO_INIT;
  const eloP1 = eloExpected(elo1, elo2);
  const eloP2 = 1 - eloP1;
  const eloMatches1 = t1Entry?.games || 0;
  const eloMatches2 = t2Entry?.games || 0;

  // Mesma curva: piso 5 jogos, full weight em 20+
  const minGames = Math.min(eloMatches1, eloMatches2);
  const eloWeight = minGames < 5 ? 0 : Math.min(1.0, (minGames - 5) / 15);

  const imp1 = (impliedP1 || 0.5);
  const imp2 = (impliedP2 || 0.5);
  const modelP1 = eloP1 * eloWeight + imp1 * (1 - eloWeight);
  const modelP2 = eloP2 * eloWeight + imp2 * (1 - eloWeight);
  const edge1 = (modelP1 - imp1) * 100;
  const edge2 = (modelP2 - imp2) * 100;
  const maxEdge = Math.max(edge1, edge2);
  const direction = edge1 > edge2 && edge1 > 0.5 ? 'p1'
                  : edge2 > edge1 && edge2 > 0.5 ? 'p2' : 'none';
  const factorCount = (found1 ? 1 : 0) + (found2 ? 1 : 0);
  const pass = (found1 && found2) && maxEdge >= 1.0;

  return {
    pass,
    modelP1, modelP2,
    elo1: Math.round(elo1), elo2: Math.round(elo2),
    eloMatches1, eloMatches2,
    edge1, edge2,
    factorCount,
    score: maxEdge,
    direction,
    found1, found2,
  };
}

module.exports = { getCsElo, invalidateEloCache, computeEloFromDB };
