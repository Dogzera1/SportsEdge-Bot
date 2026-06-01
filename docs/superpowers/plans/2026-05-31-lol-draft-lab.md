# Draft Lab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a draft-only LoL win-probability tool ("Draft Lab") to the `/edge` dashboard — given a champion draft (from feed, manual picker, or screenshot), show win prob + an interpretable lane/synergy/counter breakdown. Display-only (no live pricing/EV/tips change).

**Architecture:** A pure runtime engine (`lib/lol-draft-model.js`) consumes three committed JSON artifacts (WR table, lane-matchup matrix, synergy matrix) produced offline by a training script reading `oracleselixir_players`. A hybrid model: a 4-feature logistic regression gives the number; each feature is also surfaced as a shrinkage-weighted breakdown. Two new public endpoints (`/api/lol-draft-analyze`, `/api/lol-draft-parse-print`) and a panel in `lol-live-dashboard.html`. The print parser calls Anthropic Claude Haiku 4.5 vision, gated on `ANTHROPIC_API_KEY` (dormant until set).

**Tech Stack:** Node.js, better-sqlite3, pure-JS logistic regression (no ML dep), existing `aiPost` HTTP helper, existing `tests/run.js` harness. **No new npm deps. No DB schema migration.**

**Spec:** `docs/superpowers/specs/2026-05-31-lol-draft-lab-design.md`

---

## File Structure

- **Create** `lib/lol-champions.js` — champion-name canonicalization (`normalizeChampion`, known-set loader). One responsibility: make feed/vision/Oracle names join.
- **Create** `lib/lol-draft-train.js` — pure training functions (build matrices, fit logistic, walk-forward eval). No I/O.
- **Create** `lib/lol-draft-model.js` — runtime engine (`computeDraftWinProb`, shrinkage, breakdown, artifact load+cache). No I/O except artifact read.
- **Create** `scripts/train-lol-draft-model.js` — CLI: read DB → `lol-draft-train` → write artifacts → print walk-forward eval.
- **Create (artifacts, committed seed)** `lib/lol-draft-wr.json`, `lib/lol-draft-matchups.json`, `lib/lol-draft-synergy.json`, `lib/lol-draft-meta.json`.
- **Modify** `server.js` — add `POST /api/lol-draft-analyze` and `POST /api/lol-draft-parse-print` near the existing `/api/lol-live-dashboard` handler (server.js:5316).
- **Modify** `public/lol-live-dashboard.html` — add the Draft Lab panel.
- **Create tests** `tests/test-lol-champions.js`, `tests/test-lol-draft-model.js`, `tests/test-lol-draft-train.js`.

**Test command (this repo):** `npm test` runs `node tests/run.js`, which auto-discovers `tests/test-*.js`. There is no single-file filter, so per-task runs use `npm test 2>&1 | grep -A4 "<suite tag>"`. Each test file exports `module.exports = function(t){ t.test(name, fn); t.assert(cond, msg); }`.

---

## Task 0: Champion name canonicalization

**Files:**
- Create: `lib/lol-champions.js`
- Test: `tests/test-lol-champions.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/test-lol-champions.js
const { normalizeChampion } = require('../lib/lol-champions');

module.exports = function (t) {
  t.test('lol-champions: basic lowercases and strips', () => {
    t.assert(normalizeChampion('Aatrox') === 'aatrox', 'Aatrox');
    t.assert(normalizeChampion("Kai'Sa") === 'kaisa', "Kai'Sa apostrophe stripped");
    t.assert(normalizeChampion("Cho'Gath") === 'chogath', "Cho'Gath");
  });
  t.test('lol-champions: cross-source aliases unify', () => {
    // Oracle's Elixir uses "MonkeyKing"; broadcasts/vision say "Wukong"
    t.assert(normalizeChampion('MonkeyKing') === normalizeChampion('Wukong'), 'wukong alias');
    t.assert(normalizeChampion('Nunu & Willump') === normalizeChampion('Nunu'), 'nunu alias');
    t.assert(normalizeChampion('Renata Glasc') === normalizeChampion('Renata'), 'renata alias');
  });
  t.test('lol-champions: null/garbage safe', () => {
    t.assert(normalizeChampion(null) === null, 'null');
    t.assert(normalizeChampion('') === null, 'empty');
    t.assert(normalizeChampion('   ') === null, 'spaces');
  });
};
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -A4 "lol-champions"`
Expected: FAIL — `Cannot find module '../lib/lol-champions'`.

- [ ] **Step 3: Implement `lib/lol-champions.js`**

```js
// lib/lol-champions.js
// Canonical champion key = lowercased, punctuation/space/'&' stripped, then alias-folded.
// Both the training matrices and the query path call this, so as long as it is consistent
// the exact string is irrelevant; ALIASES only fixes cross-source spelling drift.
const ALIASES = {
  monkeyking: 'wukong',
  nunuwillump: 'nunu',
  renataglasc: 'renata',
  drmundo: 'drmundo',
  jarvaniv: 'jarvaniv',
  leesin: 'leesin',
  masteryi: 'masteryi',
  missfortune: 'missfortune',
  reksai: 'reksai',
  tahmkench: 'tahmkench',
  twistedfate: 'twistedfate',
  xinzhao: 'xinzhao',
  aurelionsol: 'aurelionsol',
  ksante: 'ksante',
  belveth: 'belveth',
};

function normalizeChampion(name) {
  if (name == null) return null;
  let k = String(name).toLowerCase().replace(/&/g, '').replace(/[^a-z0-9]/g, '');
  if (!k) return null;
  if (ALIASES[k]) k = ALIASES[k];
  return k;
}

module.exports = { normalizeChampion, ALIASES };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test 2>&1 | grep -A4 "lol-champions"`
Expected: 3 `✓` lines, no `✗`.

