# Tennis Match Lab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a display-only "Tennis Lab" panel to `/edge` that, given two players + surface + Bo3/Bo5, shows P(win), a factor breakdown, and the full Markov market surface (handicap games, total games, set betting, tiebreak, straight sets, aces, double faults) with fair odds + live edge, plus an AI reading.

**Architecture:** REUSE the production tennis model read-only (`getTennisProbability` ML ensemble for the headline; the Markov engine for markets) — do NOT build a parallel model (P3). Money-path airtight: only read-only/pure functions; never `scanTennisMarkets`/stake/Kelly/tips. `fairOdd = 1/p`, `edge = p·odd − 1` are computed inline. Mirrors the Dota/CS Lab UX (overlay `#tennisLab` + topbar button + AI explain).

**Tech Stack:** Node 18 (no framework, `http` native), better-sqlite3, vanilla JS dashboard (`public/lol-live-dashboard.html`), `node tests/run.js` test runner (Node `assert`), Anthropic API via existing `aiPost` + `AI_ANALYSIS_DAILY_CAP`.

**Reference spec:** `docs/superpowers/specs/2026-06-16-tennis-match-lab-design.md`

---

## Key facts (verified against the codebase — do not re-derive)

- `getTennisProbability(db, match, odds, enrich, surfaceOverride)` → `{ modelP1, modelP2, confidence, method, surface, tier, factors[], _elo:{found1,found2,...}, ... }`. Pure read-only. `match = {team1, team2, league, time}`. **Pass `odds = null`** → implied prior 0.5 (market-independent headline). `enrich = { serveStats1, serveStats2, ranking1:{rank}, ranking2:{rank} }` (all optional).
- `getPlayerServeProfile(db, name, {surface})` → `{ firstInPct, firstWonPct, secondWonPct, acePerMatchAvg, acePerSvptPct, dfPerMatchAvg, dfPerSvptPct, matches, ... }` or `null`. **`firstInPct/firstWonPct/secondWonPct` are FRACTIONS (0–1).** Requires ≥5 matches w/ serve data else `null`. One call covers serve + aces + DFs.
- `serveSubModel` and `extractServeProbs` both need `{ firstServePct, firstServePointsPct, secondServePointsPct }` as **PERCENTAGES (0–100)**; `serveSubModel` also needs `.games ≥ 2`. → an **adapter** is required (multiply fractions ×100, set `games = matches`).
- `getPlayerRankInfo(db, name)` → `{ latestRank, bestRank, recentRanks } | null` (own try/catch).
- `extractServeProbs(ss1, ss2, {surface})` → `{ p1Serve, p2Serve, method } | null`.
- `solvePointProbs(pMatchTarget, pServeAvg, bestOf)` → `{ p1Serve, p2Serve }` (back-solves serve probs to hit the target match prob; preserves avg serve level).
- `priceTennisMatch({ p1Serve, p2Serve, bestOf, iters })` → `{ pMatch, setDist:{'2-1':p,...}, totalGamesAvg, totalGamesPdf:{k:p}, gamesMarginPdf:{margin:p}, pTiebreakMatch, pTiebreakFirstSet, pStraightSets, totalSetsAvg }`. **Monte Carlo (stochastic)** — tests assert ranges/structure, not exact values.
- `handicapGamesProb(gamesMarginPdf, line)` → P(player1/home covers handicap `line`) = `Σ v where margin + line > 0`.
- `estimateTennisAces({ acesPerMatch1, acesPerMatch2, bestOf, surface })` → `{ totalAcesAvg, pOver:{ '8.5':p, ... } } | null`.
- `estimateTennisDoubleFaults({ dfPerMatch1, dfPerMatch2, bestOf, surface })` → `{ totalDfAvg, pOver:{ '3.5':p, ... } } | null`.
- `applyMarkovCalib(pRaw, market, opts)` — calibrates **only** `'handicapGames'` & `'totalGames'`. Production opts: `{ tier: tournamentTier(league), format: bestOf>=5?'bo5':'bo3', side }` where `side ∈ {'over','under'}` (totals), `{'home','away'}` (handicap, home = player1). Graceful hierarchical fallback if a tier/format/side bin is absent.
- `tournamentTier(league)` → `'grandslam'|'masters'|'500'|'250'|'challenger'|'itf'|'other'`. `detectSurface(league)` → surface string.
- Player autocomplete source: `match_results WHERE game='tennis'` (team1/team2). Same set the Elo knows.
- **server.js route pattern:** `if (p === '/api/...' && req.method === 'GET'|'POST') { ... return; }` inside the main request handler. List = `db.prepare(...).all()` + `sendJson`. POST = `_readPostBody(req, res, (body) => { if (body==null) return; try { const json = safeParse(body, null); ... sendJson(res, out); } catch (e) { log('WARN','TAG',...); sendJson(res,{ok:false,error:'...'},500);} }); return;`. AI = `ANTHROPIC_API_KEY` (503 if absent) + cap via `getClientIp` + `global._aiAnalysisDayMap` + `AI_ANALYSIS_DAILY_CAP` (default 30) + `aiPost('anthropic', url, {model, max_tokens, messages:[{role:'user',content:[{type:'text',text:prompt}]}]}, {'x-api-key':KEY,'anthropic-version':'2023-06-01'}, {timeoutMs:30000, retry:{maxAttempts:2}})` + `stmts.incrApiUsage.run('anthropic', month)`; model `process.env.AI_ANALYSIS_MODEL || 'claude-sonnet-4-5'`. Insert the new routes next to the existing `/api/dota-*` / `/api/cs-*` lab routes (cluster around `server.js:5558`).
- **HTML pattern (`public/lol-live-dashboard.html`):** overlay `<div id="xLab">` with `.dl-header` / `.dl-body` / `.dl-actions` + a result `<div>`; CSS `#xLab { position:fixed; top:56px; left:0; right:0; bottom:0; z-index:40; ... }` + `#xLab.open { display:block; }`; topbar button `<button class="btn" id="xLabBtn" onclick="toggleXLab()">`; `el(tag, attrs, ...children)` helper (`class`, `html`, `on*`, else setAttribute). Dota button cluster at `~1336`; overlays around `~1412`; JS render/explain around `~2655`.
- **Tests:** `node tests/run.js`. A test file is `module.exports = function (t) { t.test('name', () => { t.assert(cond, msg); }); }`. Model tests open the real DB readonly with a skip guard: `const Database=require('better-sqlite3'); const DB_PATH=path.join(__dirname,'..','sportsedge.db'); if(!fs.existsSync(DB_PATH)){ t.test('skip (no db)', ()=>{}); return; } const db=new Database(DB_PATH,{readonly:true});`. Pure tests need no DB.

---

## File Structure

- **Create** `lib/tennis-match-lab.js` — orchestrator `analyzeTennisMatch` + pure helpers `_serveStatsFromProfile`, `_pOverFromPdf`. Read-only. One responsibility: assemble the display payload.
- **Create** `lib/tennis-match-explain.js` — `buildTennisExplainPrompt` + `parseTennisExplain` (pure).
- **Create** `tests/test-tennis-match-lab.js`, `tests/test-tennis-match-explain.js`.
- **Modify** `server.js` — 4 routes (`tennis-players`, `tennis-match-analyze`, `tennis-match-explain`, and in Task 6 `tennis-upcoming`).
- **Modify** `public/lol-live-dashboard.html` — `#tennisLab` overlay + button + JS.

---

### Task 1: Pure helpers in `lib/tennis-match-lab.js`

**Files:**
- Create: `lib/tennis-match-lab.js`
- Test: `tests/test-tennis-match-lab.js`

- [ ] **Step 1: Write the failing test**

Create `tests/test-tennis-match-lab.js`:

