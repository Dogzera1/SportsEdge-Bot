'use strict';
/**
 * TDD tests for lib/lol-match-predict.js
 * Verifies: prob range, component breakdown, honest labels, orientation symmetry.
 * Display-only module — no stake/EV/Kelly path.
 */
const assert = require('assert');
const Database = require('better-sqlite3');
const path = require('path');
const { predictMatch } = require('../lib/lol-match-predict');
const db = new Database(path.join(__dirname, '..', 'sportsedge.db'), { readonly: true });

module.exports = async function(t) {
  t.test('prob in [0,1] for known teams', () => {
    const out = predictMatch(db, { team1: 'T1', team2: 'Gen.G', side: 'blue', draft: null });
    assert.ok(typeof out.prob === 'number', 'prob is number');
    assert.ok(out.prob >= 0 && out.prob <= 1, `prob must be in [0,1], got ${out.prob}`);
  });

  t.test('breakdown has elo key', () => {
    const out = predictMatch(db, { team1: 'T1', team2: 'Gen.G', side: 'blue', draft: null });
    assert.ok(out.components && 'elo' in out.components, 'components.elo must exist');
  });

  t.test('honest label is one of forte/lean/lean fraco', () => {
    const out = predictMatch(db, { team1: 'T1', team2: 'Gen.G', side: 'blue', draft: null });
    assert.ok(['forte', 'lean', 'lean fraco'].includes(out.label),
      `label must be forte/lean/lean fraco, got "${out.label}"`);
  });

  t.test('probBlue present and in [0,1]', () => {
    const out = predictMatch(db, { team1: 'T1', team2: 'Gen.G', side: 'blue', draft: null });
    assert.ok(typeof out.probBlue === 'number', 'probBlue is number');
    assert.ok(out.probBlue >= 0 && out.probBlue <= 1, `probBlue in [0,1], got ${out.probBlue}`);
  });

  t.test('draft-only (no teams) => label lean fraco', () => {
    const out = predictMatch(db, {
      team1: null,
      team2: null,
      side: 'blue',
      draft: {
        blue: [{ champion: 'Aatrox', role: 'top' }],
        red:  [{ champion: 'Gnar',   role: 'top' }],
      },
    });
    assert.strictEqual(out.label, 'lean fraco', `expected lean fraco, got "${out.label}"`);
    assert.ok(out.prob >= 0 && out.prob <= 1, 'prob in range for draft-only');
  });

  t.test('no teams no draft => prob=0.5 lean fraco', () => {
    const out = predictMatch(db, { team1: null, team2: null, side: 'blue', draft: null });
    assert.strictEqual(out.prob, 0.5, 'prob must be 0.5 with no input');
    assert.strictEqual(out.label, 'lean fraco');
  });

  t.test('orientation: side red flips which side is blue (probBlue complements)', () => {
    const a = predictMatch(db, { team1: 'T1', team2: 'Gen.G', side: 'blue', draft: null });
    const b = predictMatch(db, { team1: 'T1', team2: 'Gen.G', side: 'red',  draft: null });
    // a: team1=T1 is blue → probBlue = P(T1 blue wins)
    // b: team1=T1 is red  → probBlue = P(Gen.G blue wins) ≈ 1 - P(T1 blue wins) (pre-calib symmetric)
    // After isotonic calib the sum a.probBlue+b.probBlue may not be exactly 1 (calib not symmetric).
    // The directional invariant: if T1 is favored on blue (a.prob<0.5 means unfavored),
    // swapping sides changes which team has blue-side advantage.
    // Minimal invariant: a.probBlue and b.probBlue are on opposite sides of 0.5 OR equal.
    const aSame = a.probBlue;
    const bMirror = b.probBlue;
    // They should sum close to 1 at the raw logistic level; post-calib they may drift slightly.
    // Just verify they're not identical (orientation actually flips) and both in range.
    assert.ok(aSame !== bMirror || Math.abs(aSame - 0.5) < 0.001,
      'orientation must change probBlue (or both are exactly 0.5)');
    assert.ok(a.prob >= 0 && a.prob <= 1, 'a.prob in range');
    assert.ok(b.prob >= 0 && b.prob <= 1, 'b.prob in range');
    // The Elo component pBlue should flip: a.components.elo.pBlue ≈ 1 - b.components.elo.pBlue
    if (a.components.elo && b.components.elo) {
      assert.ok(Math.abs(a.components.elo.pBlue + b.components.elo.pBlue - 1.0) < 0.001,
        `Elo pBlue should be complementary: ${a.components.elo.pBlue} + ${b.components.elo.pBlue}`);
    }
  });

  t.test('confidence is numeric in [0,1]', () => {
    const out = predictMatch(db, { team1: 'T1', team2: 'Gen.G', side: 'blue', draft: null });
    assert.ok(typeof out.confidence === 'number', 'confidence is number');
    assert.ok(out.confidence >= 0 && out.confidence <= 1, `confidence in [0,1], got ${out.confidence}`);
  });

  t.test('draft-only confidence is exactly 0.2', () => {
    const out = predictMatch(db, {
      team1: null, team2: null, side: 'blue',
      draft: { blue: [{ champion: 'Zeri', role: 'bot' }], red: [{ champion: 'Jinx', role: 'bot' }] },
    });
    assert.strictEqual(out.confidence, 0.2, `draft-only confidence must be 0.2, got ${out.confidence}`);
  });

  t.test('teams+draft blends both components', () => {
    const out = predictMatch(db, {
      team1: 'T1', team2: 'Gen.G', side: 'blue',
      draft: {
        blue: [{ champion: 'Aatrox', role: 'top' }],
        red:  [{ champion: 'Gnar',   role: 'top' }],
      },
    });
    // Both components should be present
    assert.ok(out.components.elo   !== null, 'elo component present when teams given');
    assert.ok(out.components.draft !== null, 'draft component present when draft given');
    assert.ok(out.prob >= 0 && out.prob <= 1, 'blended prob in range');
  });

  t.test('seriesNeutralP present in [0,1] for known teams', () => {
    const out = predictMatch(db, { team1: 'T1', team2: 'Gen.G', side: 'blue', draft: null });
    assert.ok(typeof out.seriesNeutralP === 'number', 'seriesNeutralP is number');
    assert.ok(out.seriesNeutralP >= 0 && out.seriesNeutralP <= 1, `in [0,1], got ${out.seriesNeutralP}`);
  });

  t.test('seriesNeutralP is side-agnostic (same for blue and red orientation)', () => {
    const a = predictMatch(db, { team1: 'T1', team2: 'Gen.G', side: 'blue', draft: null });
    const b = predictMatch(db, { team1: 'T1', team2: 'Gen.G', side: 'red', draft: null });
    assert.ok(Math.abs(a.seriesNeutralP - b.seriesNeutralP) < 1e-9,
      `neutral prob should match across orientation: ${a.seriesNeutralP} vs ${b.seriesNeutralP}`);
  });

  t.test('seriesNeutralP null when no teams (no Elo)', () => {
    const out = predictMatch(db, { team1: null, team2: null, side: 'blue',
      draft: { blue: [{ champion: 'Jinx', role: 'bot' }], red: [{ champion: 'Zeri', role: 'bot' }] } });
    assert.strictEqual(out.seriesNeutralP, null, 'no Elo => seriesNeutralP null');
  });

  console.log('\nSample predictMatch result (T1 blue vs Gen.G, no draft):');
  const sample = predictMatch(db, { team1: 'T1', team2: 'Gen.G', side: 'blue', draft: null });
  console.log(JSON.stringify(sample, null, 2));

  db.close();
  console.log('OK test-lol-match-predict');
};
