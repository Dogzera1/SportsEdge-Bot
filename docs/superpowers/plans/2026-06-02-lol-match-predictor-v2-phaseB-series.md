# Match Predictor v2 — Phase B (Bo3/Bo5 series) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a side-neutralized Bo3/Bo5 series probability to the Match Lab predictor, on top of the games-fed Elo shipped in Phase A.

**Architecture:** Pure `seriesProb(p, bestOf)` (binomial) over the side-agnostic Elo `P(team1 wins a game)`. `predictMatch` exposes `seriesNeutralP`; the endpoint returns `{bo1,bo3,bo5}`; the UI adds a Bo1/Bo3/Bo5 selector and shows game vs series side by side. The series uses only the Elo (no draft — future drafts unknown). Display-only.

**Tech Stack:** Node.js, better-sqlite3, custom test runner (`node tests/run.js`), the games-fed Elo from Phase A (`meta.eloSource='games'`, ship OOS Brier 0.2096).

**Spec:** `docs/superpowers/specs/2026-06-02-lol-match-predictor-v2-design.md` (Part b). Phase A (Elo source) already shipped.

---

## File structure

- `lib/lol-match-series.js` — **create**: `seriesProb(p, bestOf)` (pure binomial).
- `lib/lol-match-predict.js` — **modify**: `predictMatch` returns `seriesNeutralP`.
- `server.js` — **modify**: `/api/lol-match-analyze` returns `series:{bo1,bo3,bo5}`.
- `public/lol-live-dashboard.html` — **modify**: Bo selector + series render in `dlRenderMatchResult`.
- `scripts/backtest-lol-match.js` — **modify**: series-level validation of `seriesProb` (Brier/ECE vs real series winners); `matchOeDraft` returns its representative `gid`.
- `tests/test-lol-match-series.js` — **create**.
- `tests/test-lol-match-predict.js` — extend (predictMatch `seriesNeutralP`).

---

## Task 1: `lib/lol-match-series.js` — `seriesProb`

**Files:**
- Create: `lib/lol-match-series.js`
- Test: `tests/test-lol-match-series.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test-lol-match-series.js`:
```js
'use strict';
const assert = require('assert');
const { seriesProb } = require('../lib/lol-match-series');

module.exports = function (t) {
  t.test('Bo1 returns p unchanged', () => {
    assert.strictEqual(seriesProb(0.6, 1), 0.6);
  });
  t.test('p=0.5 gives 0.5 for every format', () => {
    for (const bo of [1, 3, 5]) {
      assert.ok(Math.abs(seriesProb(0.5, bo) - 0.5) < 1e-9, `Bo${bo} at p=0.5`);
    }
  });
  t.test('Bo3 known value p=0.6 -> 0.648', () => {
    assert.ok(Math.abs(seriesProb(0.6, 3) - 0.648) < 1e-9, `got ${seriesProb(0.6, 3)}`);
  });
  t.test('Bo5 known value p=0.6 -> 0.68256', () => {
    assert.ok(Math.abs(seriesProb(0.6, 5) - 0.68256) < 1e-9, `got ${seriesProb(0.6, 5)}`);
  });
  t.test('favorite is more favored in longer series (monotone in bestOf)', () => {
    const p = 0.6;
    assert.ok(seriesProb(p, 5) > seriesProb(p, 3) && seriesProb(p, 3) > seriesProb(p, 1), 'Bo5>Bo3>Bo1 for p>0.5');
  });
  t.test('underdog symmetric: seriesProb(p)+seriesProb(1-p)=1', () => {
    for (const bo of [1, 3, 5]) {
      assert.ok(Math.abs(seriesProb(0.6, bo) + seriesProb(0.4, bo) - 1) < 1e-9, `Bo${bo} symmetry`);
    }
  });
  t.test('result always in [0,1]', () => {
    for (const p of [0, 0.1, 0.5, 0.9, 1]) for (const bo of [1, 3, 5]) {
      const r = seriesProb(p, bo);
      assert.ok(r >= 0 && r <= 1, `seriesProb(${p},${bo})=${r}`);
    }
  });
};
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/run.js`
Expected: FAIL in `[lol-match-series]` — `seriesProb` not a function.

- [ ] **Step 3: Create `lib/lol-match-series.js`**

