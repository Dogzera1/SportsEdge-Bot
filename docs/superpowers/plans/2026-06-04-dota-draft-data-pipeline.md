# Dota Draft Data Pipeline (Fase 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingerir os dados de Dota que faltam para análise de draft — WR jogador×herói (OpenDota, on-demand+cache) e counters herói×herói (OpenDota matchups) — com migration, scripts de sync, crons e libs de leitura testáveis. Display-only; sem UI (Fase 2).

**Architecture:** 3 tabelas novas (migration 130). 2 scripts de sync seguindo `sync-opendota-heroes.js`, agendados em `bot.js` no molde de `runDotaHeroSync`. 2 libs de leitura puras (`dota-player-heroes.js`, `dota-hero-matchups.js`). Validação por testes unitários (db `:memory:` + fetcher injetável) + CLI de prova end-to-end.

**Tech Stack:** Node 18, better-sqlite3, OpenDota REST (sem token; `OPENDOTA_API_KEY` opcional), test runner caseiro (`tests/run.js`, `t.test`/`t.assert`).

---

## File Structure
- **Modify** `migrations/index.js` — migration `130_dota_draft_data_pipeline` (3 tabelas), inserida antes do `];` que fecha o array `migrations` (linha ~3494).
- **Create** `lib/dota-player-heroes.js` — `normalizeProNick`, `resolveProPlayer`, `getPlayerHeroStats` (on-demand fetch+cache).
- **Create** `lib/dota-hero-matchups.js` — `getMatchupEdge` (counter edge do confronto; resolve nome→hero_id).
- **Create** `scripts/sync-opendota-pro-players.js` — popula `dota_pro_players` (1 req).
- **Create** `scripts/sync-opendota-hero-matchups.js` — popula `dota_hero_matchups` (~138 req, `--limit` opcional).
- **Create** `scripts/dota-draft-probe.js` — CLI de prova end-to-end.
- **Modify** `bot.js` — 2 crons (após `runDotaHeroSync`, ~linha 28160).
- **Modify** `lib/stratz-dota-scraper.js` — marcador `@DORMANT`.
- **Create** `tests/test-dota-player-heroes.js`, `tests/test-dota-hero-matchups.js`.

---

## Task 1: Migration 130 (3 tabelas)

**Files:** Modify `migrations/index.js`

- [ ] **Step 1: Insert the migration object**

In `migrations/index.js`, find the end of migration `129_perf_indices_audit_p1` — it ends with:
```js
      } catch (e) { console.log(`[mig 129] indices: ${e.message}`); }
    },
  },
];
```
Insert the new object **between the `},` that closes migration 129 and the `];`** that closes the array:

