'use strict';

/**
 * darts-mt-scanner.js — varre Pinnacle handicap_sets + total_sets contra modelo
 * ML simples (pModel + bestOf) via Normal CDF aproximação.
 *
 * Darts (PDC, BDO, World Matchplay, Premier League):
 * - Best of N sets (típico Bo5/Bo7/Bo11/Bo13/Bo19/Bo21).
 * - Cada set é Bo5 legs (first to 3 legs vence o set).
 * - Format heurístico: σ_sets ≈ 1.5 (variance moderada vs basket); σ_legs ≈ 5.
 *
 * Pricing aproximado:
 *   μ_margin (sets) = (pModel - 0.5) × bestOf × 0.6
 *     (pModel=0.5 → μ=0; pModel=0.75 → μ≈+1.5 sets numa Bo7)
 *   σ_margin = max(1.0, bestOf × 0.3) — variance ~ format
 *   μ_total_sets = bestOf × 0.7 (típico — não vai full distance sempre)
 *   σ_total = max(1.0, bestOf × 0.25)
 *
 * P(team1 cobre +line sets) = 1 - Φ((-line - μ_margin) / σ_margin)
 * P(over X sets) = 1 - Φ((X - μ_total) / σ_total)
 *
 * Convention storage:
 *   side='team1' / 'team2' / 'over' / 'under'
 *   line stored as Pinnacle (perspective home/team1).
 *
 * Uso:
 *   const { scanDartsMarkets } = require('./darts-mt-scanner');
 *   const tips = scanDartsMarkets({
 *     pinMarkets, pModelT1, bestOf,
 *     minEv: 5, maxEv: 30, minPmodel: 0.45,
 *     minOdd: 1.40, maxOdd: 4.50,
 *   });
 */