```js
'use strict';
const { _serveStatsFromProfile, _pOverFromPdf } = require('../lib/tennis-match-lab');

module.exports = function (t) {
  t.test('_serveStatsFromProfile converts 0-1 fractions to 0-100 percent + games', () => {
    const out = _serveStatsFromProfile({ firstInPct: 0.62, firstWonPct: 0.74, secondWonPct: 0.52, matches: 9 });
    t.assert(Math.abs(out.firstServePct - 62) < 1e-9, `firstServePct ${out.firstServePct}`);
    t.assert(Math.abs(out.firstServePointsPct - 74) < 1e-9, `firstServePointsPct ${out.firstServePointsPct}`);
    t.assert(Math.abs(out.secondServePointsPct - 52) < 1e-9, `secondServePointsPct ${out.secondServePointsPct}`);
    t.assert(out.games === 9, `games ${out.games}`);
  });

  t.test('_serveStatsFromProfile returns null when fields missing', () => {
    t.assert(_serveStatsFromProfile(null) === null, 'null prof');
    t.assert(_serveStatsFromProfile({ firstInPct: 0.6 }) === null, 'partial prof');
  });

  t.test('_pOverFromPdf sums probability mass strictly above the line', () => {
    const pdf = { '20': 0.1, '21': 0.2, '22': 0.3, '23': 0.4 };
    t.assert(Math.abs(_pOverFromPdf(pdf, 21.5) - 0.7) < 1e-9, `over21.5 ${_pOverFromPdf(pdf, 21.5)}`);
    t.assert(Math.abs(_pOverFromPdf(pdf, 22.5) - 0.4) < 1e-9, `over22.5 ${_pOverFromPdf(pdf, 22.5)}`);
    t.assert(_pOverFromPdf({}, 21.5) === 0, 'empty pdf');
  });
};
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/run.js`
Expected: FAIL — `Cannot find module '../lib/tennis-match-lab'` (file not created yet).

- [ ] **Step 3: Create `lib/tennis-match-lab.js` with the helpers**

```js
'use strict';
/**
 * tennis-match-lab.js — Display-only Tennis match analyzer for the /edge "Tennis Lab".
 * REUSES the production tennis model read-only (getTennisProbability ML ensemble for the
 * headline + the Markov engine for the markets). Does NOT build a parallel model (P3 —
 * tennis already has one). Money-path airtight: only read-only/pure functions; never
 * scanTennisMarkets / stake / Kelly / tips. fairOdd = 1/p, edge = p*odd-1 computed inline.
 */
const { getTennisProbability, detectSurface, tournamentTier } = require('./tennis-model');
const { priceTennisMatch, extractServeProbs, solvePointProbs, handicapGamesProb,
        estimateTennisAces, estimateTennisDoubleFaults } = require('./tennis-markov-model');
const { applyMarkovCalib } = require('./tennis-markov-calib');
const { getPlayerServeProfile, getPlayerRankInfo } = require('./tennis-player-stats');

// SPW médio ATP/WTA por superfície (ref. Sackmann) — ancora solvePointProbs no fallback.
const SPW_AVG = { hard: 0.637, clay: 0.611, grass: 0.662, indoor: 0.648 };

// getPlayerServeProfile retorna firstInPct/firstWonPct/secondWonPct em FRAÇÃO (0-1);
// serveSubModel/extractServeProbs querem ...Pct em PERCENT (0-100) + .games. Adapta.
function _serveStatsFromProfile(prof) {
  if (!prof || prof.firstInPct == null || prof.firstWonPct == null || prof.secondWonPct == null) return null;
  const spw = prof.firstInPct * prof.firstWonPct + (1 - prof.firstInPct) * prof.secondWonPct; // 0-1
  return {
    firstServePct: prof.firstInPct * 100,
    firstServePointsPct: prof.firstWonPct * 100,
    secondServePointsPct: prof.secondWonPct * 100,
    games: prof.matches,   // serveSubModel exige >= 2 (getPlayerServeProfile já garante >= 5)
    spw,                   // consumido pelo trained model (enrich.serveStats.spw)
  };
}

// P(total > line) a partir do pdf {games:prob}.
function _pOverFromPdf(pdf, line) {
  let s = 0;
  for (const [k, v] of Object.entries(pdf || {})) if (Number(k) > line) s += v;
  return s;
}

module.exports = { _serveStatsFromProfile, _pOverFromPdf };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/run.js`
Expected: PASS — the three `tennis-match-lab` cases show `✓`. (Other suites unaffected.)

- [ ] **Step 5: Commit**

```bash
git add lib/tennis-match-lab.js tests/test-tennis-match-lab.js
git commit -m "feat(tennis-lab): pure helpers (serve-stat adapter + pOverFromPdf)"
```

---

### Task 2: `analyzeTennisMatch` orchestrator

**Files:**
- Modify: `lib/tennis-match-lab.js`
- Test: `tests/test-tennis-match-lab.js`

- [ ] **Step 1: Add the failing tests**

Append inside the `module.exports = function (t) { ... }` body of `tests/test-tennis-match-lab.js` (before the closing `};`):

```js
  const { analyzeTennisMatch } = require('../lib/tennis-match-lab');

  t.test('analyzeTennisMatch: no players -> lean fraco, empty markets, no db needed', () => {
    const out = analyzeTennisMatch(null, { player1: '', player2: '' });
    t.assert(out.ok === true, 'ok');
    t.assert(out.headline.label === 'lean fraco', `label ${out.headline.label}`);
    t.assert(out.headline.probP1 === 0.5, `probP1 ${out.headline.probP1}`);
    t.assert(Object.keys(out.markets).length === 0, 'markets empty');
  });

  // Data-rich path uses the real DB readonly (structural invariants only — Markov is stochastic).
  {
    const fs = require('fs'); const path = require('path');
    const DB_PATH = path.join(__dirname, '..', 'sportsedge.db');
    if (!fs.existsSync(DB_PATH)) {
      t.test('analyzeTennisMatch real-DB (skipped: no sportsedge.db)', () => {});
    } else {
      const Database = require('better-sqlite3');
      const db = new Database(DB_PATH, { readonly: true });
      // pick two players that exist in the tennis Elo history
      const row = db.prepare(`SELECT team1, team2 FROM match_results WHERE game='tennis' AND team1 IS NOT NULL AND team2 IS NOT NULL ORDER BY resolved_at DESC LIMIT 1`).get();
      t.test('analyzeTennisMatch real-DB: structural invariants + fairOdd=1/p', () => {
        const out = analyzeTennisMatch(db, { player1: row ? row.team1 : 'Novak Djokovic', player2: row ? row.team2 : 'Carlos Alcaraz', surface: 'hard', bestOf: 3, league: 'ATP Test' });
        t.assert(out.ok === true, 'ok');
        const h = out.headline;
        t.assert(h.probP1 >= 0 && h.probP1 <= 1, `probP1 range ${h.probP1}`);
        t.assert(Math.abs(h.probP1 + h.probP2 - 1) < 0.02, `probs sum ${h.probP1 + h.probP2}`);
        t.assert(['forte', 'lean', 'lean fraco'].includes(h.label), `label ${h.label}`);
        t.assert(typeof h.divergenceFlag === 'boolean', 'divergenceFlag bool');
        const ml = out.markets.ml;
        t.assert(Math.abs(ml.fairOddP1 - +(1 / ml.probP1).toFixed(2)) < 0.01, `fairOddP1 ${ml.fairOddP1}`);
        t.assert(Array.isArray(out.markets.handicapGames) && out.markets.handicapGames.length > 0, 'handicapGames');
        t.assert(Array.isArray(out.markets.totalGames) && out.markets.totalGames.length > 0, 'totalGames');
        out.markets.handicapGames.forEach(r => t.assert(r.prob >= 0 && r.prob <= 1 && Math.abs(r.fairOdd - +(1 / r.prob).toFixed(2)) < 0.01, `hg ${r.line}`));
        t.assert(['profiles', 'solved'].includes(out.serve.source), `serve source ${out.serve.source}`);
      });
      t.test('analyzeTennisMatch real-DB: edge computed when bookOdds given', () => {
        const out = analyzeTennisMatch(db, { player1: row ? row.team1 : 'A', player2: row ? row.team2 : 'B', surface: 'hard', bestOf: 3, league: 'ATP Test', bookOdds: { mlP1: 2.5 } });
        const ml = out.markets.ml;
        t.assert(Math.abs(ml.edgeP1 - +((ml.probP1 * 2.5) - 1).toFixed(3)) < 1e-9, `edgeP1 ${ml.edgeP1}`);
        t.assert(ml.edgeP2 === null, 'edgeP2 null (no mlP2 odd)');
      });
    }
  }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/run.js`
