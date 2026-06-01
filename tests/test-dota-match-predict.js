'use strict';
const assert = require('assert');
const Database = require('better-sqlite3');
const path = require('path');
const { predictMatch } = require('../lib/dota-match-predict');
const db = new Database(path.join(__dirname, '..', 'sportsedge.db'), { readonly: true });

module.exports = function(t) {
  const teams = db.prepare("SELECT team1, COUNT(*) n FROM match_results WHERE game='dota2' AND team1 IS NOT NULL AND team1!='' GROUP BY team1 ORDER BY n DESC LIMIT 2").all().map(r => r.team1);
  const T1 = teams[0], T2 = teams[1];

  t.test('prob in [0,1] for known teams', () => {
    const out = predictMatch(db, { team1: T1, team2: T2, side: 'blue' });
    assert.ok(typeof out.prob === 'number' && out.prob >= 0 && out.prob <= 1, `prob in [0,1], got ${out.prob}`);
    assert.ok(out.components && 'elo' in out.components, 'components.elo present');
  });
  t.test('no teams -> prob 0.5, lean fraco', () => {
    const out = predictMatch(db, { team1: null, team2: null, side: 'blue' });
    assert.strictEqual(out.prob, 0.5); assert.strictEqual(out.label, 'lean fraco');
  });
  t.test('side red flips probBlue orientation', () => {
    const a = predictMatch(db, { team1: T1, team2: T2, side: 'blue' });
    const b = predictMatch(db, { team1: T1, team2: T2, side: 'red' });
    assert.ok(a.prob >= 0 && b.prob >= 0, 'both valid');
    if (a.components.elo && b.components.elo) assert.ok(Math.abs(a.components.elo.pBlue + b.components.elo.pBlue - 1) < 0.001, 'elo pBlue complementary');
  });
  t.test('draft present -> components.draft populated (or null if heroes unknown)', () => {
    const out = predictMatch(db, { team1: T1, team2: T2, side: 'blue', draft: { blue: ['Invoker','Juggernaut','Crystal Maiden','Axe','Lion'], red: ['Pudge','Anti-Mage','Lina','Tidehunter','Witch Doctor'] } });
    assert.ok(out.components.draft === null || (typeof out.components.draft.blueWR === 'number'), 'draft read shape');
  });
  console.log('Sample dota predictMatch:', JSON.stringify(predictMatch(db, { team1: T1, team2: T2, side: 'blue' })));
  db.close();
};
