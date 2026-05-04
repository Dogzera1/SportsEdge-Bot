'use strict';

/**
 * basket-mt-scanner.js — varre Pinnacle totals + handicaps NBA contra
 * trained model (μ_total, σ_total, μ_margin, σ_margin) via Normal CDF.
 *
 * NBA totals/margins são aproximadamente normais (CLT — soma de muitas posses).
 * σ é estável entre matchups: ~18 pts (total) / ~13 pts (margin) — bem
 * documentado. Pricing fica:
 *   P(over X)   = 1 - Φ((X - μ_total) / σ_total)
 *   P(team1 cover line) = 1 - Φ((-line - μ_margin) / σ_margin)
 *   P(team2 cover -line) = 1 - P(team1 cover line)
 *
 * Convention storage (esports scanner pattern, NÃO football):
 *   side='team1' → line stored as team1's perspective
 *   side='team2' → line stored as team2's perspective (= -team1's line)
 * Settlement em market-tips-shadow usa essa convenção (team1Diff + line > 0).
 *
 * Uso:
 *   const { scanBasketMarkets } = require('./basket-mt-scanner');
 *   const tips = scanBasketMarkets({
 *     pinMarkets: { handicaps, totals, swap },
 *     trainedMarkets: { totalMu, totalSigma, marginMu, marginSigma },
 *     minEv: 5, maxEv: 25, minPmodel: 0.50,
 *     minOdd: 1.50, maxOdd: 3.50,
 *   });
 */

// Standard normal CDF via Abramowitz & Stegun 7.1.26 erf approx (~7e-8 precision).
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

function scanBasketMarkets({
  pinMarkets,
  trainedMarkets,
  minEv = 5, maxEv = 25,
  minPmodel = 0.50,
  minOdd = 1.50, maxOdd = 3.50,
} = {}) {
  if (!pinMarkets || !trainedMarkets) return [];
  const { totalMu, totalSigma, marginMu, marginSigma } = trainedMarkets;
  if (!Number.isFinite(totalMu) || !Number.isFinite(totalSigma) || totalSigma <= 0) return [];
  if (!Number.isFinite(marginMu) || !Number.isFinite(marginSigma) || marginSigma <= 0) return [];
  const swap = !!pinMarkets.swap;
  const tips = [];
  const oddOk = (o) => Number.isFinite(o) && o >= minOdd && o <= maxOdd;

  // ── TOTALS (Over/Under N.5 pontos) ──
  // Totals são simétricos — swap não afeta.
  const totals = Array.isArray(pinMarkets.totals) ? pinMarkets.totals : [];
  for (const t of totals) {
    const line = Number(t.line);
    if (!Number.isFinite(line)) continue;
    // NBA lines tipo 200-260; filtra ruído (ex: spreads vazando).
    if (line < 150 || line > 320) continue;
    const oddOver = Number(t.oddsOver);
    const oddUnder = Number(t.oddsUnder);
    const z = (line - totalMu) / totalSigma;
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
        label: `Over ${line} pts`,
      });
    }
    if (Number.isFinite(underEv) && underEv >= minEv && underEv <= maxEv && pUnder >= minPmodel && oddOk(oddUnder)) {
      tips.push({
        market: 'total', line, side: 'under',
        pModel: +pUnder.toFixed(4),
        pImplied: oddUnder > 1 ? +(1 / oddUnder).toFixed(4) : null,
        odd: +oddUnder.toFixed(3), ev: +underEv.toFixed(2),
        label: `Under ${line} pts`,
      });
    }
  }

  // ── HANDICAPS (Point Spread) ──
  // Pinnacle row: line é HOME handicap (negativo = home favorito). swap=true
  // reorienta home/away pra team1/team2 do caller.
  // Convention storage: cada side guarda line da SUA perspectiva.
  //   team1 com line=L → covers se team1 - team2 > -L
  //   team2 com line=-L → covers se team2 - team1 > L (= team1 - team2 < -L)
  const handicaps = Array.isArray(pinMarkets.handicaps) ? pinMarkets.handicaps : [];
  for (const h of handicaps) {
    const lineRaw = Number(h.line);
    if (!Number.isFinite(lineRaw)) continue;
    // NBA spreads tipicamente -1.5 a -15.5; filtra outliers.
    if (Math.abs(lineRaw) > 25) continue;
    const lineT1 = swap ? -lineRaw : lineRaw;
    const oddT1 = Number(swap ? h.oddsAway : h.oddsHome);
    const oddT2 = Number(swap ? h.oddsHome : h.oddsAway);

    // P(team1 covers lineT1) = P(margin > -lineT1) = 1 - Φ((-lineT1 - μ) / σ)
    const zT1 = (-lineT1 - marginMu) / marginSigma;
    const pT1 = 1 - _normalCdf(zT1);
    const pT2 = 1 - pT1;

    const evT1 = _ev(pT1, oddT1);
    const evT2 = _ev(pT2, oddT2);

    if (Number.isFinite(evT1) && evT1 >= minEv && evT1 <= maxEv && pT1 >= minPmodel && oddOk(oddT1)) {
      tips.push({
        market: 'handicap', line: lineT1, side: 'team1',
        pModel: +pT1.toFixed(4),
        pImplied: oddT1 > 1 ? +(1 / oddT1).toFixed(4) : null,
        odd: +oddT1.toFixed(3), ev: +evT1.toFixed(2),
        label: `Handicap ${lineT1 >= 0 ? '+' : ''}${lineT1} team1`,
      });
    }
    if (Number.isFinite(evT2) && evT2 >= minEv && evT2 <= maxEv && pT2 >= minPmodel && oddOk(oddT2)) {
      const lineT2 = -lineT1;
      tips.push({
        market: 'handicap', line: lineT2, side: 'team2',
        pModel: +pT2.toFixed(4),
        pImplied: oddT2 > 1 ? +(1 / oddT2).toFixed(4) : null,
        odd: +oddT2.toFixed(3), ev: +evT2.toFixed(2),
        label: `Handicap ${lineT2 >= 0 ? '+' : ''}${lineT2} team2`,
      });
    }
  }

  // Dedup por (market, side, line) — Pinnacle pode listar mesma linha múltiplas vezes.
  const byKey = new Map();
  for (const t of tips) {
    const k = `${t.market}|${t.side}|${t.line}`;
    const prev = byKey.get(k);
    if (!prev || (t.ev || 0) > (prev.ev || 0)) byKey.set(k, t);
  }
  return [...byKey.values()].sort((a, b) => (b.ev || 0) - (a.ev || 0));
}

module.exports = { scanBasketMarkets, _normalCdf };
