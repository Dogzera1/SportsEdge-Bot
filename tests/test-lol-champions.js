const { normalizeChampion } = require('../lib/lol-champions');

module.exports = function (t) {
  t.test('lol-champions: basic lowercases and strips', () => {
    t.assert(normalizeChampion('Aatrox') === 'aatrox', 'Aatrox');
    t.assert(normalizeChampion("Kai'Sa") === 'kaisa', "Kai'Sa apostrophe stripped");
    t.assert(normalizeChampion("Cho'Gath") === 'chogath', "Cho'Gath");
  });
  t.test('lol-champions: cross-source aliases unify', () => {
    t.assert(normalizeChampion('MonkeyKing') === normalizeChampion('Wukong'), 'wukong alias');
    t.assert(normalizeChampion('Nunu & Willump') === normalizeChampion('Nunu'), 'nunu alias');
    t.assert(normalizeChampion('Renata Glasc') === normalizeChampion('Renata'), 'renata alias');
  });
  t.test('lol-champions: null/garbage safe', () => {
    t.assert(normalizeChampion(null) === null, 'null');
    t.assert(normalizeChampion('') === null, 'empty');
    t.assert(normalizeChampion('   ') === null, 'spaces');
  });
};