- [ ] **Step 5: Syntax check + commit**

```bash
node -c lib/lol-champions.js
git add lib/lol-champions.js tests/test-lol-champions.js
git commit -m "feat(lol-draft): champion name canonicalization helper" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 1: Pure training functions

**Files:**
- Create: `lib/lol-draft-train.js`
- Test: `tests/test-lol-draft-train.js`

Data model recap (`oracleselixir_players`): one row per player per game with `gameid, side ('Blue'|'Red'), position ('top'|'jng'|'mid'|'bot'|'sup'), champion, result (1=win), patch`.

- [ ] **Step 1: Write the failing test**

```js
// tests/test-lol-draft-train.js
const { buildWrTable, buildMatchupMatrix, buildSynergyMatrix, fitLogistic, sigmoid } = require('../lib/lol-draft-train');

// Two synthetic games. Game g1: Blue Aatrox(top) beats Red Darius(top). g2: same again.
// So Aatrox-vs-Darius (top) should have winsBlue=2, n=2.
const rows = [
  { gameid: 'g1', side: 'Blue', position: 'top', champion: 'Aatrox', result: 1, patch: '14.1' },
  { gameid: 'g1', side: 'Red',  position: 'top', champion: 'Darius', result: 0, patch: '14.1' },
  { gameid: 'g2', side: 'Blue', position: 'top', champion: 'Aatrox', result: 1, patch: '14.1' },
  { gameid: 'g2', side: 'Red',  position: 'top', champion: 'Darius', result: 0, patch: '14.1' },
];

module.exports = function (t) {
  t.test('buildWrTable counts wins/total per champion+role', () => {
    const wr = buildWrTable(rows);
    t.assert(wr['aatrox|top'].wins === 2 && wr['aatrox|top'].n === 2, 'aatrox 2/2');
    t.assert(wr['darius|top'].wins === 0 && wr['darius|top'].n === 2, 'darius 0/2');
  });
  t.test('buildMatchupMatrix records lane head-to-head (blue perspective)', () => {
    const m = buildMatchupMatrix(rows);
    const cell = m['top']['aatrox']['darius'];
    t.assert(cell.wins === 2 && cell.n === 2, `aatrox>darius top 2/2, got ${JSON.stringify(cell)}`);
  });
  t.test('buildSynergyMatrix records same-side pairs', () => {
    // single-role games here → no same-side pairs; add a 2-player side
    const r2 = [
      { gameid: 'x', side: 'Blue', position: 'top', champion: 'Ornn', result: 1, patch: '14.1' },
      { gameid: 'x', side: 'Blue', position: 'mid', champion: 'Orianna', result: 1, patch: '14.1' },
    ];
    const s = buildSynergyMatrix(r2);
    t.assert(s['orianna|ornn'].wins === 1 && s['orianna|ornn'].n === 1, 'sorted-key pair 1/1');
  });
  t.test('fitLogistic learns separable signal; sigmoid bounded', () => {
    t.assert(sigmoid(0) === 0.5, 'sigmoid(0)=0.5');
    t.assert(sigmoid(100) > 0.99 && sigmoid(-100) < 0.01, 'sigmoid bounds');
    // x[0] perfectly predicts label
    const samples = [];
    for (let i = 0; i < 200; i++) {
      const pos = i % 2 === 0;
      samples.push({ x: [pos ? 1 : -1, 0, 0, 0], y: pos ? 1 : 0 });
    }
    const w = fitLogistic(samples, { epochs: 400, lr: 0.3, l2: 0.0001 });
    t.assert(w.length === 5, 'bias + 4 features');
    const pPos = sigmoid(w[0] + w[1] * 1);
    const pNeg = sigmoid(w[0] + w[1] * -1);
    t.assert(pPos > 0.8 && pNeg < 0.2, `learned: pPos=${pPos.toFixed(2)} pNeg=${pNeg.toFixed(2)}`);
  });
};
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -A4 "lol-draft-train"`
Expected: FAIL — `Cannot find module '../lib/lol-draft-train'`.

- [ ] **Step 3: Implement `lib/lol-draft-train.js`**

```js
// lib/lol-draft-train.js — pure training functions (no I/O). Consumed by scripts/train-lol-draft-model.js.
const { normalizeChampion } = require('./lol-champions');

function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

// WR per champion+role: key "champ|role" -> {wins,n}
function buildWrTable(rows) {
  const wr = {};
  for (const r of rows) {
    const c = normalizeChampion(r.champion); if (!c) continue;
    const role = String(r.position || '').toLowerCase();
    const key = `${c}|${role}`;
    (wr[key] = wr[key] || { wins: 0, n: 0 });
    wr[key].wins += r.result ? 1 : 0; wr[key].n += 1;
  }
  return wr;
}

function _gamesBy(rows) {
  const games = new Map();
  for (const r of rows) {
    if (!games.has(r.gameid)) games.set(r.gameid, []);
    games.get(r.gameid).push(r);
  }
  return games;
}