```js
  {
    id: '130_dota_draft_data_pipeline',
    up(db) {
      // Dota Lab draft analysis (display-only): hero matchups (counters, OpenDota),
      // pro-player map (nick->account_id), and player×hero WR cache (on-demand).
      db.exec(`
        CREATE TABLE IF NOT EXISTS dota_hero_matchups (
          hero_id INTEGER NOT NULL,
          vs_hero_id INTEGER NOT NULL,
          games INTEGER,
          wins INTEGER,
          wr REAL,
          updated_at TEXT,
          PRIMARY KEY (hero_id, vs_hero_id)
        );
        CREATE INDEX IF NOT EXISTS idx_dota_matchup_hero ON dota_hero_matchups(hero_id);

        CREATE TABLE IF NOT EXISTS dota_pro_players (
          account_id INTEGER PRIMARY KEY,
          name TEXT,
          name_norm TEXT,
          team_name TEXT,
          updated_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_dota_pro_name_norm ON dota_pro_players(name_norm);

        CREATE TABLE IF NOT EXISTS dota_player_hero_stats (
          account_id INTEGER NOT NULL,
          hero_id INTEGER NOT NULL,
          games INTEGER,
          wins INTEGER,
          wr REAL,
          last_played INTEGER,
          fetched_at TEXT,
          PRIMARY KEY (account_id, hero_id)
        );
        CREATE INDEX IF NOT EXISTS idx_dota_player_hero_acct ON dota_player_hero_stats(account_id);
      `);
      console.log('[mig 130] dota draft data tables created (hero_matchups, pro_players, player_hero_stats)');
    },
  },
```

- [ ] **Step 2: Verify syntax**

Run: `node -c migrations/index.js`
Expected: no output, exit 0.

- [ ] **Step 3: Apply against a throwaway DB and verify the 3 tables**

Run (creates a fresh DB, applies ALL migrations, checks tables, deletes it):
```bash
node -e "const init=require('./lib/database'); const {db}=init('_mig130_check.db'); const t=db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('dota_hero_matchups','dota_pro_players','dota_player_hero_stats')\").all().map(r=>r.name).sort(); console.log('tables:', t.join(', ')); db.close();" && rm _mig130_check.db _mig130_check.db-wal _mig130_check.db-shm 2>/dev/null; echo done
```
Expected: `tables: dota_hero_matchups, dota_player_hero_stats, dota_pro_players`

- [ ] **Step 4: Run the suite (schema-boot-integrity must stay green)**

Run: `node tests/run.js`
Expected: `N passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add migrations/index.js
git commit -m "feat(dota-lab): migration 130 — draft data tables (matchups/pro_players/player_hero)"
```

---

## Task 2: `lib/dota-player-heroes.js` (WR jogador×herói) — TDD

**Files:** Create `lib/dota-player-heroes.js`, Test `tests/test-dota-player-heroes.js`

- [ ] **Step 1: Write the failing test**

Create `tests/test-dota-player-heroes.js`:

```js
// tests/test-dota-player-heroes.js — pro-nick normalize/resolve + on-demand player×hero cache.
const Database = require('better-sqlite3');
const { normalizeProNick, resolveProPlayer, getPlayerHeroStats, _invalidateProCache } = require('../lib/dota-player-heroes');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dota_pro_players (account_id INTEGER PRIMARY KEY, name TEXT, name_norm TEXT, team_name TEXT, updated_at TEXT);
    CREATE TABLE dota_player_hero_stats (account_id INTEGER, hero_id INTEGER, games INTEGER, wins INTEGER, wr REAL, last_played INTEGER, fetched_at TEXT, PRIMARY KEY(account_id,hero_id));
  `);
  const ins = db.prepare(`INSERT INTO dota_pro_players VALUES (?,?,?,?,datetime('now'))`);
  for (const [acct, name] of [[201358612, 'Nisha'], [898455820, 'Malr1ne'], [97590558, 'Ace ♠']]) {
    ins.run(acct, name, normalizeProNick(name), 'Team X');
  }
  return db;
}

module.exports = async function (t) {
  _invalidateProCache();

  // normalizeProNick — dense key
  t.test('normalize lowercases + strips non-alnum', () => t.assert(normalizeProNick('Ace ♠') === 'ace'));
  t.test('normalize trims', () => t.assert(normalizeProNick('  Nisha ') === 'nisha'));
  t.test('normalize dotted handle stays dense', () => t.assert(normalizeProNick('Tundra.Nine') === 'tundranine'));
  t.test('normalize null -> empty', () => t.assert(normalizeProNick(null) === ''));

  // resolveProPlayer — whole + per-token fallback
  const db = freshDb();
  _invalidateProCache();
  t.test('resolve exact nick', () => t.assert(resolveProPlayer(db, 'Nisha')?.account_id === 201358612));
  t.test('resolve case/space-insensitive', () => t.assert(resolveProPlayer(db, ' nisha ')?.account_id === 201358612));
  t.test('resolve decorated nick (Ace ♠)', () => t.assert(resolveProPlayer(db, 'Ace')?.account_id === 97590558));
  t.test('resolve tagged handle token fallback', () => t.assert(resolveProPlayer(db, 'TeamX.Nisha')?.account_id === 201358612));
  t.test('resolve unknown -> null', () => t.assert(resolveProPlayer(db, 'Yatoro') === null));

  // getPlayerHeroStats — cache miss fetches, hit does not
  let calls = 0;
  const fetcher = async () => { calls++; return [{ hero_id: 1, games: 100, win: 60, last_played: 123 }, { hero_id: 5, games: 0, win: 0 }]; };
  const r1 = await getPlayerHeroStats(db, 201358612, { ttlDays: 7, fetcher });
  t.test('miss triggers fetch', () => t.assert(calls === 1));
  t.test('returns games>0 rows with wr', () => t.assert(r1.length === 1 && r1[0].hero_id === 1 && Math.abs(r1[0].wr - 0.6) < 1e-9));
  const r2 = await getPlayerHeroStats(db, 201358612, { ttlDays: 7, fetcher });
  t.test('fresh cache does not refetch', () => t.assert(calls === 1 && r2.length === 1));
  const rz = await getPlayerHeroStats(db, 0, { fetcher });
  t.test('zero account_id -> empty, no fetch', () => t.assert(rz.length === 0 && calls === 1));
};
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/run.js`
Expected: `[dota-player-heroes]` errors (module not found).

- [ ] **Step 3: Implement `lib/dota-player-heroes.js`**

```js
'use strict';
/**
 * dota-player-heroes.js — Display-only: WR jogador×herói via OpenDota, on-demand + cache.
 * resolveProPlayer mapeia um nick -> account_id (tabela dota_pro_players); getPlayerHeroStats
 * lê o cache dota_player_hero_stats e busca /players/{id}/heroes se ausente/velho. No stake/EV.
 */
