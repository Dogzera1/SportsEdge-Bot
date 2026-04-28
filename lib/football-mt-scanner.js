'use strict';

/**
 * football-mt-scanner.js — varre mercados Pinnacle football (totals + handicap)
 * contra fbTrained.markets pra achar EV+ além de 1X2 e OU 2.5.
 *
 * Diferente do odds-markets-scanner (esports) que precifica via lib específica,
 * football usa probabilidades JÁ PRÉ-COMPUTADAS pelo trained Poisson — não há
 * "pricingLib" porque a matrix de scorelines já fornece P pra qualquer mercado.
 *
 * Uso:
 *   const { scanFootballMarkets } = require('./football-mt-scanner');
 *   const tips = scanFootballMarkets({
 *     pinMarkets: { handicaps: [...], totals: [...], swap, homeTeam, awayTeam },
 *     trainedMarkets: fbTrained.markets, // { btts, ou, ah, ... }
 *     minEv: 5, minPmodel: 0.50,
 *     minOdd: 1.50, maxOdd: 3.50,
 *   });
 *   // tips = [{ market, line, side, pModel, pImplied, odd, ev, label }]
 *
 * Mercados cobertos:
 *   total (over/under)            — lines 0.5..4.5 (apenas se trainedMarkets.ou tem)
 *   handicap (home/away)          — lines ±0.5/±1.5 (Asian Handicap)
 */

function _ev(pModel, odd) {
  if (!Number.isFinite(pModel) || !Number.isFinite(odd) || odd <= 1) return null;
  return (pModel * odd - 1) * 100;
}

function _bestOdd(prices) {
  if (!Array.isArray(prices) || !prices.length) return null;
  return prices.reduce((max, p) => (p > max ? p : max), 0) || null;
}

