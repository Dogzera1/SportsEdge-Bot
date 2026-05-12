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

// 2026-05-06 FIX: usar devigEnsemble (auto power/Shin) — esports MT scanner
// (handicap maps + total maps) compartilhado por LoL/CS/Dota/Val. ML em
// bot.js usa ensemble; MT em multiplicativo distorcia underdog ≥1.5 odds gap.
const { devigEnsemble } = require('./devig');

/**
 * Remove vig de 2 odds e retorna P dejuiced pra cada lado.
 */
function _dejuice2way(oddsA, oddsB) {
  const r = devigEnsemble(oddsA, oddsB);
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
function scanMarkets({ markets, pMap, bestOf, pricingLib, minEv = 4, momentum = 0, minOdd, maxOdd, maxPerMatch, shadowMinEv, calibLib, calibOpts } = {}) {
  if (!markets || !pricingLib) return [];
  const swap = !!markets.swap;
  // calibLib opcional — { applyCalib(pRaw, market, opts) }. Aplica calibração
  // pós-pricing antes de calcular EV. 2026-05-12: causa-fix LoL/CS leak EV>30%
  // (gap +80-120pp). Funciona como tennis-markov-calib mas per-sport via factory.
  const _calib = (typeof calibLib?.applyCalib === 'function') ? calibLib.applyCalib : null;
  const _calibOpts = calibOpts || {};
  const _maybeCalib = (pRaw, market, side) => {
    if (!_calib) return pRaw;
    try { return _calib(pRaw, market, { ..._calibOpts, side }); }
    catch (_) { return pRaw; }
  };
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
    const pT1Calib = _maybeCalib(probs.team1, 'handicap', 'team1');
    const pT2Calib = _maybeCalib(probs.team2, 'handicap', 'team2');
    const ev1 = _ev(pT1Calib, oddT1);
    _pushTip({
      market: 'handicap', line: lineT1, side: 'team1',
      pModel: +pT1Calib.toFixed(4),
      pImplied: dj ? +dj.pA.toFixed(4) : null,
      odd: oddT1,
      ev: ev1 != null ? +ev1.toFixed(2) : null,
      label: `Handicap ${lineT1 >= 0 ? '+' : ''}${lineT1} team1`,
    });
    const ev2 = _ev(pT2Calib, oddT2);
    _pushTip({
      market: 'handicap', line: -lineT1, side: 'team2',
      pModel: +pT2Calib.toFixed(4),
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
    const pOverCalib = _maybeCalib(probs.over, 'total', 'over');
    const pUnderCalib = _maybeCalib(probs.under, 'total', 'under');
    const evO = _ev(pOverCalib, t.oddsOver);
    _pushTip({
      market: 'total', line: t.line, side: 'over',
      pModel: +pOverCalib.toFixed(4),
      pImplied: dj ? +dj.pA.toFixed(4) : null,
      odd: t.oddsOver,
      ev: evO != null ? +evO.toFixed(2) : null,
      label: `Over ${t.line} maps`,
    });
    const evU = _ev(pUnderCalib, t.oddsUnder);
    _pushTip({
      market: 'total', line: t.line, side: 'under',
      pModel: +pUnderCalib.toFixed(4),
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
