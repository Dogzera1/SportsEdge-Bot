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
  t.test('expectedTime averages gamelength of all 10 picks -> bucket', () => {
    const all = [...DRAFT.blue, ...DRAFT.red];
    const et = gp.expectedTime(all, ART.timing);
    // mean(1900,2100,1850,1700)=1887.5 -> 1888s -> 31.5min -> médio
    assert.strictEqual(et.seconds, 1888, 'seconds=1888');
    assert.strictEqual(et.bucket, 'médio', 'bucket médio');
  });
  t.test('winCondition: same side early+late -> all phases', () => {
    const s = gp.winCondition({ early: { winner: 'blue' }, late: { winner: 'blue' } });
    assert.ok(/todas as fases/.test(s), `got "${s}"`);
  });
  t.test('winCondition: early blue + late red -> convert before scaling', () => {
    const s = gp.winCondition({ early: { winner: 'blue' }, late: { winner: 'red' } });
    assert.ok(/converter/.test(s) && /Azul/.test(s), `got "${s}"`);
  });
  t.test('winCondition: all even -> execution call', () => {
    const s = gp.winCondition({ early: { winner: 'even' }, late: { winner: 'even' } });
    assert.ok(/equilibrad/.test(s), `got "${s}"`);
  });
  t.test('compStyle: two assassins -> pick', () => {
    const c = gp.compStyle([{ champion: 'Zed', role: 'mid' }, { champion: 'Talon', role: 'jng' }], ART.tags);
    assert.strictEqual(c.style, 'pick', `got ${c.style}`);
    assert.ok(c.confidence <= 0.6, 'qualitative confidence capped');
  });
  t.test('compStyle: frontline + mage -> teamfight', () => {
    const c = gp.compStyle([{ champion: 'Aatrox' }, { champion: 'Gnar' }, { champion: 'Orianna' }], ART.tags);
    assert.strictEqual(c.style, 'teamfight', `got ${c.style}`);
  });
  t.test('compStyle: no trigger -> balanceado', () => {
    const c = gp.compStyle([{ champion: 'Jinx' }], ART.tags);
    assert.strictEqual(c.style, 'balanceado', `got ${c.style}`);
  });
  t.test('compStyle: unknown champ ignored, lowers confidence', () => {
    const c = gp.compStyle([{ champion: 'Nonexistent' }], ART.tags);
    assert.ok(c.confidence < 0.3, 'unknown -> low confidence');
  });
  t.test('qualityBlock: full known + good sample -> alta', () => {
    const q = gp.qualityBlock({ knownChamps: 10, totalChamps: 10, laneMatchups: [{ n: 100 }, { n: 80 }], eloConfidence: 1 });
    assert.strictEqual(q.tier, 'alta', `got ${q.tier}`);
    assert.strictEqual(q.avgLaneN, 90, 'avgLaneN=90');
    assert.strictEqual(q.warnings.length, 0, 'no warnings');
  });
  t.test('qualityBlock: missing champs -> warning + lower tier', () => {
    const q = gp.qualityBlock({ knownChamps: 7, totalChamps: 10, laneMatchups: [{ n: 50 }], eloConfidence: 0.5 });
    assert.strictEqual(q.tier, 'média', `got ${q.tier}`);
    assert.ok(q.warnings.some(w => /sem dado/.test(w)), 'warns missing champs');
  });
  t.test('computeGameProfile: full output with draft', () => {
    const out = gp.computeGameProfile({
      draft: DRAFT, probTeam1: 0.7345, bookOdds: 1.85, eloConfidence: 1,
      laneMatchups: [{ n: 100 }, { n: 90 }], knownChamps: 4, totalChamps: 4,
    }, ART);
    assert.ok(out.phases && out.phases.early.winner === 'blue', 'phases present');
    assert.ok(out.expectedTime && out.compStyle && out.fairOdds, 'all blocks present');
    assert.ok(Math.abs(out.fairOdds.team1 - 1.36) < 0.01, 'fairOdds wired');
    assert.ok(out.edge !== null, 'edge computed when bookOdds given');
    assert.ok(out.quality && out.quality.tier, 'quality present');
  });
  t.test('computeGameProfile: no draft -> phases null, odds still present', () => {
    const out = gp.computeGameProfile({ draft: null, probTeam1: 0.6, bookOdds: null, eloConfidence: 1, laneMatchups: [], knownChamps: 0, totalChamps: 10 }, ART);
    assert.strictEqual(out.phases, null, 'phases null without draft');
    assert.strictEqual(out.compStyle, null, 'compStyle null without draft');
    assert.ok(out.fairOdds && out.edge === null, 'odds present, edge null');
  });
};