```js
'use strict';
/**
 * lol-match-series.js — convert a per-game win prob into a best-of-N series win prob.
 * Side-neutralized: `p` is P(team wins ONE game) with the blue/red advantage averaged
 * out (in a series both teams play both sides), so games are treated as i.i.d. with
 * constant p and P(series) is the binomial "first to ⌈bestOf/2⌉ wins". Display-only.
 */

function _binom(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1);
  return r;
}

// P(team wins a best-of-`bestOf` series) given per-game win prob `p`.
// bestOf 1 -> p; 3 -> p²(3−2p); 5 -> p³(6p²−15p+10); general odd N via negative binomial.
function seriesProb(p, bestOf) {
  const n = Math.max(1, Math.floor(Number(bestOf) || 1));
  if (n <= 1) return p;
  const need = Math.ceil(n / 2);
  let sum = 0;
  for (let k = 0; k < need; k++) {
    sum += _binom(need - 1 + k, k) * Math.pow(p, need) * Math.pow(1 - p, k);
  }
  return Math.max(0, Math.min(1, sum));
}

module.exports = { seriesProb };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node tests/run.js`
Expected: all `[lol-match-series]` tests pass; suite `N passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add lib/lol-match-series.js tests/test-lol-match-series.js
git commit -m "feat(match-lab): seriesProb binomial Bo1/Bo3/Bo5 (predictor v2 phase B step 1)"
```

---

## Task 2: `predictMatch` exposes `seriesNeutralP`

**Files:**
- Modify: `lib/lol-match-predict.js` (`predictMatch`)
- Test: `tests/test-lol-match-predict.js`

- [ ] **Step 1: Add tests to `tests/test-lol-match-predict.js`** (inside the exported `async function(t)` block, before the `db.close()` near the end)

```js
  t.test('seriesNeutralP present in [0,1] for known teams', () => {
    const out = predictMatch(db, { team1: 'T1', team2: 'Gen.G', side: 'blue', draft: null });
    assert.ok(typeof out.seriesNeutralP === 'number', 'seriesNeutralP is number');
    assert.ok(out.seriesNeutralP >= 0 && out.seriesNeutralP <= 1, `in [0,1], got ${out.seriesNeutralP}`);
  });

  t.test('seriesNeutralP is side-agnostic (same for blue and red orientation)', () => {
    const a = predictMatch(db, { team1: 'T1', team2: 'Gen.G', side: 'blue', draft: null });
    const b = predictMatch(db, { team1: 'T1', team2: 'Gen.G', side: 'red', draft: null });
    // P(T1 wins a game) does not depend on which side we *call* T1 — Elo is side-agnostic.
    assert.ok(Math.abs(a.seriesNeutralP - b.seriesNeutralP) < 1e-9,
      `neutral prob should match across orientation: ${a.seriesNeutralP} vs ${b.seriesNeutralP}`);
  });

  t.test('seriesNeutralP null when no teams (no Elo)', () => {
    const out = predictMatch(db, { team1: null, team2: null, side: 'blue',
      draft: { blue: [{ champion: 'Jinx', role: 'bot' }], red: [{ champion: 'Zeri', role: 'bot' }] } });
    assert.strictEqual(out.seriesNeutralP, null, 'no Elo => seriesNeutralP null');
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/run.js`
Expected: FAIL — `out.seriesNeutralP` undefined (not a number / not null).

- [ ] **Step 3: Implement in `lib/lol-match-predict.js`**

In `predictMatch`, the Elo term sets `pEloBlue = e.pA` (P(blueTeam wins)) when both teams are found, else stays `null`. `blueTeam` is `team1` when `side==='blue'`, else `team2`. So P(team1 wins a game) is `pEloBlue` when side is blue, `1 - pEloBlue` when side is red. Add this right after the Elo block (after `pEloBlue`/`eloConf` are finalized, before the draft block):

```js
  // Side-neutralized P(team1 wins one game) for series math (Elo is side-agnostic).
  const seriesNeutralP = (pEloBlue === null) ? null : (side === 'blue' ? pEloBlue : 1 - pEloBlue);
```

Then add `seriesNeutralP` to the returned object (alongside `prob`, `probBlue`, `components`, …):

```js
    seriesNeutralP: (seriesNeutralP === null) ? null : +seriesNeutralP.toFixed(4),
```

- [ ] **Step 4: Run to verify it passes**

Run: `node tests/run.js`
Expected: the three new tests pass; suite `N passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add lib/lol-match-predict.js tests/test-lol-match-predict.js
git commit -m "feat(match-lab): predictMatch exposes seriesNeutralP (predictor v2 phase B step 2)"
```

---

## Task 3: Endpoint returns `series:{bo1,bo3,bo5}`

**Files:**
- Modify: `server.js` (`/api/lol-match-analyze`, ~line 5334-5383)

- [ ] **Step 1: Compute and return the series block**

In the `/api/lol-match-analyze` handler, after `const out = predictMatch(db, { … });` (and before the `sendJson(res, { ok: true, ...out, gameProfile });` line), add:

