'use strict';

/**
 * lib/lol-match-metrics.js
 *
 * Thin wrapper exposing Brier / log-loss / ECE metrics + blue-side baseline
 * for the Match Lab predictor. Reuses _computeEce from brier-holdout-eval
 * (same {p, y} sample contract — no field remapping required).
 */

const { _computeEce } = require('./brier-holdout-eval');

// samples: Array<{ p:number(0..1), y:0|1 }>

function brier(samples) {
  if (!samples.length) return NaN;
  let s = 0;
  for (const x of samples) s += (x.p - x.y) ** 2;
  return s / samples.length;
}

function logloss(samples) {
  if (!samples.length) return NaN;
  let s = 0;
  for (const x of samples) {
    const p = Math.min(1 - 1e-9, Math.max(1e-9, x.p));
    s += -(x.y * Math.log(p) + (1 - x.y) * Math.log(1 - p));
  }
  return s / samples.length;
}

function ece(samples) {
  // _computeEce expects {p, y} — same contract as our samples array.
  return _computeEce(samples) ?? NaN;
}

// Baseline: always predicts the global base-rate (≈ blue-side win rate).
// Brier of this baseline = p*(1-p); the model must beat this to add value.
function blueSideBaseline(samples) {
  const pStar = samples.length
    ? samples.reduce((a, x) => a + x.y, 0) / samples.length
    : 0.5;
  return { pStar, brier: brier(samples.map(x => ({ p: pStar, y: x.y }))) };
}

module.exports = { brier, logloss, ece, blueSideBaseline };
