# Dota Lab Print-Parse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar ao Dota Lab a opção de colar/enviar um print do draft (ou scoreboard) e lê-lo com IA (Claude Sonnet vision), pré-preenchendo times + heróis + jogadores — espelhando o print-parse do Draft Lab de LoL. Display-only.

**Architecture:** Abordagem B (spec). Lib puro novo (`lib/dota-draft-parse.js`) com o prompt de vision + normalizador de herói; endpoint novo `/api/dota-draft-parse-print` espelhando o esqueleto do endpoint LoL e compartilhando o cap de vision; front-end no `#dotaLab` reusando o downscale/upscale e o paste já existentes. Nada toca o money-path nem o path LoL.

**Tech Stack:** Node 18 (http nativo), better-sqlite3, Claude Anthropic vision API (`aiPost`), HTML/JS vanilla. Test runner caseiro (`tests/run.js`, auto-discovery de `tests/test-*.js`, API `t.test`/`t.assert`).

---

## File Structure

- **Create** `lib/dota-draft-parse.js` — prompt de vision Dota (`buildDotaPrintPrompt`) + normalizador de herói (`normalizeHeroName`) + invalidação de cache (`_invalidateHeroCache`). Funções puras; única dependência é leitura de `dota_hero_stats` via `db`.
- **Create** `tests/test-dota-draft-parse.js` — testes unitários do lib (auto-descoberto pelo runner).
- **Modify** `server.js` — inserir o endpoint `POST /api/dota-draft-parse-print` logo após `/api/dota-match-explain` (~linha 5526).
- **Modify** `public/lol-live-dashboard.html` — CSS `.dota-slot`; markup de print no `#dotaLab`; `initDotaLab` com slots herói+jogador; helpers + `dotaSubmitPrintFile`/`dotaParsePrint`; roteamento do paste listener.

---

## Task 1: `lib/dota-draft-parse.js` — prompt + normalizador de herói (TDD)

**Files:**
- Create: `lib/dota-draft-parse.js`
- Test: `tests/test-dota-draft-parse.js`

- [ ] **Step 1: Write the failing test**

Create `tests/test-dota-draft-parse.js`:

```js
// tests/test-dota-draft-parse.js — Dota Lab print-parse: hero-name normalizer + vision prompt.
const { buildDotaPrintPrompt, normalizeHeroName, _invalidateHeroCache } = require('../lib/dota-draft-parse');

// Stub db: db.prepare(sql).all() returns rows with localized_name.
const HEROES = ['Anti-Mage', "Nature's Prophet", 'Queen of Pain', 'Outworld Destroyer', 'Pudge'];
const db = { prepare: () => ({ all: () => HEROES.map(n => ({ localized_name: n })) }) };

module.exports = function (t) {
  _invalidateHeroCache(); // module-level cache: reset before using our stub db

  // normalizeHeroName
  t.test('exact match returns canonical', () => t.assert(normalizeHeroName(db, 'Anti-Mage') === 'Anti-Mage'));
  t.test('case-insensitive exact match', () => t.assert(normalizeHeroName(db, 'anti-mage') === 'Anti-Mage'));
  t.test('loose match drops hyphen', () => t.assert(normalizeHeroName(db, 'antimage') === 'Anti-Mage'));
  t.test('loose match space-for-hyphen', () => t.assert(normalizeHeroName(db, 'anti mage') === 'Anti-Mage'));
  t.test('loose match drops apostrophe', () => t.assert(normalizeHeroName(db, 'natures prophet') === "Nature's Prophet"));
  t.test('trims surrounding whitespace', () => t.assert(normalizeHeroName(db, '  Pudge  ') === 'Pudge'));
  t.test('nickname not matched -> null', () => t.assert(normalizeHeroName(db, 'QoP') === null));
  t.test('old alias not matched -> null', () => t.assert(normalizeHeroName(db, 'Furion') === null));
  t.test('empty string -> null', () => t.assert(normalizeHeroName(db, '') === null));
  t.test('null -> null', () => t.assert(normalizeHeroName(db, null) === null));

  // buildDotaPrintPrompt
  t.test('prompt is a non-empty string', () => t.assert(typeof buildDotaPrintPrompt() === 'string' && buildDotaPrintPrompt().length > 200));
  t.test('prompt maps Radiant->blue / Dire->red', () => { const s = buildDotaPrintPrompt(); t.assert(s.includes('Radiant') && s.includes('Dire')); });
  t.test('prompt requests hero/player/teams JSON', () => { const s = buildDotaPrintPrompt(); t.assert(s.includes('"hero"') && s.includes('"player"') && s.includes('"teams"') && s.includes('JSON')); });
};
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/run.js`
Expected: FAIL — `Cannot find module '../lib/dota-draft-parse'` (suite crashes / the `dota-draft-parse` section errors).

