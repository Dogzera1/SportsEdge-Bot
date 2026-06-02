'use strict';
const assert = require('assert');
const Database = require('better-sqlite3');
const { createEloSystem } = require('../lib/elo-rating');

function _seedDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE match_results (game TEXT, team1 TEXT, team2 TEXT, winner TEXT, final_score TEXT, league TEXT, resolved_at TEXT);`);
  const ins = db.prepare(`INSERT INTO match_results VALUES ('lol',?,?,?,?,?,?)`);
  ins.run('A', 'B', 'A', '2-0', 'LCK', '2025-06-01 00:00:00');
  ins.run('A', 'C', 'A', '2-1', 'LCK', '2026-03-01 00:00:00');
  return db;
}

module.exports = function (t) {
  t.test('bootstrap maxDate excludes matches on/after the cutoff', () => {
    const db = _seedDb();
    const elo = createEloSystem({ confidenceFloor: 0 });
    const n = elo.bootstrap(db, 'lol', null, { maxAgeDays: 100000, maxDate: '2026-01-01 00:00:00' });
    assert.strictEqual(n, 1, `only the 2025 match should be rated, got ${n}`);
    assert.ok(elo.getRating('B'), 'B (2025 loser) was rated');
    assert.strictEqual(elo.getRating('C'), null, 'C (2026) was NOT rated');
    db.close();
  });

  t.test('bootstrap without maxDate rates all (back-compat)', () => {
    const db = _seedDb();
    const elo = createEloSystem({ confidenceFloor: 0 });
    const n = elo.bootstrap(db, 'lol', null, { maxAgeDays: 100000 });
    assert.strictEqual(n, 2, `both matches rated, got ${n}`);
    db.close();
  });

  t.test('aggregateOeGames returns per-game rows, date-sorted', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE oracleselixir_players (gameid TEXT, side TEXT, teamname TEXT, date TEXT, league TEXT, result INTEGER);`);
    const ins = db.prepare(`INSERT INTO oracleselixir_players VALUES (?,?,?,?,?,?)`);
    ins.run('g1', 'blue', 'A', '2026-02-02', 'LCK', 1);
    ins.run('g1', 'red', 'B', '2026-02-02', 'LCK', 0);
    ins.run('g2', 'blue', 'C', '2026-01-01', 'LPL', 0);
    ins.run('g2', 'red', 'D', '2026-01-01', 'LPL', 1);
    const { aggregateOeGames } = require('../lib/lol-match-elo');
    const games = aggregateOeGames(db, {});
    assert.strictEqual(games.length, 2, 'two games');
    assert.strictEqual(games[0].gameid, 'g2', 'date-sorted: g2 (Jan) first');
    assert.deepStrictEqual(
      { blueTeam: games[1].blueTeam, redTeam: games[1].redTeam, blueWon: games[1].blueWon },
      { blueTeam: 'A', redTeam: 'B', blueWon: 1 }, 'g1 fields');
    db.close();
  });

  t.test('buildMatchElo games source produces ratings; bad source throws', () => {
    const Database2 = require('better-sqlite3');
    const path = require('path');
    const realDb = new Database2(path.join(__dirname, '..', 'sportsedge.db'), { readonly: true });
    const { buildMatchElo } = require('../lib/lol-match-elo');
    const elo = buildMatchElo(realDb, { config: { halfLifeDays: 0 }, source: 'games' });
    assert.ok(elo.size() > 50, `expected many rated teams, got ${elo.size()}`);
    assert.throws(() => buildMatchElo(realDb, { config: {}, source: 'bogus' }), /unknown source/);
    realDb.close();
  });
};