// matchups[role][blueChamp][redChamp] = {wins (of blue), n}
function buildMatchupMatrix(rows) {
  const m = {};
  for (const [, players] of _gamesBy(rows)) {
    const blue = players.filter(p => String(p.side).toLowerCase() === 'blue');
    const red = players.filter(p => String(p.side).toLowerCase() === 'red');
    for (const b of blue) {
      const role = String(b.position || '').toLowerCase();
      const opp = red.find(p => String(p.position || '').toLowerCase() === role);
      if (!opp) continue;
      const bc = normalizeChampion(b.champion), rc = normalizeChampion(opp.champion);
      if (!bc || !rc) continue;
      m[role] = m[role] || {}; m[role][bc] = m[role][bc] || {};
      const cell = (m[role][bc][rc] = m[role][bc][rc] || { wins: 0, n: 0 });
      cell.wins += b.result ? 1 : 0; cell.n += 1;
    }
  }
  return m;
}

// synergy["champA|champB" sorted] = {wins, n} over same-side pairs
function buildSynergyMatrix(rows) {
  const s = {};
  for (const [, players] of _gamesBy(rows)) {
    for (const side of ['blue', 'red']) {
      const champs = players.filter(p => String(p.side).toLowerCase() === side)
        .map(p => ({ c: normalizeChampion(p.champion), r: p.result })).filter(x => x.c);
      for (let i = 0; i < champs.length; i++) for (let j = i + 1; j < champs.length; j++) {
        const key = [champs[i].c, champs[j].c].sort().join('|');
        const cell = (s[key] = s[key] || { wins: 0, n: 0 });
        cell.wins += champs[i].r ? 1 : 0; cell.n += 1;
      }
    }
  }
  return s;
}

// samples: [{x:[f1,f2,f3,f4], y:0|1}]. Returns weights [bias, w1..w4]. Batch GD + L2.
function fitLogistic(samples, opts = {}) {
  const lr = opts.lr ?? 0.1, epochs = opts.epochs ?? 300, l2 = opts.l2 ?? 0.0001;
  const dim = (samples[0]?.x.length || 4) + 1;
  let w = new Array(dim).fill(0);
  for (let e = 0; e < epochs; e++) {
    const grad = new Array(dim).fill(0);
    for (const s of samples) {
      const z = w[0] + s.x.reduce((a, xi, i) => a + xi * w[i + 1], 0);
      const err = sigmoid(z) - s.y;
      grad[0] += err;
      for (let i = 0; i < s.x.length; i++) grad[i + 1] += err * s.x[i];
    }
    for (let i = 0; i < dim; i++) {
      const reg = i === 0 ? 0 : l2 * w[i];
      w[i] -= lr * (grad[i] / samples.length + reg);
    }
  }
  return w;
}

module.exports = { sigmoid, buildWrTable, buildMatchupMatrix, buildSynergyMatrix, fitLogistic };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test 2>&1 | grep -A4 "lol-draft-train"`
Expected: 4 `✓`, no `✗`.

- [ ] **Step 5: Syntax + commit**

```bash
node -c lib/lol-draft-train.js
git add lib/lol-draft-train.js tests/test-lol-draft-train.js
git commit -m "feat(lol-draft): pure training fns (matrices + logistic)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Runtime engine

**Files:**
- Create: `lib/lol-draft-model.js`
- Test: `tests/test-lol-draft-model.js`

The engine accepts an optional `artifacts` arg so tests inject synthetic data (no file/DB needed). `computeDraftWinProb` builds the 4-feature vector and returns `{ prob, confidence, breakdown }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/test-lol-draft-model.js
const { shrinkWr, computeDraftWinProb } = require('../lib/lol-draft-model');

function fakeArtifacts() {
  return {
    meta: { priorWr: 0.5, shrinkK: 20, weights: [0, 4, 2, 1, 0], trainedAt: 'test' }, // bias, wrDiff, lane, syn, mastery
    wr: { 'aatrox|top': { wins: 60, n: 100 }, 'darius|top': { wins: 40, n: 100 } },
    matchups: { top: { aatrox: { darius: { wins: 70, n: 100 } } } },
    synergy: {},
  };
}

module.exports = function (t) {
  t.test('shrinkWr pulls small samples toward prior', () => {
    t.assert(Math.abs(shrinkWr(1, 1, 0.5, 20) - ((1 + 0.5 * 20) / (1 + 20))) < 1e-9, 'n=1 near prior');
    const big = shrinkWr(700, 1000, 0.5, 20);
    t.assert(big > 0.66 && big < 0.70, `n=1000 ~0.69, got ${big.toFixed(3)}`);
  });
  t.test('computeDraftWinProb favors stronger blue draft', () => {
    const draft = {
      blue: [{ champion: 'Aatrox', role: 'top' }],
      red: [{ champion: 'Darius', role: 'top' }],
    };
    const out = computeDraftWinProb(draft, {}, fakeArtifacts());
    t.assert(out.prob > 0.5 && out.prob < 1, `blue favored, got ${out.prob}`);
    t.assert(Array.isArray(out.breakdown.laneMatchups), 'has lane breakdown');
    t.assert(out.breakdown.laneMatchups[0].deltaPp > 0, 'aatrox lane edge positive');
    t.assert(out.confidence > 0 && out.confidence <= 1, 'confidence in (0,1]');
  });
  t.test('computeDraftWinProb unknown champ degrades, no throw', () => {
    const draft = { blue: [{ champion: 'Zzz', role: 'top' }], red: [{ champion: 'Yyy', role: 'top' }] };
    const out = computeDraftWinProb(draft, {}, fakeArtifacts());
    t.assert(out.prob >= 0 && out.prob <= 1, 'prob bounded');
    t.assert(out.confidence < 0.5, 'low confidence on unknown');
  });
};
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -A4 "lol-draft-model"`
Expected: FAIL — `Cannot find module '../lib/lol-draft-model'`.

