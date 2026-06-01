'use strict';
const assert = require('assert');
const gp = require('../lib/lol-game-profile');

module.exports = function(t) {
  t.test('fairOdds = 1/p for both sides', () => {
    const fo = gp.fairOdds(0.7345);
    assert.ok(Math.abs(fo.team1 - 1.36) < 0.01, `team1 ~1.36, got ${fo.team1}`);
    assert.ok(Math.abs(fo.team2 - 3.77) < 0.02, `team2 ~3.77, got ${fo.team2}`);
  });
  t.test('fairOdds clamps extreme p without dividing by zero', () => {
    const fo = gp.fairOdds(1);
    assert.ok(isFinite(fo.team1) && isFinite(fo.team2), 'finite odds at p=1');
  });
  t.test('computeEdge = p*odd - 1 when bookOdds valid', () => {
    assert.ok(Math.abs(gp.computeEdge(0.7345, 1.85) - 0.359) < 0.002, 'edge ~0.359');
  });
  t.test('computeEdge null when bookOdds missing/invalid', () => {
    assert.strictEqual(gp.computeEdge(0.5, null), null, 'null odds -> null');
    assert.strictEqual(gp.computeEdge(0.5, 1), null, 'odd<=1 -> null');
    assert.strictEqual(gp.computeEdge(0.5, 'x'), null, 'non-number -> null');
  });
};