Expected: FAIL — `analyzeTennisMatch is not a function` (not exported yet).

- [ ] **Step 3: Implement `analyzeTennisMatch`**

In `lib/tennis-match-lab.js`, insert the following **before** the `module.exports` line:

```js
const _clampP = (p) => Math.max(1e-6, Math.min(1 - 1e-6, p));
const _fairOdd = (p) => +(1 / _clampP(p)).toFixed(2);
const _edge = (p, odd) => (typeof odd === 'number' && odd > 1) ? +((p * odd) - 1).toFixed(3) : null;

function analyzeTennisMatch(db, { player1, player2, surface, bestOf, league = '', bookOdds = {}, iters = 15000 } = {}) {
  bestOf = bestOf === 5 ? 5 : 3;
  const surf = (surface && String(surface).toLowerCase()) || detectSurface(league) || 'hard';
  const tier = tournamentTier(league);
  const format = bestOf >= 5 ? 'bo5' : 'bo3';

  if (!player1 || !player2) {
    return {
      ok: true,
      headline: { probP1: 0.5, probP2: 0.5, label: 'lean fraco', confidence: 0, method: 'none', surface: surf, tier, bestOf, markovProbP1: null, divergence: null, divergenceFlag: false },
      factors: [], serve: null, markets: {}, quality: { notes: ['informe os dois jogadores'] },
    };
  }

  // 1) Perfis (uma query/jogador: serve + ace + df) + ranking.
  const prof1 = getPlayerServeProfile(db, player1, { surface: surf });
  const prof2 = getPlayerServeProfile(db, player2, { surface: surf });
  const rank1 = getPlayerRankInfo(db, player1);
  const rank2 = getPlayerRankInfo(db, player2);
  const ss1 = _serveStatsFromProfile(prof1);
  const ss2 = _serveStatsFromProfile(prof2);

  // 2) HEADLINE: getTennisProbability SEM odd da casa (prior neutro 0.5 = market-independent).
  const enrich = {
    serveStats1: ss1, serveStats2: ss2,
    ranking1: rank1 ? { rank: rank1.latestRank } : undefined,
    ranking2: rank2 ? { rank: rank2.latestRank } : undefined,
  };
  const pred = getTennisProbability(db, { team1: player1, team2: player2, league, time: Date.now() }, null, enrich, surf);
  const probP1 = pred.modelP1;

  // 3) Serve probs p/ Markov: perfis reais (assimetria) OU back-solve do headline.
  let serveInfo;
  const sp = extractServeProbs(ss1, ss2, { surface: surf });
  if (sp) {
    serveInfo = { p1Serve: +sp.p1Serve.toFixed(4), p2Serve: +sp.p2Serve.toFixed(4), method: sp.method, source: 'profiles' };
  } else {
    const solved = solvePointProbs(probP1, SPW_AVG[surf] || 0.637, bestOf);
    serveInfo = { p1Serve: +solved.p1Serve.toFixed(4), p2Serve: +solved.p2Serve.toFixed(4), method: 'solved', source: 'solved' };
  }

  // 4) Markov (uma passada) → mercados.
  const mk = priceTennisMatch({ p1Serve: serveInfo.p1Serve, p2Serve: serveInfo.p2Serve, bestOf, iters });
  const markovProbP1 = mk.pMatch;
  const divergence = +Math.abs(probP1 - markovProbP1).toFixed(4);
  const calibOpts = { tier: tier || undefined, format };

  const ml = {
    probP1: +probP1.toFixed(4), probP2: +pred.modelP2.toFixed(4),
    fairOddP1: _fairOdd(probP1), fairOddP2: _fairOdd(pred.modelP2),
    edgeP1: _edge(probP1, bookOdds.mlP1), edgeP2: _edge(pred.modelP2, bookOdds.mlP2),
  };

  const HG_LINES = bestOf >= 5 ? [-6.5, -4.5, -2.5, 2.5, 4.5, 6.5] : [-5.5, -3.5, -1.5, 1.5, 3.5, 5.5];
  const bookHg = (bookOdds.handicap && typeof bookOdds.handicap === 'object') ? bookOdds.handicap : {};
  const handicapGames = HG_LINES.map((line) => {
    const pHomeRaw = handicapGamesProb(mk.gamesMarginPdf, line);
    if (pHomeRaw == null) return null;
    const pHome = applyMarkovCalib(pHomeRaw, 'handicapGames', { ...calibOpts, side: 'home' });
    return { line, side: 'home', prob: +pHome.toFixed(4), fairOdd: _fairOdd(pHome), edge: _edge(pHome, bookHg[String(line)]) };
  }).filter(Boolean);

  const base = Math.round(mk.totalGamesAvg);
  const TG_LINES = [base - 2.5, base - 1.5, base - 0.5, base + 0.5, base + 1.5, base + 2.5].filter(l => l > 0);
  const bookOver = (bookOdds.totalOver && typeof bookOdds.totalOver === 'object') ? bookOdds.totalOver : {};
  const bookUnder = (bookOdds.totalUnder && typeof bookOdds.totalUnder === 'object') ? bookOdds.totalUnder : {};
  const totalGames = TG_LINES.map((line) => {
    const pOverRaw = _pOverFromPdf(mk.totalGamesPdf, line);
    const pOver = applyMarkovCalib(pOverRaw, 'totalGames', { ...calibOpts, side: 'over' });
    const pUnder = applyMarkovCalib(1 - pOverRaw, 'totalGames', { ...calibOpts, side: 'under' });
    return {
      line, pOver: +pOver.toFixed(4), pUnder: +pUnder.toFixed(4),
      fairOddOver: _fairOdd(pOver), fairOddUnder: _fairOdd(pUnder),
      edgeOver: _edge(pOver, bookOver[String(line)]), edgeUnder: _edge(pUnder, bookUnder[String(line)]),
    };
  });

  const setBetting = Object.entries(mk.setDist)
    .map(([score, p]) => ({ score, prob: +p.toFixed(4), fairOdd: _fairOdd(p) }))
    .sort((a, b) => b.prob - a.prob);

  const tiebreak = {
    pMatchHasTiebreak: mk.pTiebreakMatch, pFirstSetTiebreak: mk.pTiebreakFirstSet,
    fairOddYes: _fairOdd(mk.pTiebreakMatch), fairOddNo: _fairOdd(1 - mk.pTiebreakMatch),
  };
  const straightSets = { prob: mk.pStraightSets, fairOdd: _fairOdd(mk.pStraightSets) };

  let aces = null, doubleFaults = null;
  if (prof1 && prof2 && prof1.acePerMatchAvg != null && prof2.acePerMatchAvg != null) {
    const a = estimateTennisAces({ acesPerMatch1: prof1.acePerMatchAvg, acesPerMatch2: prof2.acePerMatchAvg, bestOf, surface: surf });
    if (a) aces = { totalAvg: a.totalAcesAvg, lines: Object.entries(a.pOver).map(([line, p]) => ({ line: +line, pOver: p, fairOddOver: _fairOdd(p) })) };
  }
  if (prof1 && prof2 && prof1.dfPerMatchAvg != null && prof2.dfPerMatchAvg != null) {
    const d = estimateTennisDoubleFaults({ dfPerMatch1: prof1.dfPerMatchAvg, dfPerMatch2: prof2.dfPerMatchAvg, bestOf, surface: surf });
    if (d) doubleFaults = { totalAvg: d.totalDfAvg, lines: Object.entries(d.pOver).map(([line, p]) => ({ line: +line, pOver: p, fairOddOver: _fairOdd(p) })) };
  }

  // 5) Label + quality.
  const found1 = !!(pred._elo && pred._elo.found1);
  const found2 = !!(pred._elo && pred._elo.found2);
  const conf = pred.confidence;
  let label;
  if (!found1 && !found2) label = 'lean fraco';
  else if (conf >= 0.55 && Math.abs(probP1 - 0.5) >= 0.10) label = 'forte';
  else label = 'lean';

  const notes = [];
  if (!found1) notes.push(`${player1}: pouco/zero histórico no Elo`);
  if (!found2) notes.push(`${player2}: pouco/zero histórico no Elo`);
  if (serveInfo.source === 'solved') notes.push('sem perfil de saque — games/sets estimados a partir do headline');
  if (!aces) notes.push('aces: dados de saque insuficientes');
  if (!doubleFaults) notes.push('double faults: dados insuficientes');

  return {
    ok: true,
    headline: {
      probP1: +probP1.toFixed(4), probP2: +pred.modelP2.toFixed(4),
      label, confidence: +conf.toFixed(2), method: pred.method, surface: surf, tier, bestOf,
      markovProbP1: +markovProbP1.toFixed(4), divergence, divergenceFlag: divergence > 0.05,
    },
    factors: pred.factors || [],
    serve: serveInfo,
    markets: { ml, handicapGames, totalGames, setBetting, tiebreak, straightSets, aces, doubleFaults },
    quality: { eloFound1: found1, eloFound2: found2, hasServe1: !!ss1, hasServe2: !!ss2, hasRank1: !!rank1, hasRank2: !!rank2, notes },
  };
}
```

