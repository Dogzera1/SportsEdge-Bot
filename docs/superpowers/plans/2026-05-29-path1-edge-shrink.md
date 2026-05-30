# Path 1 — Edge-Shrink + Shin devig + Gold-override fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the EV gate from selecting the model's overconfident errors by anchoring the model probability toward the devigged fair line (all default no-op via env), and produce a backtest that shows the optimal shrink per segment.

**Architecture:** New shared `lib/edge-shrink.js` (`applyEdgeShrink`, `resolveShrink`, `backtestShrink`) consumed by (a) `lib/tennis-market-scanner.js` at each EV site, and (b) a read-only `/admin/edge-shrink-fit` endpoint that backtests on `market_tips_shadow`. `bot.js` gold-override gets a POS_home exclusion so the no-edge segment isn't boosted. Everything is gated by envs defaulting to current behavior — deploy changes nothing until knobs are set.

**Tech Stack:** Node 18, better-sqlite3, `node tests/run.js` runner, fast-check available.

---

## File Structure
- **Create** `lib/edge-shrink.js` — pure helpers: `applyEdgeShrink(pModel,pFair,shrink)`, `resolveShrink(market,env)`, `backtestShrink(tips,opts)`.
- **Create** `tests/test-edge-shrink.js` — unit tests for the three helpers.
- **Modify** `lib/tennis-market-scanner.js` — import helpers; apply shrink at EV sites (191-207, 250-265, 321-333, 351-393); make `_dej` devig method env-driven; export `_ev/_dej` for tests.
- **Modify** `bot.js:19996-20009` — exclude POS_home from `_isHgGoldSegment`.
- **Modify** `server.js` — add read-only `GET /admin/edge-shrink-fit` (thin wrapper over `backtestShrink`).
- **Modify** `tests/run.js` — register `test-edge-shrink.js` if the runner uses an explicit list.

---

### Task 1: `applyEdgeShrink` helper

**Files:** Create `lib/edge-shrink.js`; Test `tests/test-edge-shrink.js`

- [ ] **Step 1: Write failing tests**
```js
// tests/test-edge-shrink.js
const assert = require('assert');
const { applyEdgeShrink } = require('../lib/edge-shrink');

function run() {
  // shrink=1 → trust model (no-op)
  assert.strictEqual(applyEdgeShrink(0.70, 0.55, 1), 0.70);
  // shrink=0 → fully market
  assert.strictEqual(applyEdgeShrink(0.70, 0.55, 0), 0.55);
  // shrink=0.5 → midpoint
  assert.ok(Math.abs(applyEdgeShrink(0.70, 0.55, 0.5) - 0.625) < 1e-9);
  // pFair null/NaN → no-op (trust model)
  assert.strictEqual(applyEdgeShrink(0.70, null, 0.5), 0.70);
  // shrink>1 clamps to no-op; shrink<0 clamps to fair
  assert.strictEqual(applyEdgeShrink(0.70, 0.55, 1.5), 0.70);
  assert.strictEqual(applyEdgeShrink(0.70, 0.55, -0.3), 0.55);
  // bad pModel → returned as-is
  assert.strictEqual(applyEdgeShrink(undefined, 0.55, 0.5), undefined);
  console.log('edge-shrink applyEdgeShrink: OK');
}
module.exports = { run };
if (require.main === module) run();
```

- [ ] **Step 2: Run, verify fail** — `node tests/test-edge-shrink.js` → Expected: throws "Cannot find module '../lib/edge-shrink'".

- [ ] **Step 3: Implement**
```js
// lib/edge-shrink.js
'use strict';
// Anchor a model probability toward the devigged fair (market) probability to
// counter adverse selection: the EV gate otherwise promotes the model's most
// overconfident calls. p_used = pFair + shrink*(pModel - pFair).
//   shrink=1 → trust model fully (current behavior, no-op)
//   shrink=0 → pure market follower (no edge over the book)
function applyEdgeShrink(pModel, pFair, shrink) {
  const pm = Number(pModel);
  if (!Number.isFinite(pm)) return pModel;
  const pf = Number(pFair);
  let s = Number(shrink);
  if (!Number.isFinite(pf) || !Number.isFinite(s)) return pm;
  if (s >= 1) return pm;
  if (s < 0) s = 0;
  return pf + s * (pm - pf);
}
module.exports = { applyEdgeShrink };
```

- [ ] **Step 4: Run, verify pass** — `node tests/test-edge-shrink.js` → Expected: "edge-shrink applyEdgeShrink: OK".

