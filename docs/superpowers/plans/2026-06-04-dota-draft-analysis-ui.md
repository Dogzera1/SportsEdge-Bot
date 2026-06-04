# Dota Lab "Analisar draft" (Fase 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar o botão "Analisar draft" ao Dota Lab — leitura de draft (counters + WR jogador×herói + força meta + composição + IA ancorada nos dados), display-only, sem win% de draft.

**Architecture:** Um orquestrador `computeDotaDraftAnalysis` combina os libs da Fase 1 (`getMatchupEdge`, `getPlayerHeroStats`/`resolveProPlayer`) + `getDraftMatchupFactor` + um novo `getDraftComposition`. Dois endpoints (`/api/dota-draft-analyze` e `/api/dota-draft-explain` com IA ancorada) compartilham o orquestrador. UI espelha o padrão `dotaRender`/`dotaExplain` existente.

**Tech Stack:** Node 18, better-sqlite3, Anthropic Sonnet (`aiPost`), HTML/JS vanilla, test runner caseiro (`t.test`/`t.assert`).

---

## File Structure
- **Modify** `lib/dota-hero-matchups.js` — promover `_resolveId` → `resolveHeroId` (público).
- **Modify** `lib/dota-hero-features.js` — novo `getDraftComposition(db, heroes)` + reset do cache novo em `invalidateMetaCache`.
- **Create** `lib/dota-draft-analysis.js` — `computeDotaDraftAnalysis(db, {blue,red,players}, {fetcher})` (orquestrador, display-only).
- **Create** `lib/dota-draft-explain.js` — `buildDotaDraftPrompt` + `parseDotaDraftExplain`.
- **Modify** `server.js` — `POST /api/dota-draft-analyze` + `POST /api/dota-draft-explain`.
- **Modify** `public/lol-live-dashboard.html` — botão "Analisar draft" + `dotaCollectDraft`/`dotaAnalyzeDraft`/`dotaRenderDraft`/`dotaExplainDraft`.
- **Modify** `tests/test-dota-hero-matchups.js` — caso p/ `resolveHeroId`.
- **Create** `tests/test-dota-draft-composition.js`, `tests/test-dota-draft-analysis.js`, `tests/test-dota-draft-explain.js`.

---

## Task 1: `resolveHeroId` público + `getDraftComposition` (TDD)

**Files:** Modify `lib/dota-hero-matchups.js`, `lib/dota-hero-features.js`, `tests/test-dota-hero-matchups.js`; Create `tests/test-dota-draft-composition.js`

- [ ] **Step 1: Promote `_resolveId` to public `resolveHeroId` in `lib/dota-hero-matchups.js`**

Rename `_resolveId` to `resolveHeroId` (3 spots: definition + the two call sites in `getMatchupEdge`) and export it. Edit the definition:
```js
function _resolveId(db, h) {
```
→
```js
function resolveHeroId(db, h) {
```
Edit the two usages inside `getMatchupEdge`:
```js
  const blue = (blueHeroes || []).map(h => _resolveId(db, h)).filter(Boolean);
  const red = (redHeroes || []).map(h => _resolveId(db, h)).filter(Boolean);
```
→
```js
  const blue = (blueHeroes || []).map(h => resolveHeroId(db, h)).filter(Boolean);
  const red = (redHeroes || []).map(h => resolveHeroId(db, h)).filter(Boolean);
```
Edit the exports:
```js
module.exports = { getMatchupEdge, _invalidateMatchupCache };
```
→
```js
module.exports = { getMatchupEdge, resolveHeroId, _invalidateMatchupCache };
```

- [ ] **Step 2: Add `resolveHeroId` test to `tests/test-dota-hero-matchups.js`**

Update the require line:
```js
const { getMatchupEdge, _invalidateMatchupCache } = require('../lib/dota-hero-matchups');
```
→
```js
const { getMatchupEdge, resolveHeroId, _invalidateMatchupCache } = require('../lib/dota-hero-matchups');
```
Add these tests just before the final `};` of the module:
```js
  t.test('resolveHeroId resolves an exact name', () => t.assert(resolveHeroId(db, 'Anti-Mage') === 1));
  t.test('resolveHeroId loose-matches', () => t.assert(resolveHeroId(db, 'antimage') === 1));
  t.test('resolveHeroId passes through numeric id', () => t.assert(resolveHeroId(db, 8) === 8));
  t.test('resolveHeroId unknown -> null', () => t.assert(resolveHeroId(db, 'Nope') === null));
```

- [ ] **Step 3: Add `getDraftComposition` to `lib/dota-hero-features.js`**