function _normalCdf(z) {
  if (!Number.isFinite(z)) return 0.5;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function _ev(pModel, odd) {
  if (!Number.isFinite(pModel) || !Number.isFinite(odd) || odd <= 1) return null;
  return (pModel * odd - 1) * 100;
}

/**
 * Estima parâmetros (μ, σ) de margin e total a partir de pModel + bestOf.
 * Heurísticas calibradas em sample histórico PDC (~σ_margin ≈ 1.5 em Bo11,
 * σ_total ≈ 2.5). Override via env DARTS_MT_*.
 */
function _estimateDartsParams(pModelT1, bestOf) {
  const bo = Number.isFinite(bestOf) && bestOf > 0 ? bestOf : 7;
  const p = Math.max(0.05, Math.min(0.95, Number(pModelT1) || 0.5));
  // μ_margin: (p - 0.5) escalado por format. Coef 0.6 calibrado pra Bo7
  // (favorito 70% típicamente vence ~4-3 ou 4-2 → margin ~0.5-1.5).
  const muMargin = (p - 0.5) * bo * (parseFloat(process.env.DARTS_MT_MU_MARGIN_COEF) || 0.6);
  // σ_margin escala com sqrt(bestOf) (variance soma de ~bo bernoullis).
  const sigmaMargin = Math.max(1.0, Math.sqrt(bo) * (parseFloat(process.env.DARTS_MT_SIGMA_MARGIN_COEF) || 0.65));
  // μ_total: ~70% do bestOf típico (não vai full distance todo match).
  // Bo7: 4-2 → 6 sets (média 5.5).
  const muTotalCoef = parseFloat(process.env.DARTS_MT_MU_TOTAL_COEF) || 0.78;
  const muTotal = bo * muTotalCoef;
  const sigmaTotal = Math.max(1.0, Math.sqrt(bo) * (parseFloat(process.env.DARTS_MT_SIGMA_TOTAL_COEF) || 0.55));
  return { muMargin, sigmaMargin, muTotal, sigmaTotal, bo };
}

function scanDartsMarkets({
  pinMarkets,
  pModelT1,
  bestOf,
  minEv = 5, maxEv = 30,
  minPmodel = 0.45,
  minOdd = 1.40, maxOdd = 4.50,
  maxPerMatch = parseInt(process.env.DARTS_MT_MAX_PER_MATCH || '3', 10),
} = {}) {
  if (!pinMarkets) return [];
  if (!Number.isFinite(pModelT1) || pModelT1 <= 0 || pModelT1 >= 1) return [];

  const params = _estimateDartsParams(pModelT1, bestOf);
  const { muMargin, sigmaMargin, muTotal, sigmaTotal } = params;
  const swap = !!pinMarkets.swap;
  const oddOk = (o) => Number.isFinite(o) && o >= minOdd && o <= maxOdd;
  const tips = [];

  // ── HANDICAPS sets ──
  // Pinnacle row: line = HOME (team1 in swap=false) handicap. Negativo = team1 favorito.
  // P(team1 cover line) = P(margin > -line). Margin = team1_sets - team2_sets.
  // (line=-2.5 → team1 precisa vencer por 3+ sets; -line=+2.5; P = 1-Φ((2.5-μ)/σ))
  const handicaps = Array.isArray(pinMarkets.handicaps) ? pinMarkets.handicaps : [];
  for (const h of handicaps) {
    const line = Number(h.line);
    if (!Number.isFinite(line)) continue;
    // Bound sanity: darts handicap_sets típico [-10, +10]. Cuta ruído.
    if (Math.abs(line) > 12) continue;
    const oddT1 = Number(swap ? h.oddsAway : h.oddsHome);
    const oddT2 = Number(swap ? h.oddsHome : h.oddsAway);

    const zT1 = (-line - muMargin) / sigmaMargin;
    const pT1 = 1 - _normalCdf(zT1);
    const pT2 = 1 - pT1;

    const evT1 = _ev(pT1, oddT1);
    const evT2 = _ev(pT2, oddT2);

    // 2026-05-22: pModelRaw = pModel (darts sem isotonic — mig 117 brier-holdout
    // medirá overfit zero, mas população padrão habilita audit cross-sport).
    if (Number.isFinite(evT1) && evT1 >= minEv && evT1 <= maxEv && pT1 >= minPmodel && oddOk(oddT1)) {
      tips.push({
        market: 'handicap', line, side: 'team1',
        pModel: +pT1.toFixed(4),
        pModelRaw: +pT1.toFixed(4),
        pImplied: oddT1 > 1 ? +(1 / oddT1).toFixed(4) : null,
        odd: +oddT1.toFixed(3), ev: +evT1.toFixed(2),
        label: `Handicap ${line >= 0 ? '+' : ''}${line} sets team1`,
      });
    }
    if (Number.isFinite(evT2) && evT2 >= minEv && evT2 <= maxEv && pT2 >= minPmodel && oddOk(oddT2)) {
      tips.push({
        market: 'handicap', line: -line, side: 'team2',
        pModel: +pT2.toFixed(4),
        pModelRaw: +pT2.toFixed(4),
        pImplied: oddT2 > 1 ? +(1 / oddT2).toFixed(4) : null,
        odd: +oddT2.toFixed(3), ev: +evT2.toFixed(2),
        label: `Handicap ${(-line) >= 0 ? '+' : ''}${-line} sets team2`,
      });
    }
  }

  // ── TOTALS sets ──
  const totals = Array.isArray(pinMarkets.totals) ? pinMarkets.totals : [];
  for (const t of totals) {
    const line = Number(t.line);
    if (!Number.isFinite(line)) continue;
    // Sanity: darts total sets típico [3, 25]. Cap pra evitar ruído (legs market vazando).
    if (line < 2.5 || line > 30) continue;
    const oddOver = Number(t.oddsOver);
    const oddUnder = Number(t.oddsUnder);
    const z = (line - muTotal) / sigmaTotal;
    const pUnder = _normalCdf(z);
    const pOver = 1 - pUnder;
    const overEv = _ev(pOver, oddOver);
    const underEv = _ev(pUnder, oddUnder);
    if (Number.isFinite(overEv) && overEv >= minEv && overEv <= maxEv && pOver >= minPmodel && oddOk(oddOver)) {
      tips.push({
        market: 'total', line, side: 'over',
        pModel: +pOver.toFixed(4),
        pModelRaw: +pOver.toFixed(4),
        pImplied: oddOver > 1 ? +(1 / oddOver).toFixed(4) : null,
        odd: +oddOver.toFixed(3), ev: +overEv.toFixed(2),
        label: `Over ${line} sets`,
      });
    }
    if (Number.isFinite(underEv) && underEv >= minEv && underEv <= maxEv && pUnder >= minPmodel && oddOk(oddUnder)) {
      tips.push({
        market: 'total', line, side: 'under',
        pModel: +pUnder.toFixed(4),
        pModelRaw: +pUnder.toFixed(4),
        pImplied: oddUnder > 1 ? +(1 / oddUnder).toFixed(4) : null,
        odd: +oddUnder.toFixed(3), ev: +underEv.toFixed(2),
        label: `Under ${line} sets`,
      });
    }
  }

  // Cap per-match: top-K por EV (correlação cruzada entre handicap+totals
  // do mesmo match — multi-tip viola Kelly indep).
  if (maxPerMatch > 0 && tips.length > maxPerMatch) {
    tips.sort((a, b) => (b.ev || 0) - (a.ev || 0));
    return tips.slice(0, maxPerMatch);
  }
  return tips;
}

module.exports = { scanDartsMarkets, _estimateDartsParams };