- [ ] **Step 5: Commit** — `git add lib/edge-shrink.js tests/test-edge-shrink.js && git commit -m "feat(edge-shrink): applyEdgeShrink helper (anchor model→fair, default no-op)"`

---

### Task 2: `resolveShrink` env hierarchy

**Files:** Modify `lib/edge-shrink.js`; `tests/test-edge-shrink.js`

- [ ] **Step 1: Add failing test** (append a second function + call it from `run()`):
```js
const { resolveShrink } = require('../lib/edge-shrink');
function runResolve() {
  const base = {};
  assert.strictEqual(resolveShrink('handicapGames', base), 1.0); // default no-op
  assert.strictEqual(resolveShrink('handicapGames', { TENNIS_MT_EDGE_SHRINK: '0.6' }), 0.6);
  // per-market (HG alias) beats blanket
  assert.strictEqual(resolveShrink('handicapGames', { TENNIS_MT_EDGE_SHRINK: '0.6', TENNIS_HG_EDGE_SHRINK: '0.4' }), 0.4);
  // out-of-range ignored → falls through to default
  assert.strictEqual(resolveShrink('handicapGames', { TENNIS_HG_EDGE_SHRINK: '9' }), 1.0);
  console.log('edge-shrink resolveShrink: OK');
}
```
(Add `runResolve()` inside `run()`.)

- [ ] **Step 2: Run, verify fail** — `node tests/test-edge-shrink.js` → Expected: throws (resolveShrink undefined).

- [ ] **Step 3: Implement** (add to lib/edge-shrink.js; market→tag alias matches existing KELLY_TENNIS_HG/TG naming):
```js
const _MARKET_TAG = { handicapgames: 'HG', totalgames: 'TG', aces: 'ACES', tiebreakyn: 'TB' };
function resolveShrink(market, env = process.env) {
  const mkLower = String(market || '').toLowerCase();
  const tag = _MARKET_TAG[mkLower] || mkLower.toUpperCase();
  const cands = [env[`TENNIS_${tag}_EDGE_SHRINK`], env['TENNIS_MT_EDGE_SHRINK']];
  for (const c of cands) {
    if (c == null || c === '') continue;
    const v = Number(c);
    if (Number.isFinite(v) && v >= 0 && v <= 1) return v;
  }
  return 1.0;
}
module.exports = { applyEdgeShrink, resolveShrink };
```

- [ ] **Step 4: Run, verify pass** — `node tests/test-edge-shrink.js` → Expected: both OK lines.

- [ ] **Step 5: Commit** — `git commit -am "feat(edge-shrink): resolveShrink env hierarchy (per-market > blanket > 1.0)"`

---

### Task 3: `backtestShrink` (per-segment re-gate ROI)

**Files:** Modify `lib/edge-shrink.js`; `tests/test-edge-shrink.js`

- [ ] **Step 1: Add failing test**:
```js
const { backtestShrink } = require('../lib/edge-shrink');
function runBacktest() {
  // 2 overconfident losers at high model-EV, 2 modest winners at low EV.
  const tips = [
    { p_model: 0.80, p_implied: 0.50, odd: 2.0, result: 'loss' }, // ev high, loses
    { p_model: 0.78, p_implied: 0.50, odd: 2.0, result: 'loss' },
    { p_model: 0.56, p_implied: 0.52, odd: 2.0, result: 'win' },  // ev low, wins
    { p_model: 0.57, p_implied: 0.52, odd: 2.0, result: 'win' },
  ];
  const r = backtestShrink(tips, { grid: [1, 0.3], minEv: 8, minN: 1 });
  const at1 = r.find(x => x.shrink === 1);
  const at03 = r.find(x => x.shrink === 0.3);
  // at shrink=1 the high-EV losers pass and drag ROI down; at 0.3 they're filtered out
  assert.ok(at03.roi > at1.roi, `expected shrink 0.3 ROI > shrink 1 ROI, got ${at03.roi} vs ${at1.roi}`);
  console.log('edge-shrink backtestShrink: OK');
}
```

- [ ] **Step 2: Run, verify fail** — Expected: throws (backtestShrink undefined).

