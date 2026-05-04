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
function scanMarkets({ markets, pMap, bestOf, pricingLib, minEv = 4, momentum = 0, minOdd, maxOdd, maxPerMatch, shadowMinEv } = {}) {
  if (!markets || !pricingLib) return [];
  const swap = !!markets.swap;
  // 2026-05-04: shadowMinEv (opcional, default = minEv pra back-compat).
  // Quando passado < minEv, retornamos OBJETO { promotable, shadow }:
  //   - promotable: tips que passam minEv + oddOk + maxPerMatch (pro promote/DM)
  //   - shadow: tips que passam APENAS shadowMinEv (sem oddOk + sem maxCap)
  // Pra shadow puro: shadowMinEv=-99 (capture qualquer EV positivo do modelo).
  const shadowEvCap = Number.isFinite(shadowMinEv) ? shadowMinEv : minEv;
  const splitMode = Number.isFinite(shadowMinEv);
  const shadowTips = [];
  const tips = [];
  const pricingOpts = momentum > 0 ? { momentum, iters: 8000 } : {};
  // Odd floor/cap gates — APENAS pra promotable. Shadow ignora.
  const floor = Number.isFinite(minOdd) && minOdd > 1 ? minOdd : null;
  const cap = Number.isFinite(maxOdd) && maxOdd > 1 ? maxOdd : null;
  const oddOk = (o) => Number.isFinite(o)
    && (!floor || o >= floor)
    && (!cap || o <= cap);

  // Helper: push tip pra shadow (se passa shadowEvCap) e pra promotable (se passa minEv + oddOk).
  const _pushTip = (entry) => {
    if (entry.ev == null) return;
    if (splitMode && entry.ev >= shadowEvCap) {
      shadowTips.push({ ...entry });
    }
    if (entry.ev >= minEv && oddOk(entry.odd)) {
      tips.push(entry);
    }
  };

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
    _pushTip({
      market: 'handicap', line: lineT1, side: 'team1',
      pModel: +probs.team1.toFixed(4),
      pImplied: dj ? +dj.pA.toFixed(4) : null,
      odd: oddT1,
      ev: ev1 != null ? +ev1.toFixed(2) : null,
      label: `Handicap ${lineT1 >= 0 ? '+' : ''}${lineT1} team1`,
    });
    // Team2 side (line simétrica)
    const ev2 = _ev(probs.team2, oddT2);
    _pushTip({
      market: 'handicap', line: -lineT1, side: 'team2',
      pModel: +probs.team2.toFixed(4),
      pImplied: dj ? +dj.pB.toFixed(4) : null,
      odd: oddT2,
      ev: ev2 != null ? +ev2.toFixed(2) : null,
      label: `Handicap ${-lineT1 >= 0 ? '+' : ''}${-lineT1} team2`,
    });
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
    _pushTip({
      market: 'total', line: t.line, side: 'over',
      pModel: +probs.over.toFixed(4),
      pImplied: dj ? +dj.pA.toFixed(4) : null,
      odd: t.oddsOver,
      ev: evO != null ? +evO.toFixed(2) : null,
      label: `Over ${t.line} maps`,
    });
    // Under
    const evU = _ev(probs.under, t.oddsUnder);
    _pushTip({
      market: 'total', line: t.line, side: 'under',
      pModel: +probs.under.toFixed(4),
      pImplied: dj ? +dj.pB.toFixed(4) : null,
      odd: t.oddsUnder,
      ev: evU != null ? +evU.toFixed(2) : null,
      label: `Under ${t.line} maps`,
    });
  }

  // Dedup helper aplicado tanto pra promotable quanto shadow (se split mode).
  const _dedupAndCap = (arr, applyCap) => {
    let result;
    if (!/^(0|false|no)$/i.test(String(process.env.MARKET_DEDUP || ''))) {
      const byKey = new Map();
      for (const t of arr) {
        const key = `${t.market}|${t.side}`;
        const cur = byKey.get(key);
        if (!cur || (t.pModel || 0) > (cur.pModel || 0)) byKey.set(key, t);
      }
      result = [...byKey.values()].sort((a, b) => b.ev - a.ev);
    } else {
      arr.sort((a, b) => b.ev - a.ev);
      result = arr;
    }
    if (applyCap && Number.isFinite(maxPerMatch) && maxPerMatch > 0 && result.length > maxPerMatch) {
      return result.slice(0, maxPerMatch);
    }
    return result;
  };

  if (splitMode) {
    return {
      promotable: _dedupAndCap(tips, true),  // promote: aplica maxPerMatch
      shadow: _dedupAndCap(shadowTips, false), // shadow: SEM maxPerMatch (captura tudo)
    };
  }
  return _dedupAndCap(tips, true);
}

module.exports = { scanMarkets };
