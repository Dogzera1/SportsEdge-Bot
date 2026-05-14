'use strict';

/**
 * cs-rounds-model.js — pricing round-level pra CS2 per-map (handicap rounds,
 * total rounds). Complementa cs-live-pricing.js (que opera map-level).
 *
 * Modelo: Normal aproximação pra round difference e round total dentro
 * de um mapa CS2 MR12 (first-to-13 + OT).
 *
 * Math:
 *   μ_diff(pMap) = K * (pMap - 0.5)
 *   σ_diff       = 3.5 rounds (empirical CS pro circuit)
 *   μ_total      = 24 rounds (avg MR12 sem OT) + OT_inflation
 *   σ_total      = 3.0 rounds
 *
 * K calibrado de pro data: pMap=0.75 → diff típico ~4-5 rounds → K ≈ 16.
 * pMap=0.60 → diff ~1.5-2 rounds (mid-tier matchup).
 *
 * Live conditional (score parcial s1 rounds team1, s2 rounds team2):
 *   current_diff = s1 - s2
 *   remaining = max(0, 24 - s1 - s2)
 *   μ_diff_final = current_diff + K * (pMap - 0.5) * (remaining / 24)
 *   σ_diff_final = σ_diff * sqrt(remaining / 24)
 *
 * P(team1 covers spread L) = P(team1_rounds - team2_rounds > -L) = 1 - Φ((-L - μ) / σ)
 * P(over X total)          = 1 - Φ((X - μ_total) / σ_total)
 *
 * Convention storage (mesma esports MT):
 *   side='team1' / 'team2' (handicap), 'over' / 'under' (total)
 *   line stored as Pinnacle (team1 perspective ou ou/under literal)
 *
 * Uso:
 *   const { scanCsRoundsMarkets } = require('./cs-rounds-model');
 *   const tips = scanCsRoundsMarkets({
 *     pinMarkets, pMap, period,
 *     score, isLive,
 *     minEv: 4, maxEv: 30, minPmodel: 0.50,
 *     minOdd: 1.50, maxOdd: 3.50,
 *   });
 */

// Standard normal CDF via Abramowitz & Stegun 7.1.26 (~7e-8 precision).
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

function _clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0.05, Math.min(0.95, n));
}

/**
 * Params de round-diff per-map dado pMap + score atual.
 * @param {number} pMap   P(team1 ganha o mapa)
 * @param {object} opts   { score1, score2 } rounds atuais (default 0,0)
 * @returns {{mu: number, sigma: number, remaining: number}}
 */
function roundDiffParams(pMap, opts = {}) {
  const p = _clamp01(pMap);
  const score1 = Math.max(0, Math.floor(Number(opts.score1) || 0));
  const score2 = Math.max(0, Math.floor(Number(opts.score2) || 0));
  const K = Number(opts.K) || 16; // tuning constant — pMap=0.75 → μ_diff=+4
  const sigmaFull = Number(opts.sigmaFull) || 3.5;
  // Total avg full game: 24 rounds (MR12 expected). OT inflate apenas em final stretch.
  const expectedTotal = 24;
  const playedRounds = score1 + score2;
  const remaining = Math.max(0, expectedTotal - playedRounds);
  const currentDiff = score1 - score2;
  // Remaining-rounds contribution. Scaled (remaining/24) — quando todas
  // rounds futuras, variance plena. Quando 0 remaining, variance 0.
  const fraction = remaining / expectedTotal;
  const mu = currentDiff + K * (p - 0.5) * fraction;
  // Sigma escala com sqrt(remaining) pq variance é soma de var per-round.
  const sigma = Math.max(0.5, sigmaFull * Math.sqrt(fraction));
  return { mu, sigma, remaining, currentDiff };
}

/**
 * Params de round-total per-map dado pMap + score atual.
 * @returns {{mu: number, sigma: number}}
 */
