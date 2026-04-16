/**
 * darts-ml.js — Pré-filtro ML para darts.
 *
 * Sinais (em ordem de peso):
 *   1. 3-dart avg differential (xG equivalente) — escala conservadora 0.02 × diff
 *   2. Win rate recente diferencial — 0.15 × diff
 *   3. Checkout % diferencial (finalizador) — 0.10 × diff
 *
 * Ponderação por sample size:
 *   - Cada sinal é atenuado se o jogador tem poucos jogos (< 5) — amostra pequena = ruído
 *   - Fator de confiança: min(games, 10) / 10  → 1.0 = sample completo; 0.3 = 3 jogos
 *
 * Calibração revisada (abr/2026):
 *   - Escala 3DA reduzida de 0.03 → 0.02 (era agressiva demais)
 *   - Cap total mantido em ±15pp sobre implied (evita overshoot)
 *   - Gate: 4pp com 2+ fatores, 5pp com 1 fator
 */

function _sampleConfidence(games) {
  if (!Number.isFinite(games) || games <= 0) return 0;
  return Math.min(1.0, games / 10);
}

/**
 * @param {Object} match   — { team1, team2, odds: {t1,t2} }
 * @param {Object} enrich  — {
 *   avgP1, avgP2,               // 3-dart avg últimos N jogos
 *   winRateP1, winRateP2,       // %
 *   gamesP1, gamesP2,           // sample size (para ponderação)
 *   checkoutP1, checkoutP2,     // checkout % (opcional)
 *   h2hP1Wins, h2hP2Wins        // H2H Sofascore últimos 30 matches (opcional)
 * }
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
  const gP1   = Number(enrich?.gamesP1);
  const gP2   = Number(enrich?.gamesP2);
  const coP1  = Number(enrich?.checkoutP1);
  const coP2  = Number(enrich?.checkoutP2);

  // Confiança do sample: média da confiança dos dois jogadores
  // Quando um dos dois tem poucos jogos, atenua todos os sinais estatísticos
  const conf = (_sampleConfidence(gP1) + _sampleConfidence(gP2)) / 2 || 0.5;

  let factorCount = 0;
  let adjustP1 = 0;

  // ── Fator 1: 3-dart avg differential ──
  // Escala 0.02 (era 0.03) — mais conservadora. 5pts diff → 10pp shift bruto × confiança.
  // Saturação em ±10 pontos → ±20pp bruto máximo (fica no cap total de 15pp).
  if (Number.isFinite(avgP1) && Number.isFinite(avgP2) && avgP1 > 0 && avgP2 > 0) {
    const diff = avgP1 - avgP2;
    const clamped = Math.max(-10, Math.min(10, diff));
    adjustP1 += clamped * 0.02 * conf;
    factorCount++;
  }

  // ── Fator 2: win rate recente diferencial ──
  // 0.15 × wrDiff. Saturação ±40% → ±6pp bruto × conf.
  if (Number.isFinite(wrP1) && Number.isFinite(wrP2)) {
    const wrDiff = (wrP1 - wrP2) / 100;
    const clamped = Math.max(-0.4, Math.min(0.4, wrDiff));
    adjustP1 += clamped * 0.15 * conf;
    factorCount++;
  }

  // ── Fator 3: checkout % diferencial (finalizador em momento crítico) ──
  // Peso baixo mas independente: bom checkout ganha legs apertadas.
  // Saturação ±20% → ±2pp.
  if (Number.isFinite(coP1) && Number.isFinite(coP2)) {
    const coDiff = (coP1 - coP2) / 100;
    const clamped = Math.max(-0.2, Math.min(0.2, coDiff));
    adjustP1 += clamped * 0.10 * conf;
    factorCount++;
  }

  // ── Fator 4: H2H histórico (Sofascore últimos ~30 matches) ──
  // Requer ≥5 matches (alinhado com snooker; <5 tem bias de amostra pequena).
  // Peso conservador (0.10) × confiança amostra. Saturação em ±0.3 bias → ±3pp bruto máximo.
  const h2hP1 = Number(enrich?.h2hP1Wins);
  const h2hP2 = Number(enrich?.h2hP2Wins);
  if (Number.isFinite(h2hP1) && Number.isFinite(h2hP2) && (h2hP1 + h2hP2) >= 5) {
    const totalH2H = h2hP1 + h2hP2;
    const h2hBias = (h2hP1 / totalH2H) - 0.5; // -0.5..+0.5
    const clamped = Math.max(-0.3, Math.min(0.3, h2hBias));
    const h2hConf = Math.min(1.0, totalH2H / 10); // satura em 10 matches
    adjustP1 += clamped * 0.10 * h2hConf;
    factorCount++;
  }

  // Cap total ±15pp sobre implied (invariante — evita overshoot acumulado)
  const totalAdjustCap = 0.15;
  const adjClamped = Math.max(-totalAdjustCap, Math.min(totalAdjustCap, adjustP1));
  let modelP1 = impliedP1 + adjClamped;
  modelP1 = Math.max(0.05, Math.min(0.95, modelP1));
  const modelP2 = 1 - modelP1;

  const edgeP1 = (modelP1 - impliedP1) * 100;
  const edgeP2 = (modelP2 - impliedP2) * 100;
  const score = Math.max(edgeP1, edgeP2);
  const direction = edgeP1 >= edgeP2 ? 't1' : 't2';

  // Threshold adaptativo: sample pequeno exige edge maior
  // conf >= 0.7 (jogadores com ≥7 jogos): gate normal
  // conf < 0.7: gate +1pp (compensa incerteza)
  const confPenalty = conf < 0.7 ? 1.0 : 0;
  const minEdge = (factorCount >= 2 ? 4.0 : 5.0) + confPenalty;
  const pass = score >= minEdge && factorCount >= 1;

  return {
    pass,
    direction,
    score: +score.toFixed(2),
    modelP1: +modelP1.toFixed(4),
    modelP2: +modelP2.toFixed(4),
    impliedP1: +impliedP1.toFixed(4),
    impliedP2: +impliedP2.toFixed(4),
    factorCount,
    sampleConfidence: +conf.toFixed(2),
  };
}

module.exports = { dartsPreFilter };