After `getDraftMatchupFactor` (before `invalidateMetaCache`), add:
```js
/** Cache do meta por nome (roles/attr/wr/pickban) — separado do _metaCache (que filtra pro_pick>0). */
let _compCache = null, _compCacheTs = 0;
function _loadHeroMeta(db) {
  const now = Date.now();
  if (_compCache && (now - _compCacheTs) < CACHE_TTL) return _compCache;
  const m = new Map();
  try {
    const rows = db.prepare(
      'SELECT localized_name, roles, primary_attr, pro_winrate, pro_pickban_rate FROM dota_hero_stats WHERE localized_name IS NOT NULL'
    ).all();
    for (const r of rows) {
      m.set(String(r.localized_name).toLowerCase().trim(), {
        name: r.localized_name,
        roles: r.roles ? String(r.roles).split(',').map(s => s.trim()).filter(Boolean) : [],
        attr: r.primary_attr || null,
        wr: r.pro_winrate != null ? r.pro_winrate : null,
        pickban: r.pro_pickban_rate != null ? r.pro_pickban_rate : null,
      });
    }
  } catch (e) { log('DEBUG', TAG, `comp load err: ${e.message}`); }
  _compCache = m; _compCacheTs = now;
  return m;
}

/**
 * Leitura de composição de um lado a partir do meta de heróis (display-only).
 * @returns {{ known, heroes:[{name,wr,pickban,attr,roles}], roleCounts:{}, attrCounts:{} }}
 */
function getDraftComposition(db, heroes) {
  const meta = _loadHeroMeta(db);
  const out = { known: 0, heroes: [], roleCounts: {}, attrCounts: {} };
  for (const h of (heroes || [])) {
    const entry = meta.get(String(h || '').toLowerCase().trim());
    if (!entry) continue;
    out.known++;
    out.heroes.push({ name: entry.name, wr: entry.wr, pickban: entry.pickban, attr: entry.attr, roles: entry.roles });
    if (entry.attr) out.attrCounts[entry.attr] = (out.attrCounts[entry.attr] || 0) + 1;
    for (const role of entry.roles) out.roleCounts[role] = (out.roleCounts[role] || 0) + 1;
  }
  return out;
}
```
Update `invalidateMetaCache` to also reset the new cache:
```js
function invalidateMetaCache() {
  _metaCache = null;
  _metaCacheTs = 0;
}
```
→
```js
function invalidateMetaCache() {
  _metaCache = null;
  _metaCacheTs = 0;
  _compCache = null;
  _compCacheTs = 0;
}
```
Update the exports to add `getDraftComposition`:
```js
module.exports = {
  getTeamDraftStrength,
  getDraftMatchupFactor,
  invalidateMetaCache,
};
```
→
```js
module.exports = {
  getTeamDraftStrength,
  getDraftMatchupFactor,
  getDraftComposition,
  invalidateMetaCache,
};
```

- [ ] **Step 4: Create `tests/test-dota-draft-composition.js`**

```js
// tests/test-dota-draft-composition.js — getDraftComposition counts roles/attrs from dota_hero_stats.
const Database = require('better-sqlite3');
const { getDraftComposition, invalidateMetaCache } = require('../lib/dota-hero-features');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE dota_hero_stats (hero_id INTEGER PRIMARY KEY, localized_name TEXT, roles TEXT, primary_attr TEXT, pro_winrate REAL, pro_pickban_rate REAL, pub_winrate REAL, pro_pick INTEGER);`);
  const h = db.prepare('INSERT INTO dota_hero_stats (hero_id,localized_name,roles,primary_attr,pro_winrate,pro_pickban_rate) VALUES (?,?,?,?,?,?)');
  h.run(1, 'Anti-Mage', 'Carry,Escape', 'agi', 0.52, 0.30);
  h.run(5, 'Crystal Maiden', 'Support,Disabler,Nuker', 'int', 0.49, 0.20);
  h.run(8, 'Juggernaut', 'Carry,Pusher', 'agi', 0.55, 0.40);
  return db;
}

