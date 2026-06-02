const { buildMasteryTable, normPlayerName } = require('../lib/lol-draft-train');

module.exports = function (t) {
  t.test('normPlayerName folds case/accents/punct', () => {
    t.assert(normPlayerName('  Fáker ') === 'faker', `got ${normPlayerName('  Fáker ')}`);
  });

  t.test('buildMasteryTable aggregates player|champ and player|* and prunes n<3', () => {
    const rows = [
      { playername: 'Faker', champion: 'Azir', result: 1, kills: 5, deaths: 1, assists: 7, golddiffat15: 400 },
      { playername: 'Faker', champion: 'Azir', result: 1, kills: 3, deaths: 2, assists: 4, golddiffat15: 200 },
      { playername: 'Faker', champion: 'Azir', result: 0, kills: 2, deaths: 4, assists: 6, golddiffat15: -100 },
      { playername: 'Faker', champion: 'Ryze', result: 1, kills: 1, deaths: 0, assists: 2, golddiffat15: 50 },
    ];
    const m = buildMasteryTable(rows);
    t.assert(m['faker|azir'] && m['faker|azir'].n === 3, 'azir pair kept');
    t.assert(m['faker|azir'].wins === 2, 'azir wins=2');
    t.assert(m['faker|azir'].kSum === 10 && m['faker|azir'].dSum === 7 && m['faker|azir'].aSum === 17, 'azir kda sums');
    t.assert(!m['faker|ryze'], 'ryze pair pruned (n<3)');
    t.assert(m['faker|*'] && m['faker|*'].nAll === 4, 'baseline counts all 4 games');
  });

  t.test('computeMasteryFeatures: experienced high-WR blue player → positive masteryWrDiff', () => {
    const { computeMasteryFeatures } = require('../lib/lol-draft-train');
    const wrTbl = { 'azir|mid': { wins: 50, n: 100 } }; // champ base WR = 0.50
    const mastery = {
      'faker|azir': { wins: 18, n: 20, kSum: 100, dSum: 20, aSum: 100, gd15Sum: 6000, gd15N: 20 },
      'faker|*':    { nAll: 200, kAll: 600, dAll: 400, aAll: 800, gd15All: 20000, gd15N: 200 },
    };
    const meta = { priorWr: 0.5, shrinkK: 100 };
    const blue = [{ c: 'azir', role: 'mid', player: 'Faker' }];
    const red  = [{ c: 'azir', role: 'mid', player: null }];
    const out = computeMasteryFeatures(blue, red, mastery, wrTbl, meta);
    t.assert(out.masteryWrDiff > 0, `blue mastery WR edge >0, got ${out.masteryWrDiff}`);
    t.assert(out.masteryPerfDiff > 0, `blue perf edge >0, got ${out.masteryPerfDiff}`);
    t.assert(out.rows.length === 1 && out.rows[0].side === 'blue', 'one blue mastery row');
  });

  t.test('computeMasteryFeatures: no players → both diffs exactly 0', () => {
    const { computeMasteryFeatures } = require('../lib/lol-draft-train');
    const out = computeMasteryFeatures(
      [{ c: 'azir', role: 'mid' }], [{ c: 'ryze', role: 'mid' }], {}, {}, { priorWr: 0.5, shrinkK: 100 });
    t.assert(out.masteryWrDiff === 0 && out.masteryPerfDiff === 0, 'inert without names');
  });

  t.test('computeMasteryFeatures: pair below MIN_N is ignored', () => {
    const { computeMasteryFeatures } = require('../lib/lol-draft-train');
    const mastery = { 'noob|azir': { wins: 1, n: 2, kSum: 2, dSum: 2, aSum: 2, gd15Sum: 0, gd15N: 2 }, 'noob|*': { nAll: 2, kAll: 2, dAll: 2, aAll: 2, gd15All: 0, gd15N: 2 } };
    const out = computeMasteryFeatures(
      [{ c: 'azir', role: 'mid', player: 'noob' }], [{ c: 'ryze', role: 'mid' }], mastery, { 'azir|mid': { wins: 50, n: 100 } }, { priorWr: 0.5, shrinkK: 100 });
    t.assert(out.masteryWrDiff === 0, 'n<MIN_N contributes nothing');
  });

  t.test('fillPlayersFromRoster sets player by normalized role, skips filled', () => {
    const { fillPlayersFromRoster } = require('../lib/oracleselixir-player-features');
    const side = [{ champion: 'Azir', role: 'MID' }, { champion: 'Jinx', role: 'ADC', player: 'Keep' }];
    const expectedRoster = { expected: { mid: 'Faker', bot: 'Gumayusi' } };
    const out = fillPlayersFromRoster(side, expectedRoster);
    t.assert(out[0].player === 'Faker', 'MID slot resolves to mid→Faker');
    t.assert(out[1].player === 'Keep', 'already-filled slot untouched');
  });

  t.test('fillPlayersFromRoster tolerates null roster', () => {
    const { fillPlayersFromRoster } = require('../lib/oracleselixir-player-features');
    const side = [{ champion: 'Azir', role: 'MID' }];
    t.assert(fillPlayersFromRoster(side, null)[0].player === undefined, 'no roster → unchanged');
  });
};
