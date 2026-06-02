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
};
