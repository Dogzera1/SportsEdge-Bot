'use strict';

const assert = require('assert');
const m = require('../lib/lol-match-metrics');

// Brier: pred 1.0 and outcome 1 => 0; pred 0.5 always => 0.25
assert.ok(Math.abs(m.brier([{ p: 1, y: 1 }, { p: 0, y: 0 }]) - 0) < 1e-9);
assert.ok(Math.abs(m.brier([{ p: 0.5, y: 1 }, { p: 0.5, y: 0 }]) - 0.25) < 1e-9);

// Baseline blue-side: always predicts base-rate p* => Brier = p*(1-p*)
const samples = [{ p: 0, y: 1 }, { p: 0, y: 0 }, { p: 0, y: 1 }]; // base-rate y = 2/3
const b = m.blueSideBaseline(samples);
assert.ok(Math.abs(b.pStar - 2 / 3) < 1e-9);
assert.ok(Math.abs(b.brier - (2 / 3) * (1 / 3)) < 1e-9);

// ECE of perfectly calibrated predictions ~ 0
const cal = Array.from({ length: 100 }, (_, i) => ({ p: 0.7, y: i < 70 ? 1 : 0 }));
assert.ok(m.ece(cal) < 0.05);

console.log('OK test-lol-match-metrics');