- [ ] **Step 3: Implement `lib/lol-draft-model.js`**

```js
// lib/lol-draft-model.js — runtime draft win-prob engine (hybrid: logistic number + component breakdown).
const fs = require('fs');
const path = require('path');
const { normalizeChampion } = require('./lol-champions');
const { sigmoid } = require('./lol-draft-train');

let _cache = null;
function _loadArtifacts() {
  if (_cache) return _cache;
  const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
  _cache = {
    meta: read('lol-draft-meta.json'),
    wr: read('lol-draft-wr.json'),
    matchups: read('lol-draft-matchups.json'),
    synergy: read('lol-draft-synergy.json'),
  };
  return _cache;
}
function invalidateCache() { _cache = null; }

// Empirical-Bayes shrink toward prior: (wins + k*prior) / (n + k)
function shrinkWr(wins, n, prior, k) {
  return (wins + k * prior) / (n + k);
}

function _wr(art, champ, role) {
  const cell = art.wr[`${champ}|${role}`];
  if (!cell) return { wr: art.meta.priorWr, n: 0 };
  return { wr: shrinkWr(cell.wins, cell.n, art.meta.priorWr, art.meta.shrinkK), n: cell.n };
}

function _laneDelta(art, blueChamp, redChamp, role) {
  const cell = art.matchups?.[role]?.[blueChamp]?.[redChamp];
  const n = cell ? cell.n : 0;
  const wr = cell ? shrinkWr(cell.wins, cell.n, art.meta.priorWr, art.meta.shrinkK) : art.meta.priorWr;
  return { deltaPp: (wr - 0.5) * 100, n };
}

function _synergy(art, champs) {
  let sum = 0, used = 0;
  for (let i = 0; i < champs.length; i++) for (let j = i + 1; j < champs.length; j++) {
    const cell = art.synergy[[champs[i], champs[j]].sort().join('|')];
    if (!cell) continue;
    sum += (shrinkWr(cell.wins, cell.n, art.meta.priorWr, art.meta.shrinkK) - 0.5);
    used++;
  }
  return { score: sum, pairs: used };
}

// draft = { blue:[{champion,role,player?}], red:[...] }
function computeDraftWinProb(draft, opts = {}, artifacts = null) {
  const art = artifacts || _loadArtifacts();
  const norm = (arr) => (arr || []).map(p => ({ c: normalizeChampion(p.champion), role: String(p.role || '').toLowerCase(), raw: p.champion }));
  const blue = norm(draft.blue), red = norm(draft.red);

  let knownN = 0, totalN = 0;
  const blueWr = blue.map(p => { const w = _wr(art, p.c, p.role); totalN++; if (w.n > 0) knownN++; return w.wr; });
  const redWr = red.map(p => { const w = _wr(art, p.c, p.role); totalN++; if (w.n > 0) knownN++; return w.wr; });
  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0.5;
  const wrDiff = avg(blueWr) - avg(redWr);

  const laneMatchups = [];
  let laneSum = 0;
  for (const b of blue) {
    const opp = red.find(r => r.role === b.role && b.role);
    if (!opp) continue;
    const d = _laneDelta(art, b.c, opp.c, b.role);
    laneSum += d.deltaPp / 100;
    laneMatchups.push({ role: b.role, blue: b.raw, red: opp.raw, deltaPp: +d.deltaPp.toFixed(1), n: d.n });
  }

  const sB = _synergy(art, blue.map(p => p.c).filter(Boolean));
  const sR = _synergy(art, red.map(p => p.c).filter(Boolean));
  const synergyDiff = sB.score - sR.score;
  const masteryDiff = 0; // wired in Phase 2 (needs player names + pro_player_champ_stats); 0 keeps weight inert

  const w = art.meta.weights; // [bias, wrDiff, lane, synergy, mastery]
  const z = w[0] + w[1] * wrDiff + w[2] * laneSum + w[3] * synergyDiff + w[4] * masteryDiff;
  const prob = Math.max(0, Math.min(1, sigmoid(z)));

  const confidence = Math.max(0.05, Math.min(1, (knownN / Math.max(1, totalN)) * (laneMatchups.filter(l => l.n >= 10).length / 5)));

  return {
    prob: +prob.toFixed(4),
    confidence: +confidence.toFixed(2),
    breakdown: {
      wrDiffPp: +(wrDiff * 100).toFixed(1),
      laneMatchups: laneMatchups.sort((a, b) => Math.abs(b.deltaPp) - Math.abs(a.deltaPp)),
      synergyBluePairs: sB.pairs, synergyRedPairs: sR.pairs, synergyDiff: +synergyDiff.toFixed(3),
      knownChamps: knownN, totalChamps: totalN,
    },
  };
}

module.exports = { computeDraftWinProb, shrinkWr, invalidateCache };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test 2>&1 | grep -A4 "lol-draft-model"`
Expected: 3 `✓`, no `✗`.

- [ ] **Step 5: Commit**

