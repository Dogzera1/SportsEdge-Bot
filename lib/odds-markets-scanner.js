'use strict';

/**
 * odds-markets-scanner.js — varre mercados Pinnacle (handicap + totals) contra
 * pricing interno pra achar EV positivo em mercados além de moneyline.
 *
 * Uso:
 *   const tips = scanMarkets({
 *     markets: { moneyline, handicaps, totals },  // do /odds-markets
 *     pMap, bestOf,                                // pra pricing de séries
 *     pricingLib: require('./lol-markets'),        // { handicapProb, totalMapsProb }
 *     minEv: 0.04,                                 // 4% default
 *   });
 *   // tips = [{ market, line, side, pModel, odd, ev, label, conf }...]
 *
 * Pricing sport-agnostic desde que lib exponha { handicapProb, totalMapsProb }.
 */

const { devigMultiplicative } = require('./devig');

/**
 * Remove vig de 2 odds e retorna P dejuiced pra cada lado.
 */
function _dejuice2way(oddsA, oddsB) {
  const r = devigMultiplicative(oddsA, oddsB);
  if (!r) return null;
  return { pA: r.p1, pB: r.p2, overround: r.overround };
}

/**
 * Calcula EV pct = (pModel × odd - 1) × 100.
 */
function _ev(pModel, odd) {
  if (!Number.isFinite(pModel) || !Number.isFinite(odd) || odd <= 1) return null;
  return (pModel * odd - 1) * 100;
}

/**
 * Varre handicaps e totals contra pricing lib.
 *
 * @param {object} args
 * @param {object} args.markets — { moneyline, handicaps: [], totals: [] } do /odds-markets
 * @param {number} args.pMap    — P(team1 vence um mapa)
 * @param {number} args.bestOf  — 1, 3 ou 5
 * @param {object} args.pricingLib — { handicapProb(pMap, bo, line), totalMapsProb(pMap, bo, line) }
 * @param {number} [args.minEv=4] — EV mínimo pct pra incluir como tip
 * @returns {Array<{ market, line, side, pModel, pImplied, odd, ev, label }>}
 */
function scanMarkets({ markets, pMap, bestOf, pricingLib, minEv = 4 }) {
  if (!markets || !pricingLib) return [];
  const tips = [];

  // 1. Handicaps
  for (const h of (markets.handicaps || [])) {
    // Line em Pinnacle é HOME handicap. Se -1.5, home precisa ganhar por 2+.
    // Assumo team1 = home (t1) consistente com resto do pipeline.
    const { handicapProb } = pricingLib;
    if (typeof handicapProb !== 'function') continue;
    const probs = handicapProb(pMap, bestOf, h.line);
    if (!probs) continue;
    // Team1 handicap line = h.line. Prob team1 cobre = probs.team1.
    // Team2 handicap line = -h.line.
    const dj = _dejuice2way(h.oddsHome, h.oddsAway);
    // Team1 side
    const ev1 = _ev(probs.team1, h.oddsHome);
    if (ev1 != null && ev1 >= minEv) {
      tips.push({
        market: 'handicap', line: h.line, side: 'home',
        pModel: +probs.team1.toFixed(4),
        pImplied: dj ? +dj.pA.toFixed(4) : null,
        odd: h.oddsHome,
        ev: +ev1.toFixed(2),
        label: `Handicap ${h.line >= 0 ? '+' : ''}${h.line} team1`,
      });
    }
    // Team2 side
    const ev2 = _ev(probs.team2, h.oddsAway);
    if (ev2 != null && ev2 >= minEv) {
      tips.push({
        market: 'handicap', line: -h.line, side: 'away',
        pModel: +probs.team2.toFixed(4),
        pImplied: dj ? +dj.pB.toFixed(4) : null,
        odd: h.oddsAway,
        ev: +ev2.toFixed(2),
        label: `Handicap ${-h.line >= 0 ? '+' : ''}${-h.line} team2`,
      });
    }
  }

  // 2. Totals
  for (const t of (markets.totals || [])) {
    const { totalMapsProb } = pricingLib;
    if (typeof totalMapsProb !== 'function') continue;
    const probs = totalMapsProb(pMap, bestOf, t.line);
    if (!probs) continue;
    const dj = _dejuice2way(t.oddsOver, t.oddsUnder);
    // Over
    const evO = _ev(probs.over, t.oddsOver);
    if (evO != null && evO >= minEv) {
      tips.push({
        market: 'total', line: t.line, side: 'over',
        pModel: +probs.over.toFixed(4),
        pImplied: dj ? +dj.pA.toFixed(4) : null,
        odd: t.oddsOver,
        ev: +evO.toFixed(2),
        label: `Over ${t.line} maps`,
      });
    }
    // Under
    const evU = _ev(probs.under, t.oddsUnder);
    if (evU != null && evU >= minEv) {
      tips.push({
        market: 'total', line: t.line, side: 'under',
        pModel: +probs.under.toFixed(4),
        pImplied: dj ? +dj.pB.toFixed(4) : null,
        odd: t.oddsUnder,
        ev: +evU.toFixed(2),
        label: `Under ${t.line} maps`,
      });
    }
  }

  // Sort by EV descending
  tips.sort((a, b) => b.ev - a.ev);
  return tips;
}

module.exports = { scanMarkets };
