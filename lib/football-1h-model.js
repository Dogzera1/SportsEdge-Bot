'use strict';

/**
 * football-1h-model.js — Wave 2B 1ª metade markets (1H Match Result, 1H Total Goals, 1H BTTS).
 *
 * Modelo: Poisson sub-rate aplicado às lambdas do trained model.
 * Empírico (top-5 leagues): ~42% dos gols totais saem na 1ª metade
 *   (resto 58% na 2H — fadiga + ajustes táticos no intervalo).
 *
 * Math:
 *   λ_1H_home = 0.42 × λ_full_home
 *   λ_1H_away = 0.42 × λ_full_away
 *   matrix 1H = Poisson(λ_1H_home) × Poisson(λ_1H_away)
 *
 * Markets derivados:
 *   1H ML        — pH_1H / pD_1H / pA_1H
 *   1H totals    — over/under 0.5 / 1.5 / 2.5
 *   1H BTTS      — yes / no
 *
 * Convention:
 *   sub-rate env override: FB_1H_SUBRATE (default 0.42)
 *
 * Shadow-only por default (FB_1H_SHADOW=true).
 *
 * Caller protocol:
 *   const { scanFootball1HMarkets } = require('./football-1h-model');
 *   const tips = scanFootball1HMarkets({
 *     pinMarkets1H,                  // { ml: {home, draw, away}, totals: [], btts: {yes, no} }
 *     lamH, lamA,                    // λ full do trained Poisson (não 1H)
 *     minEv, maxEv, minPmodel,
 *     minOdd, maxOdd,
 *   });
 */

