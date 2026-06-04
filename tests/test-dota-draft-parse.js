// tests/test-dota-draft-parse.js — Dota Lab print-parse: hero-name normalizer + vision prompt.
const { buildDotaPrintPrompt, normalizeHeroName, _invalidateHeroCache } = require('../lib/dota-draft-parse');

// Stub db: db.prepare(sql).all() returns rows with localized_name.
const HEROES = ['Anti-Mage', "Nature's Prophet", 'Queen of Pain', 'Outworld Destroyer', 'Pudge'];
const db = { prepare: () => ({ all: () => HEROES.map(n => ({ localized_name: n })) }) };

module.exports = function (t) {
  _invalidateHeroCache(); // module-level cache: reset before using our stub db

  // normalizeHeroName
  t.test('exact match returns canonical', () => t.assert(normalizeHeroName(db, 'Anti-Mage') === 'Anti-Mage'));
  t.test('case-insensitive exact match', () => t.assert(normalizeHeroName(db, 'anti-mage') === 'Anti-Mage'));
  t.test('loose match drops hyphen', () => t.assert(normalizeHeroName(db, 'antimage') === 'Anti-Mage'));
  t.test('loose match space-for-hyphen', () => t.assert(normalizeHeroName(db, 'anti mage') === 'Anti-Mage'));
  t.test('loose match drops apostrophe', () => t.assert(normalizeHeroName(db, 'natures prophet') === "Nature's Prophet"));
  t.test('trims surrounding whitespace', () => t.assert(normalizeHeroName(db, '  Pudge  ') === 'Pudge'));
  t.test('nickname not matched -> null', () => t.assert(normalizeHeroName(db, 'QoP') === null));
  t.test('old alias not matched -> null', () => t.assert(normalizeHeroName(db, 'Furion') === null));
  t.test('empty string -> null', () => t.assert(normalizeHeroName(db, '') === null));
  t.test('null -> null', () => t.assert(normalizeHeroName(db, null) === null));

  // buildDotaPrintPrompt
  t.test('prompt is a non-empty string', () => t.assert(typeof buildDotaPrintPrompt() === 'string' && buildDotaPrintPrompt().length > 200));
  t.test('prompt maps Radiant->blue / Dire->red', () => { const s = buildDotaPrintPrompt(); t.assert(s.includes('Radiant') && s.includes('Dire')); });
  t.test('prompt requests hero/player/teams JSON', () => { const s = buildDotaPrintPrompt(); t.assert(s.includes('"hero"') && s.includes('"player"') && s.includes('"teams"') && s.includes('JSON')); });
};