Then update the export line to include the orchestrator:

```js
module.exports = { analyzeTennisMatch, _serveStatsFromProfile, _pOverFromPdf };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tests/run.js`
Expected: PASS — the `analyzeTennisMatch` cases show `✓` (the real-DB cases run if `sportsedge.db` exists; otherwise the skip line shows `✓`). Suite total unchanged otherwise.

- [ ] **Step 5: Syntax check + airtight grep**

Run: `node -c lib/tennis-match-lab.js`
Expected: no output (valid).

Run (PowerShell): `Select-String -Path lib/tennis-match-lab.js -Pattern 'scanTennisMarkets|kelly|stake|bankroll|recordMarketTip|emitTip|minEv|EV_CAP|is_shadow|INSERT INTO tips'`
Expected: **no matches** (money-path airtight).

- [ ] **Step 6: Commit**

```bash
git add lib/tennis-match-lab.js tests/test-tennis-match-lab.js
git commit -m "feat(tennis-lab): analyzeTennisMatch orchestrator (ML headline + Markov markets, read-only)"
```

---

### Task 3: `lib/tennis-match-explain.js` (AI prompt + parser)

**Files:**
- Create: `lib/tennis-match-explain.js`
- Test: `tests/test-tennis-match-explain.js`

- [ ] **Step 1: Write the failing test**

Create `tests/test-tennis-match-explain.js`:

```js
'use strict';
const { buildTennisExplainPrompt, parseTennisExplain } = require('../lib/tennis-match-explain');

const FAKE_PRED = {
  headline: { probP1: 0.58, probP2: 0.42, label: 'lean', confidence: 0.6, tier: 'masters', markovProbP1: 0.55, divergenceFlag: false },
  factors: [{ name: 'Surface Elo', p1: 60, p2: 40, weight: 0.5, detail: 'Sinner 2100 vs Alcaraz 2080' }],
  markets: {
    ml: { fairOddP1: 1.72, fairOddP2: 2.38 },
    totalGames: [{ line: 21.5, pOver: 0.52, pUnder: 0.48, fairOddOver: 1.92, fairOddUnder: 2.08 }],
    handicapGames: [{ line: -3.5, prob: 0.46, fairOdd: 2.17 }],
    tiebreak: { pMatchHasTiebreak: 0.61 },
  },
};

module.exports = function (t) {
  t.test('buildTennisExplainPrompt embeds data + honesty contract', () => {
    const s = buildTennisExplainPrompt({ pred: FAKE_PRED, players: { player1: 'Sinner', player2: 'Alcaraz' }, surface: 'clay', bestOf: 3 });
    t.assert(s.includes('Sinner') && s.includes('Alcaraz'), 'players');
    t.assert(/58\.0%|58%/.test(s), 'probP1');
    t.assert(s.includes('NÃO as altere'), 'honesty: do not alter');
    t.assert(s.includes('APENAS um JSON'), 'json-only instruction');
    t.assert(/não recomende stake/i.test(s), 'no stake');
    t.assert(s.includes('Surface Elo'), 'factor included');
  });

  t.test('parseTennisExplain extracts the 4 keys', () => {
    const out = parseTennisExplain('lixo antes {"overview":"a","matchupRead":"b","marketsRead":"c","verdict":"d"} lixo depois');
    t.assert(out && out.overview === 'a' && out.matchupRead === 'b' && out.marketsRead === 'c' && out.verdict === 'd', JSON.stringify(out));
  });

  t.test('parseTennisExplain fills missing keys with empty string', () => {
    const out = parseTennisExplain('{"overview":"só isso"}');
    t.assert(out && out.overview === 'só isso' && out.verdict === '', JSON.stringify(out));
  });

  t.test('parseTennisExplain returns null on garbage', () => {
    t.assert(parseTennisExplain('sem json aqui') === null, 'no json');
    t.assert(parseTennisExplain('{"x":1}') === null, 'no known keys');
  });
};
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/run.js`
Expected: FAIL — `Cannot find module '../lib/tennis-match-explain'`.

- [ ] **Step 3: Create `lib/tennis-match-explain.js`**

```js
'use strict';
/**
 * tennis-match-explain.js — Display-only Tennis AI reading.
 * The probabilities/odds come from the model (the AI must NOT alter them). The AI reads the
 * matchup (style, surface fit, H2H) using its OWN tennis knowledge — labeled general knowledge.
 * Never recommends stake.
 */
const KEYS = ['overview', 'matchupRead', 'marketsRead', 'verdict'];

function buildTennisExplainPrompt({ pred, players, surface, bestOf }) {
  const p = players || {};
  const h = pred.headline || {};
  const m = pred.markets || {};
  const n1 = p.player1 || 'J1';
  const n2 = p.player2 || 'J2';
  const lines = [];
  lines.push('Dados da partida de tênis (modelo estatístico display-only — NÃO são apostas):');
  lines.push(`- Jogadores: ${n1} vs ${n2} | superfície: ${surface} | ${bestOf === 5 ? 'Melhor de 5 sets' : 'Melhor de 3 sets'} | tier: ${h.tier || '?'}`);
  lines.push(`- P(${n1} vence) = ${(h.probP1 * 100).toFixed(1)}% (${h.label}; conf ${h.confidence}). Markov de saque: ${(h.markovProbP1 * 100).toFixed(1)}%${h.divergenceFlag ? ' (DIVERGE do modelo — favorece quem saca melhor)' : ''}.`);
  for (const f of (pred.factors || [])) lines.push(`- Fator ${f.name}: ${n1} ${f.p1}% vs ${n2} ${f.p2}% (peso ${f.weight}) — ${f.detail}`);
  if (m.ml) lines.push(`- ML odd justa: ${n1} ${m.ml.fairOddP1} / ${n2} ${m.ml.fairOddP2}`);
  if (Array.isArray(m.totalGames) && m.totalGames.length) {
    const tg = m.totalGames[Math.floor(m.totalGames.length / 2)];
    lines.push(`- Total de games linha ${tg.line}: over ${(tg.pOver * 100).toFixed(0)}% (justa ${tg.fairOddOver}) / under ${(tg.pUnder * 100).toFixed(0)}% (justa ${tg.fairOddUnder})`);
  }
  if (Array.isArray(m.handicapGames) && m.handicapGames.length) {
    const hg = m.handicapGames.find(x => x.line < 0) || m.handicapGames[0];
    lines.push(`- Handicap games ${n1} ${hg.line}: ${(hg.prob * 100).toFixed(0)}% (justa ${hg.fairOdd})`);
  }
  if (m.tiebreak) lines.push(`- P(haver tiebreak na partida): ${(m.tiebreak.pMatchHasTiebreak * 100).toFixed(0)}%`);
  lines.push('');
  lines.push('Você é um analista de tênis. As probabilidades/odds acima vêm do modelo (NÃO as altere). Para a leitura do confronto (estilo de jogo, ajuste por superfície, H2H, forma), USE O SEU CONHECIMENTO de tênis.');
  lines.push('Responda APENAS um JSON compacto, nada fora dele, em PT-BR:');
  lines.push('{"overview":"…","matchupRead":"…","marketsRead":"…","verdict":"…"}');
  lines.push('Regras: cada campo 1-3 frases; overview = resumo do confronto; matchupRead = leitura de estilo/superfície/H2H (seu conhecimento, pode não refletir lesões/forma recentes); marketsRead = o que os números de games/handicap/tiebreak sugerem (sem inventar edge); verdict = conclusão apoiada no modelo; NÃO recomende stake nem diga "aposte".');
  return lines.join('\n');
}

function parseTennisExplain(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj; try { obj = JSON.parse(m[0]); } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (!KEYS.some(k => typeof obj[k] === 'string' && obj[k].trim())) return null;
  const out = {}; for (const k of KEYS) out[k] = (typeof obj[k] === 'string') ? obj[k] : '';
  return out;
}

module.exports = { buildTennisExplainPrompt, parseTennisExplain };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/run.js`
Expected: PASS — the four `tennis-match-explain` cases show `✓`.

