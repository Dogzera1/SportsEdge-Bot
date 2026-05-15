/**
 * Test bankroll reconciliation — audit P0 architectural 2026-05-15.
 *
 * Spec: docs/superpowers/specs/2026-05-15-bankroll-integrity-design.md component E.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

function setupTestDb() {
  const tmpDb = path.join(os.tmpdir(), `test-reconcile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Database(tmpDb);
  // Minimal schema pra reconcile test — apenas tabelas necessárias.
  db.exec(`
    CREATE TABLE bankroll (
      sport TEXT PRIMARY KEY,
      initial_banca REAL NOT NULL,
      current_banca REAL NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE tips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sport TEXT NOT NULL,
      is_shadow INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0,
      result TEXT,
      profit_reais REAL
    );
  `);
  return { db, path: tmpDb };
}

function teardown({ db, path: dbPath }) {
  try { db.close(); } catch (_) {}
  try { fs.unlinkSync(dbPath); } catch (_) {}
}

module.exports = function runTests(t) {
  t.test('no drift when stored matches expected', () => {
    const fix = setupTestDb();
    try {
      fix.db.prepare(`INSERT INTO bankroll (sport, initial_banca, current_banca) VALUES (?, ?, ?)`).run('lol', 100, 102);
      fix.db.prepare(`INSERT INTO tips (sport, is_shadow, archived, result, profit_reais) VALUES (?, 0, 0, 'win', 2.00)`).run('lol');
      const { reconcileBankrollDrift } = require('../lib/bankroll-reconciliation');
      const r = reconcileBankrollDrift(fix.db, { threshold: 0.10 });
      t.assert(r.drifts.length === 0, `expected 0 drifts, got ${JSON.stringify(r.drifts)}`);
    } finally { teardown(fix); }
  });

  t.test('drift detected when stored off by R$0.15', () => {
    const fix = setupTestDb();
    try {
      fix.db.prepare(`INSERT INTO bankroll (sport, initial_banca, current_banca) VALUES (?, ?, ?)`).run('lol', 100, 102);
      // tips say profit R$2.15, stored says delta=R$2.00 → drift R$0.15
      fix.db.prepare(`INSERT INTO tips (sport, is_shadow, archived, result, profit_reais) VALUES (?, 0, 0, 'win', 2.15)`).run('lol');
      const { reconcileBankrollDrift } = require('../lib/bankroll-reconciliation');
      const r = reconcileBankrollDrift(fix.db, { threshold: 0.10 });
      t.assert(r.drifts.length === 1, `expected 1 drift, got ${JSON.stringify(r.drifts)}`);
      t.assert(r.drifts[0].sport === 'lol', `expected sport=lol, got ${r.drifts[0].sport}`);
      t.assert(Math.abs(r.drifts[0].drift_amount + 0.15) < 0.001, `expected drift_amount=-0.15 (stored 2.00 - expected 2.15), got ${r.drifts[0].drift_amount}`);
    } finally { teardown(fix); }
  });

  t.test('drift below threshold R$0.05 not flagged', () => {
    const fix = setupTestDb();
    try {
      fix.db.prepare(`INSERT INTO bankroll (sport, initial_banca, current_banca) VALUES (?, ?, ?)`).run('lol', 100, 102);
      fix.db.prepare(`INSERT INTO tips (sport, is_shadow, archived, result, profit_reais) VALUES (?, 0, 0, 'win', 2.05)`).run('lol');
      const { reconcileBankrollDrift } = require('../lib/bankroll-reconciliation');
      const r = reconcileBankrollDrift(fix.db, { threshold: 0.10 });
      t.assert(r.drifts.length === 0, `expected 0 drifts (below threshold), got ${JSON.stringify(r.drifts)}`);
    } finally { teardown(fix); }
  });

  t.test('boundary exactly at threshold not flagged (>0.10 strict)', () => {
    const fix = setupTestDb();
    try {
      fix.db.prepare(`INSERT INTO bankroll (sport, initial_banca, current_banca) VALUES (?, ?, ?)`).run('lol', 100, 102);
      fix.db.prepare(`INSERT INTO tips (sport, is_shadow, archived, result, profit_reais) VALUES (?, 0, 0, 'win', 2.10)`).run('lol');
      const { reconcileBankrollDrift } = require('../lib/bankroll-reconciliation');
      const r = reconcileBankrollDrift(fix.db, { threshold: 0.10 });
      t.assert(r.drifts.length === 0, `expected 0 drifts (boundary), got ${JSON.stringify(r.drifts)}`);
    } finally { teardown(fix); }
  });

  t.test('ignores is_shadow=1 + archived=1 tips', () => {
    const fix = setupTestDb();
    try {
      fix.db.prepare(`INSERT INTO bankroll (sport, initial_banca, current_banca) VALUES (?, ?, ?)`).run('cs', 100, 100);
      fix.db.prepare(`INSERT INTO tips (sport, is_shadow, archived, result, profit_reais) VALUES (?, 1, 0, 'win', 5.00)`).run('cs');
      fix.db.prepare(`INSERT INTO tips (sport, is_shadow, archived, result, profit_reais) VALUES (?, 0, 1, 'loss', -3.00)`).run('cs');
      const { reconcileBankrollDrift } = require('../lib/bankroll-reconciliation');
      const r = reconcileBankrollDrift(fix.db, { threshold: 0.10 });
      t.assert(r.drifts.length === 0, `expected 0 drifts (shadow+archived ignored), got ${JSON.stringify(r.drifts)}`);
    } finally { teardown(fix); }
  });

  t.test('only result IN (win,loss) counts, void/push ignored', () => {
    const fix = setupTestDb();
    try {
      fix.db.prepare(`INSERT INTO bankroll (sport, initial_banca, current_banca) VALUES (?, ?, ?)`).run('dota2', 100, 100);
      fix.db.prepare(`INSERT INTO tips (sport, is_shadow, archived, result, profit_reais) VALUES (?, 0, 0, 'void', 0)`).run('dota2');
      fix.db.prepare(`INSERT INTO tips (sport, is_shadow, archived, result, profit_reais) VALUES (?, 0, 0, 'push', 0)`).run('dota2');
      const { reconcileBankrollDrift } = require('../lib/bankroll-reconciliation');
      const r = reconcileBankrollDrift(fix.db, { threshold: 0.10 });
      t.assert(r.drifts.length === 0, `void/push should not affect, got ${JSON.stringify(r.drifts)}`);
    } finally { teardown(fix); }
  });
};
