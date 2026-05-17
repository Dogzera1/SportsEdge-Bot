const Database = require('better-sqlite3');
const { applyMigrations } = require('../../migrations');
const {
  isMtMarketPromoted,
  setMtMarketPromote,
  loadMtMarketPromoteCache,
  _clearCache,
} = require('../../lib/mt-market-promote');

let db;
beforeEach(() => {
  db = new Database(':memory:');
  applyMigrations(db);
  _clearCache();
  delete process.env.LOL_MARKET_TIPS_ENABLED;
  delete process.env.CS_MARKET_TIPS_ENABLED;
});

test('returns false when no row + no legacy env', () => {
  expect(isMtMarketPromoted('lol', 'KILLS_TOTAL')).toBe(false);
});

test('returns true when state table row enabled=1', () => {
  setMtMarketPromote(db, 'lol', 'KILLS_TOTAL', true, { source: 'manual', reason: 'test' });
  loadMtMarketPromoteCache(db);
  expect(isMtMarketPromoted('lol', 'KILLS_TOTAL')).toBe(true);
  expect(isMtMarketPromoted('lol', 'HANDICAP_MAPS')).toBe(false);
});

test('returns false when state table row enabled=0', () => {
  setMtMarketPromote(db, 'lol', 'KILLS_TOTAL', false);
  loadMtMarketPromoteCache(db);
  expect(isMtMarketPromoted('lol', 'KILLS_TOTAL')).toBe(false);
});

test('legacy env LOL_MARKET_TIPS_ENABLED=true enables ALL markets for lol', () => {
  process.env.LOL_MARKET_TIPS_ENABLED = 'true';
  loadMtMarketPromoteCache(db);
  expect(isMtMarketPromoted('lol', 'KILLS_TOTAL')).toBe(true);
  expect(isMtMarketPromoted('lol', 'HANDICAP_MAPS')).toBe(true);
  expect(isMtMarketPromoted('cs', 'KILLS_TOTAL')).toBe(false);
});

test('state table OVERRIDES legacy env (per-market wins)', () => {
  process.env.LOL_MARKET_TIPS_ENABLED = 'true';
  setMtMarketPromote(db, 'lol', 'HANDICAP_SETS', false, { reason: 'leak' });
  loadMtMarketPromoteCache(db);
  expect(isMtMarketPromoted('lol', 'KILLS_TOTAL')).toBe(true);
  expect(isMtMarketPromoted('lol', 'HANDICAP_SETS')).toBe(false);
});