- [ ] **Step 5: Syntax check + commit**

Run: `node -c lib/tennis-match-explain.js`
Expected: no output.

```bash
git add lib/tennis-match-explain.js tests/test-tennis-match-explain.js
git commit -m "feat(tennis-lab): AI explain prompt + parser (honesty contract, display-only)"
```

---

### Task 4: server.js endpoints (`tennis-players`, `tennis-match-analyze`, `tennis-match-explain`)

**Files:**
- Modify: `server.js` (insert next to the dota/cs lab routes — locate the `/api/dota-teams` handler near `server.js:5558` and insert the block right after the dota/cs lab route cluster, before the next unrelated route).

- [ ] **Step 1: Insert the three routes**

Find the existing line `if (p === '/api/dota-teams' && req.method === 'GET') {` (≈5558). Insert the following block immediately **before** it (so the tennis routes sit with the other lab routes):

```js
  // ── Tennis Lab — player autocomplete (display-only) ──
  if (p === '/api/tennis-players' && req.method === 'GET') {
    try {
      const rows = db.prepare(`SELECT team1 t FROM match_results WHERE game='tennis' AND team1 IS NOT NULL AND team1!=''
                               UNION SELECT team2 t FROM match_results WHERE game='tennis' AND team2 IS NOT NULL AND team2!=''`).all();
      sendJson(res, { ok: true, players: [...new Set(rows.map(r => r.t))].sort((a, b) => a.localeCompare(b)) });
    } catch (e) { sendJson(res, { ok: false, error: 'players_failed' }, 500); }
    return;
  }
  // Tennis Lab — match analyze (ML headline + Markov markets, display-only, airtight).
  if (p === '/api/tennis-match-analyze' && req.method === 'POST') {
    _readPostBody(req, res, (body) => {
      if (body == null) return;
      try {
        const json = safeParse(body, null);
        const { analyzeTennisMatch } = require('./lib/tennis-match-lab');
        const out = analyzeTennisMatch(db, {
          player1: json?.player1 || null, player2: json?.player2 || null,
          surface: json?.surface || null, bestOf: json?.bestOf === 5 ? 5 : 3,
          league: json?.league || '',
          bookOdds: (json?.bookOdds && typeof json.bookOdds === 'object') ? json.bookOdds : {},
        });
        sendJson(res, out);
      } catch (e) { log('WARN', 'TENNIS-LAB', `analyze err: ${e.message}`); sendJson(res, { ok: false, error: 'tennis_analyze_failed' }, 500); }
    });
    return;
  }
  // Tennis Lab — AI explain (Sonnet, capped, display-only).
  if (p === '/api/tennis-match-explain' && req.method === 'POST') {
    _readPostBody(req, res, async (body) => {
      if (body == null) return;
      try {
        const KEY = process.env.ANTHROPIC_API_KEY;
        if (!KEY) { sendJson(res, { ok: false, error: 'vision_disabled' }, 503); return; }
        const json = safeParse(body, null);
        if (!json?.player1 || !json?.player2) { sendJson(res, { ok: false, error: 'empty_match' }, 400); return; }
        const ip = getClientIp(req);
        const cap = parseInt(process.env.AI_ANALYSIS_DAILY_CAP || '30', 10);
        const _amap = (global._aiAnalysisDayMap = global._aiAnalysisDayMap || new Map());
        const dayKey = `${ip}|${new Date().toISOString().slice(0, 10)}`;
        const usedN = _amap.get(dayKey) || 0;
        if (usedN >= cap) { sendJson(res, { ok: false, error: 'daily_cap_reached', cap }, 429); return; }
        _amap.set(dayKey, usedN + 1);
        const { analyzeTennisMatch } = require('./lib/tennis-match-lab');
        const { buildTennisExplainPrompt, parseTennisExplain } = require('./lib/tennis-match-explain');
        const bestOf = json?.bestOf === 5 ? 5 : 3;
        const pred = analyzeTennisMatch(db, {
          player1: json.player1, player2: json.player2, surface: json?.surface || null,
          bestOf, league: json?.league || '',
          bookOdds: (json?.bookOdds && typeof json.bookOdds === 'object') ? json.bookOdds : {},
        });
        const prompt = buildTennisExplainPrompt({ pred, players: { player1: json.player1, player2: json.player2 }, surface: pred.headline.surface, bestOf });
        const model = process.env.AI_ANALYSIS_MODEL || 'claude-sonnet-4-5';
        const r = await aiPost('anthropic', 'https://api.anthropic.com/v1/messages',
          { model, max_tokens: 800, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] },
          { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' }, { timeoutMs: 30000, retry: { maxAttempts: 2 } });
        try { stmts.incrApiUsage.run('anthropic', new Date().toISOString().slice(0, 7)); } catch (_) {}
        const rj = r ? safeParse(r.body, {}) : {};
        const text = (rj?.content || []).map(c => c.text || '').join('');
        const analysis = parseTennisExplain(text);
        if (analysis) sendJson(res, { ok: true, analysis });
        else if (text && text.trim()) sendJson(res, { ok: true, analysis: null, raw: text.slice(0, 1200) });
        else sendJson(res, { ok: false, error: 'ai_failed' }, 500);
      } catch (e) { log('WARN', 'TENNIS-LAB', `explain err: ${e.message}`); sendJson(res, { ok: false, error: 'ai_failed' }, 500); }
    });
    return;
  }
```

- [ ] **Step 2: Syntax check**

Run: `node -c server.js`
Expected: no output (valid). If it errors, the insertion landed inside another handler — move it to just before the `/api/dota-teams` route.

- [ ] **Step 3: Smoke the endpoints locally against the read-only DB**

Run (PowerShell, starts server on its default port — adjust if `PORT` is set):

```powershell
$env:PORT='8099'; $p = Start-Process node -ArgumentList 'server.js' -PassThru -NoNewWindow; Start-Sleep 6
Invoke-RestMethod 'http://localhost:8099/api/tennis-players' | Select-Object -ExpandProperty players -First 5
$body = @{ player1='Novak Djokovic'; player2='Carlos Alcaraz'; surface='hard'; bestOf=3; league='ATP Test' } | ConvertTo-Json
Invoke-RestMethod -Method Post 'http://localhost:8099/api/tennis-match-analyze' -ContentType 'application/json' -Body $body | ConvertTo-Json -Depth 4 | Select-Object -First 40
Stop-Process -Id $p.Id -Force
```

