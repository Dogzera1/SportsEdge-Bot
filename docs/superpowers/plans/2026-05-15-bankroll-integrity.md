# Bankroll Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement defense-in-depth bankroll integrity — 4 prevention components (propagator audit + idempotency + settle gap detector + force-sync ambiguous block) + 1 detection (daily reconciliation cron) with R$0.10 ABS drift threshold.

**Architecture:** New helpers em lib/ pra testability + cron wiring em bot.js + audit gravado em propagator + endpoint guard em server.js. Migração 110 adiciona tabela bankroll_drift_log pra trending. TDD discipline em 3 test files novos.

**Tech Stack:** Node.js 18, better-sqlite3 sync, fast-check pra property tests, custom runner tests/run.js.

**Spec reference:** `docs/superpowers/specs/2026-05-15-bankroll-integrity-design.md`

---

## File Structure

| Action | File | Responsibility |
|---|---|---|
| Create | `lib/bankroll-reconciliation.js` | Component E — compute expected delta + compare to stored |
| Create | `lib/settle-gap-detector.js` | Component C — find shadow_settled + tips_pending gaps |
| Create | `tests/test-bankroll-reconciliation.js` | TDD test E |
| Create | `tests/test-propagator-idempotency.js` | TDD test A+B |
| Create | `tests/test-settle-gap-detector.js` | TDD test C |
| Modify | `migrations/index.js` | Add migration 110_bankroll_drift_log |
| Modify | `lib/mt-result-propagator.js` | Components A (audit trail) + B (idempotency guard) |
| Modify | `bot.js` | Wire crons E (4h UTC) + C (5h UTC) |
| Modify | `server.js:14124-14180` `/admin/force-sync-bankroll` | Component D — ambiguous block 409 |
| Modify | `.env.example` | Document new envs |

---

## Task 1: Migration 110_bankroll_drift_log

**Files:**
- Modify: `migrations/index.js` (append before applyMigrations function)

- [ ] **Step 1: Locate end of migrations array in migrations/index.js**

Run:
```bash
grep -nE "^\s*\{[\s]*$|^]\s*;|function applyMigrations" migrations/index.js | tail -5
```

Expected: line numbers showing end of `const migrations = [...]` array (the last `]` + `;`) followed by `function applyMigrations(db) {`.

- [ ] **Step 2: Append migration 110 entry to migrations array**

Edit `migrations/index.js` — find the last migration entry (currently `'109_match_result_sources'` or whatever is highest sequential — look just before the `]` closing the array). Add this entry BEFORE the closing `]`:

```javascript
  {
    id: '110_bankroll_drift_log',
    up(db) {
      // 2026-05-15 audit P0 architectural: detection cron pra drift entre
      // bankroll.current_banca e sum(profit_reais real). Trending pra
      // identificar drift recorrente vs one-off.
      db.exec(`
        CREATE TABLE IF NOT EXISTS bankroll_drift_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sport TEXT NOT NULL,
          expected_delta REAL NOT NULL,
          stored_delta REAL NOT NULL,
          drift_amount REAL NOT NULL,
          threshold REAL NOT NULL DEFAULT 0.10,
          detected_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_bankroll_drift_log_sport_ts
          ON bankroll_drift_log(sport, detected_at DESC);
      `);
    },
  },
```

- [ ] **Step 3: Verify migration syntax**

Run:
```bash
node -c migrations/index.js && echo "syntax OK"
```

Expected: `syntax OK`.

- [ ] **Step 4: Apply migration locally (test)**

Run:
```bash
node -e "
const Database = require('better-sqlite3');
const fs = require('fs');
const tmpDb = '/tmp/test-mig-110-' + Date.now() + '.db';
const db = new Database(tmpDb);
const { applyMigrations } = require('./migrations');
const r = applyMigrations(db);
const cols = db.prepare(\"PRAGMA table_info(bankroll_drift_log)\").all();
console.log('Migration applied:', r);
console.log('bankroll_drift_log columns:', cols.map(c => c.name).join(', '));
db.close();
try { fs.unlinkSync(tmpDb); } catch (_) {}
"
```

Expected: `Migration applied: { applied: N }` (N=number of pending migs) + columns listed include `id, sport, expected_delta, stored_delta, drift_amount, threshold, detected_at`.

---

## Task 2: Bankroll reconciliation helper (Component E)

**Files:**
- Create: `lib/bankroll-reconciliation.js`
- Create: `tests/test-bankroll-reconciliation.js`

- [ ] **Step 1: Write failing test**

Create `tests/test-bankroll-reconciliation.js`:

```javascript
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
  const tmpDb = path.join(os.tmpdir(), `test-reconcile-${Date.now()}-${Math.random().toString(36).slice(2,8)}.db`);
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

  t.test('drift detected when stored is off by R$0.15', () => {
    const fix = setupTestDb();
    try {
      fix.db.prepare(`INSERT INTO bankroll (sport, initial_banca, current_banca) VALUES (?, ?, ?)`).run('lol', 100, 102);
      // tips say profit R$2.15, stored says delta=R$2.00 → drift R$0.15
      fix.db.prepare(`INSERT INTO tips (sport, is_shadow, archived, result, profit_reais) VALUES (?, 0, 0, 'win', 2.15)`).run('lol');
      const { reconcileBankrollDrift } = require('../lib/bankroll-reconciliation');
      const r = reconcileBankrollDrift(fix.db, { threshold: 0.10 });
      t.assert(r.drifts.length === 1, `expected 1 drift, got ${JSON.stringify(r.drifts)}`);
      t.assert(r.drifts[0].sport === 'lol', `expected sport=lol, got ${r.drifts[0].sport}`);
      t.assert(Math.abs(r.drifts[0].drift_amount - 0.15) < 0.001, `expected drift~0.15, got ${r.drifts[0].drift_amount}`);
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
```

- [ ] **Step 2: Verify test fails (RED)**