const https = require('https');

function normalizeProNick(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// pro-player map cache (~30min) — keyed module-level; prod has a single db.
let _proCache = null, _proTs = 0;
const PRO_TTL = 30 * 60 * 1000;
function _loadProMap(db) {
  const now = Date.now();
  if (_proCache && (now - _proTs) < PRO_TTL) return _proCache;
  const m = new Map();
  try {
    for (const r of db.prepare('SELECT account_id, name, name_norm, team_name FROM dota_pro_players').all()) {
      if (r.name_norm && !m.has(r.name_norm)) m.set(r.name_norm, { account_id: r.account_id, name: r.name, team_name: r.team_name });
    }
  } catch (_) { /* table missing (boot/test) */ }
  _proCache = m; _proTs = now;
  return m;
}
function _invalidateProCache() { _proCache = null; _proTs = 0; }

function resolveProPlayer(db, nick) {
  const raw = String(nick == null ? '' : nick).trim();
  if (!raw) return null;
  const map = _loadProMap(db);
  const whole = normalizeProNick(raw);
  if (whole && map.has(whole)) return map.get(whole);
  // fallback: try each token (handles "Tundra.Nine" / "OG ATF" / decorations)
  for (const tok of raw.split(/[\s.]+/)) {
    const k = normalizeProNick(tok);
    if (k.length >= 3 && map.has(k)) return map.get(k);
  }
  return null;
}

function _opendotaFetcher(accountId) {
  const key = process.env.OPENDOTA_API_KEY ? `?api_key=${process.env.OPENDOTA_API_KEY}` : '';
  return new Promise((resolve, reject) => {
    const req = https.get(`https://api.opendota.com/api/players/${accountId}/heroes${key}`,
      { headers: { 'User-Agent': 'SportsEdge/1.0' }, timeout: 15000 }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
        });
      });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * WR do jogador por herói (cache dota_player_hero_stats, fetch on-demand se ausente/velho).
 * @returns Array<{hero_id, games, wins, wr, last_played}> ordenado por games desc (só games>0).
 */
async function getPlayerHeroStats(db, accountId, { ttlDays = 7, fetcher = _opendotaFetcher } = {}) {
  const acct = parseInt(accountId, 10);
  if (!acct) return [];
  const cutoff = new Date(Date.now() - ttlDays * 86400000).toISOString();
  const fresh = db.prepare('SELECT COUNT(*) c FROM dota_player_hero_stats WHERE account_id=? AND fetched_at > ?').get(acct, cutoff).c;
  if (!fresh) {
    let rows = null;
    try { rows = await fetcher(acct); } catch (_) { rows = null; }
    if (Array.isArray(rows)) {
      const now = new Date().toISOString();
      const up = db.prepare(`INSERT INTO dota_player_hero_stats (account_id,hero_id,games,wins,wr,last_played,fetched_at)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(account_id,hero_id) DO UPDATE SET games=excluded.games, wins=excluded.wins, wr=excluded.wr, last_played=excluded.last_played, fetched_at=excluded.fetched_at`);
      const tx = db.transaction(() => {
        for (const r of rows) {
          const games = r.games || 0, win = r.win || 0;
          up.run(acct, r.hero_id, games, win, games ? win / games : null, r.last_played || null, now);
        }
      });
      tx();
    }
  }
  return db.prepare('SELECT hero_id, games, wins, wr, last_played FROM dota_player_hero_stats WHERE account_id=? AND games>0 ORDER BY games DESC').all(acct);
}

module.exports = { normalizeProNick, resolveProPlayer, getPlayerHeroStats, _invalidateProCache };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node tests/run.js`
Expected: `[dota-player-heroes]` all green; final `N passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add lib/dota-player-heroes.js tests/test-dota-player-heroes.js
git commit -m "feat(dota-lab): dota-player-heroes lib (resolve pro nick + on-demand player×hero WR)"
```

---

## Task 3: `lib/dota-hero-matchups.js` (counter edge) — TDD

**Files:** Create `lib/dota-hero-matchups.js`, Test `tests/test-dota-hero-matchups.js`

- [ ] **Step 1: Write the failing test**

Create `tests/test-dota-hero-matchups.js`:

```js
// tests/test-dota-hero-matchups.js — counter edge from dota_hero_matchups (name->id via dota_hero_stats).
const Database = require('better-sqlite3');
const { getMatchupEdge, _invalidateMatchupCache } = require('../lib/dota-hero-matchups');
const { _invalidateHeroCache } = require('../lib/dota-draft-parse');

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dota_hero_stats (hero_id INTEGER PRIMARY KEY, localized_name TEXT);
    CREATE TABLE dota_hero_matchups (hero_id INTEGER, vs_hero_id INTEGER, games INTEGER, wins INTEGER, wr REAL, updated_at TEXT, PRIMARY KEY(hero_id,vs_hero_id));
  `);
  const h = db.prepare('INSERT INTO dota_hero_stats VALUES (?,?)');
  h.run(1, 'Anti-Mage'); h.run(5, 'Crystal Maiden'); h.run(8, 'Juggernaut');
  const m = db.prepare('INSERT INTO dota_hero_matchups VALUES (?,?,?,?,?,?)');
  // Anti-Mage (1) strong vs CM (5): wr .60, weak vs Jugg (8): wr .40, low-sample vs ?
  m.run(1, 5, 100, 60, 0.60, null);
  m.run(1, 8, 100, 40, 0.40, null);
  return db;
}

module.exports = function (t) {
  const db = freshDb();
  _invalidateHeroCache();      // force normalizeHeroName to read THIS test's dota_hero_stats
  _invalidateMatchupCache();

  t.test('resolves names and aggregates blue advantage', () => {
    const r = getMatchupEdge(db, ['Anti-Mage'], ['Crystal Maiden'], { minGames: 20 });
    // adv = wr - 0.5 = +0.10 -> +10.0pp
    t.assert(Math.abs(r.blueAdvantagePp - 10.0) < 0.05 && r.sampled === 1);
  });
  t.test('sums multiple pairs (one favorable, one not)', () => {
    const r = getMatchupEdge(db, ['Anti-Mage'], ['Crystal Maiden', 'Juggernaut'], { minGames: 20 });
    // +10.0 (vs CM) + (-10.0) (vs Jugg) = 0.0pp, 2 pairs
    t.assert(Math.abs(r.blueAdvantagePp - 0.0) < 0.05 && r.sampled === 2);
  });
  t.test('honors min-sample guard', () => {
    const r = getMatchupEdge(db, ['Anti-Mage'], ['Crystal Maiden'], { minGames: 200 });
    t.assert(r.sampled === 0 && r.blueAdvantagePp === 0);
  });
  t.test('unknown hero name is skipped', () => {
    const r = getMatchupEdge(db, ['Anti-Mage'], ['Nonexistent Hero'], { minGames: 20 });
    t.assert(r.sampled === 0);
  });
  t.test('accepts numeric hero ids too', () => {
    const r = getMatchupEdge(db, [1], [5], { minGames: 20 });
    t.assert(Math.abs(r.blueAdvantagePp - 10.0) < 0.05);
  });
};
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/run.js`
Expected: `[dota-hero-matchups]` errors (module not found).

- [ ] **Step 3: Implement `lib/dota-hero-matchups.js`**

```js
'use strict';
/**
 * dota-hero-matchups.js — Display-only: counter edge of a draft from dota_hero_matchups
 * (populated by sync-opendota-hero-matchups). Accepts hero names (resolved to hero_id via
 * dota_hero_stats, reusing dota-draft-parse.normalizeHeroName) or numeric hero_ids. No stake/EV.
 */
const { normalizeHeroName } = require('./dota-draft-parse');

// caches (~30min): name->id map + matchup table
let _idCache = null, _idTs = 0, _muCache = null, _muTs = 0;
const TTL = 30 * 60 * 1000;

function _idMap(db) {
  const now = Date.now();
  if (_idCache && (now - _idTs) < TTL) return _idCache;
  const m = new Map();
  try {
    for (const r of db.prepare('SELECT hero_id, localized_name FROM dota_hero_stats WHERE localized_name IS NOT NULL').all()) {
      m.set(String(r.localized_name).toLowerCase(), r.hero_id);
    }
  } catch (_) { /* table missing */ }
  _idCache = m; _idTs = now;
  return m;
}

function _muMap(db) {
  const now = Date.now();
  if (_muCache && (now - _muTs) < TTL) return _muCache;
  const m = new Map();
  try {
    for (const r of db.prepare('SELECT hero_id, vs_hero_id, games, wr FROM dota_hero_matchups').all()) {
      m.set(`${r.hero_id}:${r.vs_hero_id}`, { games: r.games, wr: r.wr });
    }
  } catch (_) { /* table missing */ }
  _muCache = m; _muTs = now;
  return m;
}

function _resolveId(db, h) {
  if (typeof h === 'number') return h;
  const canon = normalizeHeroName(db, h);   // canonical localized_name or null
  if (!canon) return null;
  return _idMap(db).get(String(canon).toLowerCase()) || null;
}

/**
 * Counter edge of blue draft vs red draft.
 * @returns {{ blueAdvantagePp:number, sampled:number, pairs:Array<{blue,red,advPp,games}> }}
 *   blueAdvantagePp = sum over pairs of (wr_blue_vs_red - 0.5)*100, only pairs with games>=minGames.
 */
function getMatchupEdge(db, blueHeroes, redHeroes, { minGames = 20 } = {}) {
  const blue = (blueHeroes || []).map(h => _resolveId(db, h)).filter(Boolean);
  const red = (redHeroes || []).map(h => _resolveId(db, h)).filter(Boolean);
  const mu = _muMap(db);
  let sum = 0, sampled = 0;
  const pairs = [];
  for (const b of blue) {
    for (const r of red) {
      const m = mu.get(`${b}:${r}`);
      if (!m || m.wr == null || (m.games || 0) < minGames) continue;
      const adv = m.wr - 0.5;
      sum += adv; sampled++;
      pairs.push({ blue: b, red: r, advPp: +(adv * 100).toFixed(1), games: m.games });
    }
  }
  pairs.sort((a, b) => Math.abs(b.advPp) - Math.abs(a.advPp));
  return { blueAdvantagePp: +(sum * 100).toFixed(1), sampled, pairs };
}

function _invalidateMatchupCache() { _idCache = null; _idTs = 0; _muCache = null; _muTs = 0; }

module.exports = { getMatchupEdge, _invalidateMatchupCache };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node tests/run.js`
Expected: `[dota-hero-matchups]` all green; final `N passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add lib/dota-hero-matchups.js tests/test-dota-hero-matchups.js
git commit -m "feat(dota-lab): dota-hero-matchups lib (counter edge from OpenDota matchups)"
```

---

## Task 4: Sync scripts (pro-players + hero-matchups)

**Files:** Create `scripts/sync-opendota-pro-players.js`, `scripts/sync-opendota-hero-matchups.js`

- [ ] **Step 1: Create `scripts/sync-opendota-pro-players.js`**

```js
#!/usr/bin/env node
'use strict';
// scripts/sync-opendota-pro-players.js
// Puxa /proPlayers do OpenDota e grava o mapa nick->account_id em dota_pro_players.
require('dotenv').config({ override: true });
const path = require('path');
const https = require('https');
const initDatabase = require('../lib/database');
const { normalizeProNick } = require('../lib/dota-player-heroes');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');
const API_KEY = process.env.OPENDOTA_API_KEY || '';

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'SportsEdge/1.0' }, timeout: 30000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`)); try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

