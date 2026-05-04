'use strict';

/**
 * basket-trained.js
 *
 * Inference do modelo treinado NBA. Lê data/basket-trained-params.json
 * (gerado por scripts/train-basket-model.js), computa features point-in-time
 * via DB query (basket_match_history), aplica weights logistic, calibra com
 * isotonic.
 *
 * Public API:
 *   hasTrainedBasketModel()        → bool
 *   predictTrainedBasket(db, home, away, gameDate?) → { pHome, pAway, confidence, features, isCold }
 *   getParams()                    → params JSON ou null
 *   invalidateCache()
 */

const fs = require('fs');
const path = require('path');

let _cached = null;
let _cachedAt = 0;
const TTL_MS = 30 * 60 * 1000;

const _norm = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

function _paramsPath() {
  const dbPath = (process.env.DB_PATH || 'sportsedge.db').trim();
  return path.join(path.dirname(path.resolve(dbPath)), 'basket-trained-params.json');
}

function _load() {
  try {
    const p = _paramsPath();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
}

function getParams() {
  const now = Date.now();
  if (_cached && (now - _cachedAt) < TTL_MS) return _cached;
  _cached = _load();
  _cachedAt = now;
  return _cached;
}

function invalidateCache() {
  _cached = null;
  _cachedAt = 0;
}

function hasTrainedBasketModel() {
  const p = getParams();
  return !!(p && Array.isArray(p.weights) && Number.isFinite(p.intercept));
}

function _sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

function _expected(rA, rB) { return 1 / (1 + Math.pow(10, (rB - rA) / 400)); }

/**
 * Computa features rolling pra (home, away) AS-OF gameDate.
 * Lê basket_match_history pra games anteriores e calcula Elo + form +
 * season WR + rest days + h2h, mesma lógica do script de treino.
 *
 * Retorna { features, isCold, hGames, aGames }
 */
function _computeFeatures(db, home, away, gameDate, params) {
  const hN = _norm(home), aN = _norm(away);
  if (!hN || !aN) return null;
  const dateClause = gameDate ? `AND game_date < ?` : '';
  const dateArg = gameDate ? [gameDate] : [];

  // Pull histórico relevante: jogos onde home/away aparecem ATÉ gameDate.
  // Limite 500 mais recentes pra cada team é suficiente.
  const homeGames = db.prepare(`
    SELECT * FROM basket_match_history
    WHERE (home_team_norm = ? OR away_team_norm = ?)
      AND home_score IS NOT NULL ${dateClause}
    ORDER BY game_date DESC LIMIT 500
  `).all(hN, hN, ...dateArg);
  const awayGames = db.prepare(`
    SELECT * FROM basket_match_history
    WHERE (home_team_norm = ? OR away_team_norm = ?)
      AND home_score IS NOT NULL ${dateClause}
    ORDER BY game_date DESC LIMIT 500
  `).all(aN, aN, ...dateArg);

  const ELO_INIT = params.elo_init || 1500;
  const ELO_K = params.elo_k || 20;
  const HOME_ADV = params.home_adv || 85;
  const ROLLING = params.rolling_window || 10;

  // Elo: precisa de full rolling pra cada team. Pull ALL games entre todos teams,
  // ordenados por date asc, e replay até gameDate. Custo: ~2400 games × O(1) = fast.
  const allGames = db.prepare(`
    SELECT * FROM basket_match_history
    WHERE home_score IS NOT NULL ${dateClause}
    ORDER BY game_date ASC
  `).all(...dateArg);

  const eloMap = new Map();
  const formMap = new Map();
  const seasonMap = new Map();
  const lastDate = new Map();
  const h2hMap = new Map();
  const getEloT = (n) => eloMap.get(n) ?? ELO_INIT;
  const getRest = (n, d) => {
    const last = lastDate.get(n);
    if (!last) return 3;
    const diff = (new Date(d) - new Date(last)) / (1000 * 60 * 60 * 24);
    return Math.max(0, Math.min(7, diff));
  };
  const getRollingForm = (n) => {
    const arr = formMap.get(n) || [];
    if (!arr.length) return { wr: 0.5, margin: 0 };
    const wins = arr.filter(g => g.won).length;
    return { wr: wins / arr.length, margin: arr.reduce((s, g) => s + g.margin, 0) / arr.length };
  };
  const getSeasonWr = (n, season) => {
    const v = seasonMap.get(`${n}__${season}`);
    if (!v || (v.wins + v.losses) < 3) return 0.5;
    return v.wins / (v.wins + v.losses);
  };
  const getH2hHome = (h, a) => {
    const k = h < a ? `${h}__${a}` : `${a}__${h}`;
    const v = h2hMap.get(k);
    if (!v || (v.home_wins + v.away_wins) < 2) return 0.5;
    return v.home_wins / (v.home_wins + v.away_wins);
  };

  // Replay games up to gameDate
  for (const g of allGames) {
    const h = g.home_team_norm, a = g.away_team_norm;
    if (!h || !a) continue;
    const sH = g.home_score, sA = g.away_score;
    const homeWon = sH > sA ? 1 : 0;
    const eloH = getEloT(h), eloA = getEloT(a);
    const expH = _expected(eloH + HOME_ADV, eloA);
    eloMap.set(h, eloH + ELO_K * (homeWon - expH));
    eloMap.set(a, eloA + ELO_K * ((1 - homeWon) - (1 - expH)));
    const fH = formMap.get(h) || [];
    fH.push({ won: !!homeWon, margin: sH - sA });
    if (fH.length > ROLLING) fH.shift();
    formMap.set(h, fH);
    const fA = formMap.get(a) || [];
    fA.push({ won: !homeWon, margin: sA - sH });
    if (fA.length > ROLLING) fA.shift();
    formMap.set(a, fA);
    const kSh = `${h}__${g.season}`;
    const sObjH = seasonMap.get(kSh) || { wins: 0, losses: 0 };
    homeWon ? sObjH.wins++ : sObjH.losses++;
    seasonMap.set(kSh, sObjH);
    const kSa = `${a}__${g.season}`;
    const sObjA = seasonMap.get(kSa) || { wins: 0, losses: 0 };
    homeWon ? sObjA.losses++ : sObjA.wins++;
    seasonMap.set(kSa, sObjA);
    lastDate.set(h, g.game_date);
    lastDate.set(a, g.game_date);
    const kH2h = h < a ? `${h}__${a}` : `${a}__${h}`;
    const h2hObj = h2hMap.get(kH2h) || { home_wins: 0, away_wins: 0 };
    homeWon ? h2hObj.home_wins++ : h2hObj.away_wins++;
    h2hMap.set(kH2h, h2hObj);
  }

  // Snapshot features pra (home, away)
  const eloH = getEloT(hN), eloA = getEloT(aN);
  const formH = getRollingForm(hN), formA = getRollingForm(aN);
  // Estimativa season corrente: usa ano do gameDate
  const season = gameDate ? new Date(gameDate).getUTCFullYear() : new Date().getUTCFullYear();
  const restH = getRest(hN, gameDate || new Date().toISOString().slice(0, 10));
  const restA = getRest(aN, gameDate || new Date().toISOString().slice(0, 10));
  const seasonWrH = getSeasonWr(hN, season);
  const seasonWrA = getSeasonWr(aN, season);
  const isPlayoffs = 0; // sem signal pre-game; se precisar wired via SPORTS metadata
  const h2hHomeWr = getH2hHome(hN, aN);

  const hGames = (formMap.get(hN) || []).length;
  const aGames = (formMap.get(aN) || []).length;
  const isCold = hGames < 5 || aGames < 5;

  const features = [
    ((eloH + HOME_ADV) - eloA) / 400,
    (formH.wr - formA.wr),
    (formH.margin - formA.margin) / 10,
    (Math.min(restH, 4) - Math.min(restA, 4)) / 4,
    (seasonWrH - seasonWrA),
    isPlayoffs,
    (h2hHomeWr - 0.5) * 2,
  ];

  return {
    features,
    isCold,
    hGames,
    aGames,
    debug: { eloH, eloA, formH, formA, restH, restA, seasonWrH, seasonWrA, h2hHomeWr },
  };
}

function _applyIsotonic(map, p) {
  if (!Array.isArray(map) || !map.length) return p;
  for (const b of map) {
    if (p >= b.p_lo && p <= b.p_hi) return b.calib;
  }
  if (p < map[0].p_lo) return map[0].calib;
  return map[map.length - 1].calib;
}

/**
 * Predição main. Aceita gameDate opcional pra prediction histórica/backtest.
 * Sem gameDate = usa estado AGORA (replay até hoje).
 */
function predictTrainedBasket(db, home, away, gameDate = null) {
  const params = getParams();
  if (!params) return null;
  const fe = _computeFeatures(db, home, away, gameDate, params);
  if (!fe) return null;
  const { features, isCold, hGames, aGames } = fe;
  let z = params.intercept;
  for (let k = 0; k < params.weights.length; k++) z += params.weights[k] * features[k];
  let pHome = _sigmoid(z);
  if (params.isotonic) pHome = _applyIsotonic(params.isotonic, pHome);
  // Confidence proxy: distance from 0.5 + games warmup
  const confidence = Math.min(1.0, Math.abs(pHome - 0.5) * 2 * (isCold ? 0.5 : 1.0));
  return {
    pHome, pAway: 1 - pHome,
    confidence,
    isCold, hGames, aGames,
    features,
    debug: fe.debug,
  };
}

/**
 * Predição de TOTAL e MARGEM via rolling pace/defense per team.
 *
 * μ_home = (homePaceL10 + awayDefL10) / 2 + homeAdvPts / 2
 * μ_away = (awayPaceL10 + homeDefL10) / 2 - homeAdvPts / 2
 * μ_total  = μ_home + μ_away
 * μ_margin = μ_home - μ_away (team1's perspective)
 *
 * σ é constante NBA-wide (variance é estável entre matchups; totals σ≈18,
 * margins σ≈13 — bem documentado em literatura NBA). Override via params se
 * train script computar (params.market_sigma).
 *
 * Retorna null se cold (qualquer team <5 games rolling).
 */
function predictTrainedBasketMarkets(db, home, away, gameDate = null) {
  const params = getParams();
  if (!params) return null;
  const hN = _norm(home), aN = _norm(away);
  if (!hN || !aN) return null;

  const dateClause = gameDate ? `AND game_date < ?` : '';
  const dateArg = gameDate ? [gameDate] : [];

  // Rolling pace/defense per team. Replay all games asc, manter últimos N.
  const allGames = db.prepare(`
    SELECT game_date, home_team_norm, away_team_norm, home_score, away_score
    FROM basket_match_history
    WHERE home_score IS NOT NULL AND away_score IS NOT NULL ${dateClause}
    ORDER BY game_date ASC
  `).all(...dateArg);

  const ROLLING = params.rolling_window || 10;
  const HOME_ADV_PTS = Number.isFinite(params.home_adv_pts) ? params.home_adv_pts : 3.0;

  // paceMap: norm → array de pontos marcados; defMap: array de pontos sofridos
  const paceMap = new Map();
  const defMap = new Map();
  const push = (m, n, v) => {
    let a = m.get(n) || [];
    a.push(v);
    if (a.length > ROLLING) a.shift();
    m.set(n, a);
  };

  for (const g of allGames) {
    const h = g.home_team_norm, a = g.away_team_norm;
    if (!h || !a) continue;
    push(paceMap, h, g.home_score);
    push(defMap,  h, g.away_score);
    push(paceMap, a, g.away_score);
    push(defMap,  a, g.home_score);
  }

  const mean = (arr) => (arr && arr.length) ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  const homePace = mean(paceMap.get(hN));
  const homeDef  = mean(defMap.get(hN));
  const awayPace = mean(paceMap.get(aN));
  const awayDef  = mean(defMap.get(aN));

  const hGames = (paceMap.get(hN) || []).length;
  const aGames = (paceMap.get(aN) || []).length;
  const isCold = hGames < 5 || aGames < 5;
  if (isCold || homePace == null || awayPace == null) {
    return { isCold: true, hGames, aGames };
  }

  const muHome = (homePace + awayDef) / 2 + HOME_ADV_PTS / 2;
  const muAway = (awayPace + homeDef) / 2 - HOME_ADV_PTS / 2;
  const totalMu = muHome + muAway;
  const marginMu = muHome - muAway;

  // σ defaults NBA: total~18, margin~13. Override via params se train script
  // computar (basket-trained-params.json key 'market_sigma').
  const totalSigma = Number.isFinite(params.market_sigma?.total) ? params.market_sigma.total : 18.0;
  const marginSigma = Number.isFinite(params.market_sigma?.margin) ? params.market_sigma.margin : 13.0;

  return {
    isCold: false,
    hGames, aGames,
    totalMu: +totalMu.toFixed(2),
    totalSigma: +totalSigma.toFixed(2),
    marginMu: +marginMu.toFixed(2),
    marginSigma: +marginSigma.toFixed(2),
    debug: {
      homePace: +homePace.toFixed(1),
      homeDef: +homeDef.toFixed(1),
      awayPace: +awayPace.toFixed(1),
      awayDef: +awayDef.toFixed(1),
      muHome: +muHome.toFixed(1),
      muAway: +muAway.toFixed(1),
    },
  };
}

module.exports = {
  hasTrainedBasketModel,
  predictTrainedBasket,
  predictTrainedBasketMarkets,
  getParams,
  invalidateCache,
  _computeFeatures, // exposed pra testing
};
