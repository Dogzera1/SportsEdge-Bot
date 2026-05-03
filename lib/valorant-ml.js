/**
 * valorant-ml.js — Elo model para Valorant.
 *
 * Fork de cs-ml.js. Estrutura idêntica (time-vs-time, sem superfície).
 * Reutiliza match_results WHERE game='valorant'.
 *
 * Bootstrap via /seed-valorant-history (PandaScore /valorant/matches/past).
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
    WHERE game = 'valorant' AND winner IS NOT NULL AND winner != ''
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

function getValorantElo(db, team1, team2, impliedP1, impliedP2) {
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

  const minGames = Math.min(eloMatches1, eloMatches2);
  // 2026-05-03 FIX: hardcoded floor=5 desonra VAL_MIN_ELO_GAMES gate (default 3).
  // Quando bot.js gate aceitava VCL/Challengers com 3-4 jogos, eloWeight=0 →
  // modelP colapsava em impliedP, direction virava ruído. Honra env e escala
  // smoothly desde o piso até maturidade (15 jogos).
  const minGamesFloor = parseInt(process.env.VAL_MIN_ELO_GAMES || '5', 10);
  const eloWeight = minGames < minGamesFloor
    ? 0
    : Math.min(1.0, (minGames - minGamesFloor) / Math.max(1, 20 - minGamesFloor));

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

// ── Helpers para in-series score adjustment e form ──

function binomial(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let c = 1;
  for (let i = 0; i < k; i++) c = c * (n - i) / (i + 1);
  return c;
}

/**
 * P(time A vence série BoX dado placar atual).
 * Usa p = P(A vence um mapa) como aproximação do eloP1 inicial.
 *
 * @param {number} p   — P(A vence um mapa), 0..1
 * @param {number} bo  — 1, 3, 5
 * @param {number} sA  — mapas ganhos por A
 * @param {number} sB  — mapas ganhos por B
 */
function seriesWinProb(p, bo, sA, sB) {
  const need = Math.ceil(bo / 2);
  const A = need - sA;
  const B = need - sB;
  if (A <= 0) return 1;
  if (B <= 0) return 0;
  if (bo === 1) return p;
  let prob = 0;
  for (let k = 0; k < B; k++) {
    prob += binomial(A + k - 1, k) * Math.pow(p, A) * Math.pow(1 - p, k);
  }
  return Math.max(0, Math.min(1, prob));
}

/**
 * Win rate nas últimas N partidas do time (fonte: match_results).
 * Retorna null se amostra < 3.
 */
function getRecentForm(db, teamName, windowN = 10) {
  const targetNorm = _norm(teamName);
  if (!targetNorm) return null;
  const rows = db.prepare(`
    SELECT team1, team2, winner FROM match_results
    WHERE game = 'valorant'
      AND winner IS NOT NULL AND winner != ''
    ORDER BY resolved_at DESC
    LIMIT 500
  `).all();
  const relevant = [];
  for (const r of rows) {
    if (_norm(r.team1) === targetNorm || _norm(r.team2) === targetNorm) {
      relevant.push(r);
      if (relevant.length >= windowN) break;
    }
  }
  if (relevant.length < 3) return null;
  let wins = 0;
  for (const r of relevant) {
    const winnerNorm = _norm(r.winner);
    if (winnerNorm === targetNorm) wins++;
  }
  return { winRate: wins / relevant.length, games: relevant.length };
}

/**
 * Win rate de um time em um mapa específico.
 * Retorna null se <4 jogos (ruído demais).
 */
function getMapWinRate(db, teamName, mapName, windowN = 30) {
  const tNorm = _norm(teamName);
  const mNorm = String(mapName || '').toLowerCase().trim();
  if (!tNorm || !mNorm) return null;
  const rows = db.prepare(`
    SELECT team1, team2, winner FROM valorant_map_results
    WHERE LOWER(map_name) = ?
      AND (LOWER(team1) LIKE ? OR LOWER(team2) LIKE ?)
    ORDER BY resolved_at DESC
    LIMIT ?
  `).all(mNorm, `%${tNorm}%`, `%${tNorm}%`, windowN);
  const relevant = rows.filter(r =>
    _norm(r.team1) === tNorm || _norm(r.team2) === tNorm
  );
  if (relevant.length < 4) return null;
  let wins = 0;
  for (const r of relevant) {
    if (_norm(r.winner) === tNorm) wins++;
  }
  return { winRate: wins / relevant.length, games: relevant.length };
}

/**
 * H2H direto: últimos N encontros entre os dois times específicos.
 * Retorna null se <3 encontros (ruído).
 */
function getH2H(db, team1, team2, windowN = 10) {
  const n1 = _norm(team1), n2 = _norm(team2);
  if (!n1 || !n2) return null;
  const rows = db.prepare(`
    SELECT team1, team2, winner FROM match_results
    WHERE game = 'valorant'
      AND winner IS NOT NULL AND winner != ''
    ORDER BY resolved_at DESC
    LIMIT 1000
  `).all();
  const h2hRows = [];
  for (const r of rows) {
    const a = _norm(r.team1), b = _norm(r.team2);
    const pairMatch = (a === n1 && b === n2) || (a === n2 && b === n1);
    if (pairMatch) {
      h2hRows.push(r);
      if (h2hRows.length >= windowN) break;
    }
  }
  if (h2hRows.length < 3) return null;
  let t1Wins = 0, t2Wins = 0;
  for (const r of h2hRows) {
    const winnerNorm = _norm(r.winner);
    if (winnerNorm === n1) t1Wins++;
    else if (winnerNorm === n2) t2Wins++;
  }
  const total = t1Wins + t2Wins;
  if (total === 0) return null;
  return { t1Wins, t2Wins, total, t1Rate: t1Wins / total };
}