async function main() {
  const { db } = initDatabase(DB_PATH);
  const url = `https://api.opendota.com/api/proPlayers${API_KEY ? '?api_key=' + API_KEY : ''}`;
  console.log(`[opendota-pros] fetching ${url}`);
  const rows = await getJson(url);
  if (!Array.isArray(rows)) { console.error('not an array'); process.exit(1); }
  console.log(`[opendota-pros] ${rows.length} pro players`);

  const upsert = db.prepare(`INSERT INTO dota_pro_players (account_id, name, name_norm, team_name, updated_at)
    VALUES (@account_id, @name, @name_norm, @team_name, datetime('now'))
    ON CONFLICT(account_id) DO UPDATE SET name=excluded.name, name_norm=excluded.name_norm, team_name=excluded.team_name, updated_at=datetime('now')`);
  let n = 0;
  const tx = db.transaction(() => {
    for (const p of rows) {
      if (!p.account_id) continue;
      const name = p.name || p.personaname || '';
      upsert.run({ account_id: p.account_id, name, name_norm: normalizeProNick(name), team_name: p.team_name || null });
      n++;
    }
  });
  tx();
  console.log(`[opendota-pros] upserted ${n}; total ${db.prepare('SELECT COUNT(*) c FROM dota_pro_players').get().c}`);
}
main().catch(e => { console.error('fatal:', e.message); process.exit(1); });
```

- [ ] **Step 2: Create `scripts/sync-opendota-hero-matchups.js`**

```js
#!/usr/bin/env node
'use strict';
// scripts/sync-opendota-hero-matchups.js
// Pra cada herói em dota_hero_stats, puxa /heroes/{id}/matchups (counters) e grava em dota_hero_matchups.
// Uso: node scripts/sync-opendota-hero-matchups.js [--limit N] [--delay 1100]
require('dotenv').config({ override: true });
const path = require('path');
const https = require('https');
const initDatabase = require('../lib/database');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');
const API_KEY = process.env.OPENDOTA_API_KEY || '';
const argv = process.argv.slice(2);
const LIMIT = (() => { const i = argv.indexOf('--limit'); return i >= 0 ? parseInt(argv[i + 1], 10) : Infinity; })();
const DELAY = (() => { const i = argv.indexOf('--delay'); return i >= 0 ? parseInt(argv[i + 1], 10) : 1100; })();

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'SportsEdge/1.0' }, timeout: 30000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`)); try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const { db } = initDatabase(DB_PATH);
  const heroes = db.prepare('SELECT hero_id FROM dota_hero_stats ORDER BY hero_id').all().map(r => r.hero_id).slice(0, LIMIT);
  console.log(`[opendota-matchups] ${heroes.length} heroes, delay ${DELAY}ms`);
  const upsert = db.prepare(`INSERT INTO dota_hero_matchups (hero_id, vs_hero_id, games, wins, wr, updated_at)
    VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(hero_id,vs_hero_id) DO UPDATE SET games=excluded.games, wins=excluded.wins, wr=excluded.wr, updated_at=datetime('now')`);
  let ok = 0, fail = 0, pairs = 0;
  for (const hid of heroes) {
    try {
      const rows = await getJson(`https://api.opendota.com/api/heroes/${hid}/matchups${API_KEY ? '?api_key=' + API_KEY : ''}`);
      if (Array.isArray(rows)) {
        const tx = db.transaction(() => {
          for (const r of rows) {
            const games = r.games_played || 0, wins = r.wins || 0;
            if (!r.hero_id || !games) continue;
            upsert.run(hid, r.hero_id, games, wins, wins / games);
            pairs++;
          }
        });
        tx();
        ok++;
      } else fail++;
    } catch (e) { fail++; }
    await sleep(DELAY);
  }
  console.log(`[opendota-matchups] heroes ok=${ok} fail=${fail}; pairs upserted=${pairs}; total ${db.prepare('SELECT COUNT(*) c FROM dota_hero_matchups').get().c}`);
}
main().catch(e => { console.error('fatal:', e.message); process.exit(1); });
```

- [ ] **Step 3: Verify syntax**

Run: `node -c scripts/sync-opendota-pro-players.js && node -c scripts/sync-opendota-hero-matchups.js && echo OK`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add scripts/sync-opendota-pro-players.js scripts/sync-opendota-hero-matchups.js
git commit -m "feat(dota-lab): OpenDota sync scripts (pro-players map + hero matchups)"
```

