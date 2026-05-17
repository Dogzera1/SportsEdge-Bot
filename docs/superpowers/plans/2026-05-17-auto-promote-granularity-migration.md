# Auto-Promote Granularity Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate ML + MT auto-promote from sport-level binary decisions to full P1 granularity (sport × market × side × tier × bucket), unlocking surgical promote/revert decisions per market/side without leaking globally.

**Architecture:** State migrates from env-only (`<SPORT>_MARKET_TIPS_ENABLED`) to DB-backed `mt_market_promote_state` / `ml_tier_promote_state` tables with in-memory cache. Decision queries expand GROUP BY incrementally per phase. Backward compat preserved via 2-layer lookup: new state table THEN legacy env fallback. Phased rollout — each phase ships independently and produces working software.

**Tech Stack:** Node.js 18, better-sqlite3 (WAL), migrations/ numbered, jest tests in `__tests__/`. No new dependencies.

**Pre-requisites:**
- Commit `bb34b56` ou superior (per-sport WINDOW_DAYS + EVAL_SINCE + MIN_SETTLED já mergeados)
- Acesso Railway pra setar envs por fase
- Pre-commit hook ativo (672 tests verde)

---

## Phase Map

| Fase | Granularidade adicionada | Sistemas | Complexidade | Edge unlock |
|---|---|---|---|---|
| **1** | MT: (sport, market) | MT PROMOTE + REVERT | Média | Alto — promove handicap_games separado de handicap_sets |
| **2** | MT: (sport, market, side) | MT PROMOTE + REVERT | Média | Médio — over vs under, home vs away |
| **3** | ML: (sport, tier) | ML PROMOTE + REVERT | Média | Alto — tier1 lol libera real, EWC mantém shadow |
| **4** | ML: (sport, tier, bucket) | ML PROMOTE + REVERT | Alta — sample fragmentation | Médio — bucket-specific |
| **5** | LEAGUE_BLOCK + BUCKET_BLOCK alinhamento | ambos | Baixa — só refactor | Limpeza arquitetural |

**Order rationale:** Fase 1 destrava o maior edge sem fragmentar sample (MT já tem dezenas de markets, agregar per market é estatisticamente seguro). Fase 4 último porque (tier × bucket) fragmenta sample em até 18 bins per sport — risco de promote ruidoso.

**Ship policy:** Cada fase é independente. Após mergear + 7 dias de observação em prod, próxima fase começa. Não fazer todas em sequência sem validation gap.

---

## Storage Design

### Tabela nova: `mt_market_promote_state` (mig 112)

```sql
CREATE TABLE IF NOT EXISTS mt_market_promote_state (
  sport TEXT NOT NULL,
  market TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  promoted_at TEXT,                  -- ISO ts da última transição enabled=1
  reverted_at TEXT,                  -- ISO ts da última transição enabled=0
  source TEXT NOT NULL DEFAULT 'auto',  -- auto | manual | legacy_env
  reason TEXT,
  PRIMARY KEY (sport, market)
);

CREATE INDEX IF NOT EXISTS idx_mt_market_promote_state_enabled
  ON mt_market_promote_state(sport, enabled);
```

### Tabela nova: `ml_tier_promote_state` (mig 114, depois Fase 3)

```sql
CREATE TABLE IF NOT EXISTS ml_tier_promote_state (
  sport TEXT NOT NULL,
  tier TEXT NOT NULL,                -- 'tier1', 'tier2', 'other', etc — alinhado com lib/league-tier.js
  enabled INTEGER NOT NULL DEFAULT 0,
  promoted_at TEXT,
  reverted_at TEXT,
  source TEXT NOT NULL DEFAULT 'auto',
  reason TEXT,
  PRIMARY KEY (sport, tier)
);

CREATE INDEX IF NOT EXISTS idx_ml_tier_promote_state_enabled
  ON ml_tier_promote_state(sport, enabled);
```

### Tabela nova: `ml_tier_bucket_promote_state` (mig 116, depois Fase 4)

```sql
CREATE TABLE IF NOT EXISTS ml_tier_bucket_promote_state (
  sport TEXT NOT NULL,
  tier TEXT NOT NULL,
  bucket TEXT NOT NULL,              -- '<1.4', '1.4-1.6', '1.6-2.0', '2.0-2.5', '2.5-4.0', '>4.0'
  enabled INTEGER NOT NULL DEFAULT 0,
  promoted_at TEXT,
  reverted_at TEXT,
  source TEXT NOT NULL DEFAULT 'auto',
  reason TEXT,
  PRIMARY KEY (sport, tier, bucket)
);
```

### Estado legacy preservado:
- `<SPORT>_MARKET_TIPS_ENABLED=true` env continua funcionando — interpreta como "todos os markets enabled pra esse sport" durante transição.
- `<SPORT>_SHADOW=true` env continua funcionando — interpreta como "todos tiers em shadow".
- Após Fase 5 + 30d observação, envs legacy podem ser sunsetadas via deprecation warning.

---

## File Structure

**Fase 1 toca:**
- Create: `migrations/112_mt_market_promote_state.sql`
- Create: `lib/mt-market-promote.js` (~150 LoC — helper isMtMarketPromoted + setMtMarketPromote + load cache)
- Modify: `lib/mt-auto-promote.js:155-193` (_statsBySport → _statsBySportMarket, GROUP BY sport, market)
- Modify: `lib/mt-auto-promote.js:413-440` (PROMOTE/REVERT loop iterar (sport, market) ao invés de sport)
- Modify: `bot.js` MT emit path — check isMtMarketPromoted no lugar de env-only
- Modify: `server.js` (~3 endpoints novos: /admin/mt-market-promote-status, /admin/mt-market-promote-set, /admin/mt-market-promote-list)
- Test: `__tests__/lib/mt-market-promote.test.js` (~80 LoC)
- Test: `__tests__/lib/mt-auto-promote.granular.test.js` (~120 LoC)

