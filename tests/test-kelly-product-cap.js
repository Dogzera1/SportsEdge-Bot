/**
 * Test Kelly product cap — audit P0 2026-05-15.
 *
 * Cap em lib/utils.js:_applyKelly previne kellyFrac product (CLV × trust ×
 * autotune × tier × steam-boost) exceder MAX_KELLY_FRAC SAGRADO. Cap default
 * 0.15 (= 1.5× base SAGRADO), overridable via env KELLY_PRODUCT_CAP_FRAC.
 *
 * Spec: docs/superpowers/specs/2026-05-15-kelly-product-cap-design.md
 * Plan: docs/superpowers/plans/2026-05-15-kelly-product-cap.md
 */

const fc = require('fast-check');
const { calcKellyWithP } = require('../lib/utils');

module.exports = function runTests(t) {
  // ─── ANCHOR 1: cap fires na repro do audit ────────────────────────────
  t.test('cap fires quando frac > 0.15 (repro audit: 0.25 × 1.5 × 1.3 = 0.4875)', () => {
    const capped = calcKellyWithP(0.55, '2.00', 0.4875, { sport: 'cs', confKey: 'ALTA' });
    const reference = calcKellyWithP(0.55, '2.00', 0.15, { sport: 'cs', confKey: 'ALTA' });
    t.assert(capped === reference,
      `expected cap to clamp frac=0.4875 → reference stake at frac=0.15, got capped="${capped}" reference="${reference}"`);
  });

  // ─── ANCHOR 2: frac SAGRADO base passa sem cap ────────────────────────
  t.test('frac=0.10 (SAGRADO base) passa sem cap', () => {
    const r10 = calcKellyWithP(0.55, '2.00', 0.10, { sport: 'lol' });
    const r14 = calcKellyWithP(0.55, '2.00', 0.14, { sport: 'lol' });
    // Frac < 0.15 = cap não dispara; stakes podem diferir (frac diferente)
    // mas ambos devem ter 'u' suffix (formato canonical).
    t.assert(typeof r10 === 'string' && r10.endsWith('u'), `expected 'u' suffix, got ${r10}`);
    t.assert(typeof r14 === 'string' && r14.endsWith('u'), `expected 'u' suffix, got ${r14}`);
  });

  // ─── ANCHOR 3: Kelly negative bypass preservado ───────────────────────
  t.test('Kelly negative (p × odds < 1) retorna 0u independente de frac alto', () => {
    // p=0.40, odds=1.50 → Kelly negativo (0.40 × 1.50 = 0.60 < 1)
    const r = calcKellyWithP(0.40, '1.50', 0.50, { sport: 'cs' });
    t.assert(/^0(\.0+)?u$/.test(r), `expected '0u' or '0.0u', got ${r}`);
  });

  // ─── ANCHOR 4: cap boundary exato passa unchanged ─────────────────────
  t.test('frac=0.15 (boundary) passa sem cap (não dispara log)', () => {
    const r15 = calcKellyWithP(0.55, '2.00', 0.15, { sport: 'dota2' });
    const r15plus = calcKellyWithP(0.55, '2.00', 0.150001, { sport: 'dota2' });
    t.assert(typeof r15 === 'string' && r15.endsWith('u'), `expected 'u' suffix, got ${r15}`);
    const n15 = parseFloat(r15);
    const n15p = parseFloat(r15plus);
    t.assert(Math.abs(n15 - n15p) <= 0.6,
      `expected boundary stake ≈ capped stake, got r15=${r15} r15plus=${r15plus}`);
  });

  // ─── PROPERTY: cap monotonic — frac > 0.15 → stake ≤ stake @ 0.15 ────
  // Uso fc.integer().map() em vez de fc.float (que requer 32-bit em
  // fast-check moderno). Sample space: frac in [0.15, 1.00] step 0.01,
  // p in [0.51, 0.85] step 0.01, odds in [1.50, 4.00] step 0.01.
  t.test('property: cap monotonic (frac > 0.15 produces stake ≤ stake@0.15)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 15, max: 100 }).map(n => n / 100),
        fc.integer({ min: 51, max: 85 }).map(n => n / 100),
        fc.integer({ min: 150, max: 400 }).map(n => n / 100),
        (frac, p, odds) => {
          const oddsStr = odds.toFixed(2);
          const capped = calcKellyWithP(p, oddsStr, frac, { sport: 'test' });
          const cap15 = calcKellyWithP(p, oddsStr, 0.15, { sport: 'test' });
          const capN = parseFloat(String(capped));
          const ref = parseFloat(String(cap15));
          if (!Number.isFinite(capN) || !Number.isFinite(ref)) return;
          // Stakes em 0.5u grid — cap correto deve produzir capN ≤ ref + 0.5 (snap tolerance)
          if (capN > ref + 0.51) {
            throw new Error(`monotonic violation: frac=${frac.toFixed(3)} p=${p.toFixed(3)} odds=${oddsStr} capped="${capped}" (${capN}) vs cap15="${cap15}" (${ref})`);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
};