---

## Task 5: Crons (bot.js) + CLI probe + Stratz dormant marker

**Files:** Modify `bot.js`, `lib/stratz-dota-scraper.js`; Create `scripts/dota-draft-probe.js`

- [ ] **Step 1: Add the two crons in `bot.js`**

Find the end of the `runDotaHeroSync` block (~line 28160), which ends with:
```js
  setInterval(runDotaHeroSync, 7 * 24 * 60 * 60 * 1000); // weekly
  setTimeout(runDotaHeroSync, 110 * 60 * 1000); // 110min pós-boot
```
Insert immediately after it:

```js
  // Dota pro-players map (OpenDota /proPlayers) — daily. Mapa nick->account_id pro Dota Lab.
  const runDotaProPlayersSync = () => {
    try {
      const { spawn } = require('child_process');
      const proc = spawn('node', ['scripts/sync-opendota-pro-players.js'], { cwd: __dirname, env: process.env, detached: false });
      proc.on('close', (code) => {
        log(code === 0 ? 'INFO' : 'WARN', 'HIST-DOTA-PROS', `Auto-sync pro players exit=${code}`);
        try { require('./lib/dota-player-heroes')._invalidateProCache(); } catch (_) {}
      });
      log('INFO', 'HIST-DOTA-PROS', 'Auto-sync pro players started (background)');
    } catch (e) { log('WARN', 'HIST-DOTA-PROS', `err: ${e.message}`); }
  };
  setInterval(runDotaProPlayersSync, 24 * 60 * 60 * 1000); // daily
  setTimeout(runDotaProPlayersSync, 112 * 60 * 1000); // 112min pós-boot

  // Dota hero matchups (OpenDota /heroes/{id}/matchups) — weekly. Counters pro Dota Lab.
  const runDotaMatchupsSync = () => {
    try {
      const { spawn } = require('child_process');
      const proc = spawn('node', ['scripts/sync-opendota-hero-matchups.js'], { cwd: __dirname, env: process.env, detached: false });
      proc.on('close', (code) => {
        log(code === 0 ? 'INFO' : 'WARN', 'HIST-DOTA-MATCHUPS', `Auto-sync hero matchups exit=${code}`);
        try { require('./lib/dota-hero-matchups')._invalidateMatchupCache(); } catch (_) {}
      });
      log('INFO', 'HIST-DOTA-MATCHUPS', 'Auto-sync hero matchups started (background)');
    } catch (e) { log('WARN', 'HIST-DOTA-MATCHUPS', `err: ${e.message}`); }
  };
  setInterval(runDotaMatchupsSync, 7 * 24 * 60 * 60 * 1000); // weekly
  setTimeout(runDotaMatchupsSync, 120 * 60 * 1000); // 120min pós-boot
```

