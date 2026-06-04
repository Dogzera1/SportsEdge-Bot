// tests/test-dota-draft-analysis.js — computeDotaDraftAnalysis orchestration (db + injected fetcher, no network).
const Database = require('better-sqlite3');
const { computeDotaDraftAnalysis } = require('../lib/dota-draft-analysis');
const { _invalidateMatchupCache } = require('../lib/dota-hero-matchups');
const { invalidateMetaCache } = require('../lib/dota-hero-features');
const { _invalidateProCache, normalizeProNick } = require('../lib/dota-player-heroes');
const { _invalidateHeroCache } = require('../lib/dota-draft-parse');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dota_hero_stats (hero_id INTEGER PRIMARY KEY, localized_name TEXT, roles TEXT, primary_attr TEXT, pro_winrate REAL, pro_pickban_rate REAL, pub_winrate REAL, pro_pick INTEGER);
    CREATE TABLE dota_hero_matchups (hero_id INTEGER, vs_hero_id INTEGER, games INTEGER, wins INTEGER, wr REAL, updated_at TEXT, PRIMARY KEY(hero_id,vs_hero_id));
    CREATE TABLE dota_pro_players (account_id INTEGER PRIMARY KEY, name TEXT, name_norm TEXT, team_name TEXT, updated_at TEXT);
    CREATE TABLE dota_player_hero_stats (account_id INTEGER, hero_id INTEGER, games INTEGER, wins INTEGER, wr REAL, last_played INTEGER, fetched_at TEXT, PRIMARY KEY(account_id,hero_id));
  `);
  const h = db.prepare('INSERT INTO dota_hero_stats (hero_id,localized_name,roles,primary_attr,pro_winrate,pro_pickban_rate,pro_pick) VALUES (?,?,?,?,?,?,?)');
  h.run(1, 'Anti-Mage', 'Carry,Escape', 'agi', 0.52, 0.30, 50);
  h.run(5, 'Crystal Maiden', 'Support,Disabler', 'int', 0.49, 0.20, 50);
  h.run(8, 'Juggernaut', 'Carry', 'agi', 0.55, 0.40, 50);
  const m = db.prepare('INSERT INTO dota_hero_matchups VALUES (?,?,?,?,?,?)');
  m.run(1, 5, 100, 60, 0.60, null);  // AM strong vs CM
  m.run(1, 8, 100, 42, 0.42, null);  // AM weak vs Jugg
  db.prepare('INSERT INTO dota_pro_players VALUES (?,?,?,?,?)').run(201358612, 'Nisha', normalizeProNick('Nisha'), 'Team Liquid', new Date().toISOString());
  return db;
}

module.exports = async function (t) {
  const db = freshDb();
  _invalidateMatchupCache(); invalidateMetaCache(); _invalidateProCache(); _invalidateHeroCache();

  const fetcher = async () => [{ hero_id: 1, games: 80, win: 52, last_played: 1 }, { hero_id: 8, games: 40, win: 20, last_played: 1 }];
  const out = await computeDotaDraftAnalysis(db,
    { blue: ['Anti-Mage'], red: ['Crystal Maiden', 'Juggernaut'], players: { blue: ['Nisha'], red: [] } },
    { fetcher });

  t.test('matchup edge sums pairs', () => t.assert(Math.abs(out.matchupEdge.blueAdvantagePp - 2.0) < 0.05 && out.matchupEdge.sampled === 2));
  t.test('matchup pairs carry hero names', () => t.assert(out.matchupEdge.pairs[0].blueName === 'Anti-Mage'));
  t.test('composition counts roles', () => t.assert(out.composition.red.roleCounts.Carry === 1 && out.composition.red.roleCounts.Support === 1));
  t.test('player resolved with onHero (Nisha on Anti-Mage)', () => {
    const p = out.playerHeroes.blue[0];
    t.assert(p.resolved && p.player === 'Nisha' && p.onHero && Math.abs(p.onHero.wr - 0.65) < 1e-9);
  });
  t.test('player top heroes are named', () => t.assert(out.playerHeroes.blue[0].top[0].hero === 'Anti-Mage'));
  // getTeamDraftStrength returns null with <3 heroes a side; blue here has 1 hero -> draftStrength null (correct).
  t.test('draftStrength null with <3 heroes a side', () => t.assert(out.draftStrength === null));
};
