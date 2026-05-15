/**
 * Test settle gap detector — detecta shadow settled + tips pending
 * (race window de crash mid-flow entre shadow commit + propagator).
 *
 * Spec: docs/superpowers/specs/2026-05-15-bankroll-integrity-design.md (C)
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

function setupTestDb() {
  const tmpDb = path.join(os.tmpdir(), `test-gap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Database(tmpDb);
  db.exec(`
    CREATE TABLE tips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sport TEXT NOT NULL,
      match_id TEXT,
      market_type TEXT,
      tip_participant TEXT,
      participant1 TEXT,
      participant2 TEXT,
      odds REAL,
      result TEXT,
      profit_reais REAL,
      stake_reais REAL,
      sent_at TEXT,
      settled_at TEXT,
      is_shadow INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0
    );
    CREATE TABLE market_tips_shadow (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sport TEXT,
      market TEXT,
      side TEXT,
      team1 TEXT,
      team2 TEXT,
      result TEXT,
      profit_pct REAL,
      line REAL,
      odd REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return { db, path: tmpDb };
}

function teardown({ db, path: dbPath }) {
  try { db.close(); } catch (_) {}
  try { fs.unlinkSync(dbPath); } catch (_) {}
}

module.exports = function runTests(t) {
  t.test('finds gap: shadow settled + tip pending matching pair', () => {
    const fix = setupTestDb();
    try {
      fix.db.prepare(`INSERT INTO market_tips_shadow (sport, market, side, team1, team2, result, profit_pct, line, odd, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-2 hours'))`)
        .run('cs', 'TOTAL', 'over', 'teamalpha', 'teambeta', 'win', 18.5, 26.5, 1.85);
      fix.db.prepare(`INSERT INTO tips (sport, match_id, market_type, tip_participant, participant1, participant2, odds, sent_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '-1 hours'))`)
        .run('cs', 'cs_test_gap', 'TOTAL', 'over', 'Team Alpha', 'Team Beta', 1.85);
      const { findSettleGaps } = require('../lib/settle-gap-detector');
      const gaps = findSettleGaps(fix.db, { windowDays: 30 });
      t.assert(gaps.length === 1, `expected 1 gap, got ${gaps.length}: ${JSON.stringify(gaps)}`);
      t.assert(gaps[0].shadow_id, `expected shadow_id, got ${JSON.stringify(gaps[0])}`);
      t.assert(gaps[0].tip_id, `expected tip_id, got ${JSON.stringify(gaps[0])}`);
    } finally { teardown(fix); }
  });

  t.test('no gap: shadow settled + tip ALSO settled', () => {
    const fix = setupTestDb();
    try {
      fix.db.prepare(`INSERT INTO market_tips_shadow (sport, market, team1, team2, result, profit_pct, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-2 hours'))`)
        .run('cs', 'TOTAL', 'teamalpha', 'teambeta', 'win', 18.5);
      fix.db.prepare(`INSERT INTO tips (sport, match_id, market_type, participant1, participant2, result, profit_reais, sent_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '-1 hours'))`)
        .run('cs', 'cs_test_done', 'TOTAL', 'Team Alpha', 'Team Beta', 'win', 0.85);
      const { findSettleGaps } = require('../lib/settle-gap-detector');
      const gaps = findSettleGaps(fix.db, { windowDays: 30 });
      t.assert(gaps.length === 0, `expected 0 gaps (both settled), got ${gaps.length}`);
    } finally { teardown(fix); }
  });

  t.test('no gap: shadow NOT settled (pending)', () => {
    const fix = setupTestDb();
    try {
      fix.db.prepare(`INSERT INTO market_tips_shadow (sport, market, team1, team2, result, created_at)
        VALUES (?, ?, ?, ?, NULL, datetime('now', '-2 hours'))`)
        .run('cs', 'TOTAL', 'teamalpha', 'teambeta');
      fix.db.prepare(`INSERT INTO tips (sport, match_id, market_type, participant1, participant2, sent_at)
        VALUES (?, ?, ?, ?, ?, datetime('now', '-1 hours'))`)
        .run('cs', 'cs_test_pending', 'TOTAL', 'Team Alpha', 'Team Beta');
      const { findSettleGaps } = require('../lib/settle-gap-detector');
      const gaps = findSettleGaps(fix.db, { windowDays: 30 });
      t.assert(gaps.length === 0, `expected 0 gaps (shadow pending), got ${gaps.length}`);
    } finally { teardown(fix); }
  });

  t.test('respects windowDays — old shadow ignored', () => {
    const fix = setupTestDb();
    try {
      fix.db.prepare(`INSERT INTO market_tips_shadow (sport, market, team1, team2, result, profit_pct, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-60 days'))`)
        .run('cs', 'TOTAL', 'teamalpha', 'teambeta', 'win', 18.5);
      fix.db.prepare(`INSERT INTO tips (sport, match_id, market_type, participant1, participant2, sent_at)
        VALUES (?, ?, ?, ?, ?, datetime('now', '-60 days'))`)
        .run('cs', 'cs_test_old', 'TOTAL', 'Team Alpha', 'Team Beta');
      const { findSettleGaps } = require('../lib/settle-gap-detector');
      const gaps = findSettleGaps(fix.db, { windowDays: 30 });
      t.assert(gaps.length === 0, `expected 0 gaps (out of window), got ${gaps.length}`);
    } finally { teardown(fix); }
  });
};