- [ ] **Step 3: Write minimal implementation**

Create `lib/dota-draft-parse.js`:

```js
'use strict';
/**
 * dota-draft-parse.js — Display-only helpers for the Dota Lab print-parse (vision OCR).
 * Pure vision prompt + hero-name normalizer. No HTTP/stake/EV — display-only by construction.
 * Mirrors the role of lib/lol-champions.js (normalizeChampion) for the Dota domain.
 */

// Vision prompt: a Dota 2 draft (pick screen) OR an in-game scoreboard.
const PROMPT =
  'This image is a Dota 2 draft (hero pick screen) OR a live in-game scoreboard. '
  + 'Return ONLY compact JSON, no prose: '
  + '{"teams":{"blue":"<team name or null>","red":"<team name or null>"},"blue":[{"hero":"<name>","player":"<player name or null>"}],"red":[...]} '
  + 'with exactly 5 entries per team. '
  + 'The Radiant team is "blue"; the Dire team is "red". On a scoreboard, Radiant is the top/left (green) side and Dire is the bottom/right (red) side; in a pick screen Radiant is on the left. '
  + 'For "teams", read the team names from a broadcast/tournament overlay or the scoreboard header (one per side); use null if not shown. '
  + 'Identify each hero from its portrait icon AND its name text. Use the official English Dota 2 hero name '
  + '(e.g. "Anti-Mage", "Nature\'s Prophet", "Queen of Pain", "Outworld Destroyer"); never use nicknames or abbreviations '
  + '(not "AM", "QoP", "Furion", "Wisp") and never guess a hero from a position/lane. '
  + 'For "player": each scoreboard row has TWO separate texts — the hero name AND the human player handle (a person nickname, '
  + 'often with a short team tag, e.g. "Tundra.Nine", "OG ATF"). Put that handle in "player"; it is NOT the hero name — '
  + 'never copy the hero name into "player". If no separate human handle is visible, use null. '
  + 'CRITICAL: read all text exactly as shown — never translate or invent a team, player, or hero name. '
  + 'If any single value is not clearly legible, use null for that value instead of guessing.';

function buildDotaPrintPrompt() {
  return PROMPT;
}

// Hero-name lookup cache (~30min, same pattern as dota-hero-features). Keyed module-level,
// not per-db; prod has a single db. Tests call _invalidateHeroCache() before swapping the stub.
const CACHE_TTL = 30 * 60 * 1000;
let _cache = null; // { exact: Map<lowerName, canonical>, loose: Map<looseKey, canonical|null> }
let _cacheTs = 0;

function _looseKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function _load(db) {
  const now = Date.now();
  if (_cache && (now - _cacheTs) < CACHE_TTL) return _cache;
  const exact = new Map();
  const loose = new Map();
  try {
    const rows = db.prepare(
      "SELECT DISTINCT localized_name FROM dota_hero_stats WHERE localized_name IS NOT NULL AND localized_name != ''"
    ).all();
    for (const r of rows) {
      const name = r.localized_name;
      const ex = String(name).toLowerCase().trim();
      if (!ex) continue;
      if (!exact.has(ex)) exact.set(ex, name);
      const lk = _looseKey(name);
      if (!lk) continue;
      if (loose.has(lk) && loose.get(lk) !== name) loose.set(lk, null); // distinct heroes collide -> ambiguous
      else if (!loose.has(lk)) loose.set(lk, name);
    }
  } catch (_) { /* table missing (boot/test) — empty maps, normalizeHeroName returns null */ }
  _cache = { exact, loose };
  _cacheTs = now;
  return _cache;
}

/**
 * Resolve a vision-read hero name to the canonical dota_hero_stats.localized_name, or null.
 * The model matches heroes by exact (lowercased) name, so a mismatch silently falls to neutral WR.
 */
function normalizeHeroName(db, raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const { exact, loose } = _load(db);
  const ex = s.toLowerCase();
  if (exact.has(ex)) return exact.get(ex);
  const lk = _looseKey(s);
  if (lk && loose.has(lk)) return loose.get(lk); // null if ambiguous
  return null;
}

function _invalidateHeroCache() { _cache = null; _cacheTs = 0; }

module.exports = { buildDotaPrintPrompt, normalizeHeroName, _invalidateHeroCache };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/run.js`
Expected: PASS — section `[dota-draft-parse]` shows 13 ✓; final line `N passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add lib/dota-draft-parse.js tests/test-dota-draft-parse.js
git commit -m "feat(dota-lab): hero-name normalizer + vision prompt for print-parse"
```

