'use strict';
const assert = require('assert');
const gp = require('../lib/lol-game-profile');

const ART = {
  timing: {
    byChampRole: {
      'aatrox|top': { golddiff15: 300, xpdiff15: 200, csdiff15: 5, n: 100 },
      'gnar|top':   { golddiff15: -100, xpdiff15: -50, csdiff15: -3, n: 80 },
      'jinx|bot':   { golddiff15: 50, xpdiff15: 30, csdiff15: 2, n: 120 },
      'caitlyn|bot':{ golddiff15: 120, xpdiff15: 60, csdiff15: 4, n: 90 },
    },
    scaling: {
      aatrox:  { index: -0.08, wrShort: 0.55, wrLong: 0.47, nShort: 50, nLong: 50 },
      gnar:    { index: 0.02, wrShort: 0.49, wrLong: 0.51, nShort: 40, nLong: 40 },
      jinx:    { index: 0.12, wrShort: 0.44, wrLong: 0.56, nShort: 60, nLong: 60 },
      caitlyn: { index: -0.10, wrShort: 0.56, wrLong: 0.46, nShort: 55, nLong: 55 },
    },
    expectedLen: { aatrox: 1900, gnar: 1850, jinx: 2100, caitlyn: 1700 },
  },
  tags: {
    aatrox:  { tags: ['Fighter', 'Tank'], info: { attack: 8, defense: 4, magic: 3, difficulty: 4 } },
    gnar:    { tags: ['Fighter', 'Tank'], info: { attack: 6, defense: 5, magic: 5, difficulty: 6 } },
    jinx:    { tags: ['Marksman'], info: { attack: 9, defense: 2, magic: 2, difficulty: 6 } },
    caitlyn: { tags: ['Marksman'], info: { attack: 8, defense: 2, magic: 2, difficulty: 6 } },
    orianna: { tags: ['Mage'], info: { attack: 4, defense: 3, magic: 8, difficulty: 7 } },
    zed:     { tags: ['Assassin'], info: { attack: 9, defense: 1, magic: 3, difficulty: 7 } },
    talon:   { tags: ['Assassin'], info: { attack: 9, defense: 3, magic: 1, difficulty: 7 } },
  },
};
const DRAFT = {
  blue: [{ champion: 'Aatrox', role: 'top' }, { champion: 'Jinx', role: 'bot' }],
  red:  [{ champion: 'Gnar', role: 'top' }, { champion: 'Caitlyn', role: 'bot' }],
};

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
  t.test('phaseEdges: early measured, blue ahead in gold', () => {
    const ph = gp.phaseEdges(DRAFT, ART.timing);
    // early: mean(blue gold 300,50)=175 - mean(red gold -100,120)=10 => +165
    assert.strictEqual(ph.early.measured, true, 'early measured');
    assert.strictEqual(ph.early.anchor.golddiff15, 165, 'early anchor gold = 165');
    assert.strictEqual(ph.early.winner, 'blue', 'blue wins early');
    assert.ok(ph.early.bars >= 0 && ph.early.bars <= 5, 'bars in [0,5]');
  });
  t.test('phaseEdges: late estimated, labeled', () => {
    const ph = gp.phaseEdges(DRAFT, ART.timing);
    assert.strictEqual(ph.late.measured, false, 'late not measured');
    assert.strictEqual(ph.late.label, 'estimativa', 'late labeled estimativa');
  });
  t.test('phaseEdges: mid is transition, lower confidence than early', () => {
    const ph = gp.phaseEdges(DRAFT, ART.timing);
    assert.strictEqual(ph.mid.label, 'transição', 'mid labeled transição');
    assert.ok(ph.mid.confidence < ph.early.confidence, 'mid less confident than early');
  });
  t.test('phaseEdges: even when no gold/scaling difference', () => {
    const mirror = { blue: [{ champion: 'Aatrox', role: 'top' }], red: [{ champion: 'Aatrox', role: 'top' }] };
    const ph = gp.phaseEdges(mirror, ART.timing);
    assert.strictEqual(ph.early.winner, 'even', 'mirror draft -> even early');
  });
};