```js
        let series = null;
        if (typeof out.seriesNeutralP === 'number') {
          const { seriesProb } = require('./lib/lol-match-series');
          const p = out.seriesNeutralP;
          series = {
            neutralP: +p.toFixed(4),
            bo1: +seriesProb(p, 1).toFixed(4),
            bo3: +seriesProb(p, 3).toFixed(4),
            bo5: +seriesProb(p, 5).toFixed(4),
          };
        }
```

Then change the success response to include `series`:

```js
        sendJson(res, { ok: true, ...out, gameProfile, series });
```

- [ ] **Step 2: Syntax check + smoke the endpoint logic**

Run: `node -c server.js`
Expected: parses clean.

Run (smoke the series math against a real prediction):
```
node -e "const Database=require('better-sqlite3');const db=new Database('sportsedge.db',{readonly:true});const {predictMatch}=require('./lib/lol-match-predict');const {seriesProb}=require('./lib/lol-match-series');const o=predictMatch(db,{team1:'T1',team2:'Gen.G',side:'blue',draft:null});const p=o.seriesNeutralP;console.log('neutralP',p,'bo3',seriesProb(p,3).toFixed(4),'bo5',seriesProb(p,5).toFixed(4));db.close();"
```
Expected: prints `neutralP <x>` and bo3/bo5 values; bo5 should be further from 0.5 than bo3 (longer series favors the favorite). Paste the output.

- [ ] **Step 3: Run the suite**

