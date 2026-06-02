'use strict';
const assert = require('assert');
const { seriesProb } = require('../lib/lol-match-series');

module.exports = function (t) {
  t.test('Bo1 returns p unchanged', () => {
    assert.strictEqual(seriesProb(0.6, 1), 0.6);
  });
  t.test('p=0.5 gives 0.5 for every format', () => {
    for (const bo of [1, 3, 5]) {
      assert.ok(Math.abs(seriesProb(0.5, bo) - 0.5) < 1e-9, `Bo${bo} at p=0.5`);
    }
  });
  t.test('Bo3 known value p=0.6 -> 0.648', () => {
    assert.ok(Math.abs(seriesProb(0.6, 3) - 0.648) < 1e-9, `got ${seriesProb(0.6, 3)}`);
  });
  t.test('Bo5 known value p=0.6 -> 0.68256', () => {
    assert.ok(Math.abs(seriesProb(0.6, 5) - 0.68256) < 1e-9, `got ${seriesProb(0.6, 5)}`);
  });
  t.test('favorite is more favored in longer series (monotone in bestOf)', () => {
    const p = 0.6;
    assert.ok(seriesProb(p, 5) > seriesProb(p, 3) && seriesProb(p, 3) > seriesProb(p, 1), 'Bo5>Bo3>Bo1 for p>0.5');
  });
  t.test('underdog symmetric: seriesProb(p)+seriesProb(1-p)=1', () => {
    for (const bo of [1, 3, 5]) {
      assert.ok(Math.abs(seriesProb(0.6, bo) + seriesProb(0.4, bo) - 1) < 1e-9, `Bo${bo} symmetry`);
    }
  });
  t.test('result always in [0,1]', () => {
    for (const p of [0, 0.1, 0.5, 0.9, 1]) for (const bo of [1, 3, 5]) {
      const r = seriesProb(p, bo);
      assert.ok(r >= 0 && r <= 1, `seriesProb(${p},${bo})=${r}`);
    }
  });
};