---

## Phase 1: MT (sport, market) PROMOTE

### Task 1.1: Migration 112 — `mt_market_promote_state` table

**Files:**
- Create: `migrations/112_mt_market_promote_state.sql`
- Test: `__tests__/migrations/112_mt_market_promote_state.test.js`

- [ ] **Step 1: Write the failing test**

```js
// __tests__/migrations/112_mt_market_promote_state.test.js
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

test('mig 112 creates mt_market_promote_state with index', () => {
  const db = new Database(':memory:');
  // Run migrations 001..112 in order; assume migration runner exists at lib/migrations/index.js
  const { runMigrations } = require('../../lib/migrations');
  runMigrations(db);
  const tableInfo = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='mt_market_promote_state'`).get();
  expect(tableInfo).toBeTruthy();
  const cols = db.prepare(`PRAGMA table_info(mt_market_promote_state)`).all();
  const colNames = cols.map(c => c.name);
  expect(colNames).toEqual(expect.arrayContaining(['sport', 'market', 'enabled', 'promoted_at', 'reverted_at', 'source', 'reason']));
  const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_mt_market_promote_state_enabled'`).get();
  expect(idx).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/migrations/112_mt_market_promote_state.test.js -t "mig 112"`
Expected: FAIL with "no such table"

- [ ] **Step 3: Write migration**

```sql
-- migrations/112_mt_market_promote_state.sql
-- 2026-05-17 — per (sport, market) promote state pra MT auto-promote granular.
-- Backward compat: legacy <SPORT>_MARKET_TIPS_ENABLED continua sendo lido
-- (isMtMarketPromoted faz 2-layer lookup: table THEN env fallback).
CREATE TABLE IF NOT EXISTS mt_market_promote_state (
  sport TEXT NOT NULL,
  market TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  promoted_at TEXT,
  reverted_at TEXT,
  source TEXT NOT NULL DEFAULT 'auto',
  reason TEXT,
  PRIMARY KEY (sport, market)
);

CREATE INDEX IF NOT EXISTS idx_mt_market_promote_state_enabled
  ON mt_market_promote_state(sport, enabled);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/migrations/112_mt_market_promote_state.test.js -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add migrations/112_mt_market_promote_state.sql __tests__/migrations/112_mt_market_promote_state.test.js
git commit -m "mig 112: mt_market_promote_state table"
```

---

### Task 1.2: Helper `lib/mt-market-promote.js` — isMtMarketPromoted + cache

**Files:**
- Create: `lib/mt-market-promote.js`
- Test: `__tests__/lib/mt-market-promote.test.js`

- [ ] **Step 1: Write the failing test (load + lookup + cache)**

```js
// __tests__/lib/mt-market-promote.test.js
const Database = require('better-sqlite3');
const { runMigrations } = require('../../lib/migrations');
const {
  isMtMarketPromoted,
  setMtMarketPromote,
  loadMtMarketPromoteCache,
  _clearCache,
} = require('../../lib/mt-market-promote');

let db;
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  _clearCache();
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
  delete process.env.LOL_MARKET_TIPS_ENABLED;
});

