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
};
