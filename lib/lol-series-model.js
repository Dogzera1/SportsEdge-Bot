'use strict';

/**
 * lol-series-model.js — Conversões entre probabilidade de mapa e série,
 * simulação Monte Carlo de BO3/BO5 com momentum, e shrinkage BO1.
 *
 * Motivação:
 *   - `getLolProbability` devolve P de série (Elo treinado em resultados de série).
 *   - Para mercados de mapa individual ou para modelar momentum entre mapas,
 *     precisamos separar o mapa da série e simular a série a partir do mapa.
 *   - BO1 tem variância alta; modelo puxado pra 0.5 evita overconfidence.
 *
 * Momentum calibrado: 0.03 (via scripts/calibrate-lol-momentum.js em 2026-04-18,
 * 662 séries BO3/BO5 de test, LRT χ²=5.39 vs momentum=0, p<0.05).
 */

const LOL_MOMENTUM_DEFAULT = 0.03;

/**
 * Simula probabilidade de série a partir de probabilidade por mapa.
 * Com momentum=0 usa fórmula fechada (binomial). Com momentum>0 roda Monte Carlo.
 *
 * @param {number} pMap       P(team1 vence um mapa). Em [0,1].
 * @param {number} bestOf     1, 3 ou 5.
 * @param {object} [opts]
 * @param {number} [opts.momentum=0]  Boost aditivo no pMap do vencedor do mapa anterior (ex.: 0.03).
 * @param {number} [opts.iterations=20000] Monte Carlo iterations quando momentum>0.
 * @returns {number} P(team1 vence a série), em [0,1].
 */
function seriesProbFromMap(pMap, bestOf, opts = {}) {
  const p = clamp01(pMap);
  const bo = Number(bestOf) || 1;
  const momentum = Number(opts.momentum) || 0;

  if (bo <= 1) return p;

  if (momentum === 0) {
    return closedFormSeriesProb(p, bo);
  }

  const iters = Math.max(1000, Number(opts.iterations) || 20000);
  return monteCarloSeries(p, bo, momentum, iters);
}

/**
 * Inverso de seriesProbFromMap com momentum=0. Dado P de série, devolve o pMap
 * que a geraria sob independência. Bisection — monotônico em pMap.
 *
 * @param {number} pSeries
 * @param {number} bestOf
 * @returns {number} pMap correspondente.
 */
function mapProbFromSeries(pSeries, bestOf) {
  const ps = clamp01(pSeries);
  const bo = Number(bestOf) || 1;
  if (bo <= 1) return ps;

  let lo = 0.001, hi = 0.999;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const s = closedFormSeriesProb(mid, bo);
    if (s < ps) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Regression-to-mean pra séries curtas. Puxa P de volta pra 0.5 proporcional
 * ao ruído esperado do formato. Valores default empíricos — revisar após backtest.
 *
 * @param {number} p
 * @param {number} bestOf
 * @returns {number}
 */
function shrinkForBestOf(p, bestOf) {
  const bo = Number(bestOf) || 1;
  let factor;
  if (bo <= 1) factor = 0.85;
  else if (bo === 3) factor = 0.95;
  else factor = 1.0;
  return 0.5 + (clamp01(p) - 0.5) * factor;
}

// ── internals ─────────────────────────────────────────────────────────────

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// Probabilidade de vencer "first-to-N" com pMap constante (mapas independentes).
// BO3 → first to 2. BO5 → first to 3.
function closedFormSeriesProb(p, bo) {
  const winsNeeded = Math.ceil(bo / 2);
  const q = 1 - p;
  // Σ C(winsNeeded-1+k, k) * p^winsNeeded * q^k, k=0..winsNeeded-1
  let sum = 0;
  for (let k = 0; k < winsNeeded; k++) {
    sum += binomial(winsNeeded - 1 + k, k) * Math.pow(p, winsNeeded) * Math.pow(q, k);
  }
  return sum;
}

function binomial(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let c = 1;
  for (let i = 0; i < k; i++) c = c * (n - i) / (i + 1);
  return c;
}

// Monte Carlo com momentum aditivo no vencedor do mapa anterior.
function monteCarloSeries(pBase, bo, momentum, iters) {
  const winsNeeded = Math.ceil(bo / 2);
  let t1Series = 0;
  for (let it = 0; it < iters; it++) {
    let w1 = 0, w2 = 0;
    let lastWinner = 0; // 0 = nenhum, 1 = team1, 2 = team2
    while (w1 < winsNeeded && w2 < winsNeeded) {
      let pThisMap = pBase;
      if (lastWinner === 1) pThisMap += momentum;
      else if (lastWinner === 2) pThisMap -= momentum;
      if (pThisMap < 0.05) pThisMap = 0.05;
      else if (pThisMap > 0.95) pThisMap = 0.95;

      if (Math.random() < pThisMap) { w1++; lastWinner = 1; }
      else { w2++; lastWinner = 2; }
    }
    if (w1 === winsNeeded) t1Series++;
  }
  return t1Series / iters;
}

/**
 * Monte Carlo pra série LIVE: combina P(mapa atual) + P(mapas restantes) + state atual.
 *
 * Usa `pMapCurrent` pro mapa em andamento (reflete gold diff, live stats)
 * e `pMapBase` pros mapas futuros (pré-match baseline). Momentum opcional
 * entre mapas.
 *
 * @param {object} args
 * @param {number} args.pMapCurrent — P(team1 vence mapa atual), derivado de live stats
 * @param {number} args.pMapBase    — P(team1 vence mapa em vacuum), pré-match
 * @param {number} args.bestOf      — 1, 3 ou 5
 * @param {number} [args.setsA=0]   — sets vencidos por team1 ANTES do mapa atual
 * @param {number} [args.setsB=0]   — sets vencidos por team2 ANTES do mapa atual
 * @param {number} [args.momentum=0]
 * @param {number} [args.iters=10000]
 * @returns {number} P(team1 vence a série)
 */
function priceSeriesFromLiveMap({ pMapCurrent, pMapBase, bestOf = 3, setsA = 0, setsB = 0, momentum = 0, iters = 10000 }) {
  const pCur = clamp01(pMapCurrent);
  const pBase = clamp01(pMapBase != null ? pMapBase : pMapCurrent);
  const bo = Number(bestOf) || 1;
  const winsNeeded = Math.ceil(bo / 2);
  const initA = Math.max(0, Number(setsA) || 0);
  const initB = Math.max(0, Number(setsB) || 0);

  // Terminal cases
  if (initA >= winsNeeded) return 1;
  if (initB >= winsNeeded) return 0;

  let team1Series = 0;
  for (let it = 0; it < iters; it++) {
    let a = initA, b = initB;
    // 1. Simula mapa atual com pMapCurrent
    const curWinA = Math.random() < pCur;
    if (curWinA) a++; else b++;
    let lastWinA = curWinA;

    // 2. Mapas restantes com pMapBase + momentum
    while (a < winsNeeded && b < winsNeeded) {
      let p = pBase;
      if (momentum) p += (lastWinA ? momentum : -momentum);
      if (p < 0.05) p = 0.05;
      else if (p > 0.95) p = 0.95;
      const w = Math.random() < p;
      if (w) a++; else b++;
      lastWinA = w;
    }
    if (a >= winsNeeded) team1Series++;
  }
  return team1Series / iters;
}

module.exports = {
  seriesProbFromMap,
  mapProbFromSeries,
  shrinkForBestOf,
  priceSeriesFromLiveMap,
  LOL_MOMENTUM_DEFAULT,
  // exposto pra teste
  _closedFormSeriesProb: closedFormSeriesProb,
};
