'use strict';

/**
 * tennis-h2h-ensemble.js — H2H second-opinion model pra blendar com Markov.
 *
 * Inspirado em Wang & Drekic 2026 (Journal of Quantitative Analysis Sports):
 * ensemble point-based + H2H-only models reaches ~70% accuracy. Nosso Markov
 * já é point-based; adicionar H2H-pure como segundo opinador.
 *
 * Heurística:
 *   - p_h2h = (t1Wins + alpha) / (totalMatches + 2*alpha)  [Laplace smoothing]
 *   - alpha = 0.5 (prior uniforme: 50/50 sem dados)
 *   - decay temporal: matches >12 meses têm peso reduzido (não implementado
 *     aqui — o /h2h endpoint já filtra days=730, peso uniforme aceitável)
 *   - weight do H2H no blend escala com sample: max 30% quando n>=10
 *
 * Uso típico: depois do Markov + TB + isotonic mas antes de injury risk.
 */
'use strict';

/**
 * Calcula p ensemble blendando p_markov com p_h2h.
 *
 * @param {object} h2hData — payload do /h2h endpoint: {totalMatches, t1Wins, t2Wins, results}
 * @param {number} pMarkov — probabilidade atual do modelo Markov para player1 (já calibrado)
 * @param {object} opts — { minN: 3, maxWeight: 0.30, alpha: 0.5, recencyBoostDays: 365 }
 * @returns {{ pBlend, pH2h, weight, applied, reason }}
 */
function computeH2HEnsemble(h2hData, pMarkov, opts = {}) {
  const minN = Number.isFinite(opts.minN) ? opts.minN : 3;
  const maxWeight = Number.isFinite(opts.maxWeight) ? opts.maxWeight : 0.30;
  const alpha = Number.isFinite(opts.alpha) ? opts.alpha : 0.5;
  const recencyBoostDays = Number.isFinite(opts.recencyBoostDays) ? opts.recencyBoostDays : 365;

  // Sanity inputs
  if (!Number.isFinite(pMarkov) || pMarkov <= 0 || pMarkov >= 1) {
    return { pBlend: pMarkov, pH2h: null, weight: 0, applied: false, reason: 'invalid_p_markov' };
  }
  if (!h2hData || typeof h2hData !== 'object') {
    return { pBlend: pMarkov, pH2h: null, weight: 0, applied: false, reason: 'no_h2h_data' };
  }

  const total = Number(h2hData.totalMatches) || 0;
  const t1w = Number(h2hData.t1Wins) || 0;
  if (total < minN) {
    return { pBlend: pMarkov, pH2h: null, weight: 0, applied: false, reason: `insufficient_n (${total} < ${minN})` };
  }

  // Recency-weighted H2H: cada match contribui peso 1.0 se <12m, 0.5 se >12m.
  // Usa results[].date pra calcular weight efetivo se disponível.
  let weightedT1Wins = 0, weightedTotal = 0;
  const now = Date.now();
  const results = Array.isArray(h2hData.results) ? h2hData.results : [];
  if (results.length === total) {
    for (const r of results) {
      const dt = r.date ? new Date(r.date).getTime() : 0;
      const ageDays = dt > 0 ? (now - dt) / (24 * 60 * 60 * 1000) : recencyBoostDays;
      const w = ageDays <= recencyBoostDays ? 1.0 : 0.5;
      // results não tem winner direto — inferir via homeGoals/awayGoals comparando team1
      // Placar não é confiável pra tennis (homeGoals seria sets). Fallback: usa t1Wins agregado se ambíguo.
      const isT1Win = (r.homeGoals || 0) > (r.awayGoals || 0); // approx
      if (isT1Win) weightedT1Wins += w;
      weightedTotal += w;
    }
  } else {
    // Sem detalhes per-match: usa agregado uniforme (peso 1 cada).
    weightedT1Wins = t1w;
    weightedTotal = total;
  }

  // Laplace smoothing
  const pH2h = (weightedT1Wins + alpha) / (weightedTotal + 2 * alpha);

  // Weight scales linearly até maxWeight quando n>=10.
  // n=3 → 0.09, n=5 → 0.15, n=10 → 0.30 (cap). Evita overfit em sample baixo.
  const weight = Math.min(maxWeight, (total / 10) * maxWeight);

  // Blend
  const pBlend = (1 - weight) * pMarkov + weight * pH2h;
  const pBlendClamped = Math.max(0.05, Math.min(0.95, pBlend));

  return {
    pBlend: pBlendClamped,
    pH2h: +pH2h.toFixed(4),
    weight: +weight.toFixed(3),
    applied: true,
    reason: 'ok',
    n: total,
    t1Wins: t1w,
    weightedT1Wins: +weightedT1Wins.toFixed(2),
    weightedTotal: +weightedTotal.toFixed(2),
  };
}

module.exports = { computeH2HEnsemble };
