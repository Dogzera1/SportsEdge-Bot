'use strict';

/**
 * tennis-market-scanner.js — varre mercados Pinnacle tennis contra pricing
 * Markov + Poisson (aces). Complementa odds-markets-scanner (esports) mas usa
 * estrutura diferente: tennis tem muitos lines fracionários (21.5, 22.5, ...)
 * e mercados especiais (TB yes/no, correct score 2-0).
 *
 * Mercados suportados:
 *   - Total games over/under (interpola totalGamesPdf)
 *   - Total sets over/under (via setDist)
 *   - Tiebreak in match yes/no
 *   - Set correct score (2-0, 2-1, 0-2, 1-2 em BO3)
 *   - Aces over/under (Poisson)
 *
 * Markets format (Pinnacle-like do /odds-markets):
 *   markets.totals = [{line, oddsOver, oddsUnder, period}]  # games totals quando period=0
 *   markets.handicaps = [{line, oddsHome, oddsAway, period}] # sets handicap
 *
 * Tennis specific markets requer markets.acesTotals, markets.tiebreakYN, etc.
 * passados separadamente (Pinnacle devolve tudo em getMatchupMarkets).
 */

const { devigMultiplicative } = require('./devig');

function _ev(pModel, odd) {
  if (!Number.isFinite(pModel) || !Number.isFinite(odd) || odd <= 1) return null;
  return (pModel * odd - 1) * 100;
}

function _dej(a, b) {
  const r = devigMultiplicative(a, b);
  return r ? { pA: r.p1, pB: r.p2 } : null;
}

/**
 * Interpola P(over line) do totalGamesPdf.
 * pdf é {numGames: prob, ...}. Para line=22.5, sum probs com numGames > 22.5.
 */
function _pOverFromPdf(pdf, line) {
  if (!pdf) return null;
  let s = 0;
  for (const [kStr, v] of Object.entries(pdf)) {
    const k = Number(kStr);
    if (Number.isFinite(k) && k > line) s += v;
  }
  return s;
}

/**
 * Precifica mercados tennis comuns.
 *
 * @param {object} args
 * @param {object} args.markov — output de priceTennisMatch(): { pMatch, totalGamesPdf, pTiebreakMatch, pStraightSets, setDist }
 * @param {object} [args.aces] — output de estimateTennisAces(): { pOver: {'8.5': 0.72, ...}, totalAcesAvg }
 * @param {object} args.markets — { moneyline, handicaps: [], totals: [] } mais opcionais acesTotals[], tiebreakYN{yes,no}
 * @param {number} [args.minEv=4]
 * @returns {Array<{market, line, side, pModel, pImplied, odd, ev, label}>}
 */
