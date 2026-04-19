'use strict';

/**
 * lol-markets.js — Pricing de mercados específicos de LoL a partir de pMap.
 *
 * Mercados suportados (BO3 e BO5):
 *   - Match winner (moneyline da série)
 *   - Map handicap (-1.5, +1.5, -2.5, +2.5)
 *   - Total de mapas (over/under 2.5 pra BO3; 3.5 e 4.5 pra BO5)
 *   - Correct score (exato 2-0, 2-1, 3-0, 3-1, 3-2)
 *
 * Assumindo independência entre mapas (closed-form binomial first-to-N).
 * Pra modelar momentum, usar seriesProbFromMap do lol-series-model.js com
 * momentum>0 (Monte Carlo).
 *
 * Distribuição dos placares (first-to-N):
 *   P(N-k) = C(N-1+k, k) * p^N * q^k     k = 0..N-1
 *   BO3 (N=2): P(2-0)=p², P(2-1)=2p²q, P(1-2)=2pq², P(0-2)=q²
 *   BO5 (N=3): P(3-0)=p³, P(3-1)=3p³q, P(3-2)=6p³q²,
 *              P(2-3)=6p²q³, P(1-3)=3pq³, P(0-3)=q³
 *
 * Uso:
 *   const { handicapProb, totalMapsProb, mapScoreDistribution } = require('./lol-markets');
 *   const { over, under } = totalMapsProb(0.6, 3, 2.5);   // P(goes 3) / P(sweep)
 *   const { team1, team2 } = handicapProb(0.6, 3, -1.5);  // P(2-0 t1) / P(t2 wins ≥1)
 */

function _binomial(n, k) {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let c = 1;
  for (let i = 0; i < k; i++) c = c * (n - i) / (i + 1);
  return c;
}

function _clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

/**
 * Distribuição exata de placares finais da série.
 *
 * @param {number} pMap   P(team1 vence um mapa), [0,1]
 * @param {number} bestOf 1, 3 ou 5
 * @returns {Record<string, number>} ex: { '2-0': 0.36, '2-1': 0.29, '1-2': 0.19, '0-2': 0.16 }
 */