(The pre-commit hook runs the full suite — it must stay green.)

---

## Task 2: `POST /api/dota-draft-parse-print` endpoint (server.js)

**Files:**
- Modify: `server.js` (insert after the `/api/dota-match-explain` handler, ~line 5526, before the `// Match Lab — AI match reading` comment)

- [ ] **Step 1: Insert the endpoint**

Paste this block immediately after the closing of the `/api/dota-match-explain` handler (after its `return;` and `}`), before the `// Match Lab — AI match reading (display-only)` comment:

```js
  // Dota Lab — parse a draft/scoreboard screenshot into heroes via Claude vision.
  // Dormant until ANTHROPIC_API_KEY is set. Result is for USER CONFIRMATION before analyze.
  // Display-only: feeds only the Dota Lab inputs, never stake/EV. Shares the vision daily cap
  // (_draftVisionDayMap + ANTHROPIC_VISION_DAILY_CAP) with /api/lol-draft-parse-print — same paid API.
  if (p === '/api/dota-draft-parse-print' && req.method === 'POST') {
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
        if (b64.length > 7000000) { sendJson(res, { ok: false, error: 'image_too_large', max_b64: 7000000 }, 413); return; }

        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
        const cap = parseInt(process.env.ANTHROPIC_VISION_DAILY_CAP || '50', 10);
        const _vmap = (global._draftVisionDayMap = global._draftVisionDayMap || new Map());
        const dayKey = `${ip}|${new Date().toISOString().slice(0, 10)}`;
        const used = _vmap.get(dayKey) || 0;
        if (used >= cap) { sendJson(res, { ok: false, error: 'daily_cap_reached', cap }, 429); return; }
        // Reserve the slot BEFORE the paid call so failures still count toward the cap.
        _vmap.set(dayKey, used + 1);

        const { buildDotaPrintPrompt, normalizeHeroName } = require('./lib/dota-draft-parse');
        const payload = {
          model: 'claude-sonnet-4-5', max_tokens: 1024,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
            { type: 'text', text: buildDotaPrintPrompt() },
          ] }],
        };
        const r = await aiPost('anthropic', 'https://api.anthropic.com/v1/messages', payload,
          { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' }, { timeoutMs: 30000, retry: { maxAttempts: 2 } });
        try { stmts.incrApiUsage.run('anthropic', new Date().toISOString().slice(0, 7)); } catch (_) {}

        const rj = r ? safeParse(r.body, {}) : {};
        const text = (rj?.content || []).map(c => c.text || '').join('');
        const parsed = safeParse((text.match(/\{[\s\S]*\}/) || [null])[0], null);
        if (!parsed) { sendJson(res, { ok: false, error: 'parse_failed', raw: text.slice(0, 300) }, 502); return; }
        const { stripPlayerTeamTag } = require('./lib/lol-champions');
        const tag = (arr) => (arr || []).map(e => ({ hero: e.hero, player: stripPlayerTeamTag(e.player), key: normalizeHeroName(db, e.hero) }));
        const teams = (parsed.teams && typeof parsed.teams === 'object')
          ? { blue: parsed.teams.blue || null, red: parsed.teams.red || null } : null;
        sendJson(res, { ok: true, teams, blue: tag(parsed.blue), red: tag(parsed.red), needsConfirmation: true });
      } catch (e) {
        log('WARN', 'DOTA-LAB', `parse-print err: ${e.message}`);
        sendJson(res, { ok: false, error: 'parse_print_failed' }, 500);
      }
    }, 2000000); // 2MB body cap (client downscales first); mirrors the LoL endpoint.
    return;
  }
```

- [ ] **Step 2: Verify syntax**

Run: `node -c server.js`
Expected: no output, exit 0.