- [ ] **Step 2: Mark the Stratz scraper dormant**

In `lib/stratz-dota-scraper.js`, change the top of the header comment from:
```js
/**
 * lib/stratz-dota-scraper.js — STRATZ GraphQL API client.
```
to:
```js
/**
 * lib/stratz-dota-scraper.js — STRATZ GraphQL API client.
 *
 * @DORMANT 2026-06-04 — não cabeado a nenhum cron. Counters do Dota Lab usam OpenDota
 * (lib/dota-hero-matchups + scripts/sync-opendota-hero-matchups). Reativável se houver
 * STRATZ_API_TOKEN (traz synergy de dupla, que o OpenDota não dá). Sem token = 403.
```

- [ ] **Step 3: Create `scripts/dota-draft-probe.js` (CLI validation)**

```js
#!/usr/bin/env node
'use strict';
// scripts/dota-draft-probe.js — prova end-to-end dos libs de draft Dota (sem UI).
// Uso: node scripts/dota-draft-probe.js --blue "Anti-Mage,Pudge" --red "Juggernaut,Lion" --players "Nisha,Malr1ne"
require('dotenv').config({ override: true });
const path = require('path');
const initDatabase = require('../lib/database');
const { resolveProPlayer, getPlayerHeroStats } = require('../lib/dota-player-heroes');
const { getMatchupEdge } = require('../lib/dota-hero-matchups');

const DB_PATH = (process.env.DB_PATH || path.join(__dirname, '../sportsedge.db')).trim().replace(/^=+/, '');
const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : ''; };
const list = (s) => (s || '').split(',').map(x => x.trim()).filter(Boolean);

async function main() {
  const { db } = initDatabase(DB_PATH);
  const blue = list(arg('--blue')), red = list(arg('--red')), players = list(arg('--players'));

  console.log('=== matchup edge (blue vs red) ===');
  const edge = getMatchupEdge(db, blue, red);
  console.log(`blueAdvantagePp=${edge.blueAdvantagePp} sampled=${edge.sampled}`);
  for (const p of edge.pairs.slice(0, 6)) console.log(`  ${p.blue} vs ${p.red}: ${p.advPp >= 0 ? '+' : ''}${p.advPp}pp (n=${p.games})`);

  console.log('\n=== player×hero WR (on-demand) ===');
  for (const nick of players) {
    const pro = resolveProPlayer(db, nick);
    if (!pro) { console.log(`  ${nick}: (não encontrado em dota_pro_players)`); continue; }
    const hs = await getPlayerHeroStats(db, pro.account_id);
    const top = hs.slice(0, 3).map(h => `hero ${h.hero_id} ${(h.wr * 100).toFixed(0)}% (n=${h.games})`).join(', ');
    console.log(`  ${nick} -> ${pro.name} [${pro.team_name || '?'}] acct=${pro.account_id}: ${top || '(sem dados)'}`);
  }
  db.close();
}
main().catch(e => { console.error('fatal:', e.message); process.exit(1); });
```