function mapScoreDistribution(pMap, bestOf, opts = {}) {
  const p = _clamp01(pMap);
  const q = 1 - p;
  const bo = Number(bestOf) || 1;
  const momentum = Number(opts.momentum) || 0;
  const iters = Number(opts.iters) || 8000;

  if (bo <= 1) {
    return { '1-0': p, '0-1': q };
  }

  // Momentum ativo → Monte Carlo. Binomial independente subestima spreads quando
  // vencer mapa 1 aumenta P(vencer mapa 2) (comum em Dota/CS por morale/momentum).
  if (momentum > 0) {
    const N = Math.ceil(bo / 2);
    const counts = {};
    for (let k = 0; k < N; k++) { counts[`${N}-${k}`] = 0; counts[`${k}-${N}`] = 0; }
    for (let it = 0; it < iters; it++) {
      let w1 = 0, w2 = 0, lastWinner = 0;
      while (w1 < N && w2 < N) {
        let pi = p;
        if (lastWinner === 1) pi += momentum;
        else if (lastWinner === 2) pi -= momentum;
        if (pi < 0.05) pi = 0.05; else if (pi > 0.95) pi = 0.95;
        if (Math.random() < pi) { w1++; lastWinner = 1; }
        else { w2++; lastWinner = 2; }
      }
      const key = w1 === N ? `${N}-${w2}` : `${w1}-${N}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    const out = {};
    for (const [k, c] of Object.entries(counts)) out[k] = c / iters;
    return out;
  }

  // Binomial closed-form (first-to-N)
  const N = Math.ceil(bo / 2);
  const out = {};
  for (let k = 0; k < N; k++) {
    out[`${N}-${k}`] = _binomial(N - 1 + k, k) * Math.pow(p, N) * Math.pow(q, k);
  }
  for (let k = 0; k < N; k++) {
    out[`${k}-${N}`] = _binomial(N - 1 + k, k) * Math.pow(q, N) * Math.pow(p, k);
  }
  return out;
}

/**
 * P(team1 vence a série) — sum da coluna "team1 wins" da dist.
 */
function seriesWinProb(pMap, bestOf) {
  const bo = Number(bestOf) || 1;
  if (bo <= 1) return _clamp01(pMap);
  const p = _clamp01(pMap);
  const q = 1 - p;
  const N = Math.ceil(bo / 2);
  let s = 0;
  for (let k = 0; k < N; k++) s += _binomial(N - 1 + k, k) * Math.pow(p, N) * Math.pow(q, k);
  return s;
}

/**
 * Map handicap. Convenção: linha negativa = time dá handicap (precisa ganhar por mais).
 *   -1.5 em BO3 = ganhar 2-0.
 *   +1.5 em BO3 = ganhar ou perder 1-2 (ao menos 1 mapa).
 *   -1.5 em BO5 = ganhar 3-0 ou 3-1.
 *   -2.5 em BO5 = ganhar 3-0.
 *   +1.5 em BO5 = ganhar ou perder por ≤2 (3-2, 2-3, ..., 0-3 excluído).
 *   +2.5 em BO5 = ganhar ou perder por ≤1 (3-2, 2-3 incluídos, 3-1 e 1-3 excluídos).
 *
 * @param {number} pMap
 * @param {number} bestOf
 * @param {number} line  handicap pro team1. Aceita ±0.5, ±1.5, ±2.5.
 * @returns {{ team1: number, team2: number }}
 */
function handicapProb(pMap, bestOf, line, opts = {}) {
  const dist = mapScoreDistribution(pMap, bestOf, opts);
  const L = Number(line);
  if (!Number.isFinite(L)) return { team1: NaN, team2: NaN };

  // Para cada placar "s1-s2", diff = s1 - s2. Team1 cobre handicap se diff + line > 0.
  // Usamos +0.5 / -0.5 / 1.5 / 2.5 (pushes são evitados com half-lines).
  let pTeam1 = 0;
  for (const [label, prob] of Object.entries(dist)) {
    const [s1, s2] = label.split('-').map(Number);
    if ((s1 - s2) + L > 0) pTeam1 += prob;
  }
  return { team1: pTeam1, team2: 1 - pTeam1 };
}

/**
 * Total de mapas over/under.
 *
 * @param {number} pMap
 * @param {number} bestOf
 * @param {number} line   ex: 2.5 (BO3), 3.5 / 4.5 (BO5)
 * @returns {{ over: number, under: number }}
 */
function totalMapsProb(pMap, bestOf, line, opts = {}) {
  const dist = mapScoreDistribution(pMap, bestOf, opts);
  const L = Number(line);
  if (!Number.isFinite(L)) return { over: NaN, under: NaN };
  let over = 0;
  for (const [label, prob] of Object.entries(dist)) {
    const [s1, s2] = label.split('-').map(Number);
    if ((s1 + s2) > L) over += prob;
  }
  return { over, under: 1 - over };
}

/**
 * Probabilidade exata de um placar específico.
 *
 * @param {number} pMap
 * @param {number} bestOf
 * @param {string} score  ex: '2-1', '3-0'
 * @returns {number}
 */
function exactScoreProb(pMap, bestOf, score) {
  const dist = mapScoreDistribution(pMap, bestOf);
  return dist[score] || 0;
}

/**
 * Placar mais provável + sua probabilidade.
 */
function mostLikelyScore(pMap, bestOf) {
  const dist = mapScoreDistribution(pMap, bestOf);
  let best = null, bestP = -1;
  for (const [label, p] of Object.entries(dist)) {
    if (p > bestP) { bestP = p; best = label; }
  }
  return { score: best, prob: bestP };
}

module.exports = {
  mapScoreDistribution,
  seriesWinProb,
  handicapProb,
  totalMapsProb,
  exactScoreProb,
  mostLikelyScore,
};