- [ ] **Step 3: Implement** (flat-1u stake measures SELECTION quality, not historical Kelly):
```js
function backtestShrink(tips, opts = {}) {
  const grid = opts.grid || [0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1.0];
  const minEv = Number.isFinite(opts.minEv) ? opts.minEv : 8;
  const out = [];
  for (const shrink of grid) {
    let n = 0, profit = 0, clvSum = 0, clvN = 0;
    for (const t of tips) {
      const odd = Number(t.odd);
      if (!Number.isFinite(odd) || odd <= 1) continue;
      const pUsed = applyEdgeShrink(t.p_model, t.p_implied, shrink);
      if (!Number.isFinite(pUsed)) continue;
      const ev = (pUsed * odd - 1) * 100;
      if (ev < minEv) continue;
      const res = String(t.result || '').toLowerCase();
      if (res !== 'win' && res !== 'loss') continue; // void/pending excluded
      n++;
      profit += res === 'win' ? (odd - 1) : -1;
      const clv = Number(t.clv_pct);
      if (Number.isFinite(clv)) { clvSum += clv; clvN++; }
    }
    out.push({ shrink, n, roi: n ? +(100 * profit / n).toFixed(2) : null, meanClv: clvN ? +(clvSum / clvN).toFixed(2) : null });
  }
  return out;
}
module.exports = { applyEdgeShrink, resolveShrink, backtestShrink };
```

- [ ] **Step 4: Run, verify pass** — `node tests/test-edge-shrink.js` → Expected: 3 OK lines.

- [ ] **Step 5: Commit** — `git commit -am "feat(edge-shrink): backtestShrink per-segment re-gate ROI/CLV"`

---

### Task 4: Wire shrink + devig-method into the tennis scanner

**Files:** Modify `lib/tennis-market-scanner.js`

- [ ] **Step 1:** Add import after line 29 and make `_dej` method-configurable; add a per-scan resolved shrink. Replace `_dej` (36-39):
```js
const { applyEdgeShrink, resolveShrink } = require('./edge-shrink');
const _DEVIG_METHOD = process.env.TENNIS_MT_DEVIG_METHOD || 'auto'; // 'auto' (no-op) | 'shin' | 'power' | 'multiplicative'
function _dej(a, b) {
  const r = devigEnsemble(a, b, _DEVIG_METHOD === 'auto' ? undefined : { method: _DEVIG_METHOD });
  return r ? { pA: r.p1, pB: r.p2 } : null;
}
```

- [ ] **Step 2:** At EACH EV site, anchor the model prob to the fair side BEFORE `_ev`. Pattern (handicapGames home, scanner.js:253) — insert the shrink and feed the shrunk prob to both `_ev` and the stored `pModel`:
```js
// handicapGames (home @253 / away @265): dj already computed at 250
const sH = resolveShrink('handicapGames');
const pT1u = dj ? applyEdgeShrink(pT1, dj.pA, sH) : pT1;
const evH = _ev(pT1u, h.oddsHome);          // was _ev(pT1, ...)
// ...in tips.push: pModel: +pT1u.toFixed(4),  (keep pModelRaw + pImplied as-is)
const pT2u = dj ? applyEdgeShrink(pT2, dj.pB, sH) : pT2;
const evA = _ev(pT2u, h.oddsAway);
// ...away push: pModel: +pT2u.toFixed(4),
```
Apply the same three-line pattern at totalGames (191/207, fair `dj.pA/pB` from 191), aces (351-363, 381-393), tiebreak (321-333, `dj` from 321). Use `resolveShrink('totalGames')`, `resolveShrink('aces')`, `resolveShrink('tiebreakYN')` respectively. Where `dj` is null, fall back to the raw model prob (no-op). **Do not** change `pImplied`/`pModelRaw`.

- [ ] **Step 3:** Export internals for testing — change line 425:
```js
module.exports = { scanTennisMarkets, _ev, _dej };
```

- [ ] **Step 4: Validate** — `node -c lib/tennis-market-scanner.js` (Expected: no output) then `node tests/run.js` (Expected: full suite passes, including new edge-shrink tests). With no envs set, behavior is identical (shrink=1, devig 'auto') — confirm suite count unchanged.

- [ ] **Step 5: Commit** — `git commit -am "feat(tennis-scanner): edge-shrink anchor to fair line + env devig method (default no-op)"`

---

### Task 5: Fix the gold-override POS_home bypass

**Files:** Modify `bot.js:19996-20009`

- [ ] **Step 1:** Inside the `_isHgGoldSegment` IIFE, add a POS_home exclusion right after the `handicapgames` guard (after line 19997). POS_home has no edge (−8.7% ROI, ~0 CLV) and must never receive the high-EV boost:
```js
// 2026-05-29: POS_home has no demonstrable edge (real −8.7% ROI / ~0 CLV) —
// never apply the high-EV gold boost to it; let it fall to base frac (which
// honors KELLY_TENNIS_HG_POS_HOME). Otherwise the EV>=15 boost bypasses the cut.
if (String(t.side).toLowerCase() === 'home' && _hgLineDir === 'POS') return false;
```

