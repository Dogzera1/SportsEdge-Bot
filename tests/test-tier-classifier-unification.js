/**
 * Sprint 2 — Tier classifier unification (P3 tech debt resolution)
 *
 * Pre-fix state:
 *   - lib/esports-runtime-features.leagueTier (return 3=top, 2=mid, 1=other) is ML feature
 *   - lib/league-tier.js getLeagueTier (return 1=top, 2=mid, 3=other) is canonical
 *   - esports-segment-gate.js uses runtime-feat.leagueTier with manual inversion shim
 *   - league-tier.js MISSING: \bewc\b/esports world cup (tier1) + \bcct\b (tier2)
 *
 * Post-fix:
 *   - league-tier.js owns operational tier semantics (1=top, 2=mid, 3=other)
 *   - league-tier.js adds EWC + CCT from audit 2026-05-11
 *   - esports-segment-gate.js delegates to getLeagueTier — no inversion shim
 *   - runtime-feat.leagueTier locked as ML feature internal (JSDoc warns)
 */

const { getLeagueTier } = require('../lib/league-tier');
const { leagueTier: runtimeFeatLeagueTier } = require('../lib/esports-runtime-features');
const { esportsSegmentGate } = require('../lib/esports-segment-gate');

module.exports = function(t) {
  // ── league-tier.js canonical: anchor existing + new audit refinements ──
  t.test('canonical: LCK is tier 1 (top)', () => {
    t.assert(getLeagueTier('lol', 'LCK Spring') === 1, 'LCK should be tier1');
  });

  t.test('canonical: IEM Cologne is tier 1', () => {
    t.assert(getLeagueTier('cs2', 'IEM Cologne 2026') === 1, 'IEM Cologne should be tier1');
  });

  t.test('canonical (audit refinement): EWC is tier 1 (top)', () => {
    t.assert(getLeagueTier('lol', 'EWC 2026') === 1, 'EWC must be tier1 (top esports event)');
    t.assert(getLeagueTier('cs2', 'Esports World Cup') === 1, '"Esports World Cup" full name must be tier1');
  });

  t.test('canonical (audit refinement): CCT is tier 2 (mid)', () => {
    t.assert(getLeagueTier('cs2', 'CCT European Series 1') === 2, 'CCT European must be tier2 (audit 2026-05-11)');
    t.assert(getLeagueTier('cs2', 'CCT South America') === 2, 'CCT SA must be tier2');
  });

  t.test('canonical: LLA is tier 2', () => {
    t.assert(getLeagueTier('lol', 'LLA') === 2, 'LLA should be tier2');
  });

  t.test('canonical: unknown league falls to tier 3', () => {
    t.assert(getLeagueTier('lol', 'Random Backwater League 17') === 3, 'unknown league should be tier3');
  });

  // ── esports-segment-gate.js: uses canonical naming (1=top, 2=mid, 3=other) ──
  t.test('segment-gate: LCK is policy.tier1', () => {
    const r = esportsSegmentGate('lol', 'LCK Spring', 3);
    t.assert(r.tier === 1, `LCK gate tier should be 1 (got ${r.tier})`);
  });

  t.test('segment-gate: LLA is policy.tier2', () => {
    const r = esportsSegmentGate('lol', 'LLA', 3);
    t.assert(r.tier === 2, `LLA gate tier should be 2 (got ${r.tier})`);
  });

  t.test('segment-gate: unknown league is policy.tier3', () => {
    const r = esportsSegmentGate('cs2', 'Random Backwater League 17', 3);
    t.assert(r.tier === 3, `unknown gate tier should be 3 (got ${r.tier})`);
  });

  t.test('segment-gate: EWC routed to tier1 (audit fix)', () => {
    const r = esportsSegmentGate('cs2', 'EWC 2026', 3);
    t.assert(r.tier === 1, `EWC gate tier should be 1 after audit fix (got ${r.tier})`);
  });

  t.test('segment-gate: CCT routed to tier2 (audit fix)', () => {
    const r = esportsSegmentGate('cs2', 'CCT European Series 1', 3);
    t.assert(r.tier === 2, `CCT gate tier should be 2 after audit fix (got ${r.tier})`);
    t.assert(r.minEdgeBonus >= 3, `CCT tier2 Bo3 should require minEdgeBonus >= 3 (got ${r.minEdgeBonus})`);
  });

  t.test('segment-gate: ENV override bypass intact', () => {
    process.env.ESPORTS_SEGMENT_GATE_OFF = 'true';
    const r = esportsSegmentGate('cs2', 'LCK', 3);
    t.assert(r.skip === false && r.minEdgeBonus === 0, 'ESPORTS_SEGMENT_GATE_OFF must bypass');
    delete process.env.ESPORTS_SEGMENT_GATE_OFF;
  });

  // ── runtime-feat.leagueTier: LOCKED ML feature (3=top convention preserved) ──
  t.test('runtime-feat: ML feature convention preserved (LCK → 3)', () => {
    t.assert(runtimeFeatLeagueTier('LCK Spring') === 3, 'ML model trained with LCK=3 — must not change');
  });

  t.test('runtime-feat: ML feature convention preserved (random → 1)', () => {
    t.assert(runtimeFeatLeagueTier('Random Backwater League 17') === 1, 'ML model: random league=1 (other)');
  });

  // ── cross-sport (P5): getLeagueTier works for all esports sport keys ──
  t.test('cross-sport: getLeagueTier accepts lol/cs2/dota2/valorant', () => {
    t.assert(getLeagueTier('lol', 'LCK') === 1, 'lol/LCK');
    t.assert(getLeagueTier('cs2', 'IEM Katowice') === 1, 'cs2/IEM Katowice');
    t.assert(getLeagueTier('dota2', 'The International') === 1, 'dota2/TI');
    t.assert(getLeagueTier('valorant', 'VCT Americas') === 1, 'valorant/VCT Americas');
  });
};
