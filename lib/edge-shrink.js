'use strict';

/**
 * edge-shrink.js — anchor a model probability toward the devigged FAIR (market)
 * probability to counter ADVERSE SELECTION.
 *
 * Problem (audit 2026-05-29): the MT scanner computes EV = pModel × RAW_odd − 1
 * and the gate promotes the highest EV. When the model is overconfident in a
 * sub-segment, EV inflates BECAUSE of the overconfidence (not edge), so the gate
 * systematically selects the model's worst calls. Confirmed corr(EV,ROI) tennis
 * −0.48 / totalGames −0.82.
 *
 * Fix: shrink the model toward the market's fair line before computing EV.
 *   p_used = pFair + shrink·(pModel − pFair)
 *     shrink = 1 → trust model fully (current behavior, NO-OP)
 *     shrink = 0 → pure market follower (no edge over the book → no bets fire)
 *     shrink ∈ (0,1) → overconfident high-EV picks shrink the MOST.
 *
 * Used by lib/tennis-market-scanner.js (emission) and the read-only
 * /admin/edge-shrink-fit endpoint (backtest on market_tips_shadow).
 */

/**
 * @param {number} pModel — calibrated model probability for the side
 * @param {number} pFair  — devigged fair probability for the SAME side
 * @param {number} shrink — ∈ [0,1]; ≥1 or non-finite → no-op (trust model)
 * @returns {number} p_used
 */
function applyEdgeShrink(pModel, pFair, shrink) {
  const pm = Number(pModel);
  if (!Number.isFinite(pm)) return pModel; // bad model prob → pass through untouched
  if (pFair == null) return pm;            // null/undefined fair → no-op (Number(null)===0 footgun)
  const pf = Number(pFair);
  let s = Number(shrink);
  if (!Number.isFinite(pf) || !Number.isFinite(s)) return pm; // no fair or bad shrink → trust model
  if (s >= 1) return pm;      // no-op (default)
  if (s < 0) s = 0;           // clamp → pure market
  return pf + s * (pm - pf);
}

// Market → env tag, matching the existing KELLY_TENNIS_HG/TG naming convention.
const _MARKET_TAG = { handicapgames: 'HG', totalgames: 'TG', aces: 'ACES', tiebreakyn: 'TB' };

/**
 * Resolve shrink for a market from env hierarchy (most specific wins):
 *   TENNIS_<TAG>_EDGE_SHRINK  >  TENNIS_MT_EDGE_SHRINK  >  1.0 (no-op default)
 * Out-of-range / non-finite values are ignored (fall through).
 * @param {string} market
 * @param {object} env — defaults to process.env (injectable for tests)
 * @returns {number} shrink ∈ [0,1]
 */
function resolveShrink(market, env = process.env) {
  const mkLower = String(market || '').toLowerCase();
  const tag = _MARKET_TAG[mkLower] || mkLower.toUpperCase();
  const cands = [env[`TENNIS_${tag}_EDGE_SHRINK`], env['TENNIS_MT_EDGE_SHRINK']];
  for (const c of cands) {
    if (c == null || c === '') continue;
    const v = Number(c);
    if (Number.isFinite(v) && v >= 0 && v <= 1) return v;
  }
  return 1.0;
}

/**
 * Backtest: for each shrink in the grid, recompute EV on a set of historical
 * shadow tips, re-apply the EV gate, and measure realized ROI/CLV of the
 * SURVIVING tips. Flat 1u stake — this measures SELECTION quality, not the
 * historical Kelly sizing. P2: this runs on SHADOW (research) data only.
 *
 * @param {Array<{p_model,p_implied,odd,result,clv_pct?}>} tips
 * @param {object} opts — { grid?: number[], minEv?: number }
 * @returns {Array<{shrink,n,roi,meanClv}>}
 */
function backtestShrink(tips, opts = {}) {
  const grid = opts.grid || [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  const minEv = Number.isFinite(opts.minEv) ? opts.minEv : 8;
  const out = [];
  for (const shrink of grid) {
    let n = 0, profit = 0, clvSum = 0, clvN = 0;
    for (const t of (tips || [])) {
      const odd = Number(t.odd);
      if (!Number.isFinite(odd) || odd <= 1) continue;
      const pUsed = applyEdgeShrink(t.p_model, t.p_implied, shrink);
      if (!Number.isFinite(pUsed)) continue;
      const ev = (pUsed * odd - 1) * 100;
      if (ev < minEv) continue; // re-gate
      const res = String(t.result || '').toLowerCase();
      if (res !== 'win' && res !== 'loss') continue; // void/pending excluded from settled
      n++;
      profit += res === 'win' ? (odd - 1) : -1;
      const clv = Number(t.clv_pct);
      if (Number.isFinite(clv)) { clvSum += clv; clvN++; }
    }
    out.push({
      shrink,
      n,
      roi: n ? +(100 * profit / n).toFixed(2) : null,
      meanClv: clvN ? +(clvSum / clvN).toFixed(2) : null,
    });
  }
  return out;
}

module.exports = { applyEdgeShrink, resolveShrink, backtestShrink };