- [ ] **Step 2: Validate** — `node -c bot.js` (Expected: no output). Reason through: a POS_home HG tip now returns `false` from `_isHgGoldSegment` → `_kellyFracForTip = _kellyBaseFrac` (includes `KELLY_TENNIS_HG_POS_HOME` mult via getKellyFraction). NEG_away/POS_away/NEG_home unaffected.

- [ ] **Step 3: Commit** — `git commit -am "fix(tennis-kelly): exclude POS_home from HG gold boost (honors POS_HOME cut)"`

---

### Task 6: Read-only fit endpoint `/admin/edge-shrink-fit`

**Files:** Modify `server.js` (add a route near other `/admin/mt-*` read endpoints)

- [ ] **Step 1:** Add a route handler that pulls settled tennis shadow rows with `p_model`+`p_implied`+`odd`+`result`, groups by segment (market × tier × side × lineDir), and runs `backtestShrink` per segment. Query (read-only, OLAP):
```js
// GET /admin/edge-shrink-fit?sport=tennis&days=90&minN=20&minEv=8
if (p === '/admin/edge-shrink-fit' && req.method === 'GET') {
  if (!requireAdmin(req, res)) return;
  const { backtestShrink } = require('./lib/edge-shrink');
  const sport = (url.searchParams.get('sport') || 'tennis').toLowerCase();
  const days = Math.max(7, parseInt(url.searchParams.get('days') || '90', 10));
  const minN = parseInt(url.searchParams.get('minN') || '20', 10);
  const minEv = parseFloat(url.searchParams.get('minEv') || '8');
  const rows = db.prepare(`
    SELECT market, side, line, league, p_model, p_implied, odd, result, clv_pct
    FROM market_tips_shadow
    WHERE sport = ? AND result IN ('win','loss','void')
      AND p_model IS NOT NULL AND p_implied IS NOT NULL AND odd > 1
      AND created_at >= datetime('now','-'||?||' days')
  `).all(sport, days);
  const seg = {};
  for (const r of rows) {
    const dir = r.line < 0 ? 'NEG' : (r.line > 0 ? 'POS' : 'PK');
    const key = `${r.market}|${dir}_${r.side}`;
    (seg[key] = seg[key] || []).push(r);
  }
  const result = {};
  for (const [key, tips] of Object.entries(seg)) {
    if (tips.length < minN) continue;
    const bt = backtestShrink(tips, { minEv });
    const cur = bt.find(x => x.shrink === 1) || {};
    const best = bt.filter(x => x.n >= Math.min(minN, tips.length) && x.roi != null)
                   .sort((a,b) => b.roi - a.roi)[0] || null;
    result[key] = { n: tips.length, current: cur, best, curve: bt };
  }
  return sendJson(res, 200, { ok: true, sport, days, minEv, segments: result });
}
```
(Match the file's existing helper names: replace `requireAdmin`/`sendJson`/`db`/`url`/`p` with whatever the neighbouring `/admin/mt-*` handlers use — read one adjacent handler first.)

- [ ] **Step 2: Validate** — `node -c server.js` (Expected: no output). Endpoint is read-only and P2-compliant (shadow → research/cause only; it recommends, never auto-acts).

- [ ] **Step 3: Commit** — `git commit -am "feat(admin): /admin/edge-shrink-fit backtest per-segment optimal shrink (read-only)"`

---

### Task 7: Register test + full green

- [ ] **Step 1:** Open `tests/run.js`; if it uses an explicit require list, add `require('./test-edge-shrink').run();` (match existing style). If it auto-globs `test-*.js`, no change.
- [ ] **Step 2: Run** — `node tests/run.js` → Expected: all tests pass, new edge-shrink tests included.
- [ ] **Step 3: Final syntax** — `node -c bot.js && node -c server.js && node -c lib/tennis-market-scanner.js && node -c lib/edge-shrink.js` → Expected: no output.
- [ ] **Step 4: Commit** — `git commit -am "test(edge-shrink): register in runner; full suite green"`

---

## Self-Review (done)
- **Spec coverage:** Fix A (Tasks 1-4), Fix B (Task 4 devig), Fix C (Task 5), fit/validation (Tasks 3+6). All covered.
- **No-op default:** shrink default 1.0 (Task 2), devig default 'auto' (Task 4), gold-exclusion only narrows POS_home — deploy changes nothing until envs set. ✓
- **Type consistency:** `applyEdgeShrink/resolveShrink/backtestShrink` signatures consistent across Tasks 1-3, 4, 6. ✓
- **Post-build:** run `/admin/edge-shrink-fit` on prod → present per-segment optimal shrink to user BEFORE setting any `TENNIS_*_EDGE_SHRINK` env.
