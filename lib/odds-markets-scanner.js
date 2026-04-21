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
 * @param {object} args.markets — { moneyline, handicaps: [], totals: [], swap? } do /odds-markets
 * @param {number} args.pMap    — P(team1 vence um mapa)
 * @param {number} args.bestOf  — 1, 3 ou 5
 * @param {object} args.pricingLib — { handicapProb(pMap, bo, line), totalMapsProb(pMap, bo, line) }
 * @param {number} [args.minEv=4] — EV mínimo pct pra incluir como tip
 * @returns {Array<{ market, line, side, pModel, pImplied, odd, ev, label }>}
 *
 * Orientação: pMap = P(team1 vence mapa) — sempre na ótica do caller.
 *   Se `markets.swap===true`, o cache Pinnacle tem home=team2 do caller, então
 *   invertemos home/away das handicaps antes de aplicar pricing.
 *   Totals são simétricos (não dependem de home/away).
 */
function scanMarkets({ markets, pMap, bestOf, pricingLib, minEv = 4, momentum = 0 }) {
  if (!markets || !pricingLib) return [];
  const swap = !!markets.swap;
  const tips = [];
  const pricingOpts = momentum > 0 ? { momentum, iters: 8000 } : {};

  // 1. Handicaps — line em Pinnacle é HOME handicap.
  // Quando swap=true, o Pinnacle home = nosso team2. Line precisa ser invertida
  // (se Pinnacle mostra home -1.5 e swap, pro nosso team1 isso vira line +1.5).
  for (const h of (markets.handicaps || [])) {
    const { handicapProb } = pricingLib;
    if (typeof handicapProb !== 'function') continue;
    // Reorienta pra team1: se swap, team1 é Pinnacle away → line team1 = -h.line, odd team1 = oddsAway.
    const lineT1 = swap ? -h.line : h.line;
    const oddT1 = swap ? h.oddsAway : h.oddsHome;
    const oddT2 = swap ? h.oddsHome : h.oddsAway;
    const probs = handicapProb(pMap, bestOf, lineT1, pricingOpts);
    if (!probs) continue;
    const dj = _dejuice2way(oddT1, oddT2);
    // Team1 side
    const ev1 = _ev(probs.team1, oddT1);
    if (ev1 != null && ev1 >= minEv) {
      tips.push({
        market: 'handicap', line: lineT1, side: 'team1',
        pModel: +probs.team1.toFixed(4),
        pImplied: dj ? +dj.pA.toFixed(4) : null,
        odd: oddT1,
        ev: +ev1.toFixed(2),
        label: `Handicap ${lineT1 >= 0 ? '+' : ''}${lineT1} team1`,
      });
    }
    // Team2 side (line simétrica)
    const ev2 = _ev(probs.team2, oddT2);
    if (ev2 != null && ev2 >= minEv) {
      tips.push({
        market: 'handicap', line: -lineT1, side: 'team2',
        pModel: +probs.team2.toFixed(4),
        pImplied: dj ? +dj.pB.toFixed(4) : null,
        odd: oddT2,
        ev: +ev2.toFixed(2),
        label: `Handicap ${-lineT1 >= 0 ? '+' : ''}${-lineT1} team2`,
      });
    }
  }

  // 2. Totals (simétrico — swap não afeta)
  for (const t of (markets.totals || [])) {
    const { totalMapsProb } = pricingLib;
    if (typeof totalMapsProb !== 'function') continue;
    const probs = totalMapsProb(pMap, bestOf, t.line, pricingOpts);
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
  // Dedup: 1 tip por (market, side) — linhas correlacionadas (ex: totalMaps
  // over 2.5 e over 3.5) mantém só a LINHA LIMITE (maior pModel = menor
  // variância). Different markets (handicap + totals) não são dedupeados
  // entre si — podem coexistir. Override via MARKET_DEDUP=false.
  if (!/^(0|false|no)$/i.test(String(process.env.MARKET_DEDUP || ''))) {
    const byKey = new Map();
    for (const t of tips) {
      const key = `${t.market}|${t.side}`;
      const cur = byKey.get(key);
      if (!cur || (t.pModel || 0) > (cur.pModel || 0)) byKey.set(key, t);
    }
    return [...byKey.values()].sort((a, b) => b.ev - a.ev);
  }
  tips.sort((a, b) => b.ev - a.ev);
  return tips;
}

module.exports = { scanMarkets };