- [ ] **Step 3: Run the suite (nothing regressed)**

Run: `node tests/run.js`
Expected: `N passed, 0 failed`.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(dota-lab): /api/dota-draft-parse-print vision endpoint"
```

---

## Task 3: Front-end — print upload/paste + hero+player slots (`public/lol-live-dashboard.html`)

**Files:**
- Modify: `public/lol-live-dashboard.html` (CSS ~1276; `#dotaLab` markup ~1373/1389; `initDotaLab` ~2568; new functions + paste listener ~2532/2620)

- [ ] **Step 1: Add `.dota-slot` CSS**

After the `.dl-print-msg.visible { display: block; }` rule (~line 1276), insert:

```css
.dota-slot { display: flex; gap: 6px; margin-bottom: 6px; }
.dota-slot .dota-hero   { flex: 1 1 62%; min-width: 0; }
.dota-slot .dota-player { flex: 1 1 38%; min-width: 0; }
```

- [ ] **Step 2: Update the `#dotaLab` subtitle**

Replace (~line 1373):

```html
    <span class="dl-subtitle">times + heróis — win% calibrado com Elo e draft</span>
```

with:

```html
    <span class="dl-subtitle">times + heróis (ou cole um print) — win% calibrado com Elo e draft</span>
```

- [ ] **Step 3: Add the print block to the `#dotaLab` actions**

Replace the `.dl-actions` block of the Dota Lab (~lines 1389-1391):

```html
    <div class="dl-actions">
      <button class="btn primary" id="dotaAnalyzeBtn">Analisar partida</button>
    </div>
```

with:

```html
    <div class="dl-actions">
      <button class="btn primary" id="dotaAnalyzeBtn">Analisar partida</button>
      <label class="btn" style="cursor:pointer; text-align:center;">
        📷 enviar print
        <input type="file" id="dotaPrintInput" accept="image/*" style="display:none" onchange="dotaParsePrint(this)">
      </label>
      <span class="dl-paste-hint">ou Ctrl+V pra colar</span>
      <div class="dl-print-msg" id="dotaPrintMsg"></div>
      <div class="dl-error" id="dotaError"></div>
    </div>
```

- [ ] **Step 4: Rewrite `initDotaLab` to build hero+player slots**

Replace the `initDotaLab` IIFE (~lines 2568-2576):

```js
(function initDotaLab() {
  for (const side of ['Blue', 'Red']) {
    const c = document.getElementById('dota' + side + 'Heroes');
    for (let i = 0; i < 5; i++) c.appendChild(el('input', { type: 'text', list: 'dotaHeroList', placeholder: side === 'Blue' ? 'Herói azul' : 'Herói vermelho', autocomplete: 'off', class: 'dota-hero', 'data-side': side.toLowerCase() }));
  }
  fetch('/api/dota-teams').then(r => r.json()).then(d => { if (d.ok) document.getElementById('dotaTeamList').innerHTML = d.teams.map(t => `<option value="${t.replace(/"/g, '&quot;')}">`).join(''); }).catch(() => {});
  fetch('/api/dota-heroes').then(r => r.json()).then(d => { if (d.ok) document.getElementById('dotaHeroList').innerHTML = d.heroes.map(h => `<option value="${h.replace(/"/g, '&quot;')}">`).join(''); }).catch(() => {});
  document.getElementById('dotaAnalyzeBtn').addEventListener('click', dotaAnalyze);
})();
```

with (each slot = hero input + player input; `dotaCollect` still finds `.dota-hero` via the recursive `querySelectorAll`):

```js
(function initDotaLab() {
  for (const side of ['Blue', 'Red']) {
    const c = document.getElementById('dota' + side + 'Heroes');
    const lc = side.toLowerCase();
    for (let i = 0; i < 5; i++) {
      const hero = el('input', { type: 'text', list: 'dotaHeroList', placeholder: side === 'Blue' ? 'Herói azul' : 'Herói vermelho', autocomplete: 'off', class: 'dota-hero', 'data-side': lc });
      const player = el('input', { type: 'text', placeholder: 'jogador', autocomplete: 'off', class: 'dota-player', 'data-side': lc });
      c.appendChild(el('div', { class: 'dota-slot' }, hero, player));
    }
  }
  fetch('/api/dota-teams').then(r => r.json()).then(d => { if (d.ok) document.getElementById('dotaTeamList').innerHTML = d.teams.map(t => `<option value="${t.replace(/"/g, '&quot;')}">`).join(''); }).catch(() => {});
  fetch('/api/dota-heroes').then(r => r.json()).then(d => { if (d.ok) document.getElementById('dotaHeroList').innerHTML = d.heroes.map(h => `<option value="${h.replace(/"/g, '&quot;')}">`).join(''); }).catch(() => {});
  document.getElementById('dotaAnalyzeBtn').addEventListener('click', dotaAnalyze);
})();
```

- [ ] **Step 5: Add Dota print helpers + submit/picker functions**

Immediately after `dotaExplain` (ends ~line 2620, before the `// initial` / `startPolling();` comment), insert:

