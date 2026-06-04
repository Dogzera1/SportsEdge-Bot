// tests/test-dota-hero-matchups.js — counter edge from dota_hero_matchups (name->id via dota_hero_stats).
const Database = require('better-sqlite3');
const { getMatchupEdge, _invalidateMatchupCache } = require('../lib/dota-hero-matchups');
const { _invalidateHeroCache } = require('../lib/dota-draft-parse');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dota_hero_stats (hero_id INTEGER PRIMARY KEY, localized_name TEXT);
    CREATE TABLE dota_hero_matchups (hero_id INTEGER, vs_hero_id INTEGER, games INTEGER, wins INTEGER, wr REAL, updated_at TEXT, PRIMARY KEY(hero_id,vs_hero_id));
  `);
  const h = db.prepare('INSERT INTO dota_hero_stats VALUES (?,?)');
  h.run(1, 'Anti-Mage'); h.run(5, 'Crystal Maiden'); h.run(8, 'Juggernaut');
  const m = db.prepare('INSERT INTO dota_hero_matchups VALUES (?,?,?,?,?,?)');
  // Anti-Mage (1) strong vs CM (5): wr .60, weak vs Jugg (8): wr .40
  m.run(1, 5, 100, 60, 0.60, null);
  m.run(1, 8, 100, 40, 0.40, null);
  return db;
}

module.exports = function (t) {
  const db = freshDb();
  _invalidateHeroCache();      // force normalizeHeroName to read THIS test's dota_hero_stats
  _invalidateMatchupCache();

  t.test('resolves names and aggregates blue advantage', () => {
    const r = getMatchupEdge(db, ['Anti-Mage'], ['Crystal Maiden'], { minGames: 20 });
    // adv = wr - 0.5 = +0.10 -> +10.0pp
    t.assert(Math.abs(r.blueAdvantagePp - 10.0) < 0.05 && r.sampled === 1);
  });
  t.test('sums multiple pairs (one favorable, one not)', () => {
    const r = getMatchupEdge(db, ['Anti-Mage'], ['Crystal Maiden', 'Juggernaut'], { minGames: 20 });
    // +10.0 (vs CM) + (-10.0) (vs Jugg) = 0.0pp, 2 pairs
    t.assert(Math.abs(r.blueAdvantagePp - 0.0) < 0.05 && r.sampled === 2);
  });
  t.test('honors min-sample guard', () => {
    const r = getMatchupEdge(db, ['Anti-Mage'], ['Crystal Maiden'], { minGames: 200 });
    t.assert(r.sampled === 0 && r.blueAdvantagePp === 0);
  });
  t.test('unknown hero name is skipped', () => {
    const r = getMatchupEdge(db, ['Anti-Mage'], ['Nonexistent Hero'], { minGames: 20 });
    t.assert(r.sampled === 0);
  });
  t.test('accepts numeric hero ids too', () => {
    const r = getMatchupEdge(db, [1], [5], { minGames: 20 });
    t.assert(Math.abs(r.blueAdvantagePp - 10.0) < 0.05);
  });
};
