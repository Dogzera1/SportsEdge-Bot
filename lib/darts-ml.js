/**
 * darts-ml.js — Pré-filtro ML para darts.
 *
 * Sinal principal: 3-dart average differential (equivalente ao xG).
 * Sinais secundários: recent form (win rate últimos N), checkout % em eventos recentes.
 *
 * Calibração: 3-dart avg diff de 5 pontos ≈ 15pp de edge em P de vitória.
 * Essa heurística é conservadora — validar no shadow mode nos primeiros 30 tips.
 */

/**
 * @param {Object} match       — { team1, team2, odds: {t1,t2} }
 * @param {Object} enrich      — { avgP1, avgP2, winRateP1, winRateP2 }
 * @returns {{ pass, direction, score, modelP1, modelP2, impliedP1, impliedP2, factorCount }}
 */
function dartsPreFilter(match, enrich) {
  const o1 = parseFloat(match?.odds?.t1);
  const o2 = parseFloat(match?.odds?.t2);
  if (!o1 || !o2 || o1 <= 1 || o2 <= 1) {
    return { pass: false, direction: null, score: 0, modelP1: 0, modelP2: 0, impliedP1: 0, impliedP2: 0, factorCount: 0 };
  }

  const r1 = 1 / o1, r2 = 1 / o2;
  const vig = r1 + r2;
  const impliedP1 = r1 / vig;
  const impliedP2 = r2 / vig;

  const avgP1 = Number(enrich?.avgP1);
  const avgP2 = Number(enrich?.avgP2);
  const wrP1  = Number(enrich?.winRateP1);
  const wrP2  = Number(enrich?.winRateP2);

  let factorCount = 0;
  let adjustP1 = 0; // shift sobre implied para formar modelP1

  // ── Fator 1: 3-dart avg differential (peso alto, similar xG) ──
  if (Number.isFinite(avgP1) && Number.isFinite(avgP2) && avgP1 > 0 && avgP2 > 0) {
    const diff = avgP1 - avgP2;
    // 1 ponto de avg diff ≈ 3pp de edge em P (empírico conservador).
    // Saturação em ±10 pontos → ±30pp máx do fator 1.
    const clamped = Math.max(-10, Math.min(10, diff));
    adjustP1 += clamped * 0.03;
    factorCount++;
  }

  // ── Fator 2: win rate recente diferencial ──
  if (Number.isFinite(wrP1) && Number.isFinite(wrP2)) {
    const wrDiff = (wrP1 - wrP2) / 100; // em fração
    // Saturação em ±40% de WR diff → ±8pp max (peso menor)
    const clamped = Math.max(-0.4, Math.min(0.4, wrDiff));
    adjustP1 += clamped * 0.2;
    factorCount++;
  }

  // Modelo: shift limitado em torno do implied para evitar overshoot
  const totalAdjustCap = 0.15; // ±15pp max sobre implied
  const adjClamped = Math.max(-totalAdjustCap, Math.min(totalAdjustCap, adjustP1));
  let modelP1 = impliedP1 + adjClamped;
  modelP1 = Math.max(0.05, Math.min(0.95, modelP1));
  const modelP2 = 1 - modelP1;

  // Edge em pontos percentuais (model vs implied), pega o lado com maior edge
  const edgeP1 = (modelP1 - impliedP1) * 100;
  const edgeP2 = (modelP2 - impliedP2) * 100;
  const score = Math.max(edgeP1, edgeP2);
  const direction = edgeP1 >= edgeP2 ? 't1' : 't2';

  // Threshold: 4.0pp com 2 fatores, 5.0pp com 1 fator (mais conservador)
  const minEdge = factorCount >= 2 ? 4.0 : 5.0;
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

module.exports = { dartsPreFilter };