- [ ] **Step 4: Verify syntax**

Run: `node -c bot.js && node -c lib/stratz-dota-scraper.js && node -c scripts/dota-draft-probe.js && echo OK`
Expected: `OK`

- [ ] **Step 5: Run the suite**

Run: `node tests/run.js`
Expected: `N passed, 0 failed`.

- [ ] **Step 6: Commit**

```bash
git add bot.js lib/stratz-dota-scraper.js scripts/dota-draft-probe.js
git commit -m "feat(dota-lab): schedule OpenDota draft-data syncs + CLI probe; mark Stratz dormant"
```

---

## Task 6: Final verification (apply migration, real sync, end-to-end probe, money-path)

**Files:** none (verification only)

- [ ] **Step 1: Money-path airtight grep**

Run (PowerShell):
```powershell
Select-String -Path bot.js,lib/scanner.js,lib/market-tip-processor.js,lib/dota-map-model.js -Pattern 'dota-player-heroes','dota-hero-matchups','dota_player_hero_stats' -List
```
Expected: **only** `bot.js` matches (the cron `require('./lib/dota-player-heroes')._invalidateProCache()` + matchups invalidate). NO matches in scanner / market-tip-processor / dota-map-model. If any of those match, STOP — display-only breached.

- [ ] **Step 2: Apply migration to the local prod DB**

