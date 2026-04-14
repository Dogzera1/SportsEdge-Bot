/**
 * snooker-ml.js — Pré-filtro ML para snooker.
 *
 * Sinais:
 *   1. Ranking diff (via snooker.org — placeholder, pendente aprovação)
 *   2. Win rate recente (via CueTracker scraping — ATIVO)
 *   3. Centuries % (via CueTracker — opcional quando disponível)
 *
 * Ponderação por sample size:
 *   Jogadores com menos de 20 jogos na temporada têm seu WR atenuado.
 *   Ex: Jun Jiang (0 jogos) não contribui — seu WR é NaN → fator ignorado.
 *
 * Calibração revisada (abr/2026):
 *   - Peso WR aumentado de 0.2 → 0.25 × conf (CueTracker é sinal limpo)
 *   - Sample ponderação evita distorção de jogadores sem histórico
 *   - Gate reduzido: 4pp com 2 fatores, 5pp com 1 fator
 */

function _sampleConfidence(games) {
  if (!Number.isFinite(games) || games <= 0) return 0;
  return Math.min(1.0, games / 20); // 20 jogos = confiança 100%
}

/**
 * @param {Object} match    — { team1, team2, odds: {t1,t2} }
 * @param {Object} enrich   — {
 *   rankP1, rankP2,                // snooker.org (pode ser null)
 *   winRateP1, winRateP2,          // %
 *   gamesP1, gamesP2,              // total jogos temporada (para confiança)
 *   centuriesP1, centuriesP2       // # centuries temporada (opcional)
 * }
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
  const gP1  = Number(enrich?.gamesP1);
  const gP2  = Number(enrich?.gamesP2);
  const ctP1 = Number(enrich?.centuriesP1);
  const ctP2 = Number(enrich?.centuriesP2);

  // Confiança do sample: mínimo entre os dois (pior caso manda)
  // Se um dos players tem 0 jogos (ex: Jun Jiang), confiança cai forte
  const confP1 = _sampleConfidence(gP1);
  const confP2 = _sampleConfidence(gP2);
  const conf = Math.min(confP1, confP2);

  let factorCount = 0;
  let adjustP1 = 0;

  // ── Fator 1: ranking log-diff ──
  if (Number.isFinite(rkP1) && Number.isFinite(rkP2) && rkP1 > 0 && rkP2 > 0) {
    const logDiff = Math.log(rkP2) - Math.log(rkP1); // positivo se P1 melhor ranking
    const clamped = Math.max(-2.0, Math.min(2.0, logDiff));
    adjustP1 += clamped * 0.08; // peso mantido
    factorCount++;
  }

  // ── Fator 2: win rate temporada atual × confiança do sample ──
  if (Number.isFinite(wrP1) && Number.isFinite(wrP2)) {
    const wrDiff = (wrP1 - wrP2) / 100;
    const clamped = Math.max(-0.4, Math.min(0.4, wrDiff));
    // Peso 0.25 × confiança. Sem confiança (0), fator inativo efetivamente.
    adjustP1 += clamped * 0.25 * conf;
    factorCount++;
  }

  // ── Fator 3: centuries per game (qualidade de break) ──
  // Proxy para consistência em momentos altos. Útil quando CueTracker parsear centuries.
  // Normaliza pelo número de jogos para não favorecer jogadores de elite com mais matches.
  if (Number.isFinite(ctP1) && Number.isFinite(ctP2) && gP1 > 5 && gP2 > 5) {
    const cpgP1 = ctP1 / gP1; // centuries per game
    const cpgP2 = ctP2 / gP2;
    const cpgDiff = cpgP1 - cpgP2;
    // Saturação em ±1.0 cpg diff → ±10pp bruto × conf × 0.08 = ±1pp
    const clamped = Math.max(-1.0, Math.min(1.0, cpgDiff));
    adjustP1 += clamped * 0.08 * conf;
    factorCount++;
  }

  // Cap total ±15pp sobre implied
  const cap = 0.15;
  const adj = Math.max(-cap, Math.min(cap, adjustP1));
  let modelP1 = impliedP1 + adj;
  modelP1 = Math.max(0.05, Math.min(0.95, modelP1));
  const modelP2 = 1 - modelP1;

  const edgeP1 = (modelP1 - impliedP1) * 100;
  const edgeP2 = (modelP2 - impliedP2) * 100;
  const score = Math.max(edgeP1, edgeP2);
  const direction = edgeP1 >= edgeP2 ? 't1' : 't2';

  // Gate: 4pp com 2+ fatores (sample confiável), 5pp com 1 fator
  // + penalidade se sample confidence < 0.5 (menos de 10 jogos no pior caso)
  const confPenalty = conf < 0.5 ? 1.0 : 0;
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

module.exports = { snookerPreFilter };
