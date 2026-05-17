const Database = require('better-sqlite3');
const { applyMigrations } = require('../../migrations');

test('mig 112 creates mt_market_promote_state with index', () => {
  const db = new Database(':memory:');
  applyMigrations(db);

  const tableInfo = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='mt_market_promote_state'`
  ).get();
  expect(tableInfo).toBeTruthy();

  const cols = db.prepare(`PRAGMA table_info(mt_market_promote_state)`).all();
  const colNames = cols.map(c => c.name);
  expect(colNames).toEqual(
    expect.arrayContaining(['sport', 'market', 'enabled', 'promoted_at', 'reverted_at', 'source', 'reason'])
  );

  const pks = cols.filter(c => c.pk > 0).map(c => c.name).sort();
  expect(pks).toEqual(['market', 'sport']);

  const idx = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_mt_market_promote_state_enabled'`
  ).get();
  expect(idx).toBeTruthy();
});

test('mig 112 is idempotent on re-run', () => {
  const db = new Database(':memory:');
  applyMigrations(db);
  expect(() => applyMigrations(db)).not.toThrow();
  // Confirm table still exists with intact schema after re-run
  const tableInfo = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='mt_market_promote_state'`).get();
  expect(tableInfo).toBeTruthy();
});