Run:
```bash
node -e "const init=require('./lib/database'); init('sportsedge.db'); console.log('migrations applied');"
```
Expected: prints `[mig 130] dota draft data tables created ...` (first run) then `migrations applied`.

- [ ] **Step 3: Real sync — pro-players (1 req) + matchups (subset)**

Run:
```bash
node scripts/sync-opendota-pro-players.js && node scripts/sync-opendota-hero-matchups.js --limit 8
```
Expected: `[opendota-pros] upserted <~4400>` and `[opendota-matchups] heroes ok=8 ... pairs upserted=<~900>`.

- [ ] **Step 4: End-to-end probe with real data**

Run:
```bash
node scripts/dota-draft-probe.js --blue "Anti-Mage" --red "Crystal Maiden" --players "Nisha,Malr1ne,skiter"
```
Expected: matchup edge prints a pp value (or `sampled=0` if hero 1's matchups weren't in the 8-hero subset — rerun with the hero in range or full sync), and each player resolves to a pro with top heroes (e.g. `Nisha -> Nisha [Team Liquid] acct=201358612: hero X 5x% (n=...)`).

- [ ] **Step 5: Full suite + syntax**

Run: `node -c bot.js; node tests/run.js`
Expected: syntax OK; `N passed, 0 failed`.

(No commit — verification only. The local DB now has real rows, which is fine; prod populates via the crons.)

---

## Notes for the implementer
- **No new npm dep, no new required env** (`OPENDOTA_API_KEY` optional, already used by `sync-opendota-heroes.js`).
- **Display-only:** these tables/libs are for analysis (Fase 2 UI). They must never be imported by the scanner / market-tip-processor / dota-map-model.
- **Tests use `better-sqlite3` `:memory:`** with a hand-built schema + an injected `fetcher` — no network, not flaky.
- **OpenDota field names (validated 2026-06-04):** `/players/{id}/heroes` → `{hero_id, games, win, last_played}`; `/heroes/{id}/matchups` → `{hero_id, games_played, wins}`; `/proPlayers` → `{account_id, name, team_name}`.
- **P5/P4 note (for the final response, not a task):** the Stratz scraper + `stratz_hero_matchups` stay dormant; a future Fase 2 could add synergy via Stratz if a token is provided.
