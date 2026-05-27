'use strict';

const assert = require('assert');
const { classifyTier } = require('../lib/mt-tier-classifier');

// Mirror constants from lib/valorant-ml.js to verify behavior.
// If valorant-ml.js changes, these values should mirror.
const VALORANT_TIER_SHRINK = {
  tier1_intl: 0.00,
  tier2_franchised: 0.10,
  tier3_challengers: 0.50,
  tier4_game_changers: 0.25,
  tier_unknown: 0.15,
};

function applyShrink(p1, p2, league) {
  const tier = classifyTier('valorant', league);
  const alpha = VALORANT_TIER_SHRINK[tier] ?? 0.15;
  if (alpha === 0) return { p1, p2, tier, alpha };
  return {
    p1: p1 * (1 - alpha) + 0.5 * alpha,
    p2: p2 * (1 - alpha) + 0.5 * alpha,
    tier,
    alpha,
  };
}

describe('valorant tier-aware shrink', () => {
  it('tier1_intl: no shrink (modelP preserved)', () => {
    const r = applyShrink(0.65, 0.35, 'VCT Masters Toronto 2025');
    assert.strictEqual(r.tier, 'tier1_intl');
    assert.strictEqual(r.alpha, 0.00);
    assert.strictEqual(r.p1, 0.65);
    assert.strictEqual(r.p2, 0.35);
  });

  it('tier2_franchised: small shrink toward 0.5', () => {
    const r = applyShrink(0.70, 0.30, 'Valorant - Champions Tour: Americas');
    assert.strictEqual(r.tier, 'tier2_franchised');
    assert.strictEqual(r.alpha, 0.10);
    assert.ok(Math.abs(r.p1 - 0.68) < 0.001, `expected 0.68, got ${r.p1}`);
    assert.ok(Math.abs(r.p2 - 0.32) < 0.001, `expected 0.32, got ${r.p2}`);
  });

  it('tier3_challengers: heavy shrink for Spain (documented -100%)', () => {
    const r = applyShrink(0.80, 0.20, 'VCL Spain');
    assert.strictEqual(r.tier, 'tier3_challengers');
    assert.strictEqual(r.alpha, 0.50);
    assert.ok(Math.abs(r.p1 - 0.65) < 0.001, `expected 0.65, got ${r.p1}`);
    assert.ok(Math.abs(r.p2 - 0.35) < 0.001, `expected 0.35, got ${r.p2}`);
  });

  it('symmetric shrink preserves sum P1+P2 = 1', () => {
    for (const league of ['VCL Spain', 'VCT EMEA', 'VCT Masters', 'unknown league']) {
      const r = applyShrink(0.62, 0.38, league);
      assert.ok(Math.abs(r.p1 + r.p2 - 1.0) < 0.0001, `sum broke for ${league}: ${r.p1 + r.p2}`);
    }
  });

  it('tier_unknown: moderate shrink (0.15)', () => {
    const r = applyShrink(0.55, 0.45, 'Some Random Tournament Foo Bar');
    assert.strictEqual(r.tier, 'tier_unknown');
    assert.strictEqual(r.alpha, 0.15);
  });

  it('alpha=0 returns unchanged probabilities (early exit)', () => {
    const r = applyShrink(0.55, 0.45, 'VCT Champions Seoul 2024');
    assert.strictEqual(r.alpha, 0.00);
    assert.strictEqual(r.p1, 0.55);
    assert.strictEqual(r.p2, 0.45);
  });
});
