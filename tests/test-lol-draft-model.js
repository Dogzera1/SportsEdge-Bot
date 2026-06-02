const { shrinkWr, computeDraftWinProb } = require('../lib/lol-draft-model');

function fakeArtifacts() {
  return {
    meta: { priorWr: 0.5, shrinkK: 20, weights: [0, 4, 2, 1, 3, 1], trainedAt: 'test' }, // bias,wr,lane,syn,mWr,mPerf
    wr: { 'aatrox|top': { wins: 60, n: 100 }, 'darius|top': { wins: 40, n: 100 } },
    matchups: { top: { aatrox: { darius: { wins: 70, n: 100 } } } },
    synergy: {},
    mastery: {},
  };
}

module.exports = function (t) {
  t.test('shrinkWr pulls small samples toward prior', () => {
    t.assert(Math.abs(shrinkWr(1, 1, 0.5, 20) - ((1 + 0.5 * 20) / (1 + 20))) < 1e-9, 'n=1 near prior');
    const big = shrinkWr(700, 1000, 0.5, 20);
    t.assert(big > 0.66 && big < 0.70, `n=1000 ~0.69, got ${big.toFixed(3)}`);
  });
  t.test('computeDraftWinProb favors stronger blue draft', () => {
    const draft = {
      blue: [{ champion: 'Aatrox', role: 'top' }],
      red: [{ champion: 'Darius', role: 'top' }],
    };
    const out = computeDraftWinProb(draft, {}, fakeArtifacts());
    t.assert(out.prob > 0.5 && out.prob < 1, `blue favored, got ${out.prob}`);
    t.assert(Array.isArray(out.breakdown.laneMatchups), 'has lane breakdown');
    t.assert(out.breakdown.laneMatchups[0].deltaPp > 0, 'aatrox lane edge positive');
    t.assert(out.confidence > 0 && out.confidence <= 1, 'confidence in (0,1]');
  });
  t.test('computeDraftWinProb unknown champ degrades, no throw', () => {
    const draft = { blue: [{ champion: 'Zzz', role: 'top' }], red: [{ champion: 'Yyy', role: 'top' }] };
    const out = computeDraftWinProb(draft, {}, fakeArtifacts());
    t.assert(out.prob >= 0 && out.prob <= 1, 'prob bounded');
    t.assert(out.confidence < 0.5, 'low confidence on unknown');
  });
  t.test('computeDraftWinProb accepts UI role aliases (ADC→bot lane resolves)', () => {
    const { computeDraftWinProb } = require('../lib/lol-draft-model');
    const art = {
      meta: { priorWr: 0.5, shrinkK: 20, weights: [0, 4, 2, 1, 0, 0] },
      wr: { 'jinx|bot': { wins: 60, n: 100 }, 'aphelios|bot': { wins: 40, n: 100 } },
      matchups: { bot: { jinx: { aphelios: { wins: 70, n: 100 } } } },
      synergy: {},
      mastery: {},
    };
    const out = computeDraftWinProb({ blue: [{ champion: 'Jinx', role: 'ADC' }], red: [{ champion: 'Aphelios', role: 'ADC' }] }, {}, art);
    const lane = out.breakdown.laneMatchups[0];
    t.assert(lane && lane.n === 100, `ADC lane resolved via bot alias, got ${JSON.stringify(lane)}`);
    t.assert(lane.deltaPp > 0, 'jinx favored vs aphelios bot');
  });

  t.test('mastery inert without player names (breakdown diffs 0)', () => {
    const out = computeDraftWinProb(
      { blue: [{ champion: 'Aatrox', role: 'top' }], red: [{ champion: 'Darius', role: 'top' }] },
      {}, fakeArtifacts());
    t.assert(out.breakdown.masteryWrDiff === 0 && out.breakdown.masteryPerfDiff === 0, 'no players → 0 mastery');
  });

  t.test('mastery shifts prob when a strong player is named', () => {
    const art = fakeArtifacts();
    art.mastery = {
      'faker|aatrox': { wins: 18, n: 20, kSum: 100, dSum: 20, aSum: 100, gd15Sum: 6000, gd15N: 20 },
      'faker|*':      { nAll: 200, kAll: 600, dAll: 400, aAll: 800, gd15All: 20000, gd15N: 200 },
    };
    const base = computeDraftWinProb(
      { blue: [{ champion: 'Aatrox', role: 'top' }], red: [{ champion: 'Darius', role: 'top' }] }, {}, art);
    const withPlayer = computeDraftWinProb(
      { blue: [{ champion: 'Aatrox', role: 'top', player: 'Faker' }], red: [{ champion: 'Darius', role: 'top' }] }, {}, art);
    t.assert(withPlayer.prob > base.prob, `named strong player raises blue prob (${base.prob}→${withPlayer.prob})`);
    t.assert(withPlayer.breakdown.mastery.length === 1, 'mastery row present');
  });

  t.test('missing mastery artifact does not throw', () => {
    const art = fakeArtifacts(); delete art.mastery;
    const out = computeDraftWinProb(
      { blue: [{ champion: 'Aatrox', role: 'top', player: 'Faker' }], red: [{ champion: 'Darius', role: 'top' }] }, {}, art);
    t.assert(out.prob >= 0 && out.prob <= 1, 'prob bounded, no throw');
  });
};