Expected: `players` lists tennis player names; analyze returns `ok:true` with `headline.probP1`, `markets.handicapGames`/`totalGames` arrays. (If the local DB has no serve data for those names, `serve.source` may be `solved` and `aces`/`doubleFaults` `null` — that is the documented degradation, not a failure.)

> Note: if `node server.js` fails to boot locally for unrelated reasons (env/network), skip this step and rely on the prod smoke in Task 7; the `node -c` check + the lib tests already validate the handler wiring.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(tennis-lab): endpoints tennis-players / tennis-match-analyze / tennis-match-explain"
```

---

### Task 5: UI overlay `#tennisLab` + JS

**Files:**
- Modify: `public/lol-live-dashboard.html`

- [ ] **Step 1: Add the overlay CSS**

Find the CSS rule block `#csLab {` (≈1068). Immediately after the `#csLab { ... }` rule block, add:

```css
#tennisLab {
  position: fixed; top: 56px; left: 0; right: 0; bottom: 0;
  z-index: 40; display: none; overflow-y: auto;
  background: var(--bg, #0e0f13); padding: var(--pad-4, 16px);
}
#tennisLab.open { display: block; }
.tn-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; max-width: 620px; }
.tn-mkt { margin-top: 12px; }
.tn-mkt h4 { margin: 6px 0; font-size: 13px; opacity: .8; }
.tn-row { display: flex; gap: 10px; align-items: center; padding: 2px 0; font-size: 13px; flex-wrap: wrap; }
.tn-odd { display: inline-flex; gap: 6px; align-items: center; }
.tn-fair { opacity: .8; }
.tn-book { width: 64px; }
.tn-edge.pos { color: #4ec9b0; } .tn-edge.neg { color: #e06c75; }
.tn-flag { color: #e5c07b; font-size: 12px; }
.tn-warn { color: #e5c07b; font-size: 12px; margin-top: 10px; }
.tn-raw { font-size: 12px; opacity: .85; white-space: pre-wrap; }
```

- [ ] **Step 2: Add the topbar button**

Find the line `<button class="btn" id="csLabBtn" onclick="toggleCsLab()">⚗ CS Lab</button>` (≈1337). Add immediately after it:

```html
    <button class="btn" id="tennisLabBtn" onclick="toggleTennisLab()">🎾 Tennis Lab</button>
```

- [ ] **Step 3: Add the overlay markup**

Find the closing of the Dota Lab overlay — the line `<div id="dotaResult" style="margin-top: var(--pad-4);"></div>` followed by `</div>` (≈1443-1444). After that closing `</div>`, insert:

```html
<!-- ── Tennis Lab ──────────────────────────────────────────────── -->
<div id="tennisLab">
  <div class="dl-header">
    <span class="dl-title">Tennis Lab</span>
    <span class="dl-subtitle">2 jogadores + superfície — P(vence) + mercados (handicap games, totais, sets, tiebreak, aces, DF)</span>
    <button class="btn" onclick="toggleTennisLab(false)" style="margin-left:auto;">✕ fechar</button>
  </div>
  <datalist id="tennisPlayerList"></datalist>
  <div class="dl-body">
    <div class="tn-grid">
      <input class="dl-team-input" id="tn_p1" list="tennisPlayerList" placeholder="Jogador 1" autocomplete="off">
      <input class="dl-team-input" id="tn_p2" list="tennisPlayerList" placeholder="Jogador 2" autocomplete="off">
      <select id="tn_surface">
        <option value="hard">Hard</option>
        <option value="clay">Clay (saibro)</option>
        <option value="grass">Grass (grama)</option>
        <option value="indoor">Indoor</option>
      </select>
      <select id="tn_bestof">
        <option value="3">Melhor de 3 (Bo3)</option>
        <option value="5">Melhor de 5 (Bo5)</option>
      </select>
      <input class="dl-team-input" id="tn_league" placeholder="Torneio (opcional — auto superfície/tier)" autocomplete="off">
    </div>
    <div class="dl-actions">
      <button class="btn primary" id="tennisAnalyzeBtn" onclick="tennisAnalyze()">Analisar partida</button>
      <div class="dl-error" id="tennisError"></div>
    </div>
  </div>
  <div id="tennisResult" style="margin-top: var(--pad-4);"></div>
</div>
```

- [ ] **Step 4: Add the JS (toggle + datalist + analyze + render + explain)**

Find the Dota toggle function `function toggleDotaLab(force)` (≈2615). Insert the following block immediately **before** it (so the tennis functions are defined in the same script scope):