function scanTennisMarkets({ markov, aces, markets, minEv = 4, bestOf = 3, maxEv = 40 }) {
  if (!markov || !markets) return [];
  const tips = [];
  // Sanity cap: EV acima de maxEv (default 40%) quase sempre é bug:
  // handicap fora do range de sets (Pinnacle lista handicap de GAMES como period=0)
  // ou arredondamento 1.0000 em edge case. Filtra.
  const evSafe = (ev, p) => ev != null && ev <= maxEv && p != null && p < 0.985;
  // Handicap máximo plausível em sets: Bo3 = 1.5, Bo5 = 2.5. Fora disso = games handicap.
  const maxAbsLineSets = bestOf >= 5 ? 2.5 : 1.5;

  // 1. Total games (markets.totals) — Pinnacle tennis usa period=0 games totals.
  for (const t of (markets.totals || [])) {
    // Tennis: line típico 21.5, 22.5, 23.5 pra BO3; 35+ pra BO5.
    // Só processa se line parece games (>10 pra separar de games-do-set tipo 9.5).
    if (t.line < 10) continue;
    const pOver = _pOverFromPdf(markov.totalGamesPdf, t.line);
    if (pOver == null) continue;
    const dj = _dej(t.oddsOver, t.oddsUnder);
    const evO = _ev(pOver, t.oddsOver);
    if (evSafe(evO, pOver) && evO >= minEv) {
      tips.push({
        market: 'totalGames', line: t.line, side: 'over',
        pModel: +pOver.toFixed(4),
        pImplied: dj ? +dj.pA.toFixed(4) : null,
        odd: t.oddsOver, ev: +evO.toFixed(2),
        label: `Over ${t.line} games`,
      });
    }
    const pUnder = 1 - pOver;
    const evU = _ev(pUnder, t.oddsUnder);
    if (evSafe(evU, pUnder) && evU >= minEv) {
      tips.push({
        market: 'totalGames', line: t.line, side: 'under',
        pModel: +pUnder.toFixed(4),
        pImplied: dj ? +dj.pB.toFixed(4) : null,
        odd: t.oddsUnder, ev: +evU.toFixed(2),
        label: `Under ${t.line} games`,
      });
    }
  }

  // 2. Handicaps (set handicap em BO3 é -1.5/+1.5, BO5 é ±2.5).
  //    setDist tem P(2-0, 2-1, 1-2, 0-2) — deriva handicap direto.
  //    IMPORTANTE: Pinnacle period=0 lista também handicap de GAMES (linhas maiores,
  //    ex: ±2.5 em Bo3 é games handicap, não sets). Filtramos por maxAbsLineSets.
  for (const h of (markets.handicaps || [])) {
    if (!markov.setDist) continue;
    const absLine = Math.abs(h.line);
    if (absLine > maxAbsLineSets) continue; // provavelmente games handicap — skip
    let pT1 = 0;
    for (const [label, p] of Object.entries(markov.setDist)) {
      const [s1, s2] = label.split('-').map(Number);
      const diff = s1 - s2;
      if (diff + h.line > 0) pT1 += p;
    }
    // Sanity: se pT1 = 1.0 (ou 0.0), handicap é trivial — skip
    if (pT1 >= 0.985 || pT1 <= 0.015) continue;
    const dj = _dej(h.oddsHome, h.oddsAway);
    const evH = _ev(pT1, h.oddsHome);
    if (evSafe(evH, pT1) && evH >= minEv) {
      tips.push({
        market: 'handicapSets', line: h.line, side: 'home',
        pModel: +pT1.toFixed(4),
        pImplied: dj ? +dj.pA.toFixed(4) : null,
        odd: h.oddsHome, ev: +evH.toFixed(2),
        label: `Handicap ${h.line >= 0 ? '+' : ''}${h.line} sets team1`,
      });
    }
    const pT2 = 1 - pT1;
    const evA = _ev(pT2, h.oddsAway);
    if (evSafe(evA, pT2) && evA >= minEv) {
      tips.push({
        market: 'handicapSets', line: -h.line, side: 'away',
        pModel: +pT2.toFixed(4),
        pImplied: dj ? +dj.pB.toFixed(4) : null,
        odd: h.oddsAway, ev: +evA.toFixed(2),
        label: `Handicap ${-h.line >= 0 ? '+' : ''}${-h.line} sets team2`,
      });
    }
  }

  // 3. Tiebreak yes/no (opcional — se Pinnacle expor)
  if (markets.tiebreakYN && Number.isFinite(markov.pTiebreakMatch)) {
    const { yes: oYes, no: oNo } = markets.tiebreakYN;
    if (oYes && oNo) {
      const dj = _dej(oYes, oNo);
      const evY = _ev(markov.pTiebreakMatch, oYes);
      if (evSafe(evY, markov.pTiebreakMatch) && evY >= minEv) {
        tips.push({
          market: 'tiebreakMatch', line: null, side: 'yes',
          pModel: +markov.pTiebreakMatch.toFixed(4),
          pImplied: dj ? +dj.pA.toFixed(4) : null,
          odd: oYes, ev: +evY.toFixed(2),
          label: 'Tiebreak YES',
        });
      }
      const pTbNo = 1 - markov.pTiebreakMatch;
      const evN = _ev(pTbNo, oNo);
      if (evSafe(evN, pTbNo) && evN >= minEv) {
        tips.push({
          market: 'tiebreakMatch', line: null, side: 'no',
          pModel: +pTbNo.toFixed(4),
          pImplied: dj ? +dj.pB.toFixed(4) : null,
          odd: oNo, ev: +evN.toFixed(2),
          label: 'Tiebreak NO',
        });
      }
    }
  }

  // 4. Aces over/under (opcional — precisa markets.acesTotals = [{line, oddsOver, oddsUnder}])
  if (aces && Array.isArray(markets.acesTotals)) {
    for (const a of markets.acesTotals) {
      const pOver = aces.pOver?.[String(a.line)];
      if (!Number.isFinite(pOver)) continue;
      const dj = _dej(a.oddsOver, a.oddsUnder);
      const evO = _ev(pOver, a.oddsOver);
      if (evSafe(evO, pOver) && evO >= minEv) {
        tips.push({
          market: 'totalAces', line: a.line, side: 'over',
          pModel: +pOver.toFixed(4),
          pImplied: dj ? +dj.pA.toFixed(4) : null,
          odd: a.oddsOver, ev: +evO.toFixed(2),
          label: `Over ${a.line} aces`,
        });
      }
      const pAcesUnder = 1 - pOver;
      const evU = _ev(pAcesUnder, a.oddsUnder);
      if (evSafe(evU, pAcesUnder) && evU >= minEv) {
        tips.push({
          market: 'totalAces', line: a.line, side: 'under',
          pModel: +pAcesUnder.toFixed(4),
          pImplied: dj ? +dj.pB.toFixed(4) : null,
          odd: a.oddsUnder, ev: +evU.toFixed(2),
          label: `Under ${a.line} aces`,
        });
      }
    }
  }

  // Dedup: 1 tip por (market, side). Linhas correlacionadas do mesmo mercado
  // (ex: Over 19.5 / 20.5 / 21.5) mantém só a LINHA LIMITE — linha com maior
  // pModel (mais conservadora, menor variância). Ex: Over 19.5 P=65% vs
  // Over 21.5 P=53% → escolhe 19.5.
  // Different markets (totalGames + handicap + TB) não são dedupeados entre si.
  // Override via TENNIS_MARKET_DEDUP=false.
  if (!/^(0|false|no)$/i.test(String(process.env.TENNIS_MARKET_DEDUP || ''))) {
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

module.exports = { scanTennisMarkets };