module.exports = function (t) {
  const db = freshDb();
  invalidateMetaCache();
  const c = getDraftComposition(db, ['Anti-Mage', 'Juggernaut', 'Crystal Maiden']);
  t.test('counts known heroes', () => t.assert(c.known === 3));
  t.test('aggregates roles', () => t.assert(c.roleCounts.Carry === 2 && c.roleCounts.Support === 1));
  t.test('aggregates attrs', () => t.assert(c.attrCounts.agi === 2 && c.attrCounts.int === 1));
  t.test('per-hero meta present', () => { const am = c.heroes.find(x => x.name === 'Anti-Mage'); t.assert(am && Math.abs(am.wr - 0.52) < 1e-9 && am.roles.includes('Carry')); });
  t.test('ignores unknown hero', () => { const c2 = getDraftComposition(db, ['Anti-Mage', 'Nonexistent']); t.assert(c2.known === 1); });
  t.test('empty input -> zero known', () => t.assert(getDraftComposition(db, []).known === 0));
};
```

- [ ] **Step 5: Run tests**

Run: `node tests/run.js`
Expected: `[dota-hero-matchups]` (with new resolveHeroId cases) and `[dota-draft-composition]` green; final `N passed, 0 failed`.

- [ ] **Step 6: Commit**

```bash
git add lib/dota-hero-matchups.js lib/dota-hero-features.js tests/test-dota-hero-matchups.js tests/test-dota-draft-composition.js
git commit -m "feat(dota-lab): resolveHeroId public + getDraftComposition (draft analysis helpers)"
```

---

## Task 2: `lib/dota-draft-analysis.js` orchestrator (TDD)

**Files:** Create `lib/dota-draft-analysis.js`, Test `tests/test-dota-draft-analysis.js`

- [ ] **Step 1: Write the failing test `tests/test-dota-draft-analysis.js`**

```js
// tests/test-dota-draft-analysis.js — computeDotaDraftAnalysis orchestration (db + injected fetcher, no network).
const Database = require('better-sqlite3');
const { computeDotaDraftAnalysis } = require('../lib/dota-draft-analysis');
const { _invalidateMatchupCache } = require('../lib/dota-hero-matchups');
const { invalidateMetaCache } = require('../lib/dota-hero-features');
const { _invalidateProCache, normalizeProNick } = require('../lib/dota-player-heroes');
const { _invalidateHeroCache } = require('../lib/dota-draft-parse');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dota_hero_stats (hero_id INTEGER PRIMARY KEY, localized_name TEXT, roles TEXT, primary_attr TEXT, pro_winrate REAL, pro_pickban_rate REAL, pub_winrate REAL, pro_pick INTEGER);
    CREATE TABLE dota_hero_matchups (hero_id INTEGER, vs_hero_id INTEGER, games INTEGER, wins INTEGER, wr REAL, updated_at TEXT, PRIMARY KEY(hero_id,vs_hero_id));
    CREATE TABLE dota_pro_players (account_id INTEGER PRIMARY KEY, name TEXT, name_norm TEXT, team_name TEXT, updated_at TEXT);
    CREATE TABLE dota_player_hero_stats (account_id INTEGER, hero_id INTEGER, games INTEGER, wins INTEGER, wr REAL, last_played INTEGER, fetched_at TEXT, PRIMARY KEY(account_id,hero_id));
  `);
  const h = db.prepare('INSERT INTO dota_hero_stats (hero_id,localized_name,roles,primary_attr,pro_winrate,pro_pickban_rate,pro_pick) VALUES (?,?,?,?,?,?,?)');
  h.run(1, 'Anti-Mage', 'Carry,Escape', 'agi', 0.52, 0.30, 50);
  h.run(5, 'Crystal Maiden', 'Support,Disabler', 'int', 0.49, 0.20, 50);
  h.run(8, 'Juggernaut', 'Carry', 'agi', 0.55, 0.40, 50);
  const m = db.prepare('INSERT INTO dota_hero_matchups VALUES (?,?,?,?,?,?)');
  m.run(1, 5, 100, 60, 0.60, null);  // AM strong vs CM
  m.run(1, 8, 100, 42, 0.42, null);  // AM weak vs Jugg
  db.prepare('INSERT INTO dota_pro_players VALUES (?,?,?,?,?)').run(201358612, 'Nisha', normalizeProNick('Nisha'), 'Team Liquid', new Date().toISOString());
  return db;
}

module.exports = async function (t) {
  const db = freshDb();
  _invalidateMatchupCache(); invalidateMetaCache(); _invalidateProCache(); _invalidateHeroCache();

  const fetcher = async () => [{ hero_id: 1, games: 80, win: 52, last_played: 1 }, { hero_id: 8, games: 40, win: 20, last_played: 1 }];
  const out = await computeDotaDraftAnalysis(db,
    { blue: ['Anti-Mage'], red: ['Crystal Maiden', 'Juggernaut'], players: { blue: ['Nisha'], red: [] } },
    { fetcher });

  t.test('matchup edge sums pairs', () => t.assert(Math.abs(out.matchupEdge.blueAdvantagePp - 2.0) < 0.05 && out.matchupEdge.sampled === 2));
  t.test('matchup pairs carry hero names', () => t.assert(out.matchupEdge.pairs[0].blueName === 'Anti-Mage'));
  t.test('composition counts roles', () => t.assert(out.composition.red.roleCounts.Carry === 1 && out.composition.red.roleCounts.Support === 1));
  t.test('player resolved with onHero (Nisha on Anti-Mage)', () => {
    const p = out.playerHeroes.blue[0];
    t.assert(p.resolved && p.player === 'Nisha' && p.onHero && Math.abs(p.onHero.wr - 0.65) < 1e-9);
  });
  t.test('player top heroes are named', () => t.assert(out.playerHeroes.blue[0].top[0].hero === 'Anti-Mage'));
  // getTeamDraftStrength returns null with <3 heroes a side; blue here has 1 hero -> draftStrength null (correct).
  t.test('draftStrength null with <3 heroes a side', () => t.assert(out.draftStrength === null));
};
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/run.js` → `[dota-draft-analysis]` errors (module not found).

- [ ] **Step 3: Implement `lib/dota-draft-analysis.js`**