function roundTotalParams(pMap, opts = {}) {
  const p = _clamp01(pMap);
  const score1 = Math.max(0, Math.floor(Number(opts.score1) || 0));
  const score2 = Math.max(0, Math.floor(Number(opts.score2) || 0));
  const sigmaTotalFull = Number(opts.sigmaTotalFull) || 3.0;
  const expectedTotal = 24;
  const playedRounds = score1 + score2;
  const remaining = Math.max(0, expectedTotal - playedRounds);
  const fraction = remaining / expectedTotal;
  // Mismatch reduz total — sweep 16-6 = 22 rounds, vs match equilibrado 16-14 = 30.
  // Lighter penalty: |pMap - 0.5| > 0.15 reduz expected total proporcional.
  const skew = Math.abs(p - 0.5);
  const totalAdj = skew > 0.10 ? -2.0 * (skew - 0.10) * 10 : 0; // até -4 rounds em sweep extreme
  const muRemaining = (expectedTotal + totalAdj) - playedRounds;
  const mu = playedRounds + Math.max(0, muRemaining);
  const sigma = Math.max(0.5, sigmaTotalFull * Math.sqrt(fraction));
  return { mu, sigma, remaining };
}

/**
 * Scanner principal — varre handicap/total rounds (CS2 per-map).
 *
 * @param {object} args
 * @param {object} args.pinMarkets      { handicaps: [...], totals: [...], swap }
 *                                       handicaps[i].line é HOME perspective; swap=true reverte.
 * @param {number} args.pMap            P(team1 ganha o mapa)
 * @param {object} [args.score]         { score1, score2 } live rounds (default 0,0)
 * @param {number} [args.minEv=4]
 * @param {number} [args.maxEv=30]
 * @param {number} [args.minPmodel=0.50]
 * @param {number} [args.minOdd=1.50]
 * @param {number} [args.maxOdd=3.50]
 * @param {number} [args.maxPerMatch=3] cap top-K por EV
 * @param {boolean} [args.isLive=false]
 * @returns {Array} tips
 */