```js
function dotaSetPrintMsg(msg) {
  const e = document.getElementById('dotaPrintMsg');
  if (msg) { e.textContent = msg; e.classList.add('visible'); }
  else     { e.textContent = ''; e.classList.remove('visible'); }
}
function dotaSetError(msg) {
  const e = document.getElementById('dotaError');
  if (msg) { e.textContent = msg; e.classList.add('visible'); }
  else     { e.textContent = ''; e.classList.remove('visible'); }
}

// Shared by the Dota file picker and Ctrl+V paste — downscales the image (reuses dlDownscaleToDataUrl,
// which also UPSCALES small scoreboard crops), runs the Dota vision parse, prefills inputs.
async function dotaSubmitPrintFile(file) {
  if (!file) return;
  dotaSetError(null);
  dotaSetPrintMsg('Processando print…');
  try {
    const imageBase64 = await dlDownscaleToDataUrl(file);
    const r = await fetch('/api/dota-draft-parse-print', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64 }),
    });
    if (r.status === 503) { dotaSetPrintMsg(null); dotaSetError('Parse por print indisponível (ANTHROPIC_API_KEY não setada).'); return; }
    const data = await r.json();
    if (!data.ok) {
      dotaSetPrintMsg(null);
      dotaSetError((data.error === 'body_too_large' || data.error === 'image_too_large')
        ? 'Print grande demais mesmo após reduzir — recorte só a área do draft e tente de novo.'
        : (data.error || 'Erro ao interpretar print.'));
      return;
    }
    const fill = (containerId, picks) => {
      const slots = [...document.getElementById(containerId).querySelectorAll('.dota-slot')];
      slots.forEach((slot, i) => {
        const heroInp = slot.querySelector('.dota-hero');
        const playerInp = slot.querySelector('.dota-player');
        const pick = picks[i];
        const heroVal = pick ? (pick.key || pick.hero || '') : '';
        if (heroInp) { heroInp.value = heroVal; heroInp.classList.toggle('prefilled', !!heroVal); }
        const playerVal = (pick && pick.player) ? pick.player : '';
        if (playerInp) { playerInp.value = playerVal; playerInp.classList.toggle('prefilled', !!playerVal); }
      });
    };
    fill('dotaBlueHeroes', data.blue || []);
    fill('dotaRedHeroes', data.red || []);
    if (data.teams) {
      const bt = document.getElementById('dota_blueTeam'); if (bt && data.teams.blue) bt.value = data.teams.blue;
      const rt = document.getElementById('dota_redTeam');  if (rt && data.teams.red)  rt.value = data.teams.red;
    }
    dotaSetPrintMsg('Draft preenchido — revise e clique Analisar partida.');
  } catch (e) {
    dotaSetPrintMsg(null);
    dotaSetError('Falha ao processar print: ' + e.message);
  }
}

function dotaParsePrint(input) {
  dotaSubmitPrintFile(input.files[0]);
  input.value = ''; // reset so the same file can be re-uploaded
}
```

- [ ] **Step 6: Route the paste listener to whichever lab is open**

Replace the existing paste listener (~lines 2532-2542):

```js
// Ctrl+V a draft screenshot straight into the lab (only while it's open) — same path as the picker.
document.addEventListener('paste', (e) => {
  const lab = document.getElementById('draftLab');
  if (!lab || !lab.classList.contains('open')) return;
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const it of items) {
    if (it.type && it.type.indexOf('image/') === 0) {
      const blob = it.getAsFile();
      if (blob) { e.preventDefault(); dlSubmitPrintFile(blob); return; }
    }
  }
});
```

with (routes to Dota when `#dotaLab` is open, LoL when `#draftLab` is open — they never open together):