function _poissonPmf(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

function _poissonCdf(lambda, k) {
  let s = 0;
  for (let i = 0; i <= k; i++) s += _poissonPmf(lambda, i);
  return Math.min(1, s);
}

function _poissonMatrix(lamH, lamA, maxGoals = 6) {
  const matrix = [];
  for (let i = 0; i <= maxGoals; i++) {
    matrix[i] = [];
    for (let j = 0; j <= maxGoals; j++) {
      matrix[i][j] = _poissonPmf(lamH, i) * _poissonPmf(lamA, j);
    }
  }
  return matrix;
}

function _ev(pModel, odd) {
  if (!Number.isFinite(pModel) || !Number.isFinite(odd) || odd <= 1) return null;
  return (pModel * odd - 1) * 100;
}

function _envFloat(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

/**
 * Compute 1H probabilities from full-game lambdas.
 * @returns {{pH, pD, pA, lamH1H, lamA1H, totals: {0.5,1.5,2.5: {over,under}}, btts: {yes,no}}}
 */
function compute1HProbs(lamH, lamA) {
  const subRate = _envFloat('FB_1H_SUBRATE', 0.42);
  const lamH1H = Math.max(0.05, lamH * subRate);
  const lamA1H = Math.max(0.05, lamA * subRate);

  // Matrix 1H pra ML
  const mat = _poissonMatrix(lamH1H, lamA1H, 5);
  let pH = 0, pD = 0, pA = 0;
  for (let i = 0; i < mat.length; i++) {
    for (let j = 0; j < mat[i].length; j++) {
      if (i > j) pH += mat[i][j];
      else if (i === j) pD += mat[i][j];
      else pA += mat[i][j];
    }
  }
  const total = pH + pD + pA;
  if (total > 0) { pH /= total; pD /= total; pA /= total; }

  // Totals: λ_total_1H = λH_1H + λA_1H (soma de Poissons é Poisson com soma lambdas)
  const lamTotal1H = lamH1H + lamA1H;
  const totals = {};
  for (const line of [0.5, 1.5, 2.5]) {
    const kFloor = Math.floor(line);
    const under = _poissonCdf(lamTotal1H, kFloor);
    const over = 1 - under;
    totals[line.toFixed(1)] = {
      over: +over.toFixed(4),
      under: +under.toFixed(4),
    };
  }

  // BTTS 1H: ambos times marcam na 1H
  // P(both score) = (1 - P(home=0)) × (1 - P(away=0))
  const pHomeScores = 1 - _poissonPmf(lamH1H, 0);
  const pAwayScores = 1 - _poissonPmf(lamA1H, 0);
  const bttsYes = pHomeScores * pAwayScores;
  const bttsNo = 1 - bttsYes;

  return {
    pH: +pH.toFixed(4), pD: +pD.toFixed(4), pA: +pA.toFixed(4),
    lamH1H: +lamH1H.toFixed(3), lamA1H: +lamA1H.toFixed(3),
    totals,
    btts: { yes: +bttsYes.toFixed(4), no: +bttsNo.toFixed(4) },
  };
}

/**
 * Scanner principal — compara probs 1H modeladas vs Pinnacle 1H markets.
 *
 * @param {object} args
 * @param {object} args.pinMarkets1H   { ml: {oddsHome, oddsDraw, oddsAway}, totals: [{line, oddsOver, oddsUnder}], btts: {oddsYes, oddsNo}, swap }
 * @param {number} args.lamH           λ full home (trained Poisson)
 * @param {number} args.lamA           λ full away
 * @param {number} [args.minEv=5]
 * @param {number} [args.maxEv=30]
 * @param {number} [args.minPmodel=0.40]
 * @param {number} [args.minOdd=1.50]
 * @param {number} [args.maxOdd=5.00]
 * @param {number} [args.maxPerMatch=3]
 * @returns {Array} tips
 */
function scanFootball1HMarkets({
  pinMarkets1H,
  lamH, lamA,
  minEv = _envFloat('FB_1H_MIN_EV', 5),
  maxEv = _envFloat('FB_1H_MAX_EV', 30),
  minPmodel = _envFloat('FB_1H_MIN_PMODEL', 0.40),
  minOdd = _envFloat('FB_1H_MIN_ODD', 1.50),
  maxOdd = _envFloat('FB_1H_MAX_ODD', 5.00),
  maxPerMatch = parseInt(process.env.FB_1H_MAX_PER_MATCH || '3', 10),
} = {}) {
  if (!pinMarkets1H || !Number.isFinite(lamH) || !Number.isFinite(lamA)) return [];
  const swap = !!pinMarkets1H.swap;
  const probs = compute1HProbs(lamH, lamA);
  const tips = [];
  const oddOk = (o) => Number.isFinite(o) && o >= minOdd && o <= maxOdd;

  // ── 1H ML (home/draw/away) ──
  const ml = pinMarkets1H.ml || {};
  const oddH = Number(swap ? ml.oddsAway : ml.oddsHome);
  const oddD = Number(ml.oddsDraw);
  const oddA = Number(swap ? ml.oddsHome : ml.oddsAway);
  const evH = _ev(probs.pH, oddH);
  const evD = _ev(probs.pD, oddD);
  const evA = _ev(probs.pA, oddA);
  if (Number.isFinite(evH) && evH >= minEv && evH <= maxEv && probs.pH >= minPmodel && oddOk(oddH)) {
    tips.push({ market: '1h_ml', line: 0, side: 'home', pModel: probs.pH, pImplied: +(1/oddH).toFixed(4), odd: +oddH.toFixed(3), ev: +evH.toFixed(2), label: '1H Home' });
  }
  if (Number.isFinite(evD) && evD >= minEv && evD <= maxEv && probs.pD >= minPmodel && oddOk(oddD)) {
    tips.push({ market: '1h_ml', line: 0, side: 'draw', pModel: probs.pD, pImplied: +(1/oddD).toFixed(4), odd: +oddD.toFixed(3), ev: +evD.toFixed(2), label: '1H Draw' });
  }
  if (Number.isFinite(evA) && evA >= minEv && evA <= maxEv && probs.pA >= minPmodel && oddOk(oddA)) {
    tips.push({ market: '1h_ml', line: 0, side: 'away', pModel: probs.pA, pImplied: +(1/oddA).toFixed(4), odd: +oddA.toFixed(3), ev: +evA.toFixed(2), label: '1H Away' });
  }

  // ── 1H Totals (0.5 / 1.5 / 2.5) ──
  const totals = Array.isArray(pinMarkets1H.totals) ? pinMarkets1H.totals : [];
  for (const t of totals) {
    const line = Number(t.line);
    if (!Number.isFinite(line)) continue;
    const k = line.toFixed(1);
    const probs1H = probs.totals[k];
    if (!probs1H) continue;
    const oddOver = Number(t.oddsOver);
    const oddUnder = Number(t.oddsUnder);
    const evOver = _ev(probs1H.over, oddOver);
    const evUnder = _ev(probs1H.under, oddUnder);
    if (Number.isFinite(evOver) && evOver >= minEv && evOver <= maxEv && probs1H.over >= minPmodel && oddOk(oddOver)) {
      tips.push({ market: '1h_totals', line, side: 'over', pModel: probs1H.over, pImplied: +(1/oddOver).toFixed(4), odd: +oddOver.toFixed(3), ev: +evOver.toFixed(2), label: `1H Over ${k}` });
    }
    if (Number.isFinite(evUnder) && evUnder >= minEv && evUnder <= maxEv && probs1H.under >= minPmodel && oddOk(oddUnder)) {
      tips.push({ market: '1h_totals', line, side: 'under', pModel: probs1H.under, pImplied: +(1/oddUnder).toFixed(4), odd: +oddUnder.toFixed(3), ev: +evUnder.toFixed(2), label: `1H Under ${k}` });
    }
  }

  // ── 1H BTTS ──
  const btts = pinMarkets1H.btts || {};
  const oddBttsY = Number(btts.oddsYes);
  const oddBttsN = Number(btts.oddsNo);
  const evBttsY = _ev(probs.btts.yes, oddBttsY);
  const evBttsN = _ev(probs.btts.no, oddBttsN);
  if (Number.isFinite(evBttsY) && evBttsY >= minEv && evBttsY <= maxEv && probs.btts.yes >= minPmodel && oddOk(oddBttsY)) {
    tips.push({ market: '1h_btts', line: 0, side: 'yes', pModel: probs.btts.yes, pImplied: +(1/oddBttsY).toFixed(4), odd: +oddBttsY.toFixed(3), ev: +evBttsY.toFixed(2), label: '1H BTTS Yes' });
  }
  if (Number.isFinite(evBttsN) && evBttsN >= minEv && evBttsN <= maxEv && probs.btts.no >= minPmodel && oddOk(oddBttsN)) {
    tips.push({ market: '1h_btts', line: 0, side: 'no', pModel: probs.btts.no, pImplied: +(1/oddBttsN).toFixed(4), odd: +oddBttsN.toFixed(3), ev: +evBttsN.toFixed(2), label: '1H BTTS No' });
  }

  // Sort by EV, cap per match
  const sorted = tips.sort((a, b) => (b.ev || 0) - (a.ev || 0));
  if (Number.isFinite(maxPerMatch) && maxPerMatch > 0 && sorted.length > maxPerMatch) {
    return sorted.slice(0, maxPerMatch);
  }
  return sorted;
}

module.exports = { scanFootball1HMarkets, compute1HProbs };
