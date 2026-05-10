'use strict';

/**
 * snooker-mt-scanner.js — varre Pinnacle handicap_frames + total_frames contra
 * modelo ML (pModel + bestOf) via Normal CDF aproximação.
 *
 * Snooker (World Championship, UK Championship, Masters, Players Championship):
 * - Best of N frames (típico Bo7/Bo9/Bo11/Bo17/Bo19/Bo35).
 * - World Championship final é Bo35 (first to 18).
 * - Format heurístico: σ_frames vai escalar com sqrt(bestOf).
 *
 * Pricing aproximado (similar a darts mas frames ao invés de sets):
 *   μ_margin (frames) = (pModel - 0.5) × bestOf × 0.55
 *   σ_margin = max(1.0, sqrt(bestOf) × 0.7)
 *   μ_total = bestOf × 0.78
 *   σ_total = max(1.0, sqrt(bestOf) × 0.5)
 *
 * Convention storage:
 *   side='team1' / 'team2' / 'over' / 'under'
 *
 * Uso:
 *   const { scanSnookerMarkets } = require('./snooker-mt-scanner');
 *   const tips = scanSnookerMarkets({
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

function _estimateSnookerParams(pModelT1, bestOf) {
  const bo = Number.isFinite(bestOf) && bestOf > 0 ? bestOf : 9;
  const p = Math.max(0.05, Math.min(0.95, Number(pModelT1) || 0.5));
  const muMargin = (p - 0.5) * bo * (parseFloat(process.env.SNOOKER_MT_MU_MARGIN_COEF) || 0.55);
  const sigmaMargin = Math.max(1.0, Math.sqrt(bo) * (parseFloat(process.env.SNOOKER_MT_SIGMA_MARGIN_COEF) || 0.7));
  const muTotalCoef = parseFloat(process.env.SNOOKER_MT_MU_TOTAL_COEF) || 0.78;
  const muTotal = bo * muTotalCoef;
  const sigmaTotal = Math.max(1.0, Math.sqrt(bo) * (parseFloat(process.env.SNOOKER_MT_SIGMA_TOTAL_COEF) || 0.5));
  return { muMargin, sigmaMargin, muTotal, sigmaTotal, bo };
}

function scanSnookerMarkets({
  pinMarkets,
  pModelT1,
  bestOf,
  minEv = 5, maxEv = 30,
  minPmodel = 0.45,
  minOdd = 1.40, maxOdd = 4.50,
  maxPerMatch = parseInt(process.env.SNOOKER_MT_MAX_PER_MATCH || '3', 10),
} = {}) {
  if (!pinMarkets) return [];
  if (!Number.isFinite(pModelT1) || pModelT1 <= 0 || pModelT1 >= 1) return [];

  const { muMargin, sigmaMargin, muTotal, sigmaTotal } = _estimateSnookerParams(pModelT1, bestOf);
  const swap = !!pinMarkets.swap;
  const oddOk = (o) => Number.isFinite(o) && o >= minOdd && o <= maxOdd;
  const tips = [];

  // ── HANDICAPS frames ──
  const handicaps = Array.isArray(pinMarkets.handicaps) ? pinMarkets.handicaps : [];
  for (const h of handicaps) {
    const line = Number(h.line);
    if (!Number.isFinite(line)) continue;
    // Bound sanity: snooker handicap_frames típico [-15, +15] (Bo35 finals são extremos).
    if (Math.abs(line) > 20) continue;
    const oddT1 = Number(swap ? h.oddsAway : h.oddsHome);
    const oddT2 = Number(swap ? h.oddsHome : h.oddsAway);

    const zT1 = (-line - muMargin) / sigmaMargin;
    const pT1 = 1 - _normalCdf(zT1);
    const pT2 = 1 - pT1;

    const evT1 = _ev(pT1, oddT1);
    const evT2 = _ev(pT2, oddT2);

    if (Number.isFinite(evT1) && evT1 >= minEv && evT1 <= maxEv && pT1 >= minPmodel && oddOk(oddT1)) {
      tips.push({
        market: 'handicap', line, side: 'team1',
        pModel: +pT1.toFixed(4),
        pImplied: oddT1 > 1 ? +(1 / oddT1).toFixed(4) : null,
        odd: +oddT1.toFixed(3), ev: +evT1.toFixed(2),
        label: `Handicap ${line >= 0 ? '+' : ''}${line} frames team1`,
      });
    }
    if (Number.isFinite(evT2) && evT2 >= minEv && evT2 <= maxEv && pT2 >= minPmodel && oddOk(oddT2)) {
      tips.push({
        market: 'handicap', line: -line, side: 'team2',
        pModel: +pT2.toFixed(4),
        pImplied: oddT2 > 1 ? +(1 / oddT2).toFixed(4) : null,
        odd: +oddT2.toFixed(3), ev: +evT2.toFixed(2),
        label: `Handicap ${(-line) >= 0 ? '+' : ''}${-line} frames team2`,
      });
    }
  }

  // ── TOTALS frames ──
  const totals = Array.isArray(pinMarkets.totals) ? pinMarkets.totals : [];
  for (const t of totals) {
    const line = Number(t.line);
    if (!Number.isFinite(line)) continue;
    // Sanity: snooker total frames típico [4, 35]. Bo35 final pode chegar até 35.
    if (line < 3.5 || line > 36) continue;
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
        pImplied: oddOver > 1 ? +(1 / oddOver).toFixed(4) : null,
        odd: +oddOver.toFixed(3), ev: +overEv.toFixed(2),
        label: `Over ${line} frames`,
      });
    }
    if (Number.isFinite(underEv) && underEv >= minEv && underEv <= maxEv && pUnder >= minPmodel && oddOk(oddUnder)) {
      tips.push({
        market: 'total', line, side: 'under',
        pModel: +pUnder.toFixed(4),
        pImplied: oddUnder > 1 ? +(1 / oddUnder).toFixed(4) : null,
        odd: +oddUnder.toFixed(3), ev: +underEv.toFixed(2),
        label: `Under ${line} frames`,
      });
    }
  }

  if (maxPerMatch > 0 && tips.length > maxPerMatch) {
    tips.sort((a, b) => (b.ev || 0) - (a.ev || 0));
    return tips.slice(0, maxPerMatch);
  }
  return tips;
}

module.exports = { scanSnookerMarkets, _estimateSnookerParams };