```bash
node -c lib/lol-draft-model.js
git add lib/lol-draft-model.js tests/test-lol-draft-model.js
git commit -m "feat(lol-draft): runtime engine (hybrid prob + breakdown + shrinkage)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Training CLI + generate artifacts

**Files:**
- Create: `scripts/train-lol-draft-model.js`
- Create (output): `lib/lol-draft-{wr,matchups,synergy,meta}.json`

- [ ] **Step 1: Implement `scripts/train-lol-draft-model.js`**

```js
#!/usr/bin/env node
// Trains the draft model from oracleselixir_players and writes JSON artifacts to lib/.
// Usage: node scripts/train-lol-draft-model.js [--db ./data/tipsbot.db] [--min-patch 14.0]
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { buildWrTable, buildMatchupMatrix, buildSynergyMatrix, fitLogistic, sigmoid } = require('../lib/lol-draft-train');
const { normalizeChampion } = require('../lib/lol-champions');

const args = process.argv.slice(2);
const dbPath = (args.includes('--db') ? args[args.indexOf('--db') + 1] : (process.env.DB_PATH || './data/tipsbot.db'));
const SHRINK_K = 20, PRIOR = 0.5;

const db = new Database(dbPath, { readonly: true });
const rows = db.prepare(`SELECT gameid, side, position, champion, result, patch, date
  FROM oracleselixir_players WHERE champion IS NOT NULL AND position IS NOT NULL`).all();
console.log(`[train] loaded ${rows.length} player-rows from oracleselixir_players`);
if (rows.length < 1000) { console.error('[train] ABORT: <1000 rows — run /admin sync-oracleselixir first'); process.exit(1); }

// ----- features for one game (blue perspective) -----
function gameFeatures(players, wr, matchups, synergy) {
  const blue = players.filter(p => String(p.side).toLowerCase() === 'blue');
  const red = players.filter(p => String(p.side).toLowerCase() === 'red');
  if (!blue.length || !red.length) return null;
  const shr = (c) => { const k = `${normalizeChampion(c.champion)}|${String(c.position).toLowerCase()}`; const e = wr[k]; return e ? (e.wins + SHRINK_K * PRIOR) / (e.n + SHRINK_K) : PRIOR; };
  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0.5;
  const wrDiff = avg(blue.map(shr)) - avg(red.map(shr));
  let laneSum = 0;
  for (const b of blue) {
    const role = String(b.position).toLowerCase();
    const opp = red.find(p => String(p.position).toLowerCase() === role);
    if (!opp) continue;
    const cell = matchups?.[role]?.[normalizeChampion(b.champion)]?.[normalizeChampion(opp.champion)];
    const w = cell ? (cell.wins + SHRINK_K * PRIOR) / (cell.n + SHRINK_K) : PRIOR;
    laneSum += (w - 0.5);
  }
  const synSide = (side) => { const cs = side.map(p => normalizeChampion(p.champion)).filter(Boolean); let s = 0; for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) { const cell = synergy[[cs[i], cs[j]].sort().join('|')]; if (cell) s += ((cell.wins + SHRINK_K * PRIOR) / (cell.n + SHRINK_K) - 0.5); } return s; };
  const synergyDiff = synSide(blue) - synSide(red);
  return { x: [wrDiff, laneSum, synergyDiff, 0], y: blue[0].result ? 1 : 0 };
}

function groupGames(rs) { const g = new Map(); for (const r of rs) { if (!g.has(r.gameid)) g.set(r.gameid, []); g.get(r.gameid).push(r); } return g; }

// ----- walk-forward eval: train on older patches, test on newest 20% -----
const patches = [...new Set(rows.map(r => r.patch).filter(Boolean))].sort();
const cut = patches[Math.floor(patches.length * 0.8)] || patches[patches.length - 1];
const trainRows = rows.filter(r => r.patch < cut), testRows = rows.filter(r => r.patch >= cut);

function trainOn(rs) {
  const wr = buildWrTable(rs), matchups = buildMatchupMatrix(rs), synergy = buildSynergyMatrix(rs);
  const samples = [...groupGames(rs).values()].map(p => gameFeatures(p, wr, matchups, synergy)).filter(Boolean);
  const weights = fitLogistic(samples, { epochs: 400, lr: 0.2, l2: 0.0005 });
  return { wr, matchups, synergy, weights };
}
function evalOn(model, rs) {
  let brier = 0, ll = 0, base = 0, k = 0;
  for (const players of groupGames(rs).values()) {
    const f = gameFeatures(players, model.wr, model.matchups, model.synergy); if (!f) continue;
    const w = model.weights; const p = sigmoid(w[0] + f.x.reduce((a, xi, i) => a + xi * w[i + 1], 0));
    brier += (p - f.y) ** 2; ll += -(f.y * Math.log(p + 1e-9) + (1 - f.y) * Math.log(1 - p + 1e-9));
    base += (0.5 - f.y) ** 2; k++;
  }
  return { n: k, brier: brier / k, logloss: ll / k, brierBaseline: base / k };
}

const wf = trainOn(trainRows);
const ev = evalOn(wf, testRows);
console.log(`[train] walk-forward (train<${cut}, test>=${cut}): n=${ev.n} Brier=${ev.brier.toFixed(4)} (baseline 0.5-pred=${ev.brierBaseline.toFixed(4)}) logloss=${ev.logloss.toFixed(4)}`);
if (ev.brier >= ev.brierBaseline) console.warn('[train] WARNING: model does NOT beat the 0.5 baseline OOS — review before relying on it.');