```js
'use strict';
/**
 * dota-draft-analysis.js — Display-only orchestrator for the Dota Lab "Analisar draft".
 * Combines meta draft strength + counter edge + per-player hero WR + composition.
 * No stake/EV/bet. Shared by /api/dota-draft-analyze and /api/dota-draft-explain.
 */
const { getDraftMatchupFactor, getDraftComposition } = require('./dota-hero-features');
const { getMatchupEdge, resolveHeroId } = require('./dota-hero-matchups');
const { resolveProPlayer, getPlayerHeroStats } = require('./dota-player-heroes');

async function computeDotaDraftAnalysis(db, { blue = [], red = [], players = {} } = {}, { fetcher } = {}) {
  const heroNameById = new Map();
  try { for (const r of db.prepare('SELECT hero_id, localized_name FROM dota_hero_stats').all()) heroNameById.set(r.hero_id, r.localized_name); } catch (_) {}
  const nameOf = (id) => heroNameById.get(id) || ('#' + id);

  const draftStrength = getDraftMatchupFactor(db, blue, red); // {factor,blueWR,redWR,detail} | null
  const matchupEdge = getMatchupEdge(db, blue, red);
  matchupEdge.pairs = matchupEdge.pairs.map(p => ({ ...p, blueName: nameOf(p.blue), redName: nameOf(p.red) }));
  const composition = { blue: getDraftComposition(db, blue), red: getDraftComposition(db, red) };

  async function sidePlayers(heroes, nicks) {
    const out = [];
    const list = Array.isArray(nicks) ? nicks : [];
    for (let i = 0; i < heroes.length; i++) {
      const nick = String(list[i] || '').trim();
      if (!nick) continue;
      const pro = resolveProPlayer(db, nick);
      if (!pro) { out.push({ nick, resolved: false }); continue; }
      let onHero = null, top = [];
      try {
        const hs = await getPlayerHeroStats(db, pro.account_id, fetcher ? { fetcher } : {});
        const hid = resolveHeroId(db, heroes[i]);
        if (hid) { const f = hs.find(x => x.hero_id === hid); if (f) onHero = { wr: f.wr, games: f.games }; }
        top = hs.slice(0, 3).map(x => ({ hero: nameOf(x.hero_id), wr: x.wr, games: x.games }));
      } catch (_) { /* display-only: a fetch failure leaves this player without data */ }
      out.push({ nick, resolved: true, player: pro.name, team: pro.team_name, hero: heroes[i], onHero, top });
    }
    return out;
  }
  const playerHeroes = { blue: await sidePlayers(blue, players.blue), red: await sidePlayers(red, players.red) };

  return { draftStrength, matchupEdge, playerHeroes, composition };
}
module.exports = { computeDotaDraftAnalysis };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node tests/run.js` → `[dota-draft-analysis]` green; final `N passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add lib/dota-draft-analysis.js tests/test-dota-draft-analysis.js
git commit -m "feat(dota-lab): computeDotaDraftAnalysis orchestrator (meta+counters+player×hero+composition)"
```

---

## Task 3: `lib/dota-draft-explain.js` (IA prompt + parse) — TDD

**Files:** Create `lib/dota-draft-explain.js`, Test `tests/test-dota-draft-explain.js`

- [ ] **Step 1: Write the failing test `tests/test-dota-draft-explain.js`**

```js
// tests/test-dota-draft-explain.js — Dota draft AI prompt (anchored on objective numbers) + parser.
const { buildDotaDraftPrompt, parseDotaDraftExplain } = require('../lib/dota-draft-explain');

module.exports = function (t) {
  const data = {
    teams: { blue: 'Team A', red: 'Team B' },
    draft: { blue: ['Anti-Mage'], red: ['Crystal Maiden'] },
    matchupEdge: { blueAdvantagePp: 10, sampled: 1, pairs: [{ blueName: 'Anti-Mage', redName: 'Crystal Maiden', advPp: 10, games: 100 }] },
    playerHeroes: { blue: [{ resolved: true, player: 'Nisha', hero: 'Anti-Mage', onHero: { wr: 0.65, games: 80 } }], red: [] },
    composition: { blue: { roleCounts: { Carry: 1 }, attrCounts: { agi: 1 } }, red: { roleCounts: { Support: 1 }, attrCounts: { int: 1 } } },
  };

  const p = buildDotaDraftPrompt(data);
  t.test('prompt is a non-empty string', () => t.assert(typeof p === 'string' && p.length > 200));
  t.test('prompt includes the objective numbers', () => t.assert(p.includes('Anti-Mage') && p.includes('Nisha') && p.includes('matchup')));
  t.test('prompt asks for the 4-key JSON', () => t.assert(p.includes('overview') && p.includes('matchups') && p.includes('keyPlayers') && p.includes('verdict')));
  t.test('prompt forbids inventing probability/stake', () => t.assert(/probabilidade|aposte|stake/i.test(p)));

  t.test('parse extracts 4 keys', () => {
    const r = parseDotaDraftExplain('lixo {"overview":"o","matchups":"m","keyPlayers":"k","verdict":"v"} fim');
    t.assert(r && r.overview === 'o' && r.matchups === 'm' && r.keyPlayers === 'k' && r.verdict === 'v');
  });
  t.test('parse returns null on no json', () => t.assert(parseDotaDraftExplain('sem json') === null));
  t.test('parse returns null when no known key', () => t.assert(parseDotaDraftExplain('{"foo":"bar"}') === null));
};
```

- [ ] **Step 2: Run to verify it fails** — `node tests/run.js` → `[dota-draft-explain]` module not found.

- [ ] **Step 3: Implement `lib/dota-draft-explain.js`**