function scanFootballMarkets({ pinMarkets, trainedMarkets, minEv = 5, maxEv = 25, minPmodel = 0.45, minOdd = 1.50, maxOdd = 4.00 } = {}) {
  if (!pinMarkets || !trainedMarkets) return [];
  const swap = !!pinMarkets.swap;
  const tips = [];

  // ── TOTALS (Over/Under N.5) ──
  const totals = Array.isArray(pinMarkets.totals) ? pinMarkets.totals : [];
  for (const t of totals) {
    const line = Number(t.line);
    if (!Number.isFinite(line)) continue;
    const lineKey = line.toFixed(1);
    const probs = trainedMarkets.ou?.[lineKey];
    if (!probs) continue; // line não modelada (ex: 5.5)
    const oddOver = Number(t.oddsOver ?? t.over ?? t.oddsHome ?? t.oddsT1);
    const oddUnder = Number(t.oddsUnder ?? t.under ?? t.oddsAway ?? t.oddsT2);
    const overEv = _ev(probs.over, oddOver);
    const underEv = _ev(probs.under, oddUnder);
    if (Number.isFinite(overEv) && overEv >= minEv && overEv <= maxEv && probs.over >= minPmodel
        && oddOver >= minOdd && oddOver <= maxOdd) {
      tips.push({
        market: 'totals', line, side: 'over',
        pModel: +probs.over.toFixed(4),
        pImplied: oddOver > 1 ? +(1 / oddOver).toFixed(4) : null,
        odd: +oddOver.toFixed(3), ev: +overEv.toFixed(2),
        label: `Over ${lineKey}`,
      });
    }
    if (Number.isFinite(underEv) && underEv >= minEv && underEv <= maxEv && probs.under >= minPmodel
        && oddUnder >= minOdd && oddUnder <= maxOdd) {
      tips.push({
        market: 'totals', line, side: 'under',
        pModel: +probs.under.toFixed(4),
        pImplied: oddUnder > 1 ? +(1 / oddUnder).toFixed(4) : null,
        odd: +oddUnder.toFixed(3), ev: +underEv.toFixed(2),
        label: `Under ${lineKey}`,
      });
    }
  }

  // ── Double Chance (1X / X2 / 12) ──
  // pinMarkets.dc = { h_d: { odd }, d_a: { odd }, h_a: { odd } } se aggregator tiver.
  // Aggregator atual NÃO traz por default — esperando expansão. Quando vier, este
  // bloco gera tips automaticamente.
  if (pinMarkets.dc && trainedMarkets.dc) {
    const variants = [
      { side: 'h_d', label: 'Home or Draw (1X)', pinOdd: pinMarkets.dc.h_d?.odd ?? pinMarkets.dc['1X'], trainedP: trainedMarkets.dc.h_d },
      { side: 'd_a', label: 'Draw or Away (X2)', pinOdd: pinMarkets.dc.d_a?.odd ?? pinMarkets.dc['X2'], trainedP: trainedMarkets.dc.d_a },
      { side: 'h_a', label: 'Home or Away (12, no draw)', pinOdd: pinMarkets.dc.h_a?.odd ?? pinMarkets.dc['12'], trainedP: trainedMarkets.dc.h_a },
    ];
    for (const v of variants) {
      const oddN = Number(v.pinOdd);
      if (!Number.isFinite(oddN) || oddN <= 1) continue;
      if (!Number.isFinite(v.trainedP)) continue;
      const evN = _ev(v.trainedP, oddN);
      if (Number.isFinite(evN) && evN >= minEv && evN <= maxEv && v.trainedP >= minPmodel
          && oddN >= minOdd && oddN <= maxOdd) {
        tips.push({
          market: 'doubleChance', line: null, side: v.side,
          pModel: +v.trainedP.toFixed(4),
          pImplied: +(1 / oddN).toFixed(4),
          odd: +oddN.toFixed(3), ev: +evN.toFixed(2),
          label: v.label,
        });
      }
    }
  }

  // ── Team Totals (gols home only / gols away only) ──
  // pinMarkets.ouHome = [{ line, oddsOver, oddsUnder }] — futuro coletor expandido.
  for (const teamSide of ['ouHome', 'ouAway']) {
    const lines = pinMarkets[teamSide];
    const trainedTeam = trainedMarkets[teamSide];
    if (!Array.isArray(lines) || !trainedTeam) continue;
    const teamLabel = teamSide === 'ouHome' ? 'Home' : 'Away';
    for (const t of lines) {
      const line = Number(t.line);
      if (!Number.isFinite(line)) continue;
      const lineKey = line.toFixed(1);
      const probs = trainedTeam[lineKey];
      if (!probs) continue;
      const oddOver = Number(t.oddsOver ?? t.over);
      const oddUnder = Number(t.oddsUnder ?? t.under);
      const overEv = _ev(probs.over, oddOver);
      const underEv = _ev(probs.under, oddUnder);
      if (Number.isFinite(overEv) && overEv >= minEv && overEv <= maxEv && probs.over >= minPmodel
          && oddOver >= minOdd && oddOver <= maxOdd) {
        tips.push({
          market: teamSide === 'ouHome' ? 'home_total' : 'away_total',
          line, side: 'over',
          pModel: +probs.over.toFixed(4),
          pImplied: oddOver > 1 ? +(1 / oddOver).toFixed(4) : null,
          odd: +oddOver.toFixed(3), ev: +overEv.toFixed(2),
          label: `${teamLabel} Over ${lineKey}`,
        });
      }
      if (Number.isFinite(underEv) && underEv >= minEv && underEv <= maxEv && probs.under >= minPmodel
          && oddUnder >= minOdd && oddUnder <= maxOdd) {
        tips.push({
          market: teamSide === 'ouHome' ? 'home_total' : 'away_total',
          line, side: 'under',
          pModel: +probs.under.toFixed(4),
          pImplied: oddUnder > 1 ? +(1 / oddUnder).toFixed(4) : null,
          odd: +oddUnder.toFixed(3), ev: +underEv.toFixed(2),
          label: `${teamLabel} Under ${lineKey}`,
        });
      }
    }
  }

  // ── BTTS (Both Teams To Score) ──
  // pinMarkets pode trazer btts via aggregator (não Pinnacle direto). Caller
  // injeta pinMarkets.btts = { yes: 1.85, no: 1.95 } se feed externo tiver.
  if (pinMarkets.btts && trainedMarkets.btts) {
    const yes = Number(pinMarkets.btts.yes);
    const no = Number(pinMarkets.btts.no);
    const yesEv = _ev(trainedMarkets.btts.yes, yes);
    const noEv = _ev(trainedMarkets.btts.no, no);
    if (Number.isFinite(yesEv) && yesEv >= minEv && yesEv <= maxEv && trainedMarkets.btts.yes >= minPmodel
        && yes >= minOdd && yes <= maxOdd) {
      tips.push({
        market: 'btts', line: null, side: 'yes',
        pModel: +trainedMarkets.btts.yes.toFixed(4),
        pImplied: yes > 1 ? +(1 / yes).toFixed(4) : null,
        odd: +yes.toFixed(3), ev: +yesEv.toFixed(2),
        label: 'BTTS Yes',
      });
    }
    if (Number.isFinite(noEv) && noEv >= minEv && noEv <= maxEv && trainedMarkets.btts.no >= minPmodel
        && no >= minOdd && no <= maxOdd) {
      tips.push({
        market: 'btts', line: null, side: 'no',
        pModel: +trainedMarkets.btts.no.toFixed(4),
        pImplied: no > 1 ? +(1 / no).toFixed(4) : null,
        odd: +no.toFixed(3), ev: +noEv.toFixed(2),
        label: 'BTTS No',
      });
    }
  }

  // ── HANDICAPS (Asian Handicap) ──
  // Pinnacle handicap rows: { line, oddsHome, oddsAway }. Se swap=true, home/away
  // do cache estão invertidos vs caller — invertemos line + sides ao aplicar pricing.
  const handicaps = Array.isArray(pinMarkets.handicaps) ? pinMarkets.handicaps : [];
  for (const h of handicaps) {
    const lineRaw = Number(h.line);
    if (!Number.isFinite(lineRaw)) continue;
    // Pinnacle convenção: line é AH applied ao HOME. swap=true → inverte sinal.
    const line = swap ? -lineRaw : lineRaw;
    const lineKey = line.toFixed(1);
    const probs = trainedMarkets.ah?.[lineKey];
    if (!probs) continue;
    const oddHome = Number(swap ? h.oddsAway : h.oddsHome);
    const oddAway = Number(swap ? h.oddsHome : h.oddsAway);
    const homeEv = _ev(probs.home, oddHome);
    const awayEv = _ev(probs.away, oddAway);
    if (Number.isFinite(homeEv) && homeEv >= minEv && homeEv <= maxEv && probs.home >= minPmodel
        && oddHome >= minOdd && oddHome <= maxOdd) {
      tips.push({
        market: 'handicap', line, side: 'home',
        pModel: +probs.home.toFixed(4),
        pImplied: oddHome > 1 ? +(1 / oddHome).toFixed(4) : null,
        odd: +oddHome.toFixed(3), ev: +homeEv.toFixed(2),
        label: `AH ${line >= 0 ? '+' : ''}${lineKey} home`,
      });
    }
    if (Number.isFinite(awayEv) && awayEv >= minEv && awayEv <= maxEv && probs.away >= minPmodel
        && oddAway >= minOdd && oddAway <= maxOdd) {
      tips.push({
        market: 'handicap', line, side: 'away',
        pModel: +probs.away.toFixed(4),
        pImplied: oddAway > 1 ? +(1 / oddAway).toFixed(4) : null,
        odd: +oddAway.toFixed(3), ev: +awayEv.toFixed(2),
        label: `AH ${line >= 0 ? '+' : ''}${lineKey} away`,
      });
    }
  }

  // Dedup: 1 tip por (market, side, line). Mantém o de maior EV (relevante quando
  // Pinnacle expõe múltiplos pricing rows pra mesma line).
  const byKey = new Map();
  for (const t of tips) {
    const k = `${t.market}|${t.side}|${t.line}`;
    const prev = byKey.get(k);
    if (!prev || (t.ev || 0) > (prev.ev || 0)) byKey.set(k, t);
  }
  return [...byKey.values()].sort((a, b) => (b.ev || 0) - (a.ev || 0));
}

module.exports = { scanFootballMarkets };