// ----- final fit on ALL rows, write artifacts -----
const full = trainOn(rows);
const champs = [...new Set(rows.map(r => normalizeChampion(r.champion)).filter(Boolean))].sort();
const meta = { priorWr: PRIOR, shrinkK: SHRINK_K, weights: full.weights, trainedAt: new Date().toISOString(), rows: rows.length, patches: patches.length, walkForward: ev, champCount: champs.length };
const out = (f, o) => fs.writeFileSync(path.join(__dirname, '..', 'lib', f), JSON.stringify(o));
out('lol-draft-wr.json', full.wr);
out('lol-draft-matchups.json', full.matchups);
out('lol-draft-synergy.json', full.synergy);
out('lol-draft-meta.json', meta);
console.log(`[train] wrote artifacts: ${Object.keys(full.wr).length} wr keys, ${champs.length} champions. weights=${JSON.stringify(full.weights.map(w => +w.toFixed(3)))}`);
db.close();
```

- [ ] **Step 2: Confirm prod data + run training**

First confirm `oracleselixir_players` is populated (this is the spec prerequisite). With the prod DB available locally (or a copy), run:

Run: `node scripts/train-lol-draft-model.js`
Expected: prints `loaded N player-rows` (N should be in the 100k+ range), a walk-forward Brier line that is **below** the baseline, and `wrote artifacts: ...`. Creates the 4 JSON files in `lib/`.
If it aborts with `<1000 rows`, the prerequisite failed — trigger the Oracle's Elixir sync first (admin endpoint) and re-run. **Do not proceed to commit empty artifacts.**

- [ ] **Step 3: Sanity-check the artifacts load in the engine**

Run: `node -e "const {computeDraftWinProb}=require('./lib/lol-draft-model'); console.log(computeDraftWinProb({blue:[{champion:'Aatrox',role:'top'}],red:[{champion:'Darius',role:'top'}]},{}))"`
Expected: prints `{ prob: <0..1>, confidence: <0..1>, breakdown: {...} }` with no error.

- [ ] **Step 4: Commit script + artifacts**

```bash
node -c scripts/train-lol-draft-model.js
git add scripts/train-lol-draft-model.js lib/lol-draft-wr.json lib/lol-draft-matchups.json lib/lol-draft-synergy.json lib/lol-draft-meta.json
git commit -m "feat(lol-draft): training CLI + committed model artifacts (Oracle's Elixir)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Endpoint — `/api/lol-draft-analyze`

**Files:**
- Modify: `server.js` (add handler immediately before the `/api/lol-live-dashboard` block at server.js:5316)

- [ ] **Step 1: Add the handler**

Insert before `if (p === '/api/lol-live-dashboard') {`:

```js
  // Draft Lab — draft-only win prob (display-only; no pricing/EV/tips impact).
  if (p === '/api/lol-draft-analyze' && req.method === 'POST') {
    _readPostBody(req, res, async (body) => {
      if (body == null) return;
      try {
        const json = safeParse(body, null);
        const blue = Array.isArray(json?.blue) ? json.blue.slice(0, 5) : [];
        const red = Array.isArray(json?.red) ? json.red.slice(0, 5) : [];
        if (!blue.length || !red.length) { sendJson(res, { ok: false, error: 'blue and red arrays required' }, 400); return; }
        const { computeDraftWinProb } = require('./lib/lol-draft-model');
        const out = computeDraftWinProb({ blue, red }, { patch: json?.patch || null });
        sendJson(res, { ok: true, ...out });
      } catch (e) {
        log('WARN', 'DRAFT-LAB', `analyze err: ${e.message}`);
        sendJson(res, { ok: false, error: 'analyze_failed' }, 500);
      }
    });
    return;
  }
```

- [ ] **Step 2: Syntax check**

Run: `node -c server.js`
Expected: no output (valid).

- [ ] **Step 3: Smoke test the endpoint locally**

Start the server (`node server.js` in another shell, or use the running prod after deploy), then:
Run: `curl -s -X POST http://127.0.0.1:3000/api/lol-draft-analyze -H "content-type: application/json" -d '{"blue":[{"champion":"Aatrox","role":"top"}],"red":[{"champion":"Darius","role":"top"}]}'`
Expected: JSON `{"ok":true,"prob":<n>,"confidence":<n>,"breakdown":{...}}`.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(lol-draft): POST /api/lol-draft-analyze (display-only)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Endpoint — `/api/lol-draft-parse-print` (Claude Haiku vision, gated)

**Files:**
- Modify: `server.js` (add after the analyze handler)

Gating: dormant unless `process.env.ANTHROPIC_API_KEY` is set. Cost guards: 5 MB image cap, per-IP daily cap (`ANTHROPIC_VISION_DAILY_CAP`, default 50), plus the existing 60/min rate guard. **The key is read only from env — never logged, never echoed.**

- [ ] **Step 1: Add the handler**

