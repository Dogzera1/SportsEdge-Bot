'use strict';
const assert = require('assert');
const { shrinkRate, aggregateTiming } = require('../scripts/train-lol-champion-timing');

module.exports = function(t) {
  t.test('shrinkRate returns prior when n=0', () => {
    assert.strictEqual(shrinkRate(0, 0, 10, 0.5), 0.5, 'n=0 -> prior');
  });
  t.test('shrinkRate pulls toward prior with small n', () => {
    // (8 + 10*0.5) / (10 + 10) = 13/20 = 0.65
    assert.ok(Math.abs(shrinkRate(8, 10, 10, 0.5) - 0.65) < 1e-9, 'shrunk 0.65');
  });
  t.test('shrinkRate approaches raw rate with large n', () => {
    const r = shrinkRate(800, 1000, 10, 0.5); // ~0.797
    assert.ok(r > 0.79 && r < 0.80, `large-n near raw, got ${r}`);
  });

  t.test('aggregateTiming computes byChampRole, scaling, expectedLen', () => {
    const rows = [
      { champion: 'Aatrox', position: 'top', gamelength: 1500, result: 1, golddiffat15: 300, xpdiffat15: 200, csdiffat15: 5 },
      { champion: 'Aatrox', position: 'top', gamelength: 2500, result: 0, golddiffat15: 100, xpdiffat15: 50,  csdiffat15: 2 },
      { champion: 'Aatrox', position: 'top', gamelength: 2000, result: 1, golddiffat15: 200, xpdiffat15: 150, csdiffat15: 4 },
      { champion: 'Gnar',   position: 'top', gamelength: 1400, result: 0, golddiffat15: -100, xpdiffat15: -50, csdiffat15: -3 },
      { champion: 'Gnar',   position: 'top', gamelength: 2600, result: 1, golddiffat15: 50,  xpdiffat15: 20,  csdiffat15: 1 },
      { champion: 'Gnar',   position: 'top', gamelength: 1900, result: 0, golddiffat15: -50, xpdiffat15: -20, csdiffat15: 0 },
    ];
    const a = aggregateTiming(rows);
    assert.strictEqual(a.byChampRole['aatrox|top'].n, 3, 'aatrox|top n=3');
    assert.strictEqual(a.byChampRole['aatrox|top'].golddiff15, 200, 'aatrox|top avg golddiff15=200');
    assert.strictEqual(a.expectedLen.aatrox, 2000, 'aatrox expectedLen=2000');
    assert.ok('index' in a.scaling.aatrox, 'aatrox has scaling.index');
    assert.ok(typeof a.scaling.aatrox.index === 'number', 'scaling.index numeric');
  });
};