```js
// Ctrl+V a screenshot straight into whichever lab is open — same path as that lab's file picker.
document.addEventListener('paste', (e) => {
  const dota = document.getElementById('dotaLab');
  const draft = document.getElementById('draftLab');
  const handler = (dota && dota.classList.contains('open')) ? dotaSubmitPrintFile
                : (draft && draft.classList.contains('open')) ? dlSubmitPrintFile
                : null;
  if (!handler) return;
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const it of items) {
    if (it.type && it.type.indexOf('image/') === 0) {
      const blob = it.getAsFile();
      if (blob) { e.preventDefault(); handler(blob); return; }
    }
  }
});
```

- [ ] **Step 7: Verify markers present + suite green**

Run (PowerShell):
```powershell
Select-String -Path public/lol-live-dashboard.html -Pattern 'dotaPrintInput','dotaSubmitPrintFile','dotaParsePrint','dota-slot','dota-player' | Select-Object -ExpandProperty Pattern -Unique
node tests/run.js
```
Expected: all 5 patterns listed; `N passed, 0 failed`.

- [ ] **Step 8: Commit**

```bash
git add public/lol-live-dashboard.html
git commit -m "feat(dota-lab): print upload/paste UI + hero+player slots"
```

---

## Task 4: Final verification (money-path airtight + full suite)

**Files:** none (verification only)

- [ ] **Step 1: Confirm the new code is display-only (not in the money-path)**

Run (PowerShell):
```powershell
Select-String -Path bot.js,lib/scanner.js,lib/market-tip-processor.js,lib/dota-map-model.js -Pattern 'dota-draft-parse','dota-draft-parse-print' -List
```
Expected: **no matches** (the lib/endpoint are referenced only by the server display endpoint and the dashboard). If anything matches, stop — that would breach the display-only guarantee.

- [ ] **Step 2: Confirm the LoL parse path is untouched**

Run (PowerShell):
```powershell
git diff main --stat -- server.js | Select-String 'lol-draft-parse-print'
git diff main -- server.js public/lol-live-dashboard.html | Select-String -Pattern '^\-' | Select-String 'lol-draft-parse-print','dlSubmitPrintFile'
```
Expected: no **removed** lines touching `lol-draft-parse-print` or `dlSubmitPrintFile` (the LoL handler and `dlSubmitPrintFile` body are unchanged; the only edit near `dlSubmitPrintFile` is the shared paste listener, which now *calls* it).

- [ ] **Step 3: Full suite + syntax**

Run: `node -c server.js; node tests/run.js`
Expected: server syntax OK; `N passed, 0 failed`.

- [ ] **Step 4: Manual smoke checklist (post-deploy, documented for the user)**

Not run locally — recorded for the user to confirm in prod after deploy (Dota Lab vision is dormant until `ANTHROPIC_API_KEY` is set, which it already is per memory):
1. `GET /edge` → open Dota Lab (`⚗ Dota Lab`); confirm the "📷 enviar print" button + "ou Ctrl+V pra colar" hint render, and each hero row shows a hero input + a "jogador" input.
2. Upload/paste a Dota scoreboard or draft screenshot → heroes (canonical names), players, and team names prefill; status reads "Draft preenchido — revise e clique Analisar partida."
3. Click "Analisar partida" → win%/Elo/draft WR render as before (unaffected).
4. With `ANTHROPIC_API_KEY` unset, the endpoint returns 503 and the UI shows "indisponível" (dormant by design).

---

## Notes for the implementer

- **No new npm dep, no DB migration, no new env, no new cron.** The vision cap reuses `ANTHROPIC_VISION_DAILY_CAP` (shared with LoL).
- **Player handles are display-only**: `dotaCollect` (unchanged) sends only `.dota-hero` values to `/api/dota-match-analyze` and `/api/dota-match-explain`. Do not wire players into those calls.
- **P4 follow-up (note in final response, do not do here):** the ~20 lines of vision boilerplate are now duplicated between `/api/lol-draft-parse-print` and `/api/dota-draft-parse-print`; a future pass can extract a shared `visionParseDraft({req,res,dataUrl,prompt})` helper covering both.
- **Esports knowledge:** "blue/red" in the Dota Lab UI is legacy from the LoL panel; the parse maps Radiant→blue, Dire→red. Renaming the labels is out of scope.