```js
function toggleTennisLab(force) {
  const lab = document.getElementById('tennisLab');
  if (!lab) return;
  const open = typeof force === 'boolean' ? force : !lab.classList.contains('open');
  lab.classList.toggle('open', open);
  if (open && !lab._playersLoaded) {
    lab._playersLoaded = true;
    fetch('/api/tennis-players').then(r => r.json()).then(d => {
      if (!d.ok) return;
      const dl = document.getElementById('tennisPlayerList');
      dl.innerHTML = '';
      for (const name of d.players) dl.appendChild(el('option', { value: name }));
    }).catch(() => { lab._playersLoaded = false; });
  }
}

function tennisOddCell(prob) {
  const wrap = el('span', { class: 'tn-odd' });
  wrap.appendChild(el('span', { class: 'tn-fair' }, `justa ${(1 / Math.max(1e-6, prob)).toFixed(2)}`));
  const inp = el('input', { class: 'tn-book', type: 'number', step: '0.01', min: '1.01', placeholder: 'casa' });
  const edge = el('span', { class: 'tn-edge' });
  inp.addEventListener('input', () => {
    const o = parseFloat(inp.value);
    if (o > 1) { const e = (prob * o - 1) * 100; edge.textContent = `${e >= 0 ? '+' : ''}${e.toFixed(1)}%`; edge.className = 'tn-edge ' + (e >= 0 ? 'pos' : 'neg'); }
    else { edge.textContent = ''; edge.className = 'tn-edge'; }
  });
  wrap.appendChild(inp); wrap.appendChild(edge);
  return wrap;
}

async function tennisAnalyze() {
  const p1 = document.getElementById('tn_p1').value.trim();
  const p2 = document.getElementById('tn_p2').value.trim();
  const errEl = document.getElementById('tennisError'); errEl.textContent = '';
  if (!p1 || !p2) { errEl.textContent = 'Informe os dois jogadores.'; return; }
  const surface = document.getElementById('tn_surface').value;
  const bestOf = parseInt(document.getElementById('tn_bestof').value, 10);
  const league = document.getElementById('tn_league').value.trim();
  const root = document.getElementById('tennisResult'); root.innerHTML = 'analisando…';
  try {
    const r = await fetch('/api/tennis-match-analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ player1: p1, player2: p2, surface, bestOf, league }) });
    const d = await r.json();
    if (!d.ok) { root.textContent = 'Falha na análise.'; return; }
    tennisRender(root, d, { p1, p2 });
  } catch (e) { root.textContent = 'Falha: ' + e.message; }
}

function tennisRender(root, d, who) {
  root.innerHTML = '';
  const h = d.headline, m = d.markets;
  const p1 = who.p1, p2 = who.p2;
  root.appendChild(el('div', { class: 'dl-gp-row' }, `P(${p1} vence): ${(h.probP1 * 100).toFixed(1)}%  ·  ${h.label}  ·  conf ${h.confidence}  ·  ${h.surface} ${h.bestOf === 5 ? 'Bo5' : 'Bo3'}`));
  root.appendChild(el('div', { class: 'dl-gp-note' }, `Markov de saque: P(${p1}) ${(h.markovProbP1 * 100).toFixed(1)}% (${d.serve.source === 'solved' ? 'estimado do headline' : 'perfis de saque'})`));
  if (h.divergenceFlag) root.appendChild(el('div', { class: 'tn-flag' }, `⚠ modelo e Markov de saque divergem ${(h.divergence * 100).toFixed(1)}pp — favorece quem saca melhor`));

  // Fatores
  if (d.factors && d.factors.length) {
    const fb = el('div', { class: 'tn-mkt' }, el('h4', {}, 'Fatores do modelo'));
    for (const f of d.factors) fb.appendChild(el('div', { class: 'tn-row' }, `${f.name}: ${p1} ${f.p1}% vs ${p2} ${f.p2}% (peso ${f.weight})`));
    root.appendChild(fb);
  }

  // ML
  const mlb = el('div', { class: 'tn-mkt' }, el('h4', {}, 'Moneyline'));
  mlb.appendChild(el('div', { class: 'tn-row' }, `${p1}: ${(m.ml.probP1 * 100).toFixed(1)}%`, tennisOddCell(m.ml.probP1)));
  mlb.appendChild(el('div', { class: 'tn-row' }, `${p2}: ${(m.ml.probP2 * 100).toFixed(1)}%`, tennisOddCell(m.ml.probP2)));
  root.appendChild(mlb);

  // Handicap de games (perspectiva J1)
  const hgb = el('div', { class: 'tn-mkt' }, el('h4', {}, `Handicap de games (${p1})`));
  for (const r of m.handicapGames) hgb.appendChild(el('div', { class: 'tn-row' }, `${r.line > 0 ? '+' : ''}${r.line}: ${(r.prob * 100).toFixed(1)}%`, tennisOddCell(r.prob)));
  root.appendChild(hgb);

  // Total de games
  const tgb = el('div', { class: 'tn-mkt' }, el('h4', {}, 'Total de games'));
  for (const r of m.totalGames) {
    tgb.appendChild(el('div', { class: 'tn-row' }, `Over ${r.line}: ${(r.pOver * 100).toFixed(1)}%`, tennisOddCell(r.pOver)));
    tgb.appendChild(el('div', { class: 'tn-row' }, `Under ${r.line}: ${(r.pUnder * 100).toFixed(1)}%`, tennisOddCell(r.pUnder)));
  }
  root.appendChild(tgb);

  // Set betting (cru)
  const sbb = el('div', { class: 'tn-mkt' }, el('h4', {}, 'Placar de sets (não calibrado)'));
  for (const r of m.setBetting) sbb.appendChild(el('div', { class: 'tn-row' }, `${r.score}: ${(r.prob * 100).toFixed(1)}%  ·  justa ${r.fairOdd}`));
  root.appendChild(sbb);

  // Tiebreak / straight sets (cru)
  const tbb = el('div', { class: 'tn-mkt' }, el('h4', {}, 'Tiebreak / sets diretos (não calibrado)'));
  tbb.appendChild(el('div', { class: 'tn-row' }, `Haver tiebreak na partida: ${(m.tiebreak.pMatchHasTiebreak * 100).toFixed(0)}%  ·  justa sim ${m.tiebreak.fairOddYes} / não ${m.tiebreak.fairOddNo}`));
  tbb.appendChild(el('div', { class: 'tn-row' }, `Vitória em sets diretos: ${(m.straightSets.prob * 100).toFixed(0)}%  ·  justa ${m.straightSets.fairOdd}`));
  root.appendChild(tbb);

  // Aces / DFs (cru, condicional)
  if (m.aces) {
    const ab = el('div', { class: 'tn-mkt' }, el('h4', {}, `Aces (total ~${m.aces.totalAvg}, não calibrado)`));
    for (const r of m.aces.lines) ab.appendChild(el('div', { class: 'tn-row' }, `Over ${r.line}: ${(r.pOver * 100).toFixed(0)}%  ·  justa ${r.fairOddOver}`));
    root.appendChild(ab);
  }
  if (m.doubleFaults) {
    const db2 = el('div', { class: 'tn-mkt' }, el('h4', {}, `Double faults (total ~${m.doubleFaults.totalAvg}, não calibrado)`));
    for (const r of m.doubleFaults.lines) db2.appendChild(el('div', { class: 'tn-row' }, `Over ${r.line}: ${(r.pOver * 100).toFixed(0)}%  ·  justa ${r.fairOddOver}`));
    root.appendChild(db2);
  }

  // Quality notes
  if (d.quality && d.quality.notes && d.quality.notes.length) {
    root.appendChild(el('div', { class: 'dl-gp-note' }, 'Qualidade: ' + d.quality.notes.join(' · ')));
  }

  // AI
  const aiOut = el('div', { class: 'dl-ai-out' });
  const aiBtn = el('button', { class: 'dl-ai-btn' }, '🤖 Análise da IA');
  aiBtn.addEventListener('click', () => tennisExplain(aiBtn, aiOut, { p1, p2, surface: h.surface, bestOf: h.bestOf, league: document.getElementById('tn_league').value.trim() }));
  root.appendChild(el('div', { class: 'dl-gp-ai' }, aiBtn, aiOut));
  root.appendChild(el('div', { class: 'tn-warn' }, '⚠ display-only — não é sinal de aposta. ML/handicap/totais calibrados; sets/tiebreak/aces/DF são estimativa crua.'));
}

async function tennisExplain(btn, outEl, ctx) {
  btn.disabled = true; const old = btn.textContent; btn.textContent = 'analisando…'; outEl.innerHTML = '';
  try {
    const r = await fetch('/api/tennis-match-explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ player1: ctx.p1, player2: ctx.p2, surface: ctx.surface, bestOf: ctx.bestOf, league: ctx.league }) });
    const d = await r.json();
    if (!d.ok) { outEl.textContent = d.error === 'daily_cap_reached' ? 'Limite diário atingido.' : d.error === 'vision_disabled' ? 'IA indisponível.' : 'Falha.'; return; }
    if (d.analysis) {
      [['VISÃO', d.analysis.overview], ['CONFRONTO', d.analysis.matchupRead], ['MERCADOS', d.analysis.marketsRead], ['VEREDITO', d.analysis.verdict]].forEach(([k, v]) => {
        if (v) outEl.appendChild(el('div', { class: 'dl-ai-row' }, el('span', { class: 'dl-ai-k' }, k), el('span', {}, v)));
      });
    } else if (d.raw) outEl.appendChild(el('div', { class: 'tn-raw' }, d.raw));
    outEl.appendChild(el('div', { class: 'tn-warn' }, '⚠ leitura da IA (conhecimento geral) — não é sinal de aposta'));
  } catch (e) { outEl.textContent = 'Falha: ' + e.message; }
  finally { btn.disabled = false; btn.textContent = old; }
}
```

- [ ] **Step 5: Verify the page parses (no syntax error in the inline script)**

Run (PowerShell — extracts the inline scripts and node-checks them is overkill; instead boot the server and load the page):

```powershell
$env:PORT='8099'; $p = Start-Process node -ArgumentList 'server.js' -PassThru -NoNewWindow; Start-Sleep 6
$html = (Invoke-WebRequest 'http://localhost:8099/edge').Content
if ($html -match 'tennisLab') { 'OK: tennisLab present in /edge' } else { 'FAIL: tennisLab missing' }
Stop-Process -Id $p.Id -Force
```

Expected: `OK: tennisLab present in /edge`. Then, if a browser is available, open `http://localhost:8099/edge`, click **🎾 Tennis Lab**, type two players, pick surface, click **Analisar partida**, and confirm the headline + market tables render and the book-odd inputs compute live edge. (If local boot is blocked, defer the visual check to the prod smoke in Task 7.)

- [ ] **Step 6: Commit**

```bash
git add public/lol-live-dashboard.html
git commit -m "feat(tennis-lab): /edge overlay (headline + rich markets + live edge + AI)"
```

---

### Task 6: (separable) Upcoming-match prefill — `GET /api/tennis-upcoming` + UI list

**Files:**
- Modify: `server.js` (new route), `public/lol-live-dashboard.html` (prefill list)

