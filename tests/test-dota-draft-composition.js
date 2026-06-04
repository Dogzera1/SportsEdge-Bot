// tests/test-dota-draft-composition.js — getDraftComposition counts roles/attrs from dota_hero_stats.
const Database = require('better-sqlite3');
const { getDraftComposition, invalidateMetaCache } = require('../lib/dota-hero-features');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE dota_hero_stats (hero_id INTEGER PRIMARY KEY, localized_name TEXT, roles TEXT, primary_attr TEXT, pro_winrate REAL, pro_pickban_rate REAL, pub_winrate REAL, pro_pick INTEGER);`);
  const h = db.prepare('INSERT INTO dota_hero_stats (hero_id,localized_name,roles,primary_attr,pro_winrate,pro_pickban_rate) VALUES (?,?,?,?,?,?)');
  h.run(1, 'Anti-Mage', 'Carry,Escape', 'agi', 0.52, 0.30);
  h.run(5, 'Crystal Maiden', 'Support,Disabler,Nuker', 'int', 0.49, 0.20);
  h.run(8, 'Juggernaut', 'Carry,Pusher', 'agi', 0.55, 0.40);
  return db;
}

module.exports = function (t) {
  const db = freshDb();
  invalidateMetaCache();
  const c = getDraftComposition(db, ['Anti-Mage', 'Juggernaut', 'Crystal Maiden']);
  t.test('counts known heroes', () => t.assert(c.known === 3));
  t.test('aggregates roles', () => t.assert(c.roleCounts.Carry === 2 && c.roleCounts.Support === 1));
  t.test('aggregates attrs', () => t.assert(c.attrCounts.agi === 2 && c.attrCounts.int === 1));
  t.test('per-hero meta present', () => { const am = c.heroes.find(x => x.name === 'Anti-Mage'); t.assert(am && Math.abs(am.wr - 0.52) < 1e-9 && am.roles.includes('Carry')); });
  t.test('ignores unknown hero', () => { const c2 = getDraftComposition(db, ['Anti-Mage', 'Nonexistent']); t.assert(c2.known === 1); });
  t.test('empty input -> zero known', () => t.assert(getDraftComposition(db, []).known === 0));
};