```js
  // Draft Lab — parse a draft screenshot into champions via Claude Haiku vision.
  // Dormant until ANTHROPIC_API_KEY is set in env. Result is for USER CONFIRMATION before analyze.
  if (p === '/api/lol-draft-parse-print' && req.method === 'POST') {
    _readPostBody(req, res, async (body) => {
      if (body == null) return;
      try {
        const KEY = process.env.ANTHROPIC_API_KEY;
        if (!KEY) { sendJson(res, { ok: false, error: 'vision_disabled', tip: 'set ANTHROPIC_API_KEY' }, 503); return; }
        const json = safeParse(body, null);
        const dataUrl = String(json?.imageBase64 || '');
        const m = dataUrl.match(/^data:(image\/(png|jpeg|webp));base64,(.+)$/);
        if (!m) { sendJson(res, { ok: false, error: 'imageBase64 must be a data URL (png/jpeg/webp)' }, 400); return; }
        const mediaType = m[1], b64 = m[3];
        if (b64.length > 7_000_000) { sendJson(res, { ok: false, error: 'image_too_large', max_b64: 7000000 }, 413); return; }

        // per-IP daily cap (in-memory global; resets on restart — acceptable for a cost guard)
        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
        const cap = parseInt(process.env.ANTHROPIC_VISION_DAILY_CAP || '50', 10);
        const _vmap = (global._draftVisionDayMap = global._draftVisionDayMap || new Map());
        const dayKey = `${ip}|${new Date().toISOString().slice(0, 10)}`;
        const used = _vmap.get(dayKey) || 0;
        if (used >= cap) { sendJson(res, { ok: false, error: 'daily_cap_reached', cap }, 429); return; }

        const prompt = 'This is a League of Legends draft screenshot. Return ONLY compact JSON, no prose: '
          + '{"blue":[{"champion":"<name>","role":"top|jng|mid|bot|sup"}],"red":[...]} '
          + 'with exactly 5 entries per team in role order top,jng,mid,bot,sup. '
          + 'Use official English champion names. If a role is unclear, still order by lane position. If you cannot read a champion, use null.';
        const payload = {
          model: 'claude-haiku-4-5', max_tokens: 1024,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
            { type: 'text', text: prompt },
          ] }],
        };
        const r = await aiPost('anthropic', 'https://api.anthropic.com/v1/messages', payload,
          { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' }, { timeoutMs: 30000, retry: { maxAttempts: 2 } });
        _vmap.set(dayKey, used + 1);
        try { stmts.incrApiUsage.run('anthropic', new Date().toISOString().slice(0, 7)); } catch (_) {}

        const rj = r ? safeParse(r.body, {}) : {};
        const text = (rj?.content || []).map(c => c.text || '').join('');
        const parsed = safeParse((text.match(/\{[\s\S]*\}/) || [null])[0], null);
        if (!parsed) { sendJson(res, { ok: false, error: 'parse_failed', raw: text.slice(0, 300) }, 502); return; }
        const { normalizeChampion } = require('./lib/lol-champions');
        const tag = (arr) => (arr || []).map(p => ({ champion: p.champion, role: p.role, key: normalizeChampion(p.champion) }));
        sendJson(res, { ok: true, blue: tag(parsed.blue), red: tag(parsed.red), needsConfirmation: true });
      } catch (e) {
        log('WARN', 'DRAFT-LAB', `parse-print err: ${e.message}`);
        sendJson(res, { ok: false, error: 'parse_print_failed' }, 500);
      }
    });
    return;
  }
```

- [ ] **Step 2: Syntax check**

Run: `node -c server.js`
Expected: valid.

- [ ] **Step 3: Verify gated-off behavior (no key)**

With `ANTHROPIC_API_KEY` unset, start server and:
Run: `curl -s -X POST http://127.0.0.1:3000/api/lol-draft-parse-print -H "content-type: application/json" -d '{"imageBase64":"data:image/png;base64,iVBORw0KGgo="}'`
Expected: `{"ok":false,"error":"vision_disabled","tip":"set ANTHROPIC_API_KEY"}` with HTTP 503.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(lol-draft): POST /api/lol-draft-parse-print (Haiku vision, gated on ANTHROPIC_API_KEY)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5 (USER, out-of-band): set the key in Railway**

User adds `ANTHROPIC_API_KEY=<rotated key>` to the bot service in Railway → Variables, and optionally `ANTHROPIC_VISION_DAILY_CAP`. After redeploy, the 503 becomes a live parse. (Never commit the key.)

---

## Task 6: UI panel in `/edge`

**Files:**
- Modify: `public/lol-live-dashboard.html`

The dashboard is a single HTML file with an `el(tag, attrs, ...children)` helper and a `STATE`/render structure (see existing `renderEdges`, `renderDetail`). Add a "Draft Lab" section. UI is verified manually (no unit test).

- [ ] **Step 1: Add the Draft Lab markup + logic**

