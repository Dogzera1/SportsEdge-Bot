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
  t.test('normalizeRole maps aliases to Oracle Elixir codes', () => {
    const { normalizeRole } = require('../lib/lol-champions');
    t.assert(normalizeRole('TOP') === 'top', 'TOP');
    t.assert(normalizeRole('JGL') === 'jng', 'JGL→jng');
    t.assert(normalizeRole('Jungle') === 'jng', 'Jungle→jng');
    t.assert(normalizeRole('MID') === 'mid', 'MID');
    t.assert(normalizeRole('ADC') === 'bot', 'ADC→bot');
    t.assert(normalizeRole('Bottom') === 'bot', 'Bottom→bot');
    t.assert(normalizeRole('bot') === 'bot', 'bot passthrough');
    t.assert(normalizeRole('Support') === 'sup', 'Support→sup');
    t.assert(normalizeRole('jng') === 'jng', 'jng passthrough');
    t.assert(normalizeRole('') === '', 'empty → empty');
    t.assert(normalizeRole(null) === '', 'null → empty');
  });
};