Run isolated:
```bash
cd "C:/Users/vict_/Desktop/lol betting"
node -e "
const path = require('path');
let pass = 0, fail = 0;
function makeT() {
  return {
    test(name, fn) {
      let r; try { r = fn(); } catch (e) { fail++; console.log('  ✗ '+name+'\n     '+e.message); return; }
      if (!r || typeof r.then !== 'function') { pass++; console.log('  ✓ '+name); return; }
      return r.then(()=>{pass++;console.log('  ✓ '+name);},(e)=>{fail++;console.log('  ✗ '+name+'\n     '+e.message);});
    },
    assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
  };
}
(async () => {
  const mod = require(path.resolve('tests/test-bankroll-reconciliation.js'));
  await mod(makeT());
  console.log('\n'+pass+' passed, '+fail+' failed');
})().catch(e => console.error(e.message));
"
```

Expected: all 6 tests FAIL with `Cannot find module '../lib/bankroll-reconciliation'`.

- [ ] **Step 3: Create lib/bankroll-reconciliation.js**

Create file with:

```javascript
/**
 * Bankroll reconciliation — detecta drift entre stored current_banca e
 * sum(profit_reais) das tips reais (is_shadow=0, archived=0).
 *
 * Audit P0 architectural 2026-05-15 (data flow + state agents):
 * 2026-05-12 R$6.58 mirror drift lol↔dota2 unresolved root cause —
 * detection cron pega drifts subsequentes em <24h.
 *
 * Spec: docs/superpowers/specs/2026-05-15-bankroll-integrity-design.md (E)
 */

/**
 * Computa drift per sport. Retorna array de drifts > threshold.
 *
 * @param {Database} db better-sqlite3 instance
 * @param {object} opts { threshold = 0.10 }
 * @returns {{ drifts: Array<{sport, expected_delta, stored_delta, drift_amount}>, scanned_at }}
 */
function reconcileBankrollDrift(db, opts = {}) {
  const threshold = Number.isFinite(opts.threshold) && opts.threshold > 0 ? opts.threshold : 0.10;
  const scanned_at = new Date().toISOString();

  const banks = db.prepare(`
    SELECT sport, initial_banca, current_banca
    FROM bankroll
  `).all();

  const drifts = [];
  for (const b of banks) {
    const expected = db.prepare(`
      SELECT COALESCE(SUM(profit_reais), 0) AS expected_delta
      FROM tips
      WHERE sport = ?
        AND COALESCE(is_shadow, 0) = 0
        AND (archived IS NULL OR archived = 0)
        AND result IN ('win', 'loss')
        AND profit_reais IS NOT NULL
    `).get(b.sport);
    const expected_delta = +(expected.expected_delta || 0).toFixed(2);
    const stored_delta = +(Number(b.current_banca) - Number(b.initial_banca)).toFixed(2);
    const drift_amount = +(stored_delta - expected_delta).toFixed(2);
    if (Math.abs(drift_amount) > threshold) {
      drifts.push({
        sport: b.sport,
        expected_delta,
        stored_delta,
        drift_amount,
      });
    }
  }

  return { drifts, scanned_at, threshold };
}

/**
 * Persiste drifts em bankroll_drift_log (migration 110) pra trending.
 */
function logDrifts(db, drifts, threshold) {
  if (!drifts || drifts.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO bankroll_drift_log (sport, expected_delta, stored_delta, drift_amount, threshold)
    VALUES (?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const d of drifts) stmt.run(d.sport, d.expected_delta, d.stored_delta, d.drift_amount, threshold);
  });
  tx();
  return drifts.length;
}

module.exports = { reconcileBankrollDrift, logDrifts };
```

- [ ] **Step 4: Verify test passes (GREEN)**

Re-run the isolated test from Step 2.

Expected: `6 passed, 0 failed`.

- [ ] **Step 5: Verify full npm test no regression**

Run:
```bash
npm test 2>&1 | tail -5
```

Expected: `XYZ passed, 0 failed` (XYZ = previous 573 + new 6 = 579).

---

## Task 3: Wire reconciliation cron in bot.js (Component E)

**Files:**
- Modify: `bot.js` (add cron in boot section after server.listen)

- [ ] **Step 1: Find suitable insertion point in bot.js**

Run:
```bash
grep -nE "setInterval.*_wrapCron|runP2Compliance|RECONCILE_HOUR|reconcileBankroll" bot.js | head -10
```

Expected: see existing `_wrapCron` patterns + identify where similar daily-at-hour cron is wired (look for `now.getUTCHours() === N` patterns).

- [ ] **Step 2: Add reconciliation cron block**

Find a section near other daily-hour-based crons (search for `runP2ComplianceWeekly` or `runReadinessRetentionDaily` for context). Add this block AFTER one of those:

```javascript
  // 2026-05-15 audit P0 architectural: bankroll reconciliation daily cron.
  // Compara stored current_banca − initial_banca vs sum(profit_reais real)
  // por sport; DM admin se drift > R$0.10 (default). Threshold env override.
  // Spec: docs/superpowers/specs/2026-05-15-bankroll-integrity-design.md (E)
  let _lastBankrollReconcileDay = null;
  async function runBankrollReconcileDaily() {
    if (/^(0|false|no)$/i.test(String(process.env.BANKROLL_RECONCILE_AUTO ?? 'true'))) return;
    const hourUtc = parseInt(process.env.BANKROLL_RECONCILE_HOUR_UTC || '4', 10);
    const now = new Date();
    if (now.getUTCHours() !== hourUtc) return;
    const today = now.toISOString().slice(0, 10);
    if (_lastBankrollReconcileDay === today) return;
    _lastBankrollReconcileDay = today;
    try {
      const { reconcileBankrollDrift, logDrifts } = require('./lib/bankroll-reconciliation');
      const threshold = parseFloat(process.env.BANKROLL_RECONCILE_THRESHOLD || '0.10');
      const r = reconcileBankrollDrift(db, { threshold });
      logDrifts(db, r.drifts, threshold);
      if (r.drifts.length > 0) {
        log('WARN', 'BANKROLL-DRIFT', `${r.drifts.length} sport(s) com drift > R$${threshold.toFixed(2)}: ${r.drifts.map(d => `${d.sport}=R$${d.drift_amount.toFixed(2)}`).join(', ')}`);
        if (ADMIN_IDS.size && !_isCycleMuted('bankroll-reconcile')) {
          const lines = r.drifts.slice(0, 8).map(d =>
            `🏦 ${d.sport}: stored=R$${d.stored_delta.toFixed(2)} expected=R$${d.expected_delta.toFixed(2)} drift=R$${d.drift_amount.toFixed(2)}`
          );
          const msg = `⚠️ *BANKROLL DRIFT — daily reconciliation*\n\nThreshold: R$${threshold.toFixed(2)}\n\n${lines.join('\n')}\n\nInvestigue via /admin/force-sync-bankroll?apply=0 pra preview.`;
          const token = resolveAlertsToken();
          if (token) for (const adminId of ADMIN_IDS) sendDM(token, adminId, msg).catch(e => log('WARN', 'ALERT-FAIL', `adminId=${adminId}: ${e.message}`));
        }
      } else {
        log('INFO', 'BANKROLL-RECONCILE', `clean — 0 drifts > R$${threshold.toFixed(2)} threshold`);
      }
    } catch (e) { log('ERROR', 'BANKROLL-RECONCILE', e.message); }
  }
  setInterval(() => runBankrollReconcileDaily().catch(e => log('ERROR', 'BANKROLL-RECONCILE', e.message)), 60 * 60 * 1000);
  setTimeout(() => runBankrollReconcileDaily().catch(() => {}), 100 * 60 * 1000);
```

- [ ] **Step 3: Verify syntax**

Run:
```bash
node -c bot.js && echo "bot.js syntax OK"
```

Expected: `bot.js syntax OK`.

- [ ] **Step 4: Verify integration test no regression**

Run:
```bash
npm test 2>&1 | tail -5
```

Expected: `579 passed, 0 failed`.

---

## Task 4: Propagator audit trail + idempotency guard (Components A+B)

**Files:**
- Create: `tests/test-propagator-idempotency.js`
- Modify: `lib/mt-result-propagator.js`

- [ ] **Step 1: Read current propagator structure**

Run:
```bash
grep -nE "function propagateMtResultToTips|bumpBankroll|updateTipResult|db\.transaction" lib/mt-result-propagator.js | head -10
sed -n '250,290p' lib/mt-result-propagator.js
```

Expected: function `propagateMtResultToTips` + lines around L260-273 showing the transaction with `if (changes > 0) bumpBankroll.run(profitR, sport)`.

- [ ] **Step 2: Write failing test**

Create `tests/test-propagator-idempotency.js`:

```javascript
/**
 * Test mt-result-propagator audit + idempotency guard.
 *
 * Audit P0 architectural 2026-05-15: prevent double-credit bankroll em
 * restore-voided → re-settle cycle.
 *
 * Spec: docs/superpowers/specs/2026-05-15-bankroll-integrity-design.md (A+B)
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

function setupTestDb() {
  const tmpDb = path.join(os.tmpdir(), `test-prop-idem-${Date.now()}-${Math.random().toString(36).slice(2,8)}.db`);
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
      sent_at TEXT DEFAULT (datetime('now')),
      settled_at TEXT,
      is_shadow INTEGER DEFAULT 0,
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

module.exports = function runTests(t) {
  t.test('first propagator call: writes audit + bumps bankroll', () => {
    const fix = setupTestDb();
    try {
      fix.db.prepare(`INSERT INTO bankroll (sport, initial_banca, current_banca) VALUES (?, ?, ?)`).run('cs', 100, 100);
      const tipR = fix.db.prepare(`INSERT INTO tips (sport, match_id, market_type, tip_participant, odds, stake_reais)
        VALUES (?, ?, ?, ?, ?, ?)`).run('cs', 'cs_test_1', 'TOTAL', 'TeamA', 1.85, 1.0);
      const tipId = tipR.lastInsertRowid;
      const { propagateMtResultToTips } = require('../lib/mt-result-propagator');
      const r = propagateMtResultToTips(fix.db, { id: tipId, sport: 'cs' }, 'win', 0.85);
      t.assert(r.settled === 1, `expected settled=1, got ${JSON.stringify(r)}`);
      const audit = fix.db.prepare(`SELECT * FROM tip_settlement_audit WHERE tip_id = ? AND source = ?`)
        .get(tipId, 'lib/mt-result-propagator.js');
      t.assert(audit, `expected audit row for tip ${tipId}, got ${audit}`);
      t.assert(audit.new_result === 'win', `expected new_result=win, got ${audit.new_result}`);
      const bank = fix.db.prepare(`SELECT current_banca FROM bankroll WHERE sport = 'cs'`).get();
      t.assert(Math.abs(bank.current_banca - 100.85) < 0.001, `expected banca=100.85, got ${bank.current_banca}`);
    } finally { teardown(fix); }
  });

  t.test('second propagator call same tip+result: idempotent (no double-credit)', () => {
    const fix = setupTestDb();
    try {
      fix.db.prepare(`INSERT INTO bankroll (sport, initial_banca, current_banca) VALUES (?, ?, ?)`).run('cs', 100, 100);
      const tipR = fix.db.prepare(`INSERT INTO tips (sport, match_id, market_type, tip_participant, odds, stake_reais)
        VALUES (?, ?, ?, ?, ?, ?)`).run('cs', 'cs_test_2', 'TOTAL', 'TeamA', 1.85, 1.0);
      const tipId = tipR.lastInsertRowid;
      const { propagateMtResultToTips } = require('../lib/mt-result-propagator');
      propagateMtResultToTips(fix.db, { id: tipId, sport: 'cs' }, 'win', 0.85);
      // Simula restore-voided: clear result e re-propagate
      fix.db.prepare(`UPDATE tips SET result = NULL, profit_reais = NULL WHERE id = ?`).run(tipId);
      const r = propagateMtResultToTips(fix.db, { id: tipId, sport: 'cs' }, 'win', 0.85);
      t.assert(r.skipped === true, `expected skipped=true (idempotent), got ${JSON.stringify(r)}`);
      const auditCount = fix.db.prepare(`SELECT COUNT(*) AS n FROM tip_settlement_audit WHERE tip_id = ?`).get(tipId);
      t.assert(auditCount.n === 1, `expected 1 audit row, got ${auditCount.n}`);
      // Bankroll deveria estar 100.85 (NÃO 101.70 — sem double credit)
      const bank = fix.db.prepare(`SELECT current_banca FROM bankroll WHERE sport = 'cs'`).get();
      t.assert(Math.abs(bank.current_banca - 100.85) < 0.001, `expected banca=100.85 (no double), got ${bank.current_banca}`);
    } finally { teardown(fix); }
  });

  t.test('second call with DIFFERENT result: proceeds (legit re-settle)', () => {
    const fix = setupTestDb();
    try {
      fix.db.prepare(`INSERT INTO bankroll (sport, initial_banca, current_banca) VALUES (?, ?, ?)`).run('cs', 100, 100);
      const tipR = fix.db.prepare(`INSERT INTO tips (sport, match_id, market_type, tip_participant, odds, stake_reais)
        VALUES (?, ?, ?, ?, ?, ?)`).run('cs', 'cs_test_3', 'TOTAL', 'TeamA', 1.85, 1.0);
      const tipId = tipR.lastInsertRowid;
      const { propagateMtResultToTips } = require('../lib/mt-result-propagator');
      propagateMtResultToTips(fix.db, { id: tipId, sport: 'cs' }, 'win', 0.85);
      // Admin re-settle pra void
      fix.db.prepare(`UPDATE tips SET result = NULL, profit_reais = NULL WHERE id = ?`).run(tipId);
      const r = propagateMtResultToTips(fix.db, { id: tipId, sport: 'cs' }, 'void', 0);
      t.assert(r.settled === 1, `expected settled=1 (different result proceeds), got ${JSON.stringify(r)}`);
      const auditCount = fix.db.prepare(`SELECT COUNT(*) AS n FROM tip_settlement_audit WHERE tip_id = ?`).get(tipId);
      t.assert(auditCount.n === 2, `expected 2 audit rows (one win, one void), got ${auditCount.n}`);
    } finally { teardown(fix); }
  });
};
```