function scanCsRoundsMarkets({
  pinMarkets,
  pMap,
  score = {},
  minEv = 4, maxEv = 30,
  minPmodel = 0.50,
  minOdd = 1.50, maxOdd = 3.50,
  maxPerMatch = parseInt(process.env.CS_ROUNDS_MAX_PER_MATCH || '3', 10),
  isLive = false,
} = {}) {
  if (!pinMarkets || !Number.isFinite(pMap)) return [];
  const swap = !!pinMarkets.swap;
  const tips = [];
  const oddOk = (o) => Number.isFinite(o) && o >= minOdd && o <= maxOdd;

  const diffParams = roundDiffParams(pMap, { score1: score.score1, score2: score.score2 });
  const totalParams = roundTotalParams(pMap, { score1: score.score1, score2: score.score2 });

  // ── HANDICAP ROUNDS ──
  const handicaps = Array.isArray(pinMarkets.handicaps) ? pinMarkets.handicaps : [];
  for (const h of handicaps) {
    const lineRaw = Number(h.line);
    if (!Number.isFinite(lineRaw)) continue;
    // CS round handicaps típicas ±1.5..±13.5. Filtra ruído.
    if (Math.abs(lineRaw) > 18) continue;
    const lineT1 = swap ? -lineRaw : lineRaw;
    const oddT1 = Number(swap ? h.oddsAway : h.oddsHome);
    const oddT2 = Number(swap ? h.oddsHome : h.oddsAway);
    // P(team1 covers +line) = P(team1_diff > -line) = 1 - Φ((-line - μ) / σ)
    const zT1 = (-lineT1 - diffParams.mu) / diffParams.sigma;
    const pT1 = 1 - _normalCdf(zT1);
    const pT2 = 1 - pT1;
    const evT1 = _ev(pT1, oddT1);
    const evT2 = _ev(pT2, oddT2);
    if (Number.isFinite(evT1) && evT1 >= minEv && evT1 <= maxEv && pT1 >= minPmodel && oddOk(oddT1)) {
      tips.push({
        market: 'handicap_rounds', line: lineT1, side: 'team1',
        pModel: +pT1.toFixed(4),
        pImplied: oddT1 > 1 ? +(1 / oddT1).toFixed(4) : null,
        odd: +oddT1.toFixed(3), ev: +evT1.toFixed(2),
        label: `Handicap ${lineT1 >= 0 ? '+' : ''}${lineT1} rounds team1`,
        meta: { mu_diff: +diffParams.mu.toFixed(2), sigma_diff: +diffParams.sigma.toFixed(2) },
      });
    }
    if (Number.isFinite(evT2) && evT2 >= minEv && evT2 <= maxEv && pT2 >= minPmodel && oddOk(oddT2)) {
      const lineT2 = -lineT1;
      tips.push({
        market: 'handicap_rounds', line: lineT2, side: 'team2',
        pModel: +pT2.toFixed(4),
        pImplied: oddT2 > 1 ? +(1 / oddT2).toFixed(4) : null,
        odd: +oddT2.toFixed(3), ev: +evT2.toFixed(2),
        label: `Handicap ${lineT2 >= 0 ? '+' : ''}${lineT2} rounds team2`,
        meta: { mu_diff: +diffParams.mu.toFixed(2), sigma_diff: +diffParams.sigma.toFixed(2) },
      });
    }
  }

  // ── TOTAL ROUNDS ──
  const totals = Array.isArray(pinMarkets.totals) ? pinMarkets.totals : [];
  for (const t of totals) {
    const line = Number(t.line);
    if (!Number.isFinite(line)) continue;
    // CS round totals típicas 20.5..30.5. Filtra ruído.
    if (line < 12 || line > 36) continue;
    const oddOver = Number(t.oddsOver);
    const oddUnder = Number(t.oddsUnder);
    const z = (line - totalParams.mu) / totalParams.sigma;
    const pUnder = _normalCdf(z);
    const pOver = 1 - pUnder;
    const overEv = _ev(pOver, oddOver);
    const underEv = _ev(pUnder, oddUnder);
    if (Number.isFinite(overEv) && overEv >= minEv && overEv <= maxEv && pOver >= minPmodel && oddOk(oddOver)) {
      tips.push({
        market: 'total_rounds', line, side: 'over',
        pModel: +pOver.toFixed(4),
        pImplied: oddOver > 1 ? +(1 / oddOver).toFixed(4) : null,
        odd: +oddOver.toFixed(3), ev: +overEv.toFixed(2),
        label: `Over ${line} rounds`,
        meta: { mu_total: +totalParams.mu.toFixed(2), sigma_total: +totalParams.sigma.toFixed(2) },
      });
    }
    if (Number.isFinite(underEv) && underEv >= minEv && underEv <= maxEv && pUnder >= minPmodel && oddOk(oddUnder)) {
      tips.push({
        market: 'total_rounds', line, side: 'under',
        pModel: +pUnder.toFixed(4),
        pImplied: oddUnder > 1 ? +(1 / oddUnder).toFixed(4) : null,
        odd: +oddUnder.toFixed(3), ev: +underEv.toFixed(2),
        label: `Under ${line} rounds`,
        meta: { mu_total: +totalParams.mu.toFixed(2), sigma_total: +totalParams.sigma.toFixed(2) },
      });
    }
  }

  // Dedup por (market, side, line) — Pinnacle pode listar mesma line múltiplas vezes.
  const byKey = new Map();
  for (const t of tips) {
    const k = `${t.market}|${t.side}|${t.line}`;
    const prev = byKey.get(k);
    if (!prev || (t.ev || 0) > (prev.ev || 0)) byKey.set(k, t);
  }
  const sorted = [...byKey.values()].sort((a, b) => (b.ev || 0) - (a.ev || 0));
  if (Number.isFinite(maxPerMatch) && maxPerMatch > 0 && sorted.length > maxPerMatch) {
    return sorted.slice(0, maxPerMatch);
  }
  return sorted;
}

module.exports = { scanCsRoundsMarkets, roundDiffParams, roundTotalParams, _normalCdf };