> Separable: if earlier tasks ran long, ship Tasks 1–5 first; this is v1.1. Uses `lib/tennis-data.getScoreboard` (ESPN) which already exists.

- [ ] **Step 1: Add the route**

Insert immediately after the `/api/tennis-players` handler added in Task 4:

```js
  // Tennis Lab — upcoming matches (ESPN) for one-click prefill (display-only).
  if (p === '/api/tennis-upcoming' && req.method === 'GET') {
    (async () => {
      try {
        const { getScoreboard } = require('./lib/tennis-data');
        const out = [];
        for (const tour of ['atp', 'wta']) {
          let sb = null;
          try { sb = await getScoreboard(tour); } catch (_) { sb = null; }
          const events = (sb && Array.isArray(sb.events)) ? sb.events : [];
          for (const ev of events) {
            const comp = ev?.competitions?.[0];
            const cs = comp?.competitors || [];
            if (cs.length < 2) continue;
            const name = (c) => c?.athlete?.displayName || c?.athlete?.shortName || null;
            const p1 = name(cs[0]); const p2 = name(cs[1]);
            if (!p1 || !p2) continue;
            const tournament = ev?.name || comp?.notes?.[0]?.headline || '';
            out.push({ player1: p1, player2: p2, tournament, tour, startTime: ev?.date || null });
          }
        }
        sendJson(res, { ok: true, matches: out.slice(0, 40) });
      } catch (e) { log('WARN', 'TENNIS-LAB', `upcoming err: ${e.message}`); sendJson(res, { ok: false, error: 'upcoming_failed', matches: [] }, 200); }
    })();
    return;
  }
```

- [ ] **Step 2: Syntax check**

Run: `node -c server.js`
Expected: no output.

- [ ] **Step 3: Add the prefill list to the overlay**

In `public/lol-live-dashboard.html`, inside the `#tennisLab` `.dl-body` (right after the `.dl-actions` div added in Task 5), add:

```html
    <div class="tn-mkt"><h4>Jogos próximos (clique pra preencher)</h4><div id="tennisUpcoming" class="tn-row">carregando…</div></div>
```

- [ ] **Step 4: Populate it on open**

In `toggleTennisLab` (Task 5), inside the `if (open && !lab._playersLoaded)` block, after the players `fetch(...)`, add a second fetch:

```js
    fetch('/api/tennis-upcoming').then(r => r.json()).then(d => {
      const box = document.getElementById('tennisUpcoming'); box.innerHTML = '';
      if (!d.ok || !d.matches.length) { box.textContent = '(sem jogos próximos)'; return; }
      for (const mt of d.matches) {
        const b = el('button', { class: 'btn' }, `${mt.player1} vs ${mt.player2}${mt.tournament ? ' · ' + mt.tournament : ''}`);
        b.addEventListener('click', () => {
          document.getElementById('tn_p1').value = mt.player1;
          document.getElementById('tn_p2').value = mt.player2;
          if (/roland|french|monte|madrid|rome|clay|saibro/i.test(mt.tournament)) document.getElementById('tn_surface').value = 'clay';
          else if (/wimbledon|grass|queen|halle/i.test(mt.tournament)) document.getElementById('tn_surface').value = 'grass';
          document.getElementById('tn_league').value = mt.tournament || '';
        });
        box.appendChild(b);
      }
    }).catch(() => { const box = document.getElementById('tennisUpcoming'); if (box) box.textContent = '(falha ao carregar)'; });
```

- [ ] **Step 5: Verify + commit**

Run: `node -c server.js`
Expected: no output.

```bash
git add server.js public/lol-live-dashboard.html
git commit -m "feat(tennis-lab): upcoming-match prefill (ESPN scoreboard, separable)"
```

---

### Task 7: Final verification + prod smoke

**Files:** none (verification only).

- [ ] **Step 1: Full suite green**

Run: `node tests/run.js`
Expected: ends with the pass/fail summary, `fail = 0`. All previous suites + the new `tennis-match-lab` (7 cases incl. real-DB) and `tennis-match-explain` (4 cases) pass.

- [ ] **Step 2: Syntax check both monoliths**

Run: `node -c bot.js` then `node -c server.js`
Expected: no output for either.

- [ ] **Step 3: Money-path airtight grep (new files)**

Run (PowerShell): `Select-String -Path lib/tennis-match-lab.js, lib/tennis-match-explain.js -Pattern 'scanTennisMarkets|kelly|stake|bankroll|recordMarketTip|emitTip|minEv|EV_CAP|is_shadow|INSERT INTO tips'`
Expected: **no matches**. (The lab only reads the model + computes fair odds/edge inline.)

- [ ] **Step 4: Prod smoke (after deploy)**

Open `https://sportsedge-bot-production.up.railway.app/edge` → click **🎾 Tennis Lab** → enter a real ATP confrontation (e.g., `Jannik Sinner` vs `Carlos Alcaraz`, surface `clay`, Bo3) → **Analisar partida**.

Expected:
- Headline `P(Sinner vence): NN.N% · <label> · conf X · clay Bo3`, plus the Markov serve cross-check line (and a divergence flag if >5pp).
- Market sections render: Moneyline, Handicap de games, Total de games (these three with calibrated probs + live-edge inputs), Set betting / Tiebreak / Aces / DFs (raw, with "não calibrado" labels — aces/DFs only if the players have serve data).
- Click **🤖 Análise da IA** → 4 sections (VISÃO / CONFRONTO / MERCADOS / VEREDITO) in PT-BR, no stake recommendation. (If `ANTHROPIC_API_KEY` unset in prod → "IA indisponível", rest of the panel still works.)

Also curl the analyze endpoint:

```bash
curl -s -X POST "https://sportsedge-bot-production.up.railway.app/api/tennis-match-analyze" \
  -H "Content-Type: application/json" \
  -d '{"player1":"Jannik Sinner","player2":"Carlos Alcaraz","surface":"clay","bestOf":3,"league":"ATP Masters"}' | head -c 800
```

Expected: JSON `{"ok":true,"headline":{...},"markets":{...}}`.

- [ ] **Step 5: Done**

No code commit in this task (verification only). If any step fails, fix in the owning task and re-verify.

---

## Self-Review (completed by plan author)

**Spec coverage:** Headline ML market-independent (Task 2, `odds=null`) ✓; Markov markets HG/totals calibrated + sets/tiebreak/aces/DFs raw with badges (Task 2 + Task 5 labels) ✓; reuse production model / no parallel / no backtest (Tasks 1–2) ✓; ML-primary + Markov cross-check + >5pp flag (Task 2 `divergenceFlag`, Task 5 render) ✓; airtight grep (Tasks 2 & 7) ✓; AI explain 4 sections + honesty contract (Task 3) ✓; player autocomplete (Task 4) ✓; UI overlay mirroring dota/cs (Task 5) ✓; upcoming prefill separable (Task 6) ✓; degradation paths (Task 2 notes + Task 5) ✓.

**Placeholder scan:** none — every code/test/command step is concrete.

**Type consistency:** `analyzeTennisMatch` return shape (`headline`/`factors`/`serve`/`markets`/`quality`) is identical across the orchestrator (Task 2), the explain prompt consumer (Task 3 `pred.headline`/`pred.markets`/`pred.factors`), the endpoints (Task 4), and the renderer (Task 5: `m.ml`, `m.handicapGames[].{line,prob,fairOdd}`, `m.totalGames[].{line,pOver,pUnder,...}`, `m.setBetting[].{score,prob,fairOdd}`, `m.tiebreak.{pMatchHasTiebreak,fairOddYes,fairOddNo}`, `m.straightSets.{prob,fairOdd}`, `m.aces?.lines[].{line,pOver,fairOddOver}`, `m.doubleFaults?.lines`). `bookOdds` shape (`{mlP1,mlP2,handicap:{line:odd},totalOver:{line:odd},totalUnder:{line:odd}}`) consistent between Task 2 and the (live, client-side) edge inputs in Task 5.