- [ ] **Step 3: Verify test fails (RED)**

Run isolated:
```bash
cd "C:/Users/vict_/Desktop/lol betting"
node -e "
const path = require('path');
let pass = 0, fail = 0;
function makeT() {
  return {
    test(name, fn) {
      let r; try { r = fn(); } catch (e) { fail++; console.log('  ✗ '+name+'\n     '+e.message); return; }
      if (!r || typeof r.then !== 'function') { pass++; console.log('  ✓ '+name); return; }
      return r.then(()=>{pass++;console.log('  ✓ '+name);},(e)=>{fail++;console.log('  ✗ '+name+'\n     '+e.message);});
    },
    assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
  };
}
(async () => {
  const mod = require(path.resolve('tests/test-propagator-idempotency.js'));
  await mod(makeT());
  console.log('\n'+pass+' passed, '+fail+' failed');
})().catch(e => console.error(e.message));
"
```

Expected: tests fail because propagator doesn't yet write audit OR check idempotency. Specifically: "first call writes audit" fails (no audit row), "second call idempotent" fails (banca=101.70 instead of 100.85).

- [ ] **Step 4: Modify lib/mt-result-propagator.js to add audit + idempotency**

Read the existing function:
```bash
sed -n '240,290p' lib/mt-result-propagator.js
```

Identify `propagateMtResultToTips` body. Locate the transaction block where `bumpBankroll.run(profitR, sport)` is called. Modify to:

```javascript
function propagateMtResultToTips(db, tip, result, profitR) {
  const tipId = tip.id;
  const sport = tip.sport;

  // 2026-05-15 audit P0 architectural: idempotency guard pra prevent
  // double-credit em restore-voided → re-settle cycle. Check audit row
  // existente; se já creditado pelo propagator com mesmo result, skip.
  // Spec: docs/superpowers/specs/2026-05-15-bankroll-integrity-design.md (B)
  const existingAudit = db.prepare(`
    SELECT 1 FROM tip_settlement_audit
    WHERE tip_id = ? AND source = 'lib/mt-result-propagator.js' AND new_result = ?
    LIMIT 1
  `).get(tipId, result);
  if (existingAudit) {
    return { skipped: true, reason: 'idempotent_already_propagated', tip_id: tipId };
  }

  const updateTipResult = db.prepare(`UPDATE tips SET result = ?, profit_reais = ?, settled_at = datetime('now') WHERE id = ? AND result IS NULL`);
  const bumpBankroll = db.prepare(`UPDATE bankroll SET current_banca = round(current_banca + ?, 2), updated_at = datetime('now') WHERE sport = ?`);
  // 2026-05-15 audit P0 architectural: audit trail no propagator. Era
  // missing — só /settle gravava audit row. Necessário pra idempotency
  // guard + traceability cross-source.
  // Spec: docs/superpowers/specs/2026-05-15-bankroll-integrity-design.md (A)
  const insertAudit = db.prepare(`
    INSERT INTO tip_settlement_audit (tip_id, sport, prev_result, new_result, prev_profit_reais, new_profit_reais, actor, reason, source)
    VALUES (?, ?, NULL, ?, NULL, ?, 'system', 'mt-result-propagator', 'lib/mt-result-propagator.js')
  `);

  let changes = 0;
  const tx = db.transaction(() => {
    const r = updateTipResult.run(result, profitR, tipId);
    changes = r.changes;
    if (changes > 0) {
      insertAudit.run(tipId, sport, result, profitR);
      if (Number.isFinite(profitR) && profitR !== 0) {
        bumpBankroll.run(profitR, sport);
      }
    }
  });
  tx();

  return { settled: changes, skipped: false, tip_id: tipId };
}
```

