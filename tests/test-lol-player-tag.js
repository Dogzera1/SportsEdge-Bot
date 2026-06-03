// tests/test-lol-player-tag.js — stripPlayerTeamTag drops short team-tag prefixes from handles.
const { stripPlayerTeamTag } = require('../lib/lol-champions');

module.exports = function (t) {
  t.test('drops 3-letter team tag', () => t.assert(stripPlayerTeamTag('SLY Kryze') === 'Kryze'));
  t.test('drops 2-letter team tag', () => t.assert(stripPlayerTeamTag('GL OMON') === 'OMON'));
  t.test('keeps uppercase nick after tag', () => t.assert(stripPlayerTeamTag('GL HARPOON') === 'HARPOON'));
  t.test('drops 4-char alphanumeric tag', () => t.assert(stripPlayerTeamTag('100T Ssumday') === 'Ssumday'));
  t.test('single-word handle unchanged', () => t.assert(stripPlayerTeamTag('Faker') === 'Faker'));
  t.test('trims surrounding whitespace', () => t.assert(stripPlayerTeamTag('  SLY Kryze  ') === 'Kryze'));
  t.test('long tag (>4 chars) left intact', () => t.assert(stripPlayerTeamTag('FNATIC Razork') === 'FNATIC Razork'));
  t.test('empty string -> null', () => t.assert(stripPlayerTeamTag('') === null));
  t.test('null -> null', () => t.assert(stripPlayerTeamTag(null) === null));
};
