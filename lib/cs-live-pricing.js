'use strict';

/**
 * cs-live-pricing.js — pricing live-aware pra CS2 (handicap + total maps).
 *
 * Calcula distribuição de placares FINAIS condicionada ao placar atual da
 * série. Assume independência de maps (Markov pMap constante). Permite
 * pricing CS2 reagir ao estado in-play.
 *
 * Gap fechado (audit 2026-05-12): CS MT live shadow emite tips mas nenhuma
 * promovida pra real porque pMap pre-game stale durante live → pModel boundary
 * fica preso ~0.55 → falha gate CS_MARKET_TIP_MIN_PMODEL=0.55.
 *
 * Math: dada série Bo(N) e current score (s1, s2):
 *   - team1 wins série em final (N, s2+k) com k ∈ [0, t2Needed-1]
 *     probPath = C(t1Needed-1+k, k) * pMap^t1Needed * (1-pMap)^k
 *   - team2 wins série em final (s1+k, N) com k ∈ [0, t1Needed-1]
 *     probPath = C(t2Needed-1+k, k) * pMap^k * (1-pMap)^t2Needed
 *
 * Validation: pre-game (0,0) Bo3 pMap=0.55 → P(2-0)=0.3025 == pMap².
 * Live (1,0) Bo3 pMap=0.55 → P(2-0)=0.55 = pMap. ✓
 *
 * Interface compatível com lol-markets pra plug-and-play em scanMarkets.
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
 * Distribuição de placares FINAIS condicionada ao placar atual.
 *
 * @param {number} pMap   P(team1 vence próximo mapa)
 * @param {number} bestOf 1, 3 ou 5
 * @param {object} opts   { score1, score2 } — placar atual (default 0,0)
 * @returns {Record<string, number>}
 */
function mapScoreDistribution(pMap, bestOf, opts = {}) {
  const p = _clamp01(pMap);
  const q = 1 - p;
  const bo = Number(bestOf) || 1;
  const score1 = Math.max(0, Number(opts.score1) || 0);
  const score2 = Math.max(0, Number(opts.score2) || 0);

  if (bo <= 1) {
    if (score1 >= 1) return { '1-0': 1 };
    if (score2 >= 1) return { '0-1': 1 };
    return { '1-0': p, '0-1': q };
  }

  const N = Math.ceil(bo / 2);
  const t1Needed = N - score1;
  const t2Needed = N - score2;

  // Edge cases: série já decidida ou inválida.
  if (t1Needed <= 0 && t2Needed <= 0) return {};
  if (t1Needed <= 0) return { [`${N}-${score2}`]: 1 };
  if (t2Needed <= 0) return { [`${score1}-${N}`]: 1 };

  const out = {};
  // team1 wins série: needs t1Needed mais; team2 gets 0..t2Needed-1 maps adicionais
  for (let k = 0; k < t2Needed; k++) {
    const finalT2 = score2 + k;
    // Path: nos próximos (t1Needed-1 + k) maps, team2 wins exatamente k;
    // último map team1 wins (locks série).
    const n = t1Needed - 1 + k;
    const probPath = _binomial(n, k) * Math.pow(p, t1Needed) * Math.pow(q, k);
    out[`${N}-${finalT2}`] = probPath;
  }
  // team2 wins série: symmetric
  for (let k = 0; k < t1Needed; k++) {
    const finalT1 = score1 + k;
    const n = t2Needed - 1 + k;
    const probPath = _binomial(n, k) * Math.pow(p, k) * Math.pow(q, t2Needed);
    out[`${finalT1}-${N}`] = probPath;
  }
  return out;
}

function handicapProb(pMap, bestOf, line, opts = {}) {
  const dist = mapScoreDistribution(pMap, bestOf, opts);
  const L = Number(line);
  if (!Number.isFinite(L)) return { team1: NaN, team2: NaN };
  let pTeam1 = 0;
  for (const [label, prob] of Object.entries(dist)) {
    const [s1, s2] = label.split('-').map(Number);
    if ((s1 - s2) + L > 0) pTeam1 += prob;
  }
  return { team1: pTeam1, team2: 1 - pTeam1 };
}

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

function seriesWinProb(pMap, bestOf, opts = {}) {
  const dist = mapScoreDistribution(pMap, bestOf, opts);
  const N = Math.ceil(Number(bestOf) / 2);
  let p = 0;
  for (const [label, prob] of Object.entries(dist)) {
    const [s1] = label.split('-').map(Number);
    if (s1 === N) p += prob;
  }
  return p;
}

module.exports = { mapScoreDistribution, handicapProb, totalMapsProb, seriesWinProb };
