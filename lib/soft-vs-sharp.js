'use strict';

/**
 * soft-vs-sharp.js — decide whether a detected soft-book over-odd (a Pinnacle-
 * anchored super-odd event) qualifies as a +EV REAL emit vs the de-vigged SHARP line.
 *
 * Research basis (leak diagnosis 2026-05-29): the model-vs-sharp strategy is
 * adverse-selected; the durable +EV is betting SOFT books that lag the sharp
 * (Pinnacle) close. `detectSuperOdd` already devigs the sharp line and computes
 * EV = soft_odd × fair − 1. This adds the EMIT gate the detector lacked:
 *   (1) a static EV threshold, and
 *   (2) a FRESHNESS re-check on the chosen soft entry's capture time — the
 *       staleness gap: nothing re-checked `_capturedAt` at emit time, and the BR
 *       aggregator feed can be days stale, so a +EV off a dead price is bogus.
 *
 * Pure/synchronous → unit-testable. The bot wires it into runStaleLineCron and
 * routes ok=true through /record-tip (which sizes via portfolio Kelly and
 * shadow-gates server-side). Default OFF (SOFT_VS_SHARP_ENABLED unset → no-op).
 *
 * Env:
 *   SOFT_VS_SHARP_ENABLED      opt-in master switch (default off)
 *   SOFT_VS_SHARP_MIN_EV       min EV% vs devigged sharp (default 3)
 *   SOFT_VS_SHARP_MAX_AGE_MIN  max age of the soft price in minutes (default 15)
 *
 * @param {object}  args
 * @param {object}  args.superEvt     detectSuperOdd() event {mode,superBook,superOdd,evPct,pinImpliedPct,...}
 * @param {string}  [args.capturedAt] ISO capture time of the chosen soft book (_capturedAt); null/'' = live source
 * @param {object}  [args.env]        defaults to process.env (injectable for tests)
 * @param {number}  [args.nowMs]      defaults to Date.now()
 * @returns {{ok:boolean, reason:string, fairP?:number, evPct?:number, odd?:number, book?:string, ageMin?:number}}
 */
function evaluateSoftVsSharp({ superEvt, capturedAt, env = process.env, nowMs = Date.now() } = {}) {
  if (!/^(1|true|yes)$/i.test(String(env.SOFT_VS_SHARP_ENABLED || ''))) return { ok: false, reason: 'disabled' };
  if (!superEvt) return { ok: false, reason: 'no_event' };
  // Require a SHARP anchor (Pinnacle-devigged fair). Cross-book median is too weak for real money.
  if (superEvt.mode !== 'pinnacle') return { ok: false, reason: 'no_sharp_anchor' };

  const evPct = Number(superEvt.evPct);
  const minEv = parseFloat(env.SOFT_VS_SHARP_MIN_EV || '3');
  if (!Number.isFinite(evPct) || evPct < minEv) return { ok: false, reason: 'ev_below_min', evPct };

  const odd = Number(superEvt.superOdd);
  if (!Number.isFinite(odd) || odd < 1.20 || odd > 5.00) return { ok: false, reason: 'odd_out_of_range', odd };

  const fairP = Number(superEvt.pinImpliedPct) / 100;
  if (!Number.isFinite(fairP) || fairP <= 0 || fairP >= 1) return { ok: false, reason: 'bad_fair_prob' };

  // Freshness: the BR aggregator stamps _capturedAt; live sources (Pinnacle/TheOddsAPI)
  // don't. Absent → treat as fresh (live). Present but unparseable → reject (money safety).
  // Present and older than MAX_AGE_MIN → stale (the dead-feed guard).
  if (capturedAt != null && String(capturedAt) !== '') {
    const maxAgeMin = parseFloat(env.SOFT_VS_SHARP_MAX_AGE_MIN || '15');
    let ms = Date.parse(String(capturedAt));
    if (Number.isNaN(ms)) ms = Date.parse(String(capturedAt).replace(' ', 'T') + 'Z');
    if (Number.isNaN(ms)) return { ok: false, reason: 'captured_at_unparseable' };
    const ageMin = (nowMs - ms) / 60000;
    if (ageMin > maxAgeMin) return { ok: false, reason: 'stale', ageMin: +ageMin.toFixed(1) };
  }

  return { ok: true, reason: 'emit', fairP, evPct, odd, book: superEvt.superBook };
}

module.exports = { evaluateSoftVsSharp };