Add a collapsible section (follow existing ANTE//LIVE styling/classes). Core JS to append:

```js
// ── Draft Lab ──────────────────────────────────────────────────────────
const ROLES = ['top','jng','mid','bot','sup'];
function draftLabSlots(side){
  const wrap = el('div', { class: 'dl-side dl-'+side });
  ROLES.forEach((role,i)=>{
    const inp = el('input', { class:'dl-champ', 'data-side':side, 'data-role':role, placeholder:`${side} ${role}`, list:'dl-champ-list' });
    wrap.appendChild(el('label', { class:'dl-slot' }, el('span',{class:'dl-role'},role), inp));
  });
  return wrap;
}
function readDraft(){
  const grab = (side)=>[...document.querySelectorAll(`.dl-champ[data-side="${side}"]`)]
    .map(i=>({ champion:i.value.trim(), role:i.getAttribute('data-role') })).filter(x=>x.champion);
  return { blue: grab('blue'), red: grab('red') };
}
async function runDraftAnalyze(){
  const draft = readDraft();
  const out = document.getElementById('dl-result');
  if (draft.blue.length<1 || draft.red.length<1){ out.textContent='preencha ao menos 1 campeão por lado'; return; }
  out.textContent='analisando…';
  const r = await fetch('/api/lol-draft-analyze', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(draft) });
  const j = await r.json();
  if(!j.ok){ out.textContent='erro: '+(j.error||'?'); return; }
  renderDraftResult(j);
}
function renderDraftResult(j){
  const out = document.getElementById('dl-result'); out.innerHTML='';
  const bluePct = Math.round(j.prob*100);
  out.appendChild(el('div',{class:'dl-prob'}, el('span',{class:'dl-blue'},`BLUE ${bluePct}%`), el('span',{class:'dl-red'},`${100-bluePct}% RED`)));
  out.appendChild(el('div',{class:'dl-conf'},`confiança ${Math.round(j.confidence*100)}% · WRΔ ${j.breakdown.wrDiffPp}pp · campeões conhecidos ${j.breakdown.knownChamps}/${j.breakdown.totalChamps}`));
  const lanes = el('div',{class:'dl-lanes'});
  j.breakdown.laneMatchups.forEach(l=>lanes.appendChild(el('div',{class:'dl-lane'+(l.deltaPp>=0?' pos':' neg')},`${l.role}: ${l.blue} vs ${l.red} → ${l.deltaPp>0?'+':''}${l.deltaPp}pp (n=${l.n})`)));
  out.appendChild(lanes);
}
async function parsePrint(file){
  const out = document.getElementById('dl-result'); out.textContent='lendo print…';
  const b64 = await new Promise((res)=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.readAsDataURL(file); });
  const r = await fetch('/api/lol-draft-parse-print', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ imageBase64:b64 }) });
  const j = await r.json();
  if(!j.ok){ out.textContent = j.error==='vision_disabled' ? 'parse por print indisponível (ANTHROPIC_API_KEY não setada)' : 'erro lendo print: '+j.error; return; }
  // prefill inputs for CONFIRMATION (user edits before analyze)
  const fill=(side,arr)=>arr.forEach((p,i)=>{ const inp=document.querySelectorAll(`.dl-champ[data-side="${side}"]`)[i]; if(inp&&p.champion) inp.value=p.champion; });
  fill('blue', j.blue); fill('red', j.red);
  out.textContent='print lido — confira os campeões e clique Analisar';
}
function mountDraftLab(root){
  const sec = el('section',{class:'dl-root'},
    el('div',{class:'dl-title'},'DRAFT LAB'),
    el('datalist',{id:'dl-champ-list'}), // populated below
    el('div',{class:'dl-grid'}, draftLabSlots('blue'), draftLabSlots('red')),
    el('div',{class:'dl-actions'},
      el('button',{class:'dl-btn',onclick:runDraftAnalyze},'Analisar draft'),
      el('label',{class:'dl-upload'},'📷 colar print',
        el('input',{type:'file',accept:'image/*',style:'display:none',onchange:(e)=>e.target.files[0]&&parsePrint(e.target.files[0])}))),
    el('div',{id:'dl-result',class:'dl-result'},'preencha o draft ou cole um print'));
  root.appendChild(sec);
}
```

Populate the champion datalist from `lib/lol-draft-meta.json` champions — simplest: expose them via the existing analyze response, or hardcode-load by adding `champs` to `/api/lol-draft-analyze` GET. For v1, fetch once: add a tiny `GET /api/lol-draft-champs` returning `JSON.parse(meta).champCount` names — OR skip the datalist (free text + `normalizeChampion` tolerance). Keep v1 simple: free-text inputs (normalization already tolerant); defer the datalist.

Call `mountDraftLab(<container>)` where the dashboard mounts its panels (mirror where `renderEdges`' container is created).

- [ ] **Step 2: Manual verification**

1. `node server.js` locally (or after deploy open `/edge`).
2. Type `Aatrox`/`top` (blue) and `Darius`/`top` (red), click **Analisar draft** → see a BLUE/RED prob bar + lane line.
3. With `ANTHROPIC_API_KEY` unset: click **📷 colar print**, choose any image → message "parse por print indisponível". With the key set in Railway: upload a real draft screenshot → inputs prefill → confirm → Analisar.

- [ ] **Step 3: Commit**

```bash
git add public/lol-live-dashboard.html
git commit -m "feat(lol-draft): Draft Lab panel on /edge (manual picker + print upload + breakdown)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final: full suite + push

- [ ] Run `npm test` — all suites green (existing + 3 new).
- [ ] Run `node -c bot.js && node -c server.js`.
- [ ] `git push origin main`.

## Scope notes (deferred from spec, intentional)

- **Auto-from-live-feed input path:** the spec listed three inputs (feed / manual / print). This plan ships **manual picker + print** (the two explicit user asks). Auto-prefilling a *selected live match's* draft requires exposing `collectGameContext`'s champions through an API the dashboard can read (the bot computes it server-side today). Tracked as **v1.1 follow-up** — manual + print already cover "analyze any draft" and "paste a print".
- **Eval metrics:** Task 3 reports **Brier + log-loss + a 0.5-baseline Brier** (the go/no-go signal). **ECE** (from the spec) is omitted in v1 for simplicity; add it to `evalOn` if a calibration plot is wanted later.

## Phase 2 (NOT in this plan — gated follow-up)

Promote `computeDraftWinProb` into `getLolProbability` (replace/augment `_compSubModel`). Requires: walk-forward beating the live baseline, per-patch recalibration, an env gate, and explicit user authorization (money-path / SAGRADO; LoL is in shadow). Separate spec + plan.