Run: `node tests/run.js`
Expected: `N passed, 0 failed`.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(match-lab): /api/lol-match-analyze returns series bo1/bo3/bo5 (predictor v2 phase B step 3)"
```

---

## Task 4: UI — Bo selector + game/series side by side

**Files:**
- Modify: `public/lol-live-dashboard.html`

- [ ] **Step 1: Render the series block with a Bo selector in `dlRenderMatchResult`**

`dlRenderMatchResult(data, team1, team2)` (~line 2241) builds the win% bar and `dl-prob-nums` headline, then component rows, then `dlRenderGameProfile`. After the `dl-prob-nums` headline `root.appendChild(...)` block and before the component breakdown (`const c = data.components || {}`), insert a series block. It reads `data.series` (`{neutralP, bo1, bo3, bo5}`); when present, shows a Bo1/Bo3/Bo5 selector (default Bo3) and the team1/team2 series win% side by side with the game number. Use the existing `el(...)` helper and `pct(...)` (already defined at the top of the function):

```js
  // series prob (display-only) — side-neutralized binomial; selector switches Bo (no re-request)
  if (data.series) {
    const fmts = [['Bo1', 'bo1'], ['Bo3', 'bo3'], ['Bo5', 'bo5']];
    const valEl = el('span', { class: 'dl-series-val' });
    const render = (key) => {
      const ps = data.series[key];
      valEl.textContent = `${team1 || 'T1'} ${pct(ps)} · ${team2 || 'T2'} ${pct(1 - ps)}`;
    };
    const sel = el('div', { class: 'dl-series-sel' });
    fmts.forEach(([label, key], i) => {
      const b = el('button', { class: 'dl-series-btn' + (i === 1 ? ' active' : '') }, label);
      b.addEventListener('click', () => {
        sel.querySelectorAll('.dl-series-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        render(key);
      });
      sel.appendChild(b);
    });
    root.appendChild(el('div', { class: 'dl-series-row' },
      el('span', { class: 'dl-series-lbl' }, 'Série'), sel, valEl));
    render('bo3'); // default Bo3
  }
```

- [ ] **Step 2: Add minimal CSS for the series row**

In the `<style>` block (near the `.dl-comp-row` / `.dl-prob-nums` rules), add:

```css
.dl-series-row { display: flex; align-items: center; gap: 10px; margin: 6px 0; font-family: var(--font-mono); font-size: 11px; flex-wrap: wrap; }
.dl-series-lbl { color: var(--ink-mute); letter-spacing: 0.1em; text-transform: uppercase; font-size: 9.5px; }
.dl-series-sel { display: inline-flex; gap: 4px; }
.dl-series-btn { background: var(--surface); border: 1px solid var(--border); color: var(--ink-mute); font-family: var(--font-mono); font-size: 10px; padding: 2px 7px; border-radius: 3px; cursor: pointer; }
.dl-series-btn.active { border-color: var(--border-strong); color: var(--ink); }
.dl-series-val { color: var(--ink-soft); }
```

- [ ] **Step 3: Validate JS syntax**

Run:
```
node -e "const fs=require('fs');const h=fs.readFileSync('public/lol-live-dashboard.html','utf8');const m=h.match(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i);new Function(m[1]);console.log('JS OK');"
```
Expected: `JS OK`.

- [ ] **Step 4: Manual smoke (display-only, no automated UI test)**

Run `node server.js`, open `/edge`, Match Lab → enter two known teams (e.g. T1, Gen.G), Analisar partida. Expected: a "Série" row appears with a Bo1/Bo3/Bo5 selector (Bo3 active by default); clicking Bo5 widens the favorite's % vs Bo3; the game win% headline stays as-is.

- [ ] **Step 5: Commit**

```bash
git add public/lol-live-dashboard.html
git commit -m "feat(match-lab): UI Bo selector + series win% (predictor v2 phase B step 4)"
```

---

## Task 5: Backtest — series-level validation of `seriesProb`

**Files:**
- Modify: `scripts/backtest-lol-match.js`

Validation that `seriesProb(games-Elo game prob)` predicts real series winners well. Reuses the `winnerMap` (games-fed Elo as-of per OE gameid, no leakage — built in Phase A) and `matchOeDraft` (links a `match_results` series to its game-1 OE gameid).

- [ ] **Step 1: Make `matchOeDraft` also return its representative gameid**

`matchOeDraft` (~line 93-111) computes `repGid` (the earliest gameid = game 1) and returns `{ draft, team1IsBlue }`. Change the return to also include the gid:

```js
  return { draft: { blue: og.blue, red: og.red }, team1IsBlue: cand.get(repGid), gid: repGid };
```

(Additive — existing callers ignore the extra field.)

- [ ] **Step 2: Add the series validation block (after `winnerMap` is defined, near the end of the game-level section, before `db.close()`)**

```js
// --- Phase B: validate seriesProb(games-fed Elo game prob) vs real series winners ---
const { seriesProb } = require('../lib/lol-match-series');
const seriesSamples = [];
for (const g of games) {
  const m = matchOeDraft(g, oeIndex, oeByGame, norm);
  if (!m || !m.gid) continue;
  const pBlue = winnerMap.get(m.gid); // games-fed Elo as-of pre-game-1 (no leakage)
  if (pBlue == null) continue;
  const pNeutralT1 = m.team1IsBlue ? pBlue : 1 - pBlue;
  const sc = String(g.final_score || '').match(/(\d+)\s*[-:]\s*(\d+)/);
  if (!sc) continue;
  const bestOf = 2 * Math.max(parseInt(sc[1]), parseInt(sc[2])) - 1;
  const y = (String(g.winner).toLowerCase() === String(g.team1).toLowerCase()) ? 1 : 0;
  seriesSamples.push({ p: seriesProb(pNeutralT1, bestOf), y, date: g.resolved_at });
}
seriesSamples.sort((a, b) => String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0);
const sTest = seriesSamples.slice(Math.floor(seriesSamples.length * 0.7));
const sBase = M.blueSideBaseline(sTest);
console.log('\n=== Phase B: series-level validation (seriesProb on games-Elo) ===');
console.log(`[series-B] n=${sTest.length}  Brier=${M.brier(sTest).toFixed(4)}  logloss=${M.logloss(sTest).toFixed(4)}  ECE=${M.ece(sTest).toFixed(4)}  base=${sBase.brier.toFixed(4)}`);
console.log(`[series-B] beats base-rate OOS? ${M.brier(sTest) < sBase.brier ? 'YES' : 'NO'}`);
```

- [ ] **Step 3: Run the backtest**

Run: `node scripts/backtest-lol-match.js`
Expected: in addition to the Phase A A/B table and ablation, prints the `Phase B: series-level validation` block. Report the `[series-B]` Brier/ECE and whether it beats the base-rate. (This is validation only — it does not change any artifact. ECE here is the signal for whether a series calibration is worth adding later; per spec, only add it if ECE is high.)

- [ ] **Step 4: Run the suite**

Run: `node tests/run.js`
Expected: `N passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add scripts/backtest-lol-match.js
git commit -m "feat(match-lab): backtest series-level validation of seriesProb (predictor v2 phase B step 5)"
```

---

## Notes for the implementer

- **Money-path untouched:** nothing here imports or changes `getLolProbability`, EV, Kelly, stake, or tip emission. `lol-match-series`/`lol-match-predict` are display-only; the endpoint is a display endpoint.
- **Series uses only the Elo, not the draft** — drafts of games 2–5 are unknown. The game number keeps the draft; the series number is team-skill only. Do not feed draft into `seriesProb`.
- **`seriesNeutralP` is side-agnostic by construction** — `predictMatch` derives it from the Elo `pBlue` oriented to team1; it must be identical for `side:'blue'` and `side:'red'` (Task 2 test asserts this).
- **If `[series-B]` ECE is high** (say >0.10), that is expected-ish (binomial assumes i.i.d. games; real series have momentum). Do NOT add a calibration layer in this plan — just report it; a calibration gate is a separate, evidence-driven follow-up (the game blend already calibrates its own number).
