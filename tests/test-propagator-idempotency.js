/**
 * Test mt-result-propagator audit + idempotency guard.
 *
 * Audit P0 architectural 2026-05-15: prevent double-credit bankroll em
 * restore-voided → re-settle cycle.
 *
 * Spec: docs/superpowers/specs/2026-05-15-bankroll-integrity-design.md (A+B)
 *
 * Real signature: propagateMtResultToTips(db, shadowRow, result, profitUnits).
 * Function looks up tip internally via market_type + side suffix + pair norm.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

function setupTestDb() {
  const tmpDb = path.join(os.tmpdir(), `test-prop-idem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
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
      stake TEXT,
      odds REAL,
      result TEXT,
      profit_reais REAL,
      stake_reais REAL,
      sent_at TEXT,
      settled_at TEXT,
      is_shadow INTEGER DEFAULT 0,
      is_live INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0
    );
    CREATE TABLE bankroll (
      sport TEXT PRIMARY KEY,
      initial_banca REAL NOT NULL,
      current_banca REAL NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE tip_settlement_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tip_id INTEGER NOT NULL,
      sport TEXT,
      prev_result TEXT,
      new_result TEXT,
      prev_profit_reais REAL,
      new_profit_reais REAL,
      actor TEXT,
      reason TEXT,
      source TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return { db, path: tmpDb };
}

function teardown({ db, path: dbPath }) {
  try { db.close(); } catch (_) {}
  try { fs.unlinkSync(dbPath); } catch (_) {}
}

// Seed a tip + shadow pair that propagator pode resolver via lookup.
function seedTipAndShadow(db, opts = {}) {
  const sport = opts.sport || 'cs';
  const market = opts.market || 'TOTAL';
  const side = opts.side || 'over';
  const team1 = opts.team1 || 'Team Alpha';
  const team2 = opts.team2 || 'Team Beta';
  const odd = opts.odd || 1.85;
  // match_id pattern: <prefix>::mt::<market>::<side>::ln<tag>
  const lineTag = opts.line == null ? '' : `::ln${opts.line < 0 ? `N${Math.abs(opts.line)}` : opts.line > 0 ? `P${opts.line}` : '0'}`;
  const matchId = `${sport}_test_${Date.now()}::mt::${market}::${side}${lineTag}`;
  const tipResult = db.prepare(`
    INSERT INTO tips (sport, match_id, market_type, tip_participant, participant1, participant2, stake, odds, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-1 hours'))
  `).run(sport, matchId, market, team1, team1, team2, '1u', odd);
  const shadowRow = {
    id: 9999,
    sport,
    market,
    side,
    team1,
    team2,
    line: opts.line ?? null,
    odd,
    stake_units: 1,
    created_at: new Date().toISOString(),
  };
  return { tipId: tipResult.lastInsertRowid, shadowRow };
}

module.exports = function runTests(t) {
  t.test('first propagator call: writes audit + bumps bankroll', () => {
    const fix = setupTestDb();
    try {
      fix.db.prepare(`INSERT INTO bankroll (sport, initial_banca, current_banca) VALUES (?, ?, ?)`).run('cs', 100, 100);
      const { tipId, shadowRow } = seedTipAndShadow(fix.db, { sport: 'cs', market: 'TOTAL', side: 'over' });
      const { propagateMtResultToTips } = require('../lib/mt-result-propagator');
      const r = propagateMtResultToTips(fix.db, shadowRow, 'win', 0.85);
      t.assert(r === tipId, `expected return tip id ${tipId}, got ${r}`);
      const audit = fix.db.prepare(`SELECT * FROM tip_settlement_audit WHERE tip_id = ? AND source = ?`)
        .get(tipId, 'lib/mt-result-propagator.js');
      t.assert(audit, `expected audit row for tip ${tipId}, got ${audit}`);
      t.assert(audit.new_result === 'win', `expected new_result=win, got ${audit.new_result}`);
      const bank = fix.db.prepare(`SELECT current_banca FROM bankroll WHERE sport = 'cs'`).get();
      t.assert(bank.current_banca > 100, `expected banca>100 (bumped), got ${bank.current_banca}`);
    } finally { teardown(fix); }
  });

  t.test('second propagator call same tip+result: idempotent (no double-credit)', () => {
    const fix = setupTestDb();
    try {
      fix.db.prepare(`INSERT INTO bankroll (sport, initial_banca, current_banca) VALUES (?, ?, ?)`).run('cs', 100, 100);
      const { tipId, shadowRow } = seedTipAndShadow(fix.db, { sport: 'cs', market: 'TOTAL', side: 'over' });
      const { propagateMtResultToTips } = require('../lib/mt-result-propagator');
      propagateMtResultToTips(fix.db, shadowRow, 'win', 0.85);
      const bankAfter1 = fix.db.prepare(`SELECT current_banca FROM bankroll WHERE sport = 'cs'`).get();
      // Simula restore-voided: clear result e re-propagate
      fix.db.prepare(`UPDATE tips SET result = NULL, profit_reais = NULL, settled_at = NULL WHERE id = ?`).run(tipId);
      const r = propagateMtResultToTips(fix.db, shadowRow, 'win', 0.85);
      t.assert(r === null, `expected null (idempotent skip), got ${r}`);
      const auditCount = fix.db.prepare(`SELECT COUNT(*) AS n FROM tip_settlement_audit WHERE tip_id = ?`).get(tipId);
      t.assert(auditCount.n === 1, `expected 1 audit row (no double), got ${auditCount.n}`);
      const bankAfter2 = fix.db.prepare(`SELECT current_banca FROM bankroll WHERE sport = 'cs'`).get();
      t.assert(Math.abs(bankAfter1.current_banca - bankAfter2.current_banca) < 0.01,
        `expected banca unchanged (no double credit), got ${bankAfter1.current_banca} → ${bankAfter2.current_banca}`);
    } finally { teardown(fix); }
  });

  t.test('second call with DIFFERENT result: proceeds (legit re-settle)', () => {
    const fix = setupTestDb();
    try {
      fix.db.prepare(`INSERT INTO bankroll (sport, initial_banca, current_banca) VALUES (?, ?, ?)`).run('cs', 100, 100);
      const { tipId, shadowRow } = seedTipAndShadow(fix.db, { sport: 'cs', market: 'TOTAL', side: 'over' });
      const { propagateMtResultToTips } = require('../lib/mt-result-propagator');
      propagateMtResultToTips(fix.db, shadowRow, 'win', 0.85);
      // Admin re-settle pra void
      fix.db.prepare(`UPDATE tips SET result = NULL, profit_reais = NULL, settled_at = NULL WHERE id = ?`).run(tipId);
      const r = propagateMtResultToTips(fix.db, shadowRow, 'void', 0);
      t.assert(r === tipId, `expected return tip id ${tipId} (different result proceeds), got ${r}`);
      const auditCount = fix.db.prepare(`SELECT COUNT(*) AS n FROM tip_settlement_audit WHERE tip_id = ?`).get(tipId);
      t.assert(auditCount.n === 2, `expected 2 audit rows (win + void), got ${auditCount.n}`);
    } finally { teardown(fix); }
  });
};
