/**
 * snooker-ml.js — Pré-filtro ML para snooker.
 *
 * Sinais:
 *   1. Ranking diff (via snooker.org ou fallback manual) — peso principal
 *   2. Form recente (últimas N vitórias/derrotas) — secundário
 *
 * Snooker não tem equivalente ao 3-dart avg — ranking oficial é o sinal mais
 * limpo disponível sem scraping (centuries % exigiria CueTracker).
 */

/**
 * @param {Object} match    — { team1, team2, odds: {t1,t2} }
 * @param {Object} enrich   — { rankP1, rankP2, winRateP1, winRateP2 }
 * @returns {{ pass, direction, score, modelP1, modelP2, impliedP1, impliedP2, factorCount }}
 */
function snookerPreFilter(match, enrich) {
  const o1 = parseFloat(match?.odds?.t1);
  const o2 = parseFloat(match?.odds?.t2);
  if (!o1 || !o2 || o1 <= 1 || o2 <= 1) {
    return { pass: false, direction: null, score: 0, modelP1: 0, modelP2: 0, impliedP1: 0, impliedP2: 0, factorCount: 0 };
  }

  const r1 = 1 / o1, r2 = 1 / o2;
  const vig = r1 + r2;
  const impliedP1 = r1 / vig;
  const impliedP2 = r2 / vig;

  const rkP1 = Number(enrich?.rankP1);
  const rkP2 = Number(enrich?.rankP2);
  const wrP1 = Number(enrich?.winRateP1);
  const wrP2 = Number(enrich?.winRateP2);

  let factorCount = 0;
  let adjustP1 = 0;

  // ── Fator 1: ranking diff ──
  // Ranking snooker vai de 1 (top) até ~128. Diff logarítmico é mais realista
  // que linear (diferença entre rank 1 e 5 >>> rank 50 e 54).
  if (Number.isFinite(rkP1) && Number.isFinite(rkP2) && rkP1 > 0 && rkP2 > 0) {
    // Diff log: rk melhor (menor) favorece. Cap em ±2.0 (rank 1 vs rank ~60)
    const logDiff = Math.log(rkP2) - Math.log(rkP1); // positivo se P1 ranking melhor
    const clamped = Math.max(-2.0, Math.min(2.0, logDiff));
    // Escala: log diff 1.0 (≈ rank 10 vs 27) ≈ 8pp de shift
    adjustP1 += clamped * 0.08;
    factorCount++;
  }

  // ── Fator 2: win rate recente ──
  if (Number.isFinite(wrP1) && Number.isFinite(wrP2)) {
    const wrDiff = (wrP1 - wrP2) / 100;
    const clamped = Math.max(-0.4, Math.min(0.4, wrDiff));
    adjustP1 += clamped * 0.2;
    factorCount++;
  }

  // Shift limitado a ±15pp sobre implied
  const cap = 0.15;
  const adj = Math.max(-cap, Math.min(cap, adjustP1));
  let modelP1 = impliedP1 + adj;
  modelP1 = Math.max(0.05, Math.min(0.95, modelP1));
  const modelP2 = 1 - modelP1;

  const edgeP1 = (modelP1 - impliedP1) * 100;
  const edgeP2 = (modelP2 - impliedP2) * 100;
  const score = Math.max(edgeP1, edgeP2);
  const direction = edgeP1 >= edgeP2 ? 't1' : 't2';

  // Threshold: snooker tem overround maior e variação menor → 5pp com 2 fatores
  const minEdge = factorCount >= 2 ? 5.0 : 6.0;
  const pass = score >= minEdge && factorCount >= 1;

  return {
    pass,
    direction,
    score: +score.toFixed(2),
    modelP1: +modelP1.toFixed(4),
    modelP2: +modelP2.toFixed(4),
    impliedP1: +impliedP1.toFixed(4),
    impliedP2: +impliedP2.toFixed(4),
    factorCount
  };
}

module.exports = { snookerPreFilter };