```js
'use strict';
/**
 * dota-draft-explain.js — Display-only Dota draft AI reading, ANCHORED on the objective numbers
 * (counter edge, player×hero WR, composition) computed by dota-draft-analysis. The model interprets
 * those + adds its own Dota knowledge (synergies/timings). No win-probability, no stake advice.
 */
const KEYS = ['overview', 'matchups', 'keyPlayers', 'verdict'];

function _fmtPlayers(side) {
  return (side || []).filter(p => p && p.resolved).map(p => {
    const on = p.onHero ? `${(p.onHero.wr * 100).toFixed(0)}% em ${p.games || p.onHero.games} jogos` : 'sem histórico no herói';
    return `${p.player || p.nick} (${p.hero}): ${on}`;
  }).join('; ');
}
function _fmtComp(c) {
  if (!c) return '(sem dados)';
  const roles = Object.entries(c.roleCounts || {}).map(([k, v]) => `${k} ${v}`).join(', ');
  const attrs = Object.entries(c.attrCounts || {}).map(([k, v]) => `${k} ${v}`).join('/');
  return `roles: ${roles || '—'}; atributos: ${attrs || '—'}`;
}

function buildDotaDraftPrompt({ teams, draft, matchupEdge, playerHeroes, composition }) {
  const t = teams || {};
  const d = draft || {};
  const lines = [];
  lines.push('Dados objetivos de um draft de Dota 2 (display-only — NÃO são apostas):');
  lines.push(`- Times: Azul=${t.blue || '(n/d)'}, Vermelho=${t.red || '(n/d)'}`);
  lines.push(`- Heróis Azul: ${(d.blue || []).join(', ') || '(n/d)'}`);
  lines.push(`- Heróis Vermelho: ${(d.red || []).join(', ') || '(n/d)'}`);
  if (matchupEdge) {
    lines.push(`- Counter edge (vantagem de matchup, dado): Azul ${matchupEdge.blueAdvantagePp >= 0 ? '+' : ''}${matchupEdge.blueAdvantagePp}pp em ${matchupEdge.sampled} confrontos com amostra`);
    for (const p of (matchupEdge.pairs || []).slice(0, 5)) lines.push(`  · ${p.blueName} vs ${p.redName}: ${p.advPp >= 0 ? '+' : ''}${p.advPp}pp (n=${p.games})`);
  }
  lines.push(`- WR jogador×herói (dado) — Azul: ${_fmtPlayers(playerHeroes && playerHeroes.blue) || '(n/d)'}`);
  lines.push(`- WR jogador×herói (dado) — Vermelho: ${_fmtPlayers(playerHeroes && playerHeroes.red) || '(n/d)'}`);
  lines.push(`- Composição Azul — ${_fmtComp(composition && composition.blue)}`);
  lines.push(`- Composição Vermelho — ${_fmtComp(composition && composition.red)}`);
  lines.push('');
  lines.push('Você é um analista de Dota 2. INTERPRETE os números acima (counter edge, WR jogador×herói, composição) e complemente com o seu conhecimento dos heróis (sinergias, counters, win conditions, power spikes, timings).');
  lines.push('Responda APENAS um JSON compacto, nada fora dele, em PT-BR:');
  lines.push('{"overview":"…","matchups":"…","keyPlayers":"…","verdict":"…"}');
  lines.push('Regras: cada campo 1-2 frases; matchups = leitura dos counters; keyPlayers = quem decide (apoie-se nos WR jogador×herói); verdict = síntese. NÃO invente probabilidade de vitória, NÃO recomende stake nem diga "aposte". A leitura de meta/sinergia é conhecimento geral (pode não refletir o patch atual).');
  return lines.join('\n');
}

function parseDotaDraftExplain(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj; try { obj = JSON.parse(m[0]); } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (!KEYS.some(k => typeof obj[k] === 'string' && obj[k].trim())) return null;
  const out = {}; for (const k of KEYS) out[k] = (typeof obj[k] === 'string') ? obj[k] : '';
  return out;
}
module.exports = { buildDotaDraftPrompt, parseDotaDraftExplain };
```

- [ ] **Step 4: Run to verify it passes** — `node tests/run.js` → `[dota-draft-explain]` green; `N passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add lib/dota-draft-explain.js tests/test-dota-draft-explain.js
git commit -m "feat(dota-lab): dota-draft-explain (AI prompt anchored on objective draft numbers)"
```

---

## Task 4: Endpoints `/api/dota-draft-analyze` + `/api/dota-draft-explain` (server.js)

**Files:** Modify `server.js` (insert after the `/api/dota-draft-parse-print` handler, ~line 5581)

- [ ] **Step 1: Insert both handlers**

The `/api/dota-draft-parse-print` handler (added in the print-parse feature, ~line 5532) ends with `    }, 2000000);` then `    return;` then `  }`, and is immediately followed by the comment `// Match Lab — AI match reading (display-only)`. Insert the two new handlers in that gap — after the parse-print handler's closing `}` and before the `// Match Lab` comment, at the same 2-space indentation as the other `if (p === '/api/...')` handlers:

```js
  // Dota Lab — "Analisar draft": counters + WR jogador×herói + força meta + composição. Display-only.
  if (p === '/api/dota-draft-analyze' && req.method === 'POST') {
    _readPostBody(req, res, async (body) => {
      if (body == null) return;
      try {
        const json = safeParse(body, null);
        const blue = Array.isArray(json?.blue) ? json.blue.slice(0, 5) : [];
        const red = Array.isArray(json?.red) ? json.red.slice(0, 5) : [];
        if (!blue.length && !red.length) { sendJson(res, { ok: false, error: 'blue/red required' }, 400); return; }
        const players = (json && typeof json.players === 'object' && json.players) ? json.players : {};
        const { computeDotaDraftAnalysis } = require('./lib/dota-draft-analysis');
        const out = await computeDotaDraftAnalysis(db, { blue, red, players });
        sendJson(res, { ok: true, ...out });
      } catch (e) { log('WARN', 'DOTA-LAB', `draft-analyze err: ${e.message}`); sendJson(res, { ok: false, error: 'dota_draft_analyze_failed' }, 500); }
    });
    return;
  }

  // Dota Lab — "Analisar draft" AI reading (Sonnet, anchored on the objective numbers). Display-only.
  if (p === '/api/dota-draft-explain' && req.method === 'POST') {
    _readPostBody(req, res, async (body) => {
      if (body == null) return;
      try {
        const KEY = process.env.ANTHROPIC_API_KEY;
        if (!KEY) { sendJson(res, { ok: false, error: 'vision_disabled' }, 503); return; }
        const json = safeParse(body, null);
        const blue = Array.isArray(json?.blue) ? json.blue.slice(0, 5) : [];
        const red = Array.isArray(json?.red) ? json.red.slice(0, 5) : [];
        if (!blue.length && !red.length) { sendJson(res, { ok: false, error: 'empty_draft' }, 400); return; }
        const players = (json && typeof json.players === 'object' && json.players) ? json.players : {};
        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
        const cap = parseInt(process.env.AI_ANALYSIS_DAILY_CAP || '30', 10);
        const _amap = (global._aiAnalysisDayMap = global._aiAnalysisDayMap || new Map());
        const dayKey = `${ip}|${new Date().toISOString().slice(0, 10)}`;
        const usedN = _amap.get(dayKey) || 0;
        if (usedN >= cap) { sendJson(res, { ok: false, error: 'daily_cap_reached', cap }, 429); return; }
        _amap.set(dayKey, usedN + 1);
        const { computeDotaDraftAnalysis } = require('./lib/dota-draft-analysis');
        const { buildDotaDraftPrompt, parseDotaDraftExplain } = require('./lib/dota-draft-explain');
        const data = await computeDotaDraftAnalysis(db, { blue, red, players });
        const teams = { blue: json?.team1 || null, red: json?.team2 || null };
        const prompt = buildDotaDraftPrompt({ teams, draft: { blue, red }, matchupEdge: data.matchupEdge, playerHeroes: data.playerHeroes, composition: data.composition });
        const model = process.env.AI_ANALYSIS_MODEL || 'claude-sonnet-4-5';
        const r = await aiPost('anthropic', 'https://api.anthropic.com/v1/messages',
          { model, max_tokens: 700, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] },
          { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' }, { timeoutMs: 30000, retry: { maxAttempts: 2 } });
        try { stmts.incrApiUsage.run('anthropic', new Date().toISOString().slice(0, 7)); } catch (_) {}
        const rj = r ? safeParse(r.body, {}) : {};
        const text = (rj?.content || []).map(c => c.text || '').join('');
        const analysis = parseDotaDraftExplain(text);
        if (analysis) sendJson(res, { ok: true, analysis });
        else if (text && text.trim()) sendJson(res, { ok: true, analysis: null, raw: text.slice(0, 1200) });
        else sendJson(res, { ok: false, error: 'ai_failed' }, 500);
      } catch (e) { log('WARN', 'DOTA-LAB', `draft-explain err: ${e.message}`); sendJson(res, { ok: false, error: 'ai_failed' }, 500); }
    });
    return;
  }
```

- [ ] **Step 2: Verify syntax** — `node -c server.js` → exit 0.

- [ ] **Step 3: Confirm prior Dota handlers unchanged** — `git diff server.js` shows only the added block (no `-` lines).

- [ ] **Step 4: Run suite** — `node tests/run.js` → `N passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(dota-lab): /api/dota-draft-analyze + /api/dota-draft-explain endpoints"
```