/**
 * Modelo completo Valorant: Elo + form recente + H2H + in-series adjustment.
 *
 * ctx: { bo, score1, score2 } — opcional. Se presente, aplica ajuste in-series.
 */
function getValorantModel(db, team1, team2, impliedP1, impliedP2, ctx = {}) {
  const elo = getValorantElo(db, team1, team2, impliedP1, impliedP2);
  if (!elo.found1 || !elo.found2) {
    return { ...elo, form1: null, form2: null, h2h: null, inSeriesAdjusted: false };
  }

  // Form: diferencial de win rate recente vs Elo-implied
  const form1 = getRecentForm(db, team1);
  const form2 = getRecentForm(db, team2);
  const eloOnlyP1 = elo.modelP1;
  let formAdjust = 0;
  let formFactor = false;
  if (form1 && form2) {
    const wrDiff = form1.winRate - form2.winRate;
    const minGames = Math.min(form1.games, form2.games);
    const formConf = Math.min(1.0, minGames / 8);
    formAdjust = Math.max(-0.04, Math.min(0.04, wrDiff * 0.10 * formConf));
    formFactor = true;
  }

  // H2H: bias direto dos encontros entre esses dois times
  const h2h = getH2H(db, team1, team2);
  let h2hAdjust = 0;
  let h2hFactor = false;
  if (h2h) {
    // t1Rate 0.5 = neutro; cada ponto de desvio × 0.12, cap ±4pp
    // Confiança: satura em 8 H2H. 3 jogos = 0.375 confiança.
    const bias = h2h.t1Rate - 0.5;
    const h2hConf = Math.min(1.0, h2h.total / 8);
    h2hAdjust = Math.max(-0.04, Math.min(0.04, bias * 0.12 * h2hConf));
    h2hFactor = true;
  }

  // Map-level bias: quando currentMap conhecido, bias pelo win rate por mapa.
  let mapAdjust = 0;
  let mapFactor = false;
  let mapRate1 = null, mapRate2 = null;
  if (ctx.currentMap) {
    mapRate1 = getMapWinRate(db, team1, ctx.currentMap);
    mapRate2 = getMapWinRate(db, team2, ctx.currentMap);
    if (mapRate1 && mapRate2) {
      const wrDiff = mapRate1.winRate - mapRate2.winRate;
      const minG = Math.min(mapRate1.games, mapRate2.games);
      const mapConf = Math.min(1.0, minG / 10);
      // 0.08 × diff, cap ±3pp — peso conservador (amostras pequenas por mapa)
      mapAdjust = Math.max(-0.03, Math.min(0.03, wrDiff * 0.08 * mapConf));
      mapFactor = true;
    }
  }

  // BoX variance: Bo1 reduz peso Elo
  const bo = Number(ctx.bo) || 3;
  const boWeight = bo === 1 ? 0.80 : 1.0;

  let mapP1 = eloOnlyP1 * boWeight + impliedP1 * (1 - boWeight) + formAdjust + h2hAdjust + mapAdjust;
  mapP1 = Math.max(0.05, Math.min(0.95, mapP1));

  // In-series adjustment: se placar > 0 em série Bo3/Bo5
  const s1 = Number(ctx.score1) || 0;
  const s2 = Number(ctx.score2) || 0;
  let modelP1 = mapP1;
  let inSeriesAdjusted = false;
  if (bo > 1 && (s1 > 0 || s2 > 0)) {
    modelP1 = seriesWinProb(mapP1, bo, s1, s2);
    inSeriesAdjusted = true;
  }
  modelP1 = Math.max(0.02, Math.min(0.98, modelP1));
  const modelP2 = 1 - modelP1;

  const edge1 = (modelP1 - impliedP1) * 100;
  const edge2 = (modelP2 - impliedP2) * 100;
  const maxEdge = Math.max(edge1, edge2);
  const direction = edge1 > edge2 && edge1 > 0.5 ? 'p1'
                  : edge2 > edge1 && edge2 > 0.5 ? 'p2' : 'none';
  const factorCount = (elo.found1 ? 1 : 0) + (elo.found2 ? 1 : 0) + (formFactor ? 1 : 0) + (h2hFactor ? 1 : 0) + (mapFactor ? 1 : 0);
  const pass = elo.found1 && elo.found2 && maxEdge >= 1.0;

  return {
    pass,
    modelP1, modelP2,
    elo1: elo.elo1, elo2: elo.elo2,
    eloMatches1: elo.eloMatches1, eloMatches2: elo.eloMatches2,
    form1, form2,
    formAdjust,
    h2h,
    h2hAdjust,
    mapRate1, mapRate2,
    mapAdjust,
    currentMap: ctx.currentMap || null,
    inSeriesAdjusted,
    mapP1,
    edge1, edge2,
    factorCount,
    score: maxEdge,
    direction,
    found1: elo.found1, found2: elo.found2,
  };
}

module.exports = { getValorantElo, getValorantModel, seriesWinProb, getRecentForm, getH2H, getMapWinRate, invalidateEloCache, computeEloFromDB };