test('state table OVERRIDES legacy env (per-market wins)', () => {
  process.env.LOL_MARKET_TIPS_ENABLED = 'true';
  setMtMarketPromote(db, 'lol', 'HANDICAP_SETS', false, { reason: 'leak' });
  loadMtMarketPromoteCache(db);
  expect(isMtMarketPromoted('lol', 'KILLS_TOTAL')).toBe(true);        // legacy via env
  expect(isMtMarketPromoted('lol', 'HANDICAP_SETS')).toBe(false);     // state row override
  delete process.env.LOL_MARKET_TIPS_ENABLED;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/lib/mt-market-promote.test.js -v`
Expected: FAIL with module not found

- [ ] **Step 3: Implement the helper**

```js
// lib/mt-market-promote.js
'use strict';

/**
 * mt-market-promote.js — per (sport, market) promote state pra MT auto-promote.
 *
 * Substitui o gate sport-level <SPORT>_MARKET_TIPS_ENABLED por decisão granular.
 * Backward compat: legacy env continua válida — interpretada como "todos os
 * markets enabled pra esse sport". Linhas na tabela mt_market_promote_state
 * OVERRIDE o legacy env por (sport, market) específico.
 *
 * Cache em memória (Map) populado por loadMtMarketPromoteCache. Bot.js MT emit
 * path chama isMtMarketPromoted(sport, market) hot.
 */

const { log } = require('./utils');

const _cache = new Map();  // key: 'sport|market', value: boolean

function _key(sport, market) {
  return `${String(sport || '').toLowerCase()}|${String(market || '').toUpperCase()}`;
}

function _clearCache() { _cache.clear(); }

function loadMtMarketPromoteCache(db) {
  try {
    _cache.clear();
    const rows = db.prepare(`SELECT sport, market, enabled FROM mt_market_promote_state`).all();
    for (const r of rows) {
      _cache.set(_key(r.sport, r.market), Boolean(r.enabled));
    }
    if (rows.length) log('INFO', 'MT-MARKET-PROMOTE', `Loaded ${rows.length} market state rows`);
  } catch (e) {
    log('DEBUG', 'MT-MARKET-PROMOTE', `load err: ${e.message}`);
  }
}

function isMtMarketPromoted(sport, market) {
  const k = _key(sport, market);
  if (_cache.has(k)) return _cache.get(k);
  // Fallback: legacy sport-level env (interpreta como todos markets do sport).
  const up = String(sport || '').toUpperCase();
  return process.env[`${up}_MARKET_TIPS_ENABLED`] === 'true';
}

function setMtMarketPromote(db, sport, market, enabled, opts = {}) {
  const { source = 'auto', reason = null } = opts;
  const sp = String(sport || '').toLowerCase();
  const mk = String(market || '').toUpperCase();
  if (!sp || !mk) return;
  const tsCol = enabled ? 'promoted_at' : 'reverted_at';
  db.prepare(`
    INSERT INTO mt_market_promote_state (sport, market, enabled, ${tsCol}, source, reason)
    VALUES (?, ?, ?, datetime('now'), ?, ?)
    ON CONFLICT(sport, market) DO UPDATE SET
      enabled = excluded.enabled,
      ${tsCol} = excluded.${tsCol},
      source = excluded.source,
      reason = excluded.reason
  `).run(sp, mk, enabled ? 1 : 0, source, reason);
  _cache.set(_key(sp, mk), Boolean(enabled));
}

module.exports = {
  isMtMarketPromoted,
  setMtMarketPromote,
  loadMtMarketPromoteCache,
  _clearCache,  // exported pra testes
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/lib/mt-market-promote.test.js -v`
Expected: PASS all 5 cases

- [ ] **Step 5: Commit**

```bash
git add lib/mt-market-promote.js __tests__/lib/mt-market-promote.test.js
git commit -m "feat(mt-market-promote): per (sport,market) state helper + cache"
```

---

### Task 1.3: Stats query `_statsBySportMarket` em mt-auto-promote

**Files:**
- Modify: `lib/mt-auto-promote.js` (adicionar nova function próxima a `_statsBySport`)
- Test: `__tests__/lib/mt-auto-promote.granular.test.js`

- [ ] **Step 1: Write the failing test**

```js
// __tests__/lib/mt-auto-promote.granular.test.js
const Database = require('better-sqlite3');
const { runMigrations } = require('../../lib/migrations');

let db;
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  // Insert market_tips_shadow rows: lol/HANDICAP_GAMES n=60 ROI+8%, lol/HANDICAP_SETS n=55 ROI-12%
  const stmt = db.prepare(`
    INSERT INTO market_tips_shadow (sport, market, side, team1, team2, league, created_at,
      result, stake_units, profit_units, clv_pct)
    VALUES (?, ?, ?, 'A', 'B', 'L', datetime('now'), ?, 1, ?, NULL)
  `);
  for (let i = 0; i < 60; i++) stmt.run('lol', 'HANDICAP_GAMES', 'over', 'win', 0.08);
  for (let i = 0; i < 55; i++) stmt.run('lol', 'HANDICAP_SETS', 'over', 'loss', -0.12);
});

test('_statsBySportMarket aggregates per (sport, market)', () => {
  const { _statsBySportMarket } = require('../../lib/mt-auto-promote');
  const rows = _statsBySportMarket(db, 30, { applyWindowOverride: true });
  const lolHg = rows.find(r => r.sport === 'lol' && r.market === 'HANDICAP_GAMES');
  const lolHs = rows.find(r => r.sport === 'lol' && r.market === 'HANDICAP_SETS');
  expect(lolHg.settled).toBe(60);
  expect(lolHg.profit_u).toBeCloseTo(60 * 0.08, 1);
  expect(lolHs.settled).toBe(55);
  expect(lolHs.profit_u).toBeCloseTo(55 * -0.12, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/lib/mt-auto-promote.granular.test.js -t "statsBySportMarket"`
Expected: FAIL with `_statsBySportMarket is not a function`

- [ ] **Step 3: Implement _statsBySportMarket**

Em `lib/mt-auto-promote.js`, após `_statsBySport` (line ~270 aproximadamente, antes de `_statsBySportReal`):

```js
// 2026-05-17 — Phase 1 granularidade. Aggrega per (sport, market) pra
// PROMOTE granular (handicap_games separado de handicap_sets etc).
function _statsBySportMarket(db, defaultDays, opts = {}) {
  const holdoutClause = require('./frozen-holdout').getHoldoutSql('mt_auto_promote', 'created_at');
  const BODY = `
    SELECT sport, market,
      COUNT(CASE WHEN result IN ('win','loss') THEN 1 END) AS settled,
      SUM(CASE WHEN result IN ('win','loss') THEN COALESCE(stake_units, 1) ELSE 0 END) AS stake_u,
      SUM(COALESCE(profit_units, 0)) AS profit_u,
      SUM(COALESCE(profit_units, 0) * COALESCE(profit_units, 0)) AS profit_sq,
      AVG(clv_pct) AS avg_clv,
      SUM(CASE WHEN clv_pct IS NOT NULL THEN 1 ELSE 0 END) AS clv_n
    FROM market_tips_shadow
    WHERE sport = ? AND created_at >= ?
      __HOLDOUT__
      AND market IS NOT NULL AND TRIM(market) != ''
    GROUP BY sport, market
  `;
  const stmtWithHoldout = db.prepare(BODY.replace('__HOLDOUT__', holdoutClause));
  const stmtNoHoldout = holdoutClause ? db.prepare(BODY.replace('__HOLDOUT__', '')) : stmtWithHoldout;
  const out = [];
  for (const sport of SPORTS) {
    const cutoff = _effectiveCutoffISO(sport, defaultDays, opts);
    const stmt = _hasSinceForSport(sport) ? stmtNoHoldout : stmtWithHoldout;
    const rows = stmt.all(sport, cutoff);
    for (const r of rows) out.push(r);
  }
  return out;
}
```

E exportar:

```js
module.exports = {
  runMtAutoPromoteCycle,
  isMtLeagueBlockedForMarket,
  loadMtMarketLeagueBlocklist,
  _statsBySportMarket,  // exposto pra testes
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/lib/mt-auto-promote.granular.test.js -t "statsBySportMarket"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/mt-auto-promote.js __tests__/lib/mt-auto-promote.granular.test.js
git commit -m "feat(mt-auto-promote): _statsBySportMarket aggregates per (sport,market)"
```

---

### Task 1.4: Variant `_statsBySportMarketReal` (REAL path com JOIN)

**Files:**
- Modify: `lib/mt-auto-promote.js`
- Test: `__tests__/lib/mt-auto-promote.granular.test.js` (mesmo arquivo, novo test)

- [ ] **Step 1: Write the failing test**

```js
test('_statsBySportMarketReal joins with real tips per (sport, market)', () => {
  // Insert matching real tips
  const tipsStmt = db.prepare(`
    INSERT INTO tips (sport, market_type, participant1, participant2, sent_at, result, is_shadow, archived,
      stake, odds, profit_reais)
    VALUES (?, ?, 'A', 'B', datetime('now', '-2 days'), ?, 0, 0, 1, 1.9, ?)
  `);
  for (let i = 0; i < 30; i++) tipsStmt.run('lol', 'HANDICAP_GAMES', 'win', 0.9);
  const { _statsBySportMarketReal } = require('../../lib/mt-auto-promote');
  const rows = _statsBySportMarketReal(db, 30, { applyWindowOverride: false });
  const lolHg = rows.find(r => r.sport === 'lol' && r.market === 'HANDICAP_GAMES');
  expect(lolHg).toBeTruthy();
  expect(lolHg.settled).toBe(30);
});
```

- [ ] **Step 2: Run test (FAIL — function missing)**

Run: `npx jest __tests__/lib/mt-auto-promote.granular.test.js -t "MarketReal"`
Expected: FAIL

- [ ] **Step 3: Implement _statsBySportMarketReal**

Em `lib/mt-auto-promote.js`, após `_statsBySportMarket`:

```js
function _statsBySportMarketReal(db, defaultDays, opts = {}) {
  const holdoutClause = require('./frozen-holdout').getHoldoutSql('mt_auto_promote', 'mts.created_at');
  const BODY = `
    SELECT mts.sport AS sport, mts.market AS market,
      COUNT(CASE WHEN mts.result IN ('win','loss') THEN 1 END) AS settled,
      SUM(CASE WHEN mts.result IN ('win','loss') THEN COALESCE(mts.stake_units, 1) ELSE 0 END) AS stake_u,
      SUM(COALESCE(mts.profit_units, 0)) AS profit_u,
      SUM(COALESCE(mts.profit_units, 0) * COALESCE(mts.profit_units, 0)) AS profit_sq,
      AVG(mts.clv_pct) AS avg_clv,
      SUM(CASE WHEN mts.clv_pct IS NOT NULL THEN 1 ELSE 0 END) AS clv_n
    FROM market_tips_shadow mts
    ${_JOIN_REAL_SQL}
    WHERE mts.sport = ? AND mts.created_at >= ?
      __HOLDOUT__
      AND mts.market IS NOT NULL AND TRIM(mts.market) != ''
    GROUP BY mts.sport, mts.market
  `;
  const stmtWithHoldout = db.prepare(BODY.replace('__HOLDOUT__', holdoutClause));
  const stmtNoHoldout = holdoutClause ? db.prepare(BODY.replace('__HOLDOUT__', '')) : stmtWithHoldout;
  const out = [];
  for (const sport of SPORTS) {
    const cutoff = _effectiveCutoffISO(sport, defaultDays, opts);
    const stmt = _hasSinceForSport(sport) ? stmtNoHoldout : stmtWithHoldout;
    const rows = stmt.all(sport, cutoff);
    for (const r of rows) out.push(r);
  }
  return out;
}
```

Exportar `_statsBySportMarketReal` no module.exports também.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/lib/mt-auto-promote.granular.test.js -t "MarketReal"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/mt-auto-promote.js __tests__/lib/mt-auto-promote.granular.test.js
git commit -m "feat(mt-auto-promote): _statsBySportMarketReal joins real tips per (sport,market)"
```

---

### Task 1.5: PROMOTE loop per (sport, market) — granular decision

**Files:**
- Modify: `lib/mt-auto-promote.js:380-440` (substituir loop sport-only por loop sport+market)
- Test: `__tests__/lib/mt-auto-promote.granular.test.js` (novo test)

- [ ] **Step 1: Write the failing test**

```js
test('runMtAutoPromoteCycle promotes lol/HANDICAP_GAMES, NOT lol/HANDICAP_SETS', async () => {
  // Setup: 60 wins HG (ROI +8%), 55 losses HS (ROI -12%). Threshold 50, ROI>=2%.
  process.env.MT_AUTO_PROMOTE = 'true';
  process.env.MT_AUTO_PROMOTE_MIN_SETTLED = '50';
  process.env.MT_AUTO_PROMOTE_MIN_ROI = '2';
  process.env.MT_AUTO_PROMOTE_REQUIRE_CI = 'false';  // simplify test
  const { runMtAutoPromoteCycle } = require('../../lib/mt-auto-promote');
  const { isMtMarketPromoted, loadMtMarketPromoteCache } = require('../../lib/mt-market-promote');
  const result = await runMtAutoPromoteCycle(db);
  loadMtMarketPromoteCache(db);
  expect(result.decisions.promoted).toContainEqual(expect.objectContaining({ sport: 'lol', market: 'HANDICAP_GAMES' }));
  expect(result.decisions.promoted).not.toContainEqual(expect.objectContaining({ sport: 'lol', market: 'HANDICAP_SETS' }));
  expect(isMtMarketPromoted('lol', 'HANDICAP_GAMES')).toBe(true);
  expect(isMtMarketPromoted('lol', 'HANDICAP_SETS')).toBe(false);
});
```

- [ ] **Step 2: Run test (FAIL — promote still sport-level)**

Run: `npx jest __tests__/lib/mt-auto-promote.granular.test.js -t "promotes lol/HANDICAP_GAMES"`
Expected: FAIL

- [ ] **Step 3: Refactor PROMOTE loop**

Em `lib/mt-auto-promote.js`, dentro de `runMtAutoPromoteCycle`, **substituir** o bloco `── Sport-level promote / revert ──` (linhas ~390-445 aproximadamente):

```js
  // ── (Sport, Market)-level promote / revert (Phase 1 — 2026-05-17) ──
  try {
    const sportMarketRows = _statsBySportMarket(db, days, { applyWindowOverride: true });
    const revertSrcRows = realOnly
      ? _statsBySportMarketReal(db, revertDays, { applyWindowOverride: false })
      : _statsBySportMarket(db, revertDays, { applyWindowOverride: false });
    const revertBy = new Map(revertSrcRows.map(r => [`${r.sport}|${r.market}`, r]));
    const { isMtMarketPromoted, setMtMarketPromote } = require('./mt-market-promote');

    for (const r of sportMarketRows) {
      const sport = String(r.sport || '').toLowerCase();
      const market = String(r.market || '').toUpperCase();
      if (!sport || !market || !SPORTS.includes(sport)) continue;
      const settled = Number(r.settled) || 0;
      const roi = (r.stake_u > 0) ? (Number(r.profit_u) / Number(r.stake_u) * 100) : null;
      const clv = (r.clv_n > 0) ? (Number(r.avg_clv) || 0) : null;
      const promoted = isMtMarketPromoted(sport, market);
      const ci = _computeRoiCi(settled, Number(r.profit_u) || 0, Number(r.profit_sq) || 0);
      const ciPasses = !requireCi || (ci && ci.lower_pp > ciLowerThreshold);
      // Per-sport MIN_SETTLED ja existe. Per-(sport,market) opcional (Task 1.7).
      const minSettledForSport = _envInt(`MT_AUTO_PROMOTE_MIN_SETTLED_${sport.toUpperCase()}`, minSettled);

      if (!promoted && settled >= minSettledForSport && roi != null && roi >= minRoi && ciPasses) {
        setMtMarketPromote(db, sport, market, true, { source: 'auto', reason: `auto: ROI ${roi.toFixed(1)}% n=${settled}` });
        const ciStr = ci ? ` IC95%[${ci.lower_pp},${ci.upper_pp}]pp` : '';
        _logDecision(db, { sport, market, action: 'promote', reason: `auto: ROI ${roi.toFixed(1)}%${ciStr} n=${settled}`, n: settled, roi, clv });
        decisions.promoted.push({ sport, market, roi: +roi.toFixed(1), n: settled, clv: clv != null ? +clv.toFixed(1) : null, ci });
        log('INFO', 'MT-AUTO-PROMOTE', `${sport}/${market}: PROMOVIDO ROI=${roi.toFixed(1)}%${ciStr} n=${settled}`);
      } else if (!promoted && settled >= minSettledForSport && roi != null && roi >= minRoi && !ciPasses) {
        const ciStr = ci ? ` IC95%[${ci.lower_pp},${ci.upper_pp}]pp` : ' IC=null';
        _logDecision(db, { sport, market, action: 'reject_ci', reason: `IC lower ≤ ${ciLowerThreshold}: mean ROI ${roi.toFixed(1)}%${ciStr}`, n: settled, roi });
        decisions.rejected_by_ci.push({ sport, market, roi: +roi.toFixed(1), n: settled, ci, reason: 'ic_lower_zero_or_negative' });
      } else if (promoted) {
        const rv = revertBy.get(`${sport}|${market}`);
        const rvSettled = rv ? (Number(rv.settled) || 0) : 0;
        const rvRoi = (rv && rv.stake_u > 0) ? (Number(rv.profit_u) / Number(rv.stake_u) * 100) : null;
        if (rvSettled >= Math.min(minSettledForSport, 20) && rvRoi != null && rvRoi <= revertRoi) {
          setMtMarketPromote(db, sport, market, false, { source: 'auto', reason: `auto revert: ROI ${rvRoi.toFixed(1)}% n=${rvSettled}` });
          _logDecision(db, { sport, market, action: 'revert', reason: `auto: ROI ${rvRoi.toFixed(1)}% n=${rvSettled} (${revertDays}d)`, n: rvSettled, roi: rvRoi });
          decisions.reverted.push({ sport, market, roi: +rvRoi.toFixed(1), n: rvSettled });
          log('WARN', 'MT-AUTO-PROMOTE', `${sport}/${market}: REVERTIDO ROI=${rvRoi.toFixed(1)}% n=${rvSettled} (${revertDays}d)`);
        }
      }
    }
  } catch (e) {
    log('WARN', 'MT-AUTO-PROMOTE', `sport-market-level err: ${e.message}`);
  }
```

Remove o `_setMtPromoteEnv` helper antigo (deprecated) ou mantém pra backward compat com alguma logic legacy fora da função.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest __tests__/lib/mt-auto-promote.granular.test.js -t "promotes lol/HANDICAP_GAMES"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/mt-auto-promote.js __tests__/lib/mt-auto-promote.granular.test.js
git commit -m "feat(mt-auto-promote): granular PROMOTE per (sport, market)"
```

---

### Task 1.6: Consumer bot.js — checkar `isMtMarketPromoted` no MT emit path

**Files:**
- Modify: `bot.js` (find call sites de `<SPORT>_MARKET_TIPS_ENABLED` env check)
- Test: manual + e2e (sem unit test específico — integração no recordMarketTipAsRegular path)

- [ ] **Step 1: Grep call sites**

Run: `Grep "MARKET_TIPS_ENABLED" bot.js -n`

Capturar todos os pontos onde o env é consultado. Esperado: 3-5 callsites em `recordMarketTipAsRegular`, `_splitBucketShadow`, ou similar.

- [ ] **Step 2: Substituir por isMtMarketPromoted**

Pra cada callsite, substituir:

```js
// Antes:
if (process.env[`${sport.toUpperCase()}_MARKET_TIPS_ENABLED`] !== 'true') {
  // forced shadow
}

// Depois:
const { isMtMarketPromoted } = require('./lib/mt-market-promote');
if (!isMtMarketPromoted(sport, marketType)) {
  // forced shadow
}
```

Onde `marketType` deve estar disponível no escopo da função (parameter ou derivado).

- [ ] **Step 3: Add boot-time cache load**

Em `bot.js` boot path (ou onde outros caches são carregados):

```js
const { loadMtMarketPromoteCache } = require('./lib/mt-market-promote');
loadMtMarketPromoteCache(db);
```

- [ ] **Step 4: Refresh cache pós cycle**

Em `lib/mt-auto-promote.js`, ao fim de `runMtAutoPromoteCycle`, próximo a `loadMtMarketLeagueBlocklist(db)`:

```js
require('./mt-market-promote').loadMtMarketPromoteCache(db);
```

- [ ] **Step 5: Syntax validation**

```bash
node -c bot.js && node -c lib/mt-auto-promote.js && echo OK
```

- [ ] **Step 6: Commit**

```bash
git add bot.js lib/mt-auto-promote.js
git commit -m "feat(mt-emit): consult isMtMarketPromoted instead of env-only"
```

---

### Task 1.7: Per-(sport, market) MIN_SETTLED override (opcional)

**Files:**
- Modify: `lib/mt-auto-promote.js` (PROMOTE loop)
- Test: `__tests__/lib/mt-auto-promote.granular.test.js` (novo test)

- [ ] **Step 1: Write the failing test**

```js
test('MT_AUTO_PROMOTE_MIN_SETTLED_LOL_HANDICAP_GAMES=30 lowers threshold for that market', async () => {
  // 40 wins HG (ROI +8%) — passes 30 but not 50
  process.env.MT_AUTO_PROMOTE_MIN_SETTLED = '50';
  process.env.MT_AUTO_PROMOTE_MIN_SETTLED_LOL_HANDICAP_GAMES = '30';
  // ... insert 40 HG wins
  const { runMtAutoPromoteCycle } = require('../../lib/mt-auto-promote');
  const result = await runMtAutoPromoteCycle(db);
  expect(result.decisions.promoted).toContainEqual(expect.objectContaining({ sport: 'lol', market: 'HANDICAP_GAMES' }));
});
```

- [ ] **Step 2: Run test (FAIL — env not consulted)**

- [ ] **Step 3: Implement per-(sport,market) override**

Em PROMOTE loop, substituir:

```js
const minSettledForSport = _envInt(`MT_AUTO_PROMOTE_MIN_SETTLED_${sport.toUpperCase()}`, minSettled);
```

por:

```js
const sportUp = sport.toUpperCase();
const marketUp = market.toUpperCase().replace(/[^A-Z0-9]/g, '_');
const minSettledForPair = _envInt(`MT_AUTO_PROMOTE_MIN_SETTLED_${sportUp}_${marketUp}`,
  _envInt(`MT_AUTO_PROMOTE_MIN_SETTLED_${sportUp}`, minSettled));
```

E usar `minSettledForPair` em vez de `minSettledForSport` na decisão.

- [ ] **Step 4: Run test (PASS)**

- [ ] **Step 5: Commit**

```bash
git add lib/mt-auto-promote.js __tests__/lib/mt-auto-promote.granular.test.js
git commit -m "feat(mt-auto-promote): per (sport,market) MIN_SETTLED override"
```

---

### Task 1.8: Admin endpoints

**Files:**
- Modify: `server.js` (~3 endpoints novos)
- Test: integration via curl

- [ ] **Step 1: GET /admin/mt-market-promote-status**

Em `server.js`, próximo a `/admin/mt-promote-status` existente, adicionar:

```js
// GET /admin/mt-market-promote-status?sport=lol&key=<KEY>
// Lista per (sport, market) state — granular vs legacy env.
if (p === '/admin/mt-market-promote-status') {
  const adminOk = isAdminRequest(req) || _isAdminQueryKeyDeprecated(req, parsed, p);
  if (!adminOk) { sendJson(res, { ok: false, error: 'unauthorized' }, 401); return; }
  try {
    const sportFilter = parsed.query.sport ? String(parsed.query.sport).toLowerCase() : null;
    let q = `SELECT sport, market, enabled, promoted_at, reverted_at, source, reason FROM mt_market_promote_state`;
    const args = [];
    if (sportFilter) { q += ` WHERE sport = ?`; args.push(sportFilter); }
    q += ` ORDER BY sport, market`;
    const rows = db.prepare(q).all(...args);
    // Anexa legacy env per sport pra visibility
    const ALL = ['lol', 'dota2', 'cs', 'cs2', 'valorant', 'tennis', 'football', 'mma', 'tabletennis', 'darts', 'snooker'];
    const legacy = {};
    for (const sp of ALL) {
      if (!sportFilter || sp === sportFilter) {
        const v = process.env[`${sp.toUpperCase()}_MARKET_TIPS_ENABLED`];
        if (v) legacy[sp] = v;
      }
    }
    sendJson(res, { ok: true, state_rows: rows, legacy_env: legacy });
  } catch (e) { sendJson(res, { ok: false, error: e.message }, 500); }
  return;
}
```

- [ ] **Step 2: POST /admin/mt-market-promote-set**

```js
// POST /admin/mt-market-promote-set?sport=lol&market=HANDICAP_GAMES&enabled=1&reason=...&key=<KEY>
if (p === '/admin/mt-market-promote-set' && (req.method === 'POST' || req.method === 'GET')) {
  const adminOk = isAdminRequest(req) || _isAdminQueryKeyDeprecated(req, parsed, p);
  if (!adminOk) { sendJson(res, { ok: false, error: 'unauthorized' }, 401); return; }
  const sport = parsed.query.sport ? String(parsed.query.sport).toLowerCase() : null;
  const market = parsed.query.market ? String(parsed.query.market).toUpperCase() : null;
  const enabled = parsed.query.enabled === '1' || parsed.query.enabled === 'true';
  const reason = parsed.query.reason ? String(parsed.query.reason) : null;
  if (!sport || !market) { sendJson(res, { ok: false, error: 'sport+market required' }, 400); return; }
  try {
    const { setMtMarketPromote } = require('./lib/mt-market-promote');
    setMtMarketPromote(db, sport, market, enabled, { source: 'manual', reason });
    sendJson(res, { ok: true, sport, market, enabled });
  } catch (e) { sendJson(res, { ok: false, error: e.message }, 500); }
  return;
}
```

- [ ] **Step 3: Syntax + manual test**

```bash
node -c server.js && echo OK
# Após deploy, manual:
# curl "$BASE/admin/mt-market-promote-status?key=$KEY"
# curl -X POST "$BASE/admin/mt-market-promote-set?sport=lol&market=HANDICAP_GAMES&enabled=1&reason=test&key=$KEY"
```

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(admin): /admin/mt-market-promote-{status,set} endpoints"
```

---

### Task 1.9: Header docs + observability hooks

**Files:**
- Modify: `lib/mt-auto-promote.js` (header docs)
- Modify: `FEATURE_INVENTORY.md` (catálogo)

- [ ] **Step 1: Update header**

Adicionar ao header de `lib/mt-auto-promote.js`:

```
 * 2026-05-17 — Phase 1 granularidade migration: PROMOTE/REVERT agora per
 * (sport, market) ao invés de sport-level. State persistido em
 * mt_market_promote_state (mig 112). Backward compat via 2-layer lookup
 * em isMtMarketPromoted (state row OVERRIDE legacy env, env é fallback).
 *
 * Per-(sport, market) MIN_SETTLED override: MT_AUTO_PROMOTE_MIN_SETTLED_<SPORT>_<MARKET>
```

- [ ] **Step 2: Update FEATURE_INVENTORY.md**

Adicionar linha:

```
| `mt_market_promote_state` | DB | Per (sport, market) promote state. Source: auto/manual/legacy_env. Cache em lib/mt-market-promote.js |
```

- [ ] **Step 3: Commit**

```bash
git add lib/mt-auto-promote.js FEATURE_INVENTORY.md
git commit -m "docs(mt-auto-promote): document Phase 1 granularity migration"
```

---

### Task 1.10: Validation suite + deploy

**Files:**
- All Phase 1 commits
- Force-run via /admin/mt-auto-promote?run=1

- [ ] **Step 1: Run full test suite**

```bash
node -c bot.js && node -c server.js && node -c lib/mt-auto-promote.js && node -c lib/mt-market-promote.js
npx jest __tests__/lib/mt-market-promote.test.js __tests__/lib/mt-auto-promote.granular.test.js -v
```
Expected: ALL PASS

- [ ] **Step 2: Push + deploy**

```bash
git push origin main
```

Aguardar Railway deploy. Poll `/admin/p2-status` até commit_short match.

- [ ] **Step 3: Force-run cycle**

```bash
curl -s "$BASE/admin/mt-auto-promote?run=1&key=$KEY" | jq '.cycle.decisions'
```

- [ ] **Step 4: Verify state rows**

```bash
curl -s "$BASE/admin/mt-market-promote-status?key=$KEY" | jq
```

Expected: rows pra (sport, market) que passaram threshold pós-fix.

- [ ] **Step 5: Validate consumer**

Próximas 12-24h: monitorar via `/admin/tips-recent` se MT tips reais estão saindo só pros (sport, market) promovidos, e shadow continua pros outros markets do mesmo sport.

- [ ] **Step 6: Documentar resultado**

Anotar em memory novo file `project_mt_granular_phase1_<data>.md` com:
- Quantos (sport, market) promovidos
- ROI agregado pre vs post
- Comparison com sport-level legacy
- Side findings

---

## Phase 2: MT (sport, market, side) PROMOTE

**High-level tasks (detalhe em plano follow-up após Phase 1 ship):**

- 2.1: Mig 113 — adicionar coluna `side TEXT` em `mt_market_promote_state` (ou nova tabela `mt_market_side_promote_state`)
- 2.2: Helper `isMtMarketSidePromoted(sport, market, side)`
- 2.3: `_statsBySportMarketSide` aggregator (GROUP BY sport, market, side)
- 2.4: PROMOTE loop expanded — promove (lol, HANDICAP_MAPS, over) sem promover (lol, HANDICAP_MAPS, under)
- 2.5: Consumer bot.js — passar side no check
- 2.6: Admin endpoints — extend status + set pra incluir side
- 2.7: Backward compat — null side significa "all sides" (legacy)

**Estimated effort:** ~150 LoC + 60 LoC tests. Sample fragmentation risk: per (sport, market, side) typically 50-60% do volume per (sport, market) — manageable.

---

## Phase 3: ML (sport, tier) PROMOTE

**High-level tasks:**

- 3.1: Mig 114 — `ml_tier_promote_state(sport, tier, enabled, ...)`
- 3.2: Helper `isMlTierPromoted(sport, tier)` — usa `lib/league-tier.js` pra derivar tier de `event_name`
- 3.3: `_fetchTipsFiltered` extend pra agregar per tier (já tem audit_granular per tier)
- 3.4: PROMOTE loop per (sport, tier) — substitui `_isCurrentlyShadow(sport, db)` por `!isMlTierPromoted(sport, tier)`
- 3.5: Consumer bot.js ML emit path — derivar tier do event_name, checar isMlTierPromoted
- 3.6: Hierarchy de envs: `<SPORT>_<TIER>_ML_SHADOW=true` > `<SPORT>_ML_SHADOW=true` > default
- 3.7: Admin endpoints — `/admin/ml-tier-promote-{status,set}`

**Estimated effort:** ~200 LoC + 80 LoC tests. Pega o caso lol EWC bleeder sem afetar LCK/LCS.

**Caveat:** lib/league-tier.js classifier deve ser canônico (P3 unificação já feita em commit 7f9dcc9). Se houver paralelos (lib/esports-runtime-features.leagueTier), refactor primeiro.

---

## Phase 4: ML (sport, tier, bucket) PROMOTE

**High-level tasks:**

- 4.1: Mig 116 — `ml_tier_bucket_promote_state(sport, tier, bucket, enabled, ...)`
- 4.2: Sample fragmentation guard: se `_aggregate per (sport, tier, bucket)` tem n < 30, fallback pra tier-level promote state (Phase 3)
- 4.3: `_aggregateBySportTierBucket` reuse de audit_granular logic
- 4.4: PROMOTE loop com fallback hierarchy: bucket > tier > sport
- 4.5: Consumer bot.js — bucket derivado de odd no momento da emissão
- 4.6: Admin endpoints
- 4.7: ML_BUCKET_BLOCK existing (mig 105) merge/aligna com bucket_promote_state

**Estimated effort:** ~250 LoC + 100 LoC tests. Higher risk: 6 buckets × 4 tiers = 24 bins per sport, sample fragmentation alta.

**Recommendation:** Após Phase 3 + 14d observação. Não ship sem evidence de que tier-level (Phase 3) cobre 80%+ do edge.

---

## Phase 5: LEAGUE_BLOCK + BUCKET_BLOCK alignment

**Refactor only — sem nova decisão semântica:**

- 5.1: Renomear `ml_bucket_blocklist` → `ml_tier_bucket_block_state` pra alinhar nomenclatura com promote_state
- 5.2: Merge BLOCK semantics: enabled=0 com source='auto_bucket_block' substitui blocklist separada
- 5.3: Audit P3 — verificar 3+ implementações paralelas; consolidar via lib helper canônico
- 5.4: Sunset envs legacy: `<SPORT>_MARKET_TIPS_ENABLED`, `<SPORT>_SHADOW` com deprecation warning + DM admin se ainda setadas pós 30d

**Estimated effort:** ~80 LoC refactor + tests. Low risk pois é estrutural, não comportamental.

---

## Cross-cutting concerns

### Rollback strategy (per phase)

| Fase | Rollback step |
|---|---|
| 1 | DROP TABLE mt_market_promote_state; revert commits Tasks 1.5-1.8 (bot.js consumer); legacy env retoma autoridade |
| 2 | DROP coluna side ou tabela mt_market_side_promote_state; revert consumer changes |
| 3 | DROP TABLE ml_tier_promote_state; revert ml-auto-promote PROMOTE loop |
| 4 | DROP TABLE ml_tier_bucket_promote_state; PROMOTE loop revert |
| 5 | Refactor revert — restore old table names; preserve legacy envs |

Cada fase commit é atômico — `git revert <commit>` reverte sem afetar outras fases.

### Observability (todas as fases)

- `/admin/p2-status` retorna `auto_promote_granularity_phase` (1-5) baseado em qual mig table existe.
- Log INFO cada PROMOTE/REVERT decision com granularidade explícita: `lol/HANDICAP_GAMES PROMOTE ROI+8% n=60` em vez de `lol PROMOTE`.
- Decision log table `mt_auto_promote_log` já tem coluna `market` — usar em Phase 1+. ML log table extend com `tier`, `bucket` em Phase 3-4.

### Testing strategy

- Unit: per helper (mt-market-promote, ml-tier-promote)
- Integration: per stats function (`_statsBySport*`)
- E2E: full `runMtAutoPromoteCycle` em DB :memory: com fixtures de market_tips_shadow
- Manual: post-deploy /admin/* endpoints para spot-check

### Performance

- Per-sport loop em stats functions adiciona ~11 queries por function (de 1 → 11). Total Phase 1: 4 functions × 11 = 44 queries vs 4 pre-fix. Better-sqlite3 sync ~0.1ms/query = +4-5ms total per cycle. Negligível (cron 12h).
- Cache load (`loadMtMarketPromoteCache`) é boot-time + post-cycle. Hot path (`isMtMarketPromoted`) é Map.get O(1).

---

## Self-Review checklist (autora preenche pós-write)

- [x] Spec coverage: phases cobrem ML+MT, todas P1 dimensions (sport/market/side/tier/bucket) que fazem sentido. Side+confidence+regime ficam fora — outros decision points existem (e.g., MT já tem side em alguns markets via market name; regime tem outros gates).
- [x] Placeholder scan: Phase 1 tem código completo. Phases 2-5 são high-level por design (cada uma vira plano follow-up detalhado pós-validação Phase 1). Nada "TBD" dentro de Phase 1 tasks.
- [x] Type consistency: `isMtMarketPromoted` signature consistente em Tasks 1.2, 1.5, 1.6, 1.8. `setMtMarketPromote` idem.
- [x] No magic strings: market names normalizados via `_key()` (lower sport, UPPER market).
- [x] Tests reference real columns (market_tips_shadow schema preserved).

---

## Phase 1 estimated total

- Code: ~350 LoC (lib/mt-market-promote 150 + mt-auto-promote refactor 100 + bot.js consumer 30 + server.js endpoints 70)
- Tests: ~200 LoC
- Migrations: 1 (mig 112)
- Time estimate: 4-6h focused work + 12-24h post-deploy validation

**Ready to execute Phase 1 quando autorização.**