## Notes for Task 4
- `_readPostBody`, `sendJson`, `safeParse`, `aiPost`, `stmts`, `log`, `db` are in scope (neighboring `/api/dota-*` handlers use them). Don't add requires for them.
- The explain endpoint recomputes the analysis server-side (doesn't trust the client) and reuses the existing `_aiAnalysisDayMap` cap shared with `/api/dota-match-explain`.

---

## Task 5: Front-end — "Analisar draft" button + render (`public/lol-live-dashboard.html`)

**Files:** Modify `public/lol-live-dashboard.html`

- [ ] **Step 1: Add the "Analisar draft" button**

Find (in the `#dotaLab` actions):
```html
    <div class="dl-actions">
      <button class="btn primary" id="dotaAnalyzeBtn">Analisar partida</button>
      <label class="btn" style="cursor:pointer; text-align:center;">
```
Replace with (add the second button after the first):
```html
    <div class="dl-actions">
      <button class="btn primary" id="dotaAnalyzeBtn">Analisar partida</button>
      <button class="btn" id="dotaAnalyzeDraftBtn">Analisar draft</button>
      <label class="btn" style="cursor:pointer; text-align:center;">
```

- [ ] **Step 2: Wire the button + collector in `initDotaLab`**

Find:
```js
  document.getElementById('dotaAnalyzeBtn').addEventListener('click', dotaAnalyze);
})();
```
Replace with:
```js
  document.getElementById('dotaAnalyzeBtn').addEventListener('click', dotaAnalyze);
  document.getElementById('dotaAnalyzeDraftBtn').addEventListener('click', dotaAnalyzeDraft);
})();
```

- [ ] **Step 3: Add the draft functions after `dotaExplain`**

Find the end of `dotaExplain` (ends with `  finally { btn.disabled = false; btn.textContent = old; }\n}`) and insert AFTER it (before `function dotaSetPrintMsg`):

```js

// "Analisar draft": collects heroes + players aligned per slot.
function dotaCollectDraft() {
  const side = (id) => {
    const slots = [...document.getElementById(id).querySelectorAll('.dota-slot')];
    const heroes = [], players = [];
    for (const s of slots) {
      const h = (s.querySelector('.dota-hero')?.value || '').trim();
      const p = (s.querySelector('.dota-player')?.value || '').trim();
      if (h) { heroes.push(h); players.push(p); }
    }
    return { heroes, players };
  };
  const b = side('dotaBlueHeroes'), r = side('dotaRedHeroes');
  return {
    team1: (document.getElementById('dota_blueTeam').value || '').trim() || null,
    team2: (document.getElementById('dota_redTeam').value || '').trim() || null,
    blue: b.heroes, red: r.heroes, players: { blue: b.players, red: r.players },
  };
}

async function dotaAnalyzeDraft() {
  const c = dotaCollectDraft();
  if (!c.blue.length && !c.red.length) { document.getElementById('dotaResult').textContent = 'Informe os heróis dos dois lados.'; return; }
  const root = document.getElementById('dotaResult'); root.innerHTML = 'analisando draft…';
  try {
    const r = await fetch('/api/dota-draft-analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c) });
    const d = await r.json();
    if (!d.ok) { root.textContent = 'Falha na análise.'; return; }
    dotaRenderDraft(root, d, c);
  } catch (e) { root.textContent = 'Falha: ' + e.message; }
}

function dotaRenderDraft(root, d, c) {
  root.innerHTML = '';
  // Força de draft (meta)
  if (d.draftStrength) root.appendChild(el('div', { class: 'dl-gp-row' }, `Força de draft (WR meta): azul ${(d.draftStrength.blueWR * 100).toFixed(1)}% vs vermelho ${(d.draftStrength.redWR * 100).toFixed(1)}%`));
  // Counters
  const me = d.matchupEdge || { pairs: [], sampled: 0, blueAdvantagePp: 0 };
  root.appendChild(el('div', { class: 'dl-gp-row' }, `Vantagem de matchup (azul): ${me.blueAdvantagePp >= 0 ? '+' : ''}${me.blueAdvantagePp}pp · ${me.sampled} confrontos com dado`));
  for (const p of (me.pairs || []).slice(0, 5)) root.appendChild(el('div', { class: 'dl-gp-note' }, `${p.blueName} vs ${p.redName}: ${p.advPp >= 0 ? '+' : ''}${p.advPp}pp (n=${p.games})`));
  // WR jogador×herói
  const fmtP = (arr, label) => {
    const rows = (arr || []).filter(p => p.resolved);
    if (!rows.length) return;
    root.appendChild(el('div', { class: 'dl-gp-row' }, `WR jogador×herói — ${label}:`));
    for (const p of rows) {
      const on = p.onHero ? `${(p.onHero.wr * 100).toFixed(0)}% (n=${p.onHero.games})` : 'sem histórico no herói';
      const top = (p.top || []).map(h => `${h.hero} ${(h.wr * 100).toFixed(0)}%`).join(', ');
      root.appendChild(el('div', { class: 'dl-gp-note' }, `${p.player} — ${p.hero}: ${on}${top ? '  ·  top: ' + top : ''}`));
    }
  };
  fmtP(d.playerHeroes && d.playerHeroes.blue, c.team1 || 'Azul');
  fmtP(d.playerHeroes && d.playerHeroes.red, c.team2 || 'Vermelho');
  // Composição
  const fmtC = (comp, label) => {
    if (!comp) return;
    const roles = Object.entries(comp.roleCounts || {}).map(([k, v]) => `${k} ${v}`).join(', ');
    const attrs = Object.entries(comp.attrCounts || {}).map(([k, v]) => `${k} ${v}`).join('/');
    root.appendChild(el('div', { class: 'dl-gp-note' }, `Composição ${label}: ${roles || '—'}${attrs ? '  ·  ' + attrs : ''}`));
  };
  fmtC(d.composition && d.composition.blue, c.team1 || 'Azul');
  fmtC(d.composition && d.composition.red, c.team2 || 'Vermelho');
  // IA
  const aiOut = el('div', { class: 'dl-ai-out' });
  const aiBtn = el('button', { class: 'dl-ai-btn' }, '🤖 Análise da IA');
  aiBtn.addEventListener('click', () => dotaExplainDraft(aiBtn, aiOut, c));
  root.appendChild(el('div', { class: 'dl-gp-ai' }, aiBtn, aiOut));
  root.appendChild(el('div', { class: 'dl-gp-warn' }, '⚠ leitura de draft — não é probabilidade de vitória nem sinal de aposta'));
}

async function dotaExplainDraft(btn, outEl, c) {
  const old = btn.textContent; btn.disabled = true; btn.textContent = 'analisando…'; outEl.innerHTML = '';
  try {
    const r = await fetch('/api/dota-draft-explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c) });
    const d = await r.json();
    if (!d.ok) { outEl.textContent = d.error === 'daily_cap_reached' ? 'Limite diário atingido.' : d.error === 'vision_disabled' ? 'IA indisponível.' : 'Falha.'; return; }
    if (d.analysis) { [['VISÃO', d.analysis.overview], ['MATCHUPS', d.analysis.matchups], ['JOGADORES-CHAVE', d.analysis.keyPlayers], ['VEREDITO', d.analysis.verdict]].forEach(([k, v]) => { if (v) outEl.appendChild(el('div', { class: 'dl-ai-row' }, el('span', { class: 'dl-ai-k' }, k), el('span', {}, v))); }); }
    else if (d.raw) outEl.appendChild(el('div', { class: 'dl-ai-raw' }, d.raw));
    outEl.appendChild(el('div', { class: 'dl-gp-warn' }, '⚠ leitura da IA — não é sinal de aposta'));
  } catch (e) { outEl.textContent = 'Falha: ' + e.message; }
  finally { btn.disabled = false; btn.textContent = old; }
}
```

- [ ] **Step 4: Verify markers + suite**

Run (PowerShell):
```powershell
Select-String -Path public/lol-live-dashboard.html -Pattern 'dotaAnalyzeDraftBtn','dotaCollectDraft','dotaRenderDraft','dotaExplainDraft' | Select-Object -ExpandProperty Pattern -Unique
node tests/run.js
```
Expected: all 4 patterns present; `N passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add public/lol-live-dashboard.html
git commit -m "feat(dota-lab): Analisar draft button + render (counters/player×hero/composition/AI)"
```

---

## Task 6: Final verification (money-path + seeded end-to-end + suite)

**Files:** none (verification only)

- [ ] **Step 1: Money-path airtight grep** (PowerShell)
```powershell
Select-String -Path bot.js,lib/scanner.js,lib/market-tip-processor.js,lib/dota-map-model.js -Pattern 'dota-draft-analyze','dota-draft-explain','dota-draft-analysis','getDraftComposition','resolveHeroId' -List
```
Expected: **no matches**. If any match, STOP — display-only breached.

- [ ] **Step 2: Apply migration + seed the same demo rows as Phase 1 verify, then probe the analyze path**

Create `_seed_v2.js` (seed pro player + matchups + per-hero meta + player cache, then call the orchestrator directly with a stubbed fetcher so no network is needed):
```js
const init = require('./lib/database');
const { normalizeProNick, _invalidateProCache } = require('./lib/dota-player-heroes');
const { _invalidateMatchupCache } = require('./lib/dota-hero-matchups');
const { invalidateMetaCache } = require('./lib/dota-hero-features');
const { _invalidateHeroCache } = require('./lib/dota-draft-parse');
const { computeDotaDraftAnalysis } = require('./lib/dota-draft-analysis');
const { db } = init('sportsedge.db');
const now = new Date().toISOString();
db.prepare(`INSERT INTO dota_pro_players (account_id,name,name_norm,team_name,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET name_norm=excluded.name_norm`).run(201358612,'Nisha',normalizeProNick('Nisha'),'Team Liquid',now);
const mu = db.prepare(`INSERT INTO dota_hero_matchups (hero_id,vs_hero_id,games,wins,wr,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(hero_id,vs_hero_id) DO UPDATE SET wr=excluded.wr,games=excluded.games`);
mu.run(1,5,100,60,0.60,now); mu.run(1,8,100,42,0.42,now);
_invalidateProCache(); _invalidateMatchupCache(); invalidateMetaCache(); _invalidateHeroCache();
(async () => {
  const out = await computeDotaDraftAnalysis(db, { blue:['Anti-Mage'], red:['Crystal Maiden','Juggernaut'], players:{ blue:['Nisha'], red:[] } }, { fetcher: async () => [{hero_id:1,games:80,win:52},{hero_id:8,games:40,win:20}] });
  console.log('edge', out.matchupEdge.blueAdvantagePp, 'sampled', out.matchupEdge.sampled);
  console.log('player', JSON.stringify(out.playerHeroes.blue[0]));
  console.log('comp.red.roleCounts', JSON.stringify(out.composition.red.roleCounts));
  // cleanup demo rows
  db.prepare('DELETE FROM dota_pro_players WHERE account_id=201358612').run();
  db.prepare('DELETE FROM dota_hero_matchups WHERE hero_id=1').run();
  db.close();
})();
```
Run: `node _seed_v2.js && rm -f _seed_v2.js`
Expected: `edge 2 sampled 2`; `player` shows `Nisha` with `onHero` wr≈0.65 and top heroes **named** (Anti-Mage…); `comp.red.roleCounts` has Carry/Support. (Requires `dota_hero_stats` populated — it has the 127 real heroes locally, with roles/attr.)

- [ ] **Step 3: Full suite + syntax** — `node -c server.js; node tests/run.js` → syntax OK; `N passed, 0 failed`.

(No commit — verification only.)

---

## Notes for the implementer
- **No new npm dep, no migration, no new env** (reuses `ANTHROPIC_API_KEY`/`AI_ANALYSIS_*`).
- **Display-only:** the orchestrator + endpoints feed only the dashboard. Never import them from the scanner/market-tip-processor/dota-map-model.
- Tests use `better-sqlite3` `:memory:` + injected `fetcher` (no network). Module-level caches in the reused libs (`normalizeHeroName`, matchup, pro, comp) must be invalidated at the top of each suite that swaps the db — the test stubs already do this.
- **P5/P4:** `resolveHeroId` is promoted (not duplicated); the orchestrator centralizes the analysis so the two endpoints don't repeat it.
