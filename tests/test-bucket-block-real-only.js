/**
 * Sprint cleanup — P2 enforcement: bucket_block trigger source.
 *
 * Pre-fix: lib/ml-auto-promote.js:481 triggered bucket_block only from
 * shadow universe. Block effect = SINTOMA on real tip emission, then
 * source should be REAL evidence (per CLAUDE.md P2 principle).
 *
 * Post-fix: ML_BUCKET_BLOCK_REAL_ONLY=true (default) → real triggers only.
 * Opt-out false reverts to shadow-trigger legacy.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

function setupDb() {
  const tempPath = path.join(os.tmpdir(), `bucket-block-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Database(tempPath);
  db.pragma('journal_mode = WAL');
  // Minimal schema for tips + market_tips_shadow + ml_bucket_blocklist + market_tips_runtime_state
  db.exec(`
    CREATE TABLE tips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sport TEXT NOT NULL,
      event_name TEXT,
      market_type TEXT DEFAULT 'ML',
      odds REAL,
      stake REAL,
      result TEXT,
      sent_at TEXT,
      settled_at TEXT,
      is_shadow INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0,
      tip_participant TEXT,
      clv_pct REAL
    );
    CREATE TABLE market_tips_shadow (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sport TEXT NOT NULL,
      market TEXT,
      league TEXT,
      bestOf INTEGER,
      odd REAL,
      stake REAL,
      profit_pct REAL,
      result TEXT,
      created_at TEXT,
      side TEXT,
      team1 TEXT,
      team2 TEXT,
      is_shadow INTEGER DEFAULT 1,
      archived INTEGER DEFAULT 0,
      ev_pct REAL,
      clv_pp REAL,
      tier_at_emit TEXT
    );
    CREATE TABLE ml_bucket_blocklist (
      sport TEXT NOT NULL,
      tier TEXT NOT NULL,
      bucket TEXT NOT NULL,
      since TEXT NOT NULL,
      source TEXT,
      reason TEXT,
      n INTEGER,
      roi_pct REAL,
      PRIMARY KEY (sport, tier, bucket)
    );
    CREATE TABLE market_tips_runtime_state (
      sport TEXT NOT NULL,
      market TEXT NOT NULL,
      side TEXT,
      league TEXT,
      state TEXT NOT NULL,
      reason TEXT,
      source TEXT,
      ts TEXT
    );
    CREATE TABLE ml_auto_promote_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sport TEXT,
      league TEXT,
      tier TEXT,
      bucket TEXT,
      action TEXT,
      reason TEXT,
      n INTEGER,
      roi REAL,
      clv REAL,
      ts TEXT
    );
    CREATE TABLE ml_league_blocklist (
      sport TEXT NOT NULL,
      league_norm TEXT NOT NULL,
      league_raw TEXT,
      since TEXT,
      reason TEXT,
      n INTEGER,
      roi_pct REAL,
      PRIMARY KEY (sport, league_norm)
    );
  `);
  return { db, tempPath };
}

function seedTips(db, opts) {
  // opts: { sport, odds, isShadow, n }
  // Tips at -100d to bypass FROZEN_HOLDOUT=60d default + dentro de WINDOW=120d
  const insTips = db.prepare(`INSERT INTO tips
    (sport, event_name, market_type, odds, stake, result, sent_at, settled_at, is_shadow, archived, tip_participant)
    VALUES (?, 'LCK Spring', 'ML', ?, 1, ?, datetime('now', '-100 days'), datetime('now', '-99 days'), ?, 0, 'Team A')`);
  for (let i = 0; i < opts.n; i++) {
    const isWin = opts.won === undefined ? false : opts.won;
    insTips.run(opts.sport, opts.odds, isWin ? 'win' : 'loss', opts.isShadow ? 1 : 0);
  }
}

module.exports = function(t) {
  // ── shadow-only scenario: SOMENTE shadow tips (sem real) ──
  t.test('default (real-only): shadow ROI ruim sem real → NO bucket_block', () => {
    const { db, tempPath } = setupDb();
    try {
      delete process.env.ML_BUCKET_BLOCK_REAL_ONLY; // default true
      // 15 shadow losses em (lol, tier1, 1.4-1.6) — ROI -100%
      seedTips(db, { sport: 'lol', odds: 1.5, isShadow: true, n: 25, won: false });
      // Real: 0 tips
      const { runMlAutoPromoteCycle } = require('../lib/ml-auto-promote');
      runMlAutoPromoteCycle(db);
      const blocks = db.prepare(`SELECT * FROM ml_bucket_blocklist`).all();
      t.assert(blocks.length === 0, `expected 0 blocks (real-only, no real data), got ${blocks.length}: ${JSON.stringify(blocks)}`);
    } finally {
      db.close();
      try { fs.unlinkSync(tempPath); } catch (_) {}
      ['-wal','-shm'].forEach(s => { try { fs.unlinkSync(tempPath + s); } catch (_) {} });
    }
  });

  t.test('opt-out (ML_BUCKET_BLOCK_REAL_ONLY=false): shadow ROI ruim DISPARA block (legacy)', () => {
    const { db, tempPath } = setupDb();
    try {
      process.env.ML_BUCKET_BLOCK_REAL_ONLY = 'false';
      // 15 shadow losses em (lol, tier1, 1.4-1.6) — ROI -100%
      seedTips(db, { sport: 'lol', odds: 1.5, isShadow: true, n: 25, won: false });
      const { runMlAutoPromoteCycle } = require('../lib/ml-auto-promote');
      runMlAutoPromoteCycle(db);
      const blocks = db.prepare(`SELECT * FROM ml_bucket_blocklist`).all();
      t.assert(blocks.length === 1, `expected 1 block (legacy shadow trigger), got ${blocks.length}`);
      t.assert(blocks[0].sport === 'lol', 'block sport');
      t.assert(blocks[0].tier === 'tier1', 'block tier');
    } finally {
      delete process.env.ML_BUCKET_BLOCK_REAL_ONLY;
      db.close();
      try { fs.unlinkSync(tempPath); } catch (_) {}
      ['-wal','-shm'].forEach(s => { try { fs.unlinkSync(tempPath + s); } catch (_) {} });
    }
  });

  t.test('real-only default: real ROI ruim ≥ minN DISPARA block', () => {
    const { db, tempPath } = setupDb();
    try {
      delete process.env.ML_BUCKET_BLOCK_REAL_ONLY; // default true
      process.env.ML_BUCKET_BLOCK_REAL_MIN_N = '5'; // explicit default
      // 6 real losses em (lol, tier1, 1.4-1.6) — passa minN=5, ROI -100% < -30%
      seedTips(db, { sport: 'lol', odds: 1.5, isShadow: false, n: 25, won: false });
      const { runMlAutoPromoteCycle } = require('../lib/ml-auto-promote');
      runMlAutoPromoteCycle(db);
      const blocks = db.prepare(`SELECT * FROM ml_bucket_blocklist`).all();
      t.assert(blocks.length === 1, `expected 1 block (real trigger), got ${blocks.length}`);
      t.assert(blocks[0].sport === 'lol' && blocks[0].tier === 'tier1', 'sport/tier match');
    } finally {
      delete process.env.ML_BUCKET_BLOCK_REAL_MIN_N;
      db.close();
      try { fs.unlinkSync(tempPath); } catch (_) {}
      ['-wal','-shm'].forEach(s => { try { fs.unlinkSync(tempPath + s); } catch (_) {} });
    }
  });

  t.test('real-only default: real n<minN não dispara (sample insuficiente)', () => {
    const { db, tempPath } = setupDb();
    try {
      delete process.env.ML_BUCKET_BLOCK_REAL_ONLY;
      process.env.ML_BUCKET_BLOCK_REAL_MIN_N = '5';
      // 3 real losses < minN=5
      seedTips(db, { sport: 'lol', odds: 1.5, isShadow: false, n: 10, won: false });
      const { runMlAutoPromoteCycle } = require('../lib/ml-auto-promote');
      runMlAutoPromoteCycle(db);
      const blocks = db.prepare(`SELECT * FROM ml_bucket_blocklist`).all();
      t.assert(blocks.length === 0, `expected 0 blocks (n<minN), got ${blocks.length}`);
    } finally {
      delete process.env.ML_BUCKET_BLOCK_REAL_MIN_N;
      db.close();
      try { fs.unlinkSync(tempPath); } catch (_) {}
      ['-wal','-shm'].forEach(s => { try { fs.unlinkSync(tempPath + s); } catch (_) {} });
    }
  });
};
