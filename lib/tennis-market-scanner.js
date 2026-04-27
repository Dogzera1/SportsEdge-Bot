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
const { applyMarkovCalib } = require('./tennis-markov-calib');

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
function scanTennisMarkets({ markov, aces, doubleFaults, markets, minEv = 4, bestOf = 3, maxEv = 40, minOdd, maxOdd, maxPerMatch } = {}) {
  if (!markov || !markets) return [];
  const tips = [];
  // Cap top-K tips por match (ordenadas por EV desc após dedup). Motivo: Markov
  // frequentemente precifica handicap+totals+TB+aces na mesma direção (tudo
  // reflete "match longo" ou "team1 forte"), inflando volume sem adicionar edge
  // independente. Cap reduz correlação cruzada entre tips do mesmo jogo.
  const envMaxPerMatch = parseInt(process.env.TENNIS_MARKET_MAX_PER_MATCH, 10);
  const perMatchCap = Number.isFinite(maxPerMatch) && maxPerMatch > 0 ? maxPerMatch
    : Number.isFinite(envMaxPerMatch) && envMaxPerMatch > 0 ? envMaxPerMatch : 3;
  // Min/max odd gate: shadow 14d (n=500) mostrou leak em buckets <1.5
  // (<1.3 ROI -22%, 1.3-1.4 -7%, 1.4-1.5 -13%) vs +ROI consistente em ≥1.5.
  // Caller pode passar minOdd/maxOdd explicitamente (auto-guard); fallback envs
  // TENNIS_MARKET_SCAN_MIN_ODD / _MAX_ODD; default min=1.50, max=null.
  // Passa 0 no env pra desativar.
  const envMinOdd = parseFloat(process.env.TENNIS_MARKET_SCAN_MIN_ODD);
  const envMaxOdd = parseFloat(process.env.TENNIS_MARKET_SCAN_MAX_ODD);
  const oddFloor = Number.isFinite(minOdd) && minOdd > 0 ? minOdd
    : Number.isFinite(envMinOdd) ? envMinOdd : 1.50;
  const oddCap = Number.isFinite(maxOdd) && maxOdd > 1 ? maxOdd
    : (Number.isFinite(envMaxOdd) && envMaxOdd > 1 ? envMaxOdd : null);
  // Sanity cap: EV acima de maxEv (default 40%) quase sempre é bug:
  // handicap fora do range de sets (Pinnacle lista handicap de GAMES como period=0)
  // ou arredondamento 1.0000 em edge case. Filtra.
  // BUG FIX (audit 2026-04-25): pModel ≥0.95 em pré-jogo handicap = overconfidence
  // do Markov (assume serve probs estáticas; reality varia). Aperta cap pra 0.95
  // (era 0.985). Live mid-match com vantagem grande pode ainda chegar perto.
  const maxPModel = parseFloat(process.env.TENNIS_MARKET_SCAN_MAX_PMODEL || '0.95');
  const evSafe = (ev, p, odd) =>
    ev != null && ev <= maxEv && p != null && p < maxPModel
    && Number.isFinite(odd) && odd >= oddFloor
    && (oddCap == null || odd <= oddCap);
  // Handicap máximo plausível em sets: Bo3 = 1.5, Bo5 = 2.5. Fora disso = games handicap.
  const maxAbsLineSets = bestOf >= 5 ? 2.5 : 1.5;

  // 1. Total games (markets.totals) — Pinnacle tennis usa period=0 games totals.
  for (const t of (markets.totals || [])) {
    // Tennis: line típico 21.5, 22.5, 23.5 pra BO3; 35+ pra BO5.
    // Só processa se line parece games (>10 pra separar de games-do-set tipo 9.5).
    if (t.line < 10) continue;
    const pOverRaw = _pOverFromPdf(markov.totalGamesPdf, t.line);
    if (pOverRaw == null) continue;
    const pOver = applyMarkovCalib(pOverRaw, 'totalGames');
    const dj = _dej(t.oddsOver, t.oddsUnder);
    const evO = _ev(pOver, t.oddsOver);
    if (evSafe(evO, pOver, t.oddsOver) && evO >= minEv) {
      tips.push({
        market: 'totalGames', line: t.line, side: 'over',
        pModel: +pOver.toFixed(4),
        pModelRaw: +pOverRaw.toFixed(4),
        pImplied: dj ? +dj.pA.toFixed(4) : null,
        odd: t.oddsOver, ev: +evO.toFixed(2),
        label: `Over ${t.line} games`,
      });
    }
    const pUnderRaw = 1 - pOverRaw;
    const pUnder = applyMarkovCalib(pUnderRaw, 'totalGames');
    const evU = _ev(pUnder, t.oddsUnder);
    if (evSafe(evU, pUnder, t.oddsUnder) && evU >= minEv) {
      tips.push({
        market: 'totalGames', line: t.line, side: 'under',
        pModel: +pUnder.toFixed(4),
        pModelRaw: +pUnderRaw.toFixed(4),
        pImplied: dj ? +dj.pB.toFixed(4) : null,
        odd: t.oddsUnder, ev: +evU.toFixed(2),
        label: `Under ${t.line} games`,
      });
    }
  }

  // 2. Handicap de GAMES (Pinnacle tennis period=0 "spread" = games handicap).
  //    Antes (bug resolvido 2026-04-23): scanner tratava como sets handicap,
  //    precificando via setDist (P[home não bageled] ~95%) contra odd games (~1.77).
  //    Settlement depois contava sets → match era quase sempre win "artificial".
  //    Fix raiz: precificar usando gamesMarginPdf do Markov (match-level games diff)
  //    e settlement contar games margin.
  //
  //    Line range tipo 1.5/2.5/3.5/4.5/5.5+ são todos games handicap match-level.
  //    Sets handicap é um market separado (raramente exposto pelo endpoint base).
  //    Override pra re-ativar handicap SETS (bug path antigo): TENNIS_HANDICAP_SETS_LEGACY=true.
  const { handicapGamesProb } = require('./tennis-markov-model');
  const enableLegacySets = /^(1|true|yes)$/i.test(String(process.env.TENNIS_HANDICAP_SETS_LEGACY || 'false'));
  const enableGamesHandicap = !/^(0|false|no)$/i.test(String(process.env.TENNIS_HANDICAP_GAMES_ENABLED ?? 'true'));
  // Games handicap path — default habilitado.
  // BUG FIX 2026-04-25: prefere markets.gamesHandicaps (separado pelo server.js
  // via groupByVirtual). Fallback pra markets.handicaps (compat). Em ambos casos,
  // rejeita entry com kind='sets' (pinnacle.js retorna sets-tagged quando só
  // virtual Sets está disponível — pricar via gamesMarginPdf seria errado).
  const gamesHandicapsSource = Array.isArray(markets.gamesHandicaps) ? markets.gamesHandicaps : (markets.handicaps || []);
  if (enableGamesHandicap && markov.gamesMarginPdf) {
    for (const h of gamesHandicapsSource) {
      if (h && h.kind === 'sets') continue; // pinnacle só expõe virtual Sets — não pricar como games
      // Tennis games handicap típico: |line| entre 1.5 e 9.5. Filtra absurdos.
      if (!Number.isFinite(h.line) || Math.abs(h.line) > 12) continue;
      const pT1Raw = handicapGamesProb(markov.gamesMarginPdf, h.line);
      if (pT1Raw == null || pT1Raw >= 0.985 || pT1Raw <= 0.015) continue;
      const pT1 = applyMarkovCalib(pT1Raw, 'handicapGames');
      const dj = _dej(h.oddsHome, h.oddsAway);
      const pT2Raw = 1 - pT1Raw;
      const pT2 = applyMarkovCalib(pT2Raw, 'handicapGames');
      const evH = _ev(pT1, h.oddsHome);
      if (evSafe(evH, pT1, h.oddsHome) && evH >= minEv) {
        tips.push({
          market: 'handicapGames', line: h.line, side: 'home',
          pModel: +pT1.toFixed(4),
          pModelRaw: +pT1Raw.toFixed(4),
          pImplied: dj ? +dj.pA.toFixed(4) : null,
          odd: h.oddsHome, ev: +evH.toFixed(2),
          label: `Handicap ${h.line >= 0 ? '+' : ''}${h.line} games team1`,
        });
      }
      const evA = _ev(pT2, h.oddsAway);
      if (evSafe(evA, pT2, h.oddsAway) && evA >= minEv) {
        tips.push({
          market: 'handicapGames', line: -h.line, side: 'away',
          pModel: +pT2.toFixed(4),
          pModelRaw: +pT2Raw.toFixed(4),
          pImplied: dj ? +dj.pB.toFixed(4) : null,
          odd: h.oddsAway, ev: +evA.toFixed(2),
          label: `Handicap ${-h.line >= 0 ? '+' : ''}${-h.line} games team2`,
        });
      }
    }
  }
  // Legacy sets handicap path — OFF by default (bug path).
  if (enableLegacySets) {
    for (const h of (markets.handicaps || [])) {
      if (!markov.setDist) continue;
      const absLine = Math.abs(h.line);
      if (absLine > maxAbsLineSets) continue;
      let pT1 = 0;
      for (const [label, p] of Object.entries(markov.setDist)) {
        const [s1, s2] = label.split('-').map(Number);
        const diff = s1 - s2;
        if (diff + h.line > 0) pT1 += p;
      }
      if (pT1 >= 0.985 || pT1 <= 0.015) continue;
      const dj = _dej(h.oddsHome, h.oddsAway);
      const evH = _ev(pT1, h.oddsHome);
      if (evSafe(evH, pT1, h.oddsHome) && evH >= minEv) {
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
      if (evSafe(evA, pT2, h.oddsAway) && evA >= minEv) {
        tips.push({
          market: 'handicapSets', line: -h.line, side: 'away',
          pModel: +pT2.toFixed(4),
          pImplied: dj ? +dj.pB.toFixed(4) : null,
          odd: h.oddsAway, ev: +evA.toFixed(2),
          label: `Handicap ${-h.line >= 0 ? '+' : ''}${-h.line} sets team2`,
        });
      }
    }
  }

  // 3. Tiebreak yes/no (opcional — se Pinnacle expor)
  if (markets.tiebreakYN && Number.isFinite(markov.pTiebreakMatch)) {
    const { yes: oYes, no: oNo } = markets.tiebreakYN;
    if (oYes && oNo) {
      const dj = _dej(oYes, oNo);
      const evY = _ev(markov.pTiebreakMatch, oYes);
      if (evSafe(evY, markov.pTiebreakMatch, oYes) && evY >= minEv) {
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
      if (evSafe(evN, pTbNo, oNo) && evN >= minEv) {
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
      if (evSafe(evO, pOver, a.oddsOver) && evO >= minEv) {
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
      if (evSafe(evU, pAcesUnder, a.oddsUnder) && evU >= minEv) {
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

  // 5. Double Faults over/under (precisa markets.dfTotals = [{line, oddsOver, oddsUnder}])
  if (doubleFaults && Array.isArray(markets.dfTotals)) {
    for (const a of markets.dfTotals) {
      const pOver = doubleFaults.pOver?.[String(a.line)];
      if (!Number.isFinite(pOver)) continue;
      const dj = _dej(a.oddsOver, a.oddsUnder);
      const evO = _ev(pOver, a.oddsOver);
      if (evSafe(evO, pOver, a.oddsOver) && evO >= minEv) {
        tips.push({
          market: 'totalDoubleFaults', line: a.line, side: 'over',
          pModel: +pOver.toFixed(4),
          pImplied: dj ? +dj.pA.toFixed(4) : null,
          odd: a.oddsOver, ev: +evO.toFixed(2),
          label: `Over ${a.line} double faults`,
        });
      }
      const pUnder = 1 - pOver;
      const evU = _ev(pUnder, a.oddsUnder);
      if (evSafe(evU, pUnder, a.oddsUnder) && evU >= minEv) {
        tips.push({
          market: 'totalDoubleFaults', line: a.line, side: 'under',
          pModel: +pUnder.toFixed(4),
          pImplied: dj ? +dj.pB.toFixed(4) : null,
          odd: a.oddsUnder, ev: +evU.toFixed(2),
          label: `Under ${a.line} double faults`,
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
    return [...byKey.values()].sort((a, b) => b.ev - a.ev).slice(0, perMatchCap);
  }
  tips.sort((a, b) => b.ev - a.ev);
  return tips.slice(0, perMatchCap);
}

module.exports = { scanTennisMarkets };