**Note:** the actual `propagateMtResultToTips` in current file is larger (handles lookup paths). The above is conceptual — adjust the existing function preserving lookup logic; the audit + idempotency wraps only the FINAL apply (after match identified).

In practice: find the section where `updateTipResult.run(...)` + `bumpBankroll.run(...)` happen TOGETHER. Add the audit check BEFORE and audit insert INSIDE the tx.

- [ ] **Step 5: Verify test passes (GREEN)**

Re-run the isolated test from Step 3.

Expected: `3 passed, 0 failed`.

- [ ] **Step 6: Verify integration test no regression**

Run:
```bash
npm test 2>&1 | tail -5
```

Expected: `582 passed, 0 failed` (579 + 3 new).

---

## Task 5: Settle gap detector helper (Component C)

**Files:**
- Create: `lib/settle-gap-detector.js`
- Create: `tests/test-settle-gap-detector.js`

- [ ] **Step 1: Write failing test**

Create `tests/test-settle-gap-detector.js`:

```javascript
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
  const tmpDb = path.join(os.tmpdir(), `test-gap-${Date.now()}-${Math.random().toString(36).slice(2,8)}.db`);
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
```

- [ ] **Step 2: Verify test fails (RED)**

Run isolated (same pattern as Task 2):
```bash
cd "C:/Users/vict_/Desktop/lol betting"
node -e "
const path = require('path');
let pass = 0, fail = 0;
function makeT() {
  return {
    test(name, fn) {
      let r; try { r = fn(); } catch (e) { fail++; console.log('  ✗ '+name+'\n     '+e.message); return; }
      if (!r || typeof r.then !== 'function') { pass++; console.log('  ✓ '+name); return; }
      return r.then(()=>{pass++;console.log('  ✓ '+name);},(e)=>{fail++;console.log('  ✗ '+name+'\n     '+e.message);});
    },
    assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
  };
}
(async () => {
  const mod = require(path.resolve('tests/test-settle-gap-detector.js'));
  await mod(makeT());
  console.log('\n'+pass+' passed, '+fail+' failed');
})().catch(e => console.error(e.message));
"
```

Expected: all 4 tests FAIL with `Cannot find module '../lib/settle-gap-detector'`.

- [ ] **Step 3: Create lib/settle-gap-detector.js**

```javascript
/**
 * Settle gap detector — encontra market_tips_shadow.result NOT NULL +
 * tips.result NULL (crash mid-flow entre shadow commit e propagator).
 *
 * Audit P0 architectural 2026-05-15: spec component C.
 */

/**
 * Normaliza team name pra match (espelha _normTeam em mt-result-propagator.js + sql norm).
 */
function _normTeamJs(s) {
  return String(s || '').toLowerCase().replace(/[\s\-.']/g, '');
}

/**
 * SQL fragment pra norm coluna SQLite (compatível com replicate JS norm).
 */
const _NORM_SQL_COL = (col) => `REPLACE(REPLACE(REPLACE(REPLACE(lower(${col}), ' ', ''), '-', ''), '.', ''), '''', '')`;

/**
 * Encontra gaps: shadow settled + tip pending matching (sport, market, normalized pair).
 *
 * @param {Database} db better-sqlite3
 * @param {object} opts { windowDays = 30 }
 * @returns {Array<{shadow_id, tip_id, sport, market, team1, team2, result, profit_pct}>}
 */
function findSettleGaps(db, opts = {}) {
  const windowDays = Number.isFinite(opts.windowDays) && opts.windowDays > 0 ? opts.windowDays : 30;
  const normT1 = _NORM_SQL_COL('t.participant1');
  const normT2 = _NORM_SQL_COL('t.participant2');
  // mts.team1 / mts.team2 are stored already lowercased + normalized (per market-tips-shadow logShadowTip);
  // ainda aplica norm defensively pra cobrir variantes legacy.
  const normM1 = _NORM_SQL_COL('mts.team1');
  const normM2 = _NORM_SQL_COL('mts.team2');

  const sql = `
    SELECT mts.id AS shadow_id, t.id AS tip_id, mts.sport, mts.market,
           mts.team1, mts.team2, mts.result, mts.profit_pct
    FROM market_tips_shadow mts
    INNER JOIN tips t
      ON t.sport = mts.sport
      AND UPPER(t.market_type) = UPPER(mts.market)
      AND COALESCE(t.is_shadow, 0) = 0
      AND (t.archived IS NULL OR t.archived = 0)
      AND t.result IS NULL
      AND ABS(julianday(COALESCE(t.sent_at, t.settled_at)) - julianday(mts.created_at)) < 14
      AND (
        (${normT1} = ${normM1} AND ${normT2} = ${normM2})
        OR
        (${normT1} = ${normM2} AND ${normT2} = ${normM1})
      )
    WHERE mts.result IS NOT NULL
      AND mts.created_at >= datetime('now', '-' || ? || ' days')
    LIMIT 50
  `;

  return db.prepare(sql).all(windowDays);
}

module.exports = { findSettleGaps, _normTeamJs };
```

- [ ] **Step 4: Verify test passes (GREEN)**

Re-run isolated test from Step 2.

Expected: `4 passed, 0 failed`.

- [ ] **Step 5: Verify full npm test no regression**

Run:
```bash
npm test 2>&1 | tail -5
```

Expected: `586 passed, 0 failed` (582 + 4 new).

---

## Task 6: Wire settle gap detector cron in bot.js

**Files:**
- Modify: `bot.js` (add cron near reconciliation cron from Task 3)

- [ ] **Step 1: Add cron block after reconciliation cron**

In `bot.js`, find the `runBankrollReconcileDaily` block (added in Task 3). Insert this block AFTER its `setInterval` line:

```javascript
  // 2026-05-15 audit P0 architectural: settle gap detector cron.
  // Encontra market_tips_shadow.result NOT NULL + tips.result NULL (race
  // entre shadow commit + propagator). Re-fire propagator (idempotent via
  // audit guard). DM admin se gaps > 5 (signal de crash recorrente).
  // Spec: docs/superpowers/specs/2026-05-15-bankroll-integrity-design.md (C)
  let _lastSettleGapDay = null;
  async function runSettleGapDetectorDaily() {
    if (/^(0|false|no)$/i.test(String(process.env.SETTLE_GAP_DETECTOR_AUTO ?? 'true'))) return;
    const hourUtc = parseInt(process.env.SETTLE_GAP_HOUR_UTC || '5', 10);
    const now = new Date();
    if (now.getUTCHours() !== hourUtc) return;
    const today = now.toISOString().slice(0, 10);
    if (_lastSettleGapDay === today) return;
    _lastSettleGapDay = today;
    try {
      const { findSettleGaps } = require('./lib/settle-gap-detector');
      const { propagateMtResultToTips } = require('./lib/mt-result-propagator');
      const windowDays = parseInt(process.env.SETTLE_GAP_WINDOW_DAYS || '30', 10);
      const gaps = findSettleGaps(db, { windowDays });
      log('INFO', 'SETTLE-GAP', `${gaps.length} gap(s) detectados (window ${windowDays}d)`);
      let refired = 0;
      for (const gap of gaps) {
        try {
          // Re-fire propagator — idempotency guard previne double-credit.
          const profitR = (gap.profit_pct / 100) * 1.0;
          const r = propagateMtResultToTips(db, { id: gap.tip_id, sport: gap.sport }, gap.result, profitR);
          if (r.settled === 1) refired++;
        } catch (e) {
          log('WARN', 'SETTLE-GAP', `tip#${gap.tip_id} re-fire failed: ${e.message}`);
        }
      }
      if (refired > 0) log('INFO', 'SETTLE-GAP', `re-fired ${refired}/${gaps.length} successfully`);
      if (gaps.length > 5 && ADMIN_IDS.size && !_isCycleMuted('settle-gap')) {
        const msg = `⚠️ *SETTLE GAP DETECTOR — daily*\n\n${gaps.length} gaps detectados (re-fired: ${refired}). Signal de crash recorrente entre shadow commit + propagator.\n\nInvestigar OOM / SIGKILL / deploy race em logs Railway.`;
        const token = resolveAlertsToken();
        if (token) for (const adminId of ADMIN_IDS) sendDM(token, adminId, msg).catch(e => log('WARN', 'ALERT-FAIL', `adminId=${adminId}: ${e.message}`));
      }
    } catch (e) { log('ERROR', 'SETTLE-GAP', e.message); }
  }
  setInterval(() => runSettleGapDetectorDaily().catch(e => log('ERROR', 'SETTLE-GAP', e.message)), 60 * 60 * 1000);
  setTimeout(() => runSettleGapDetectorDaily().catch(() => {}), 105 * 60 * 1000);
```

- [ ] **Step 2: Verify syntax**

Run:
```bash
node -c bot.js && echo "bot.js syntax OK"
```

Expected: `bot.js syntax OK`.

- [ ] **Step 3: Verify integration test no regression**

Run:
```bash
npm test 2>&1 | tail -5
```

Expected: `586 passed, 0 failed`.

---

## Task 7: Force-sync ambiguous block (Component D)

**Files:**
- Modify: `server.js` around L14124-14180 (`/admin/force-sync-bankroll`)

- [ ] **Step 1: Read current handler**

Run:
```bash
grep -nE "force-sync-bankroll|ambiguousEsportsTips" server.js | head -10
sed -n '14120,14180p' server.js
```

Expected: see `ambiguousEsportsTips` variable tracking + `apply` branch.

- [ ] **Step 2: Add 409 block before apply mutations**

Edit `server.js` — find the section where `apply` is true and bankroll updates happen. BEFORE the actual UPDATE call, add this block:

```javascript
        // 2026-05-15 audit P0 architectural: block apply when ambiguous esports
        // tips presentes. Antes, ambiguous tips eram SILENTLY SKIPPED → REGRAVA
        // current_banca sem contar profit ambíguo → drift permanente.
        // Workflow: admin resolve tip.sport pra bucket específico via
        // UPDATE manual (SQL OR future /admin/tip-resport-sport), depois apply.
        // Spec: docs/superpowers/specs/2026-05-15-bankroll-integrity-design.md (D)
        if (apply && ambiguousEsportsTips && ambiguousEsportsTips.length > 0) {
          sendJson(res, {
            ok: false,
            error: 'ambiguous_esports_tips_blocked',
            ambiguous_count: ambiguousEsportsTips.length,
            sample_tips: ambiguousEsportsTips.slice(0, 10),
            detail: 'Resolve tip.sport pra bucket específico (lol/cs/dota2/val) antes de force-sync com apply=1. Use SQL UPDATE tips SET sport=? WHERE id IN (...). Re-run /admin/force-sync-bankroll?apply=0 pra preview pós-resolução.',
          }, 409);
          return;
        }
```

**Note:** locate exact site where `ambiguousEsportsTips` is fully populated (after the loop that classifies tips). Insert the block immediately after that loop and BEFORE the apply mutations.

- [ ] **Step 3: Verify syntax**

Run:
```bash
node -c server.js && echo "server.js syntax OK"
```

Expected: `server.js syntax OK`.

- [ ] **Step 4: Smoke test manual via curl (post-deploy validation)**

Document but NOT execute during plan execution (requires running server):

```bash
# After deploy, smoke test:
# 1. Inject ambiguous tip:
curl -X POST 'http://localhost:3000/admin/sql' \
  -H "x-admin-key: $KEY" \
  -d '{"sql": "INSERT INTO tips (sport, match_id, result, profit_reais, is_shadow, archived) VALUES (\"esports\", \"unknown_prefix_match\", \"win\", 5.00, 0, 0)"}'
# 2. Try force-sync apply:
curl -X POST 'http://localhost:3000/admin/force-sync-bankroll?apply=1' -H "x-admin-key: $KEY"
# Expected: HTTP 409 with error="ambiguous_esports_tips_blocked"
```

- [ ] **Step 5: Verify integration test no regression**

Run:
```bash
npm test 2>&1 | tail -5
```

Expected: `586 passed, 0 failed`.

---

## Task 8: Document env vars

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Find audit envs section**

Run:
```bash
grep -nE "KELLY_PRODUCT_CAP_FRAC|ADMIN_RATE_LIMIT" .env.example
```

Expected: shows the existing audit envs section.

- [ ] **Step 2: Append bankroll integrity envs**

Edit `.env.example` — after `KELLY_PRODUCT_CAP_FRAC` line, add:

```
BANKROLL_RECONCILE_AUTO=true                # cron daily reconciliation (Spec E)
BANKROLL_RECONCILE_HOUR_UTC=4               # hora UTC daily run
BANKROLL_RECONCILE_THRESHOLD=0.10           # R$ drift threshold > 0 dispara DM admin
SETTLE_GAP_DETECTOR_AUTO=true               # cron daily settle gap detector (Spec C)
SETTLE_GAP_HOUR_UTC=5                       # hora UTC daily run (após reconcile)
SETTLE_GAP_WINDOW_DAYS=30                   # janela busca shadow settled
```

---

## Task 9: Final commit + push + memory

**Files:** all changes consolidated.

- [ ] **Step 1: Final npm test verification**

Run:
```bash
cd "C:/Users/vict_/Desktop/lol betting"
npm test 2>&1 | tail -8
```

Expected: `586 passed, 0 failed` (573 original + 13 new = reconciliation 6 + idempotency 3 + gap 4 = 13).

- [ ] **Step 2: node -c all modified files**

Run:
```bash
node -c migrations/index.js && echo "migrations OK"
node -c lib/bankroll-reconciliation.js && echo "bankroll-reconciliation OK"
node -c lib/settle-gap-detector.js && echo "gap-detector OK"
node -c lib/mt-result-propagator.js && echo "propagator OK"
node -c bot.js && echo "bot OK"
node -c server.js && echo "server OK"
```

Expected: all OK.

- [ ] **Step 3: Git status review**

Run:
```bash
git status --short
```

Expected:
```
M  bot.js
M  server.js
M  migrations/index.js
M  lib/mt-result-propagator.js
M  .env.example
A  lib/bankroll-reconciliation.js
A  lib/settle-gap-detector.js
A  tests/test-bankroll-reconciliation.js
A  tests/test-propagator-idempotency.js
A  tests/test-settle-gap-detector.js
?? db.sqlite3   (gitignored)
?? tmp_live_final.json  (gitignored)
```

- [ ] **Step 4: Commit all changes**

```bash
git add lib/bankroll-reconciliation.js lib/settle-gap-detector.js \
  tests/test-bankroll-reconciliation.js tests/test-propagator-idempotency.js \
  tests/test-settle-gap-detector.js \
  lib/mt-result-propagator.js bot.js server.js migrations/index.js .env.example

git commit -m "feat(audit-arch): Bankroll integrity defense-in-depth (5 components)

Audit P0 architectural (data flow + state agents 2026-05-15) cobrindo 3 items:
- Double-credit risk em shadow re-settle (propagator sem audit)
- Shadow + propagator NÃO-transacional (crash mid-flow → tips stuck)
- Force-sync-bankroll skipa ambiguous esports (drift permanente)

5 components implementados:

A) lib/mt-result-propagator.js audit trail
   Grava tip_settlement_audit row com source='lib/mt-result-propagator.js'
   quando bumpBankroll dispara. Provides traceability + idempotency input.

B) lib/mt-result-propagator.js idempotency guard
   Pre-check audit row existente; se mesmo tip_id + new_result já gravado
   via propagator, skip entire tx (prevent double-credit em restore-voided
   → re-settle cycle).

C) lib/settle-gap-detector.js cron daily 5h UTC
   SELECT market_tips_shadow.result NOT NULL JOIN tips.result NULL via
   norm pair + sport + market + window 14d. Re-fire propagator (idempotent
   via B). DM admin se gaps > 5.

D) server.js /admin/force-sync-bankroll ambiguous block
   Return 409 quando apply=1 AND ambiguous_count > 0. Workflow: admin
   resolve tip.sport bucket antes de apply. Detail mostra sample_tips.

E) lib/bankroll-reconciliation.js cron daily 4h UTC
   Por sport: expected_delta = sum(profit_reais real) vs
   stored_delta = current_banca - initial_banca. Threshold R$0.10 ABS
   (user decisão 2026-05-15). DM admin + log em bankroll_drift_log
   (migration 110).

Migration 110_bankroll_drift_log: nova tabela pra trending drift.

TDD: 13 tests novos (reconciliation 6 + idempotency 3 + gap 4).
Validação: npm test 586/0 cumulative (era 573 + 13 novos).

Envs novos:
- BANKROLL_RECONCILE_AUTO/HOUR_UTC/THRESHOLD
- SETTLE_GAP_DETECTOR_AUTO/HOUR_UTC/WINDOW_DAYS

Spec: docs/superpowers/specs/2026-05-15-bankroll-integrity-design.md
Plan: docs/superpowers/plans/2026-05-15-bankroll-integrity.md

Cross-sport (P5): todos sports cobertos por construção (lib/* central).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Push to main**

Run:
```bash
git push origin main 2>&1 | tail -3
```

Expected: confirmation `XX..YYY main -> main`.

- [ ] **Step 6: Memory update**

Create `memory/project_bankroll_integrity_2026_05_15.md`:

```markdown
---
name: project_bankroll_integrity_2026_05_15
description: Fix P0 audit architectural — bankroll integrity defense-in-depth (5 components A-E). Mig 110. TDD 13 tests. Cross-sport via lib central.
metadata:
  node_type: memory
  type: project
---

# Bankroll Integrity defense-in-depth — 2026-05-15

## Audit origin

Architecture audit 2026-05-15 (data flow + state agents): 3 P0 items
relacionados a profit accounting integrity:
1. Double-credit em shadow re-settle (propagator sem audit)
2. Shadow + propagator NÃO-transacional (crash mid-flow)
3. force-sync-bankroll skipa ambiguous esports

## User decisões (brainstorming)

- Area: A) Data integrity
- Scope: C) Bankroll integrity (3 items, ~4-5h)
- Strategy: Defense-in-depth (prevention + detection)
- Threshold: R$0.10 ABS

## Implementation

5 components A-E (commit IMPLEMENTATION_COMMIT_HASH):
- A) Propagator audit trail (lib/mt-result-propagator.js)
- B) Propagator idempotency guard (lib/mt-result-propagator.js)
- C) Settle gap detector cron daily 5h UTC (lib/settle-gap-detector.js)
- D) Force-sync ambiguous block 409 (server.js)
- E) Bankroll reconciliation cron daily 4h UTC (lib/bankroll-reconciliation.js)

Migration 110_bankroll_drift_log: trending drift table.

## TDD

13 tests novos (586/0 cumulative):
- tests/test-bankroll-reconciliation.js (6 tests)
- tests/test-propagator-idempotency.js (3 tests)
- tests/test-settle-gap-detector.js (4 tests)

## Envs novos

- BANKROLL_RECONCILE_AUTO=true (default)
- BANKROLL_RECONCILE_HOUR_UTC=4
- BANKROLL_RECONCILE_THRESHOLD=0.10
- SETTLE_GAP_DETECTOR_AUTO=true
- SETTLE_GAP_HOUR_UTC=5
- SETTLE_GAP_WINDOW_DAYS=30

## Pending monitoring 7-14d

- Reconciliation drift detected? Sport breakdown?
- Settle gap detector hits > 5/day (signal crash recurrent)?
- Force-sync 409 disparado em prod?

## Relacionado

- Spec: docs/superpowers/specs/2026-05-15-bankroll-integrity-design.md
- Plan: docs/superpowers/plans/2026-05-15-bankroll-integrity.md
- Audit findings: data flow + state agents 2026-05-15
- [[project_bankroll_avg_bug_2026_05_12]] — drift R$6.58 unresolved (this audit may explain root cause)
- [[project_mt_settle_mismatch_2026_05_09]] — settle path race patterns
```

Then update `memory/MEMORY.md` index:

```markdown
- [Bankroll integrity defense-in-depth 2026-05-15 PM](project_bankroll_integrity_2026_05_15.md) — 5 components (A propagator audit, B idempotency, C settle gap detector daily, D force-sync ambiguous block, E reconciliation daily R$0.10 threshold) + mig 110 + 13 TDD tests. Audit P0 architectural data flow + state agents. Memory project_bankroll_avg_bug_2026_05_12 R$6.58 drift may be explained by absence of these guards.
```

- [ ] **Step 7: Commit memory updates**

```bash
cd "C:/Users/vict_/Desktop/lol betting"
# Memory lives outside repo per CLAUDE.md — manual update via Write tool.
# After Write, no git commit needed (memory is .claude scope).
echo "Memory updated locally — no git commit needed"
```

---

## Validation Criteria (post-implementation)

- ✅ `tests/test-bankroll-reconciliation.js`: 6/6 GREEN
- ✅ `tests/test-propagator-idempotency.js`: 3/3 GREEN
- ✅ `tests/test-settle-gap-detector.js`: 4/4 GREEN
- ✅ `npm test` cumulative: 586/0
- ✅ Migration 110 applied successfully (verified via temp DB test em Task 1)
- ✅ All modified files: `node -c` OK
- ✅ Pre-commit hook passa (4 hard gates incluindo npm test)
- ✅ Spec + plan + commit referenciam-se mutuamente

## Devils Advocate (pre-execution)

3 razões pra estar errado:

1. **Cron E timing 4h UTC pode coincidir com `db_backup` (4h hardcoded)** — risk OOM stampede já flagged em audit cron. Mitigation: reconciliation é leve (1 SQL per sport, ~10 sports = 10 queries fast). Mas pra cuidado, conferir overlap antes commit.

2. **Propagator idempotency guard B usa source='lib/mt-result-propagator.js' literal** — se file renamed/moved, audit rows pre-rename não match → false positive (re-fire propagator → double-credit reintroduzido). Mitigation: source string é stable contract (refactor cuidado preserva), OU usar SHA hash do source identifier. Pragmatic: aceitar literal string.

3. **Settle gap detector C re-fires propagator com `profitR = profit_pct/100 * 1.0`** — but stake_reais real pode ser diferente (Kelly mult per sport, stake adjustments). Profit calc deveria usar `stake_reais * (odd-1)` para win, `-stake_reais` para loss. Counter: `propagateMtResultToTips` original já trata profit calc internamente; passar profitR cru aqui pode override. Verificar signature do propagator antes do Step 1 em Task 6.

## Task Dependencies

```
Task 1 (mig 110) ──→ Task 2 (reconciliation lib + tests) ──→ Task 3 (wire cron E)
                  └──→ Task 4 (propagator A+B + tests) ──→ Task 5 (gap detector lib + tests) ──→ Task 6 (wire cron C)
                                                          └──→ Task 7 (force-sync D)
                                                          └──→ Task 8 (env doc)
                                                          └──→ Task 9 (commit + push + memory)
```

Linear execution recommended — each task verifies prior task's tests pass.
