# Match Lab — Game Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar ao painel Match Lab do `/edge` uma camada display-only de leitura de partida (perfil por fase, odd justa + edge, win condition/estilo, selo de qualidade).

**Architecture:** Dois artefatos JSON pré-computados (timing do banco `oracleselixir_players` + tags Data Dragon) alimentam `lib/lol-game-profile.js` (lógica pura, injeção de artefatos pra teste). O endpoint `/api/lol-match-analyze` anexa um campo `gameProfile`; a UI renderiza as seções. Nenhuma mudança em money-path — `prob`/`probBlue` ficam byte-idênticos.

**Tech Stack:** Node 18, better-sqlite3, http nativo, runner de teste custom (`node tests/run.js`). Sem dependência npm nova, sem migration.

**Spec:** `docs/superpowers/specs/2026-06-01-lol-match-lab-game-profile-design.md`

---

## Convenções deste plano

- **Rodar a suíte:** `npm test` (executa `tests/test-*.js`). Procure a seção `[lol-game-profile]` / `[lol-champion-timing]` / `[lol-champion-tags]` no output. "Falhar" = o runner imprime `✗` e termina com `N failed` + exit 1. "Passar" = `✓` em todos e exit 0.
- **Padrão de teste** (sem framework): `module.exports = function(t){ t.test('nome', () => { assert.ok(cond, msg) }); }`, com `const assert = require('assert')` no topo. Testes de lógica pura usam **fixtures injetadas** (sem DB).
- Commits frequentes, um por task. Mensagem em inglês, terminando com o trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `scripts/build-lol-champion-tags.js` (criar) | `buildTagsArtifact(ddragon)` puro + CLI que lê o `champion.json` da Data Dragon e escreve o artefato |
| `lib/lol-champion-tags.json` (criar, commitado) | `{ "<champ>": { tags:[...], info:{attack,defense,magic,difficulty} } }` |
| `scripts/train-lol-champion-timing.js` (criar) | `shrinkRate`/`aggregateTiming` puros + CLI que lê o DB e escreve o artefato |
| `lib/lol-champion-timing.json` (criar, commitado) | `{ meta, byChampRole, scaling, expectedLen }` |
| `lib/lol-game-profile.js` (criar) | Lógica display-only: `fairOdds`, `computeEdge`, `phaseEdges`, `expectedTime`, `winCondition`, `compStyle`, `qualityBlock`, `computeGameProfile` |
| `tests/test-lol-champion-tags.js` (criar) | testa `buildTagsArtifact` |
| `tests/test-lol-champion-timing.js` (criar) | testa `shrinkRate` + `aggregateTiming` |
| `tests/test-lol-game-profile.js` (criar) | testa toda a lógica de game-profile |
| `server.js` (modificar ~5334) | ler `bookOdds`; anexar `gameProfile` ao response |
| `public/lol-live-dashboard.html` (modificar ~2131) | renderizar seções + input de odd da casa |

---

## Task 1: Artefato de tags (Data Dragon)

**Files:**
- Create: `scripts/build-lol-champion-tags.js`
- Test: `tests/test-lol-champion-tags.js`
- Output (gerado): `lib/lol-champion-tags.json`

- [ ] **Step 1: Escrever o teste do transform**

`tests/test-lol-champion-tags.js`:
```js
'use strict';
const assert = require('assert');
const { buildTagsArtifact } = require('../scripts/build-lol-champion-tags');

module.exports = function(t) {
  t.test('maps ddragon data to normalized champ keys with tags+info', () => {
    const dd = { data: {
      Aatrox: { id: 'Aatrox', tags: ['Fighter', 'Tank'], info: { attack: 8, defense: 4, magic: 3, difficulty: 4 } },
      MonkeyKing: { id: 'MonkeyKing', tags: ['Fighter'], info: { attack: 7, defense: 5, magic: 2, difficulty: 3 } },
    }};
    const art = buildTagsArtifact(dd);
    assert.deepStrictEqual(art.aatrox.tags, ['Fighter', 'Tank'], 'aatrox tags');
    assert.strictEqual(art.aatrox.info.attack, 8, 'aatrox attack');
    // normalizeChampion folds MonkeyKing -> wukong (alias in lib/lol-champions.js)
    assert.ok(art.wukong, 'MonkeyKing folds to wukong key');
    assert.strictEqual(art.wukong.tags[0], 'Fighter', 'wukong tag');
  });

  t.test('skips entries without id', () => {
    const art = buildTagsArtifact({ data: { Bad: { tags: ['Mage'] } } });
    assert.strictEqual(Object.keys(art).length, 0, 'no id -> skipped');
  });
};
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: seção `[lol-champion-tags]` com `✗` ("Cannot find module '../scripts/build-lol-champion-tags'"), exit 1.

- [ ] **Step 3: Implementar o script**

`scripts/build-lol-champion-tags.js`:
```js
'use strict';
/**
 * Builds lib/lol-champion-tags.json from Riot Data Dragon champion.json.
 * Display-only artifact (comp-style heuristic). No npm dep, no DB.
 *
 * Usage: node scripts/build-lol-champion-tags.js <path-to-champion.json>
 * (download champion.json once via PowerShell — see plan Task 1 Step 5.)
 */
const fs = require('fs');
const path = require('path');
const { normalizeChampion } = require('../lib/lol-champions');

function buildTagsArtifact(ddragon) {
  const out = {};
  const data = (ddragon && ddragon.data) || {};
  for (const champ of Object.values(data)) {
    if (!champ || !champ.id) continue;
    const key = normalizeChampion(champ.id);
    if (!key) continue;
    const info = champ.info || {};
    out[key] = {
      tags: Array.isArray(champ.tags) ? champ.tags.slice() : [],
      info: {
        attack: Number(info.attack) || 0,
        defense: Number(info.defense) || 0,
        magic: Number(info.magic) || 0,
        difficulty: Number(info.difficulty) || 0,
      },
    };
  }
  return out;
}

if (require.main === module) {
  const input = process.argv[2];
  if (!input) { console.error('usage: node scripts/build-lol-champion-tags.js <champion.json>'); process.exit(1); }
  const dd = JSON.parse(fs.readFileSync(input, 'utf8'));
  const art = buildTagsArtifact(dd);
  const dest = path.join(__dirname, '..', 'lib', 'lol-champion-tags.json');
  // sorted keys for stable diffs
  const sorted = {};
  for (const k of Object.keys(art).sort()) sorted[k] = art[k];
  fs.writeFileSync(dest, JSON.stringify(sorted, null, 0));
  console.log(`wrote ${dest} (${Object.keys(sorted).length} champions)`);
}

module.exports = { buildTagsArtifact };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: `[lol-champion-tags]` com `✓` nos 2 testes.

- [ ] **Step 5: Baixar a Data Dragon e gerar o artefato**

Baixe o `champion.json` (a rede do node é bloqueada no sandbox; o PowerShell Invoke-WebRequest funciona):
```powershell
$ver = (Invoke-RestMethod 'https://ddragon.leagueoflegends.com/api/versions.json')[0]
Invoke-WebRequest "https://ddragon.leagueoflegends.com/cdn/$ver/data/en_US/champion.json" -OutFile ddragon-champion.json
```
Gere o artefato e remova o arquivo bruto:
```bash
node scripts/build-lol-champion-tags.js ddragon-champion.json
rm ddragon-champion.json
```
Expected: `wrote .../lib/lol-champion-tags.json (~170 champions)`. Confirme: `node -e "const a=require('./lib/lol-champion-tags.json'); console.log(a.aatrox, Object.keys(a).length)"` mostra tags + contagem.

- [ ] **Step 6: Commit**

```bash
git add scripts/build-lol-champion-tags.js tests/test-lol-champion-tags.js lib/lol-champion-tags.json
git commit -m "feat(match-lab): champion class tags artifact from Data Dragon"
```

---

## Task 2: Artefato de timing (do banco)

**Files:**
- Create: `scripts/train-lol-champion-timing.js`
- Test: `tests/test-lol-champion-timing.js`
- Output (gerado): `lib/lol-champion-timing.json`

- [ ] **Step 1: Escrever o teste de `shrinkRate` + `aggregateTiming`**

`tests/test-lol-champion-timing.js`:
```js
'use strict';
const assert = require('assert');
const { shrinkRate, aggregateTiming } = require('../scripts/train-lol-champion-timing');

module.exports = function(t) {
  t.test('shrinkRate returns prior when n=0', () => {
    assert.strictEqual(shrinkRate(0, 0, 10, 0.5), 0.5, 'n=0 -> prior');
  });
  t.test('shrinkRate pulls toward prior with small n', () => {
    // (8 + 10*0.5) / (10 + 10) = 13/20 = 0.65
    assert.ok(Math.abs(shrinkRate(8, 10, 10, 0.5) - 0.65) < 1e-9, 'shrunk 0.65');
  });
  t.test('shrinkRate approaches raw rate with large n', () => {
    const r = shrinkRate(800, 1000, 10, 0.5); // ~0.797
    assert.ok(r > 0.79 && r < 0.80, `large-n near raw, got ${r}`);
  });

  t.test('aggregateTiming computes byChampRole, scaling, expectedLen', () => {
    const rows = [
      { champion: 'Aatrox', position: 'top', gamelength: 1500, result: 1, golddiffat15: 300, xpdiffat15: 200, csdiffat15: 5 },
      { champion: 'Aatrox', position: 'top', gamelength: 2500, result: 0, golddiffat15: 100, xpdiffat15: 50,  csdiffat15: 2 },
      { champion: 'Aatrox', position: 'top', gamelength: 2000, result: 1, golddiffat15: 200, xpdiffat15: 150, csdiffat15: 4 },
      { champion: 'Gnar',   position: 'top', gamelength: 1400, result: 0, golddiffat15: -100, xpdiffat15: -50, csdiffat15: -3 },
      { champion: 'Gnar',   position: 'top', gamelength: 2600, result: 1, golddiffat15: 50,  xpdiffat15: 20,  csdiffat15: 1 },
      { champion: 'Gnar',   position: 'top', gamelength: 1900, result: 0, golddiffat15: -50, xpdiffat15: -20, csdiffat15: 0 },
    ];
    const a = aggregateTiming(rows);
    assert.strictEqual(a.byChampRole['aatrox|top'].n, 3, 'aatrox|top n=3');
    assert.strictEqual(a.byChampRole['aatrox|top'].golddiff15, 200, 'aatrox|top avg golddiff15=200');
    assert.strictEqual(a.expectedLen.aatrox, 2000, 'aatrox expectedLen=2000');
    assert.ok('index' in a.scaling.aatrox, 'aatrox has scaling.index');
    assert.ok(typeof a.scaling.aatrox.index === 'number', 'scaling.index numeric');
  });
};
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: `[lol-champion-timing]` com `✗` (módulo inexistente), exit 1.

- [ ] **Step 3: Implementar o script**

`scripts/train-lol-champion-timing.js`:
```js
'use strict';
/**
 * Builds lib/lol-champion-timing.json from oracleselixir_players.
 * Display-only artifact for the Match Lab game-profile (phase/scaling). No npm dep.
 *
 *  byChampRole["champ|role"] = { golddiff15, xpdiff15, csdiff15, n }   (MEASURED early)
 *  scaling["champ"]          = { index, wrShort, wrLong, nShort, nLong } (ESTIMATED late)
 *  expectedLen["champ"]      = avg gamelength (seconds)
 *
 * Usage: node scripts/train-lol-champion-timing.js
 */
const fs = require('fs');
const path = require('path');
const { normalizeChampion, normalizeRole } = require('../lib/lol-champions');

const SHRINK_K = 10;     // empirical-Bayes strength
const SHRINK_PRIOR = 0.5;

function shrinkRate(wins, n, k = SHRINK_K, prior = SHRINK_PRIOR) {
  return (wins + k * prior) / (n + k);
}

function percentile(sortedAsc, q) {
  if (!sortedAsc.length) return 0;
  const i = Math.min(sortedAsc.length - 1, Math.floor(q * sortedAsc.length));
  return sortedAsc[i];
}

function aggregateTiming(rows) {
  const gls = rows.map(r => r.gamelength).filter(x => x > 0).sort((a, b) => a - b);
  const p33 = percentile(gls, 0.33);
  const p66 = percentile(gls, 0.66);

  const crAcc = {}, scAcc = {}, elAcc = {};
  for (const r of rows) {
    const champ = normalizeChampion(r.champion);
    if (!champ) continue;
    const role = normalizeRole(r.position);

    const crk = champ + '|' + role;
    if (!crAcc[crk]) crAcc[crk] = { g: 0, x: 0, c: 0, n: 0 };
    if (r.golddiffat15 != null) {
      crAcc[crk].g += r.golddiffat15;
      crAcc[crk].x += (r.xpdiffat15 || 0);
      crAcc[crk].c += (r.csdiffat15 || 0);
      crAcc[crk].n++;
    }

    if (!scAcc[champ]) scAcc[champ] = { ws: 0, ns: 0, wl: 0, nl: 0 };
    if (r.gamelength > 0) {
      if (r.gamelength < p33) { scAcc[champ].ns++; if (r.result === 1) scAcc[champ].ws++; }
      else if (r.gamelength > p66) { scAcc[champ].nl++; if (r.result === 1) scAcc[champ].wl++; }
    }

    if (!elAcc[champ]) elAcc[champ] = { s: 0, n: 0 };
    if (r.gamelength > 0) { elAcc[champ].s += r.gamelength; elAcc[champ].n++; }
  }

  const byChampRole = {};
  for (const k in crAcc) {
    const a = crAcc[k];
    if (a.n > 0) byChampRole[k] = {
      golddiff15: +(a.g / a.n).toFixed(1),
      xpdiff15: +(a.x / a.n).toFixed(1),
      csdiff15: +(a.c / a.n).toFixed(1),
      n: a.n,
    };
  }
  const scaling = {};
  for (const c in scAcc) {
    const a = scAcc[c];
    const wrS = shrinkRate(a.ws, a.ns);
    const wrL = shrinkRate(a.wl, a.nl);
    scaling[c] = { index: +(wrL - wrS).toFixed(3), wrShort: +wrS.toFixed(3), wrLong: +wrL.toFixed(3), nShort: a.ns, nLong: a.nl };
  }
  const expectedLen = {};
  for (const c in elAcc) { const a = elAcc[c]; expectedLen[c] = a.n ? Math.round(a.s / a.n) : 0; }

  return { meta: { rows: rows.length, p33, p66, minCellN: 20, generatedAt: new Date().toISOString() }, byChampRole, scaling, expectedLen };
}

if (require.main === module) {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(__dirname, '..', 'sportsedge.db'), { readonly: true });
  const rows = db.prepare(
    `SELECT champion, position, gamelength, result, golddiffat15, xpdiffat15, csdiffat15
       FROM oracleselixir_players
      WHERE champion IS NOT NULL AND length(champion) > 0`
  ).all();
  db.close();
  const art = aggregateTiming(rows);
  const dest = path.join(__dirname, '..', 'lib', 'lol-champion-timing.json');
  fs.writeFileSync(dest, JSON.stringify(art, null, 0));
  console.log(`wrote ${dest}: ${Object.keys(art.byChampRole).length} champ|role cells, ${Object.keys(art.scaling).length} champs`);
}

module.exports = { shrinkRate, percentile, aggregateTiming };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: `[lol-champion-timing]` com `✓` nos 4 testes.

- [ ] **Step 5: Gerar o artefato do banco**

Run: `node scripts/train-lol-champion-timing.js`
Expected: `wrote .../lib/lol-champion-timing.json: ~136 champ|role cells, ~168 champs`.
Confirme: `node -e "const a=require('./lib/lol-champion-timing.json'); console.log(a.byChampRole['aatrox|top'], a.scaling.aatrox)"`.

- [ ] **Step 6: Commit**

```bash
git add scripts/train-lol-champion-timing.js tests/test-lol-champion-timing.js lib/lol-champion-timing.json
git commit -m "feat(match-lab): champion timing+scaling artifact from oracleselixir"
```

---

## Task 3: `lol-game-profile.js` — esqueleto + odd justa + edge

**Files:**
- Create: `lib/lol-game-profile.js`
- Test: `tests/test-lol-game-profile.js`

- [ ] **Step 1: Escrever o teste**

`tests/test-lol-game-profile.js`:
```js
'use strict';
const assert = require('assert');
const gp = require('../lib/lol-game-profile');

module.exports = function(t) {
  t.test('fairOdds = 1/p for both sides', () => {
    const fo = gp.fairOdds(0.7345);
    assert.ok(Math.abs(fo.team1 - 1.36) < 0.01, `team1 ~1.36, got ${fo.team1}`);
    assert.ok(Math.abs(fo.team2 - 3.77) < 0.02, `team2 ~3.77, got ${fo.team2}`);
  });
  t.test('fairOdds clamps extreme p without dividing by zero', () => {
    const fo = gp.fairOdds(1);
    assert.ok(isFinite(fo.team1) && isFinite(fo.team2), 'finite odds at p=1');
  });
  t.test('computeEdge = p*odd - 1 when bookOdds valid', () => {
    assert.ok(Math.abs(gp.computeEdge(0.7345, 1.85) - 0.359) < 0.002, 'edge ~0.359');
  });
  t.test('computeEdge null when bookOdds missing/invalid', () => {
    assert.strictEqual(gp.computeEdge(0.5, null), null, 'null odds -> null');
    assert.strictEqual(gp.computeEdge(0.5, 1), null, 'odd<=1 -> null');
    assert.strictEqual(gp.computeEdge(0.5, 'x'), null, 'non-number -> null');
  });
};
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: `[lol-game-profile]` com `✗` (módulo inexistente), exit 1.

- [ ] **Step 3: Criar o arquivo com esqueleto + odds**

`lib/lol-game-profile.js`:
```js
'use strict';
/**
 * lol-game-profile.js — Display-only "match reading" layer for the Match Lab panel.
 *
 * DISPLAY-ONLY: MUST NOT be called from any stake/EV/Kelly/betting path. It only
 * enriches the /edge analyzer with phase profile, fair odds/edge, win condition,
 * comp style and a data-quality badge.
 *
 * Honesty contract (spec §2):
 *   - early phase = MEASURED (golddiff/xpdiff @15 real)
 *   - mid/late    = ESTIMATED (scaling via game length) — labeled, lower confidence
 *   - comp style  = QUALITATIVE (Riot class tags heuristic) — not validated vs outcome
 */
const { normalizeChampion, normalizeRole } = require('./lol-champions');

// ── Artifact load (lazy, once) ──
let _art = null;
function _loadArtifacts() {
  if (_art) return _art;
  _art = { timing: require('./lol-champion-timing.json'), tags: require('./lol-champion-tags.json') };
  return _art;
}

// ── Odds (display-only; NOT a stake/EV/Kelly path) ──
function fairOdds(probTeam1) {
  const p = Math.max(1e-6, Math.min(1 - 1e-6, probTeam1));
  return { team1: +(1 / p).toFixed(2), team2: +(1 / (1 - p)).toFixed(2) };
}

function computeEdge(probTeam1, bookOdds) {
  if (typeof bookOdds !== 'number' || !(bookOdds > 1)) return null;
  return +((probTeam1 * bookOdds) - 1).toFixed(3);
}

module.exports = { fairOdds, computeEdge, _loadArtifacts };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: `[lol-game-profile]` com `✓` nos 4 testes.

- [ ] **Step 5: Commit**

```bash
git add lib/lol-game-profile.js tests/test-lol-game-profile.js
git commit -m "feat(match-lab): game-profile fair odds + edge (display-only)"
```

---

## Task 4: Perfil por fase (`phaseEdges`)

**Files:**
- Modify: `lib/lol-game-profile.js`
- Modify: `tests/test-lol-game-profile.js`

- [ ] **Step 1: Adicionar a fixture de artefato e os testes**

No topo de `tests/test-lol-game-profile.js` (após `const gp = ...`), adicione a fixture compartilhada:
```js
const ART = {
  timing: {
    byChampRole: {
      'aatrox|top': { golddiff15: 300, xpdiff15: 200, csdiff15: 5, n: 100 },
      'gnar|top':   { golddiff15: -100, xpdiff15: -50, csdiff15: -3, n: 80 },
      'jinx|bot':   { golddiff15: 50, xpdiff15: 30, csdiff15: 2, n: 120 },
      'caitlyn|bot':{ golddiff15: 120, xpdiff15: 60, csdiff15: 4, n: 90 },
    },
    scaling: {
      aatrox:  { index: -0.08, wrShort: 0.55, wrLong: 0.47, nShort: 50, nLong: 50 },
      gnar:    { index: 0.02, wrShort: 0.49, wrLong: 0.51, nShort: 40, nLong: 40 },
      jinx:    { index: 0.12, wrShort: 0.44, wrLong: 0.56, nShort: 60, nLong: 60 },
      caitlyn: { index: -0.10, wrShort: 0.56, wrLong: 0.46, nShort: 55, nLong: 55 },
    },
    expectedLen: { aatrox: 1900, gnar: 1850, jinx: 2100, caitlyn: 1700 },
  },
  tags: {
    aatrox:  { tags: ['Fighter', 'Tank'], info: { attack: 8, defense: 4, magic: 3, difficulty: 4 } },
    gnar:    { tags: ['Fighter', 'Tank'], info: { attack: 6, defense: 5, magic: 5, difficulty: 6 } },
    jinx:    { tags: ['Marksman'], info: { attack: 9, defense: 2, magic: 2, difficulty: 6 } },
    caitlyn: { tags: ['Marksman'], info: { attack: 8, defense: 2, magic: 2, difficulty: 6 } },
    orianna: { tags: ['Mage'], info: { attack: 4, defense: 3, magic: 8, difficulty: 7 } },
    zed:     { tags: ['Assassin'], info: { attack: 9, defense: 1, magic: 3, difficulty: 7 } },
    talon:   { tags: ['Assassin'], info: { attack: 9, defense: 3, magic: 1, difficulty: 7 } },
  },
};
const DRAFT = {
  blue: [{ champion: 'Aatrox', role: 'top' }, { champion: 'Jinx', role: 'bot' }],
  red:  [{ champion: 'Gnar', role: 'top' }, { champion: 'Caitlyn', role: 'bot' }],
};
```
E os testes de fase:
```js
  t.test('phaseEdges: early measured, blue ahead in gold', () => {
    const ph = gp.phaseEdges(DRAFT, ART.timing);
    // early: mean(blue gold 300,50)=175 - mean(red gold -100,120)=10 => +165
    assert.strictEqual(ph.early.measured, true, 'early measured');
    assert.strictEqual(ph.early.anchor.golddiff15, 165, 'early anchor gold = 165');
    assert.strictEqual(ph.early.winner, 'blue', 'blue wins early');
    assert.ok(ph.early.bars >= 0 && ph.early.bars <= 5, 'bars in [0,5]');
  });
  t.test('phaseEdges: late estimated, labeled', () => {
    const ph = gp.phaseEdges(DRAFT, ART.timing);
    assert.strictEqual(ph.late.measured, false, 'late not measured');
    assert.strictEqual(ph.late.label, 'estimativa', 'late labeled estimativa');
  });
  t.test('phaseEdges: mid is transition, lower confidence than early', () => {
    const ph = gp.phaseEdges(DRAFT, ART.timing);
    assert.strictEqual(ph.mid.label, 'transição', 'mid labeled transição');
    assert.ok(ph.mid.confidence < ph.early.confidence, 'mid less confident than early');
  });
  t.test('phaseEdges: even when no gold/scaling difference', () => {
    const mirror = { blue: [{ champion: 'Aatrox', role: 'top' }], red: [{ champion: 'Aatrox', role: 'top' }] };
    const ph = gp.phaseEdges(mirror, ART.timing);
    assert.strictEqual(ph.early.winner, 'even', 'mirror draft -> even early');
  });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: `[lol-game-profile]` com `✗` ("gp.phaseEdges is not a function").

- [ ] **Step 3: Implementar `phaseEdges`**

Em `lib/lol-game-profile.js`, antes do `module.exports`:
```js
// ── Phase profile ──
function _normC(p) { return normalizeChampion(p.champion); }
function _normR(p) { return normalizeRole(p.role); }

function _meanGold(picks, timing) {
  let sum = 0, cnt = 0;
  for (const p of (picks || [])) { const c = timing.byChampRole[_normC(p) + '|' + _normR(p)]; if (c && c.n > 0) { sum += c.golddiff15; cnt++; } }
  return cnt ? sum / cnt : 0;
}
function _meanXp(picks, timing) {
  let sum = 0, cnt = 0;
  for (const p of (picks || [])) { const c = timing.byChampRole[_normC(p) + '|' + _normR(p)]; if (c && c.n > 0) { sum += c.xpdiff15; cnt++; } }
  return cnt ? sum / cnt : 0;
}
function _meanScaling(picks, timing) {
  let sum = 0, cnt = 0;
  for (const p of (picks || [])) { const s = timing.scaling[_normC(p)]; if (s) { sum += s.index; cnt++; } }
  return cnt ? sum / cnt : 0;
}
function _phaseFromScore(score, banda = 0.1) {
  const winner = score > banda ? 'blue' : score < -banda ? 'red' : 'even';
  const bars = Math.round(Math.min(1, Math.abs(score)) * 5);
  return { winner, bars };
}

function phaseEdges(draft, timing) {
  const goldDiff = _meanGold(draft.blue, timing) - _meanGold(draft.red, timing);
  const xpDiff = _meanXp(draft.blue, timing) - _meanXp(draft.red, timing);
  const scaleDiff = _meanScaling(draft.blue, timing) - _meanScaling(draft.red, timing);

  const earlyScore = Math.tanh(goldDiff / 500);   // ~500 gold saturates
  const lateScore = Math.tanh(scaleDiff / 0.10);  // ~0.10 wr diff saturates
  const midScore = (earlyScore + lateScore) / 2;

  return {
    early: { ..._phaseFromScore(earlyScore), edge: +earlyScore.toFixed(3), measured: true,
             anchor: { golddiff15: Math.round(goldDiff), xpdiff15: Math.round(xpDiff) }, confidence: 0.8 },
    mid:   { ..._phaseFromScore(midScore), edge: +midScore.toFixed(3), measured: false, label: 'transição', confidence: 0.4 },
    late:  { ..._phaseFromScore(lateScore), edge: +lateScore.toFixed(3), measured: false, label: 'estimativa', confidence: 0.45 },
  };
}
```
Atualize o export: `module.exports = { fairOdds, computeEdge, phaseEdges, _loadArtifacts };`

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: `[lol-game-profile]` com `✓` em todos.

- [ ] **Step 5: Commit**

```bash
git add lib/lol-game-profile.js tests/test-lol-game-profile.js
git commit -m "feat(match-lab): phase profile (early measured, mid/late estimated)"
```

---

## Task 5: Tempo esperado + win condition

**Files:**
- Modify: `lib/lol-game-profile.js`
- Modify: `tests/test-lol-game-profile.js`

- [ ] **Step 1: Adicionar testes**

Em `tests/test-lol-game-profile.js`:
```js
  t.test('expectedTime averages gamelength of all 10 picks -> bucket', () => {
    const all = [...DRAFT.blue, ...DRAFT.red];
    const et = gp.expectedTime(all, ART.timing);
    // mean(1900,2100,1850,1700)=1887.5 -> 1888s -> 31.5min -> médio
    assert.strictEqual(et.seconds, 1888, 'seconds=1888');
    assert.strictEqual(et.bucket, 'médio', 'bucket médio');
  });
  t.test('winCondition: same side early+late -> all phases', () => {
    const s = gp.winCondition({ early: { winner: 'blue' }, late: { winner: 'blue' } });
    assert.ok(/todas as fases/.test(s), `got "${s}"`);
  });
  t.test('winCondition: early blue + late red -> convert before scaling', () => {
    const s = gp.winCondition({ early: { winner: 'blue' }, late: { winner: 'red' } });
    assert.ok(/converter/.test(s) && /Azul/.test(s), `got "${s}"`);
  });
  t.test('winCondition: all even -> execution call', () => {
    const s = gp.winCondition({ early: { winner: 'even' }, late: { winner: 'even' } });
    assert.ok(/equilibrad/.test(s), `got "${s}"`);
  });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: `✗` ("gp.expectedTime is not a function").

- [ ] **Step 3: Implementar**

Em `lib/lol-game-profile.js`, antes do `module.exports`:
```js
// ── Expected time & win condition ──
function expectedTime(allPicks, timing) {
  let sum = 0, n = 0;
  for (const p of (allPicks || [])) { const s = timing.expectedLen[_normC(p)]; if (s) { sum += s; n++; } }
  const seconds = n ? Math.round(sum / n) : 0;
  const min = seconds / 60;
  const bucket = !seconds ? 'desconhecido' : (min < 29 ? 'curto' : (min <= 34 ? 'médio' : 'longo'));
  return { seconds, bucket };
}

function winCondition(phases) {
  const e = phases.early.winner, l = phases.late.winner;
  const side = (w) => (w === 'blue' ? 'Azul' : 'Vermelho');
  if (e !== 'even' && e === l) return `${side(e)} favorecido em todas as fases.`;
  if (e !== 'even' && l !== 'even' && e !== l) return `${side(e)} leva a rota; precisa converter antes do ${side(l)} escalar pro late.`;
  if (e !== 'even' && l === 'even') return `${side(e)} leva a vantagem na rota; o jogo tende a equilibrar depois.`;
  if (e === 'even' && l !== 'even') return `Rota equilibrada; ${side(l)} tende a crescer no late.`;
  return 'Partida equilibrada; decisão tende a vir de execução, não de draft.';
}
```
Atualize export: `module.exports = { fairOdds, computeEdge, phaseEdges, expectedTime, winCondition, _loadArtifacts };`

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: `✓` em todos.

- [ ] **Step 5: Commit**

```bash
git add lib/lol-game-profile.js tests/test-lol-game-profile.js
git commit -m "feat(match-lab): expected time bucket + win-condition narrative"
```

---

## Task 6: Estilo de comp (teamfight/pick) — `compStyle`

**Files:**
- Modify: `lib/lol-game-profile.js`
- Modify: `tests/test-lol-game-profile.js`

- [ ] **Step 1: Adicionar testes**

Em `tests/test-lol-game-profile.js`:
```js
  t.test('compStyle: two assassins -> pick', () => {
    const c = gp.compStyle([{ champion: 'Zed', role: 'mid' }, { champion: 'Talon', role: 'jng' }], ART.tags);
    assert.strictEqual(c.style, 'pick', `got ${c.style}`);
    assert.ok(c.confidence <= 0.6, 'qualitative confidence capped');
  });
  t.test('compStyle: frontline + mage -> teamfight', () => {
    const c = gp.compStyle([{ champion: 'Aatrox' }, { champion: 'Gnar' }, { champion: 'Orianna' }], ART.tags);
    assert.strictEqual(c.style, 'teamfight', `got ${c.style}`);
  });
  t.test('compStyle: no trigger -> balanceado', () => {
    const c = gp.compStyle([{ champion: 'Jinx' }], ART.tags);
    assert.strictEqual(c.style, 'balanceado', `got ${c.style}`);
  });
  t.test('compStyle: unknown champ ignored, lowers confidence', () => {
    const c = gp.compStyle([{ champion: 'Nonexistent' }], ART.tags);
    assert.ok(c.confidence < 0.3, 'unknown -> low confidence');
  });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: `✗` ("gp.compStyle is not a function").

- [ ] **Step 3: Implementar**

Em `lib/lol-game-profile.js`, antes do `module.exports`:
```js
// ── Comp style (QUALITATIVE — Riot class tags heuristic, not outcome-validated) ──
function compStyle(picks, tags) {
  const counts = { Assassin: 0, Fighter: 0, Tank: 0, Mage: 0, Marksman: 0, Support: 0 };
  let known = 0, attackSum = 0, attackN = 0;
  for (const p of (picks || [])) {
    const tag = tags[_normC(p)];
    if (!tag) continue;
    known++;
    for (const cls of (tag.tags || [])) if (cls in counts) counts[cls]++;
    if (tag.info && typeof tag.info.attack === 'number') { attackSum += tag.info.attack; attackN++; }
  }
  const frontline = counts.Tank + counts.Fighter;
  const avgAttack = attackN ? attackSum / attackN : 0;
  let style = 'balanceado';
  if (counts.Assassin >= 2) style = 'pick';
  else if (frontline >= 2 && counts.Mage >= 1) style = 'teamfight';
  else if (counts.Mage >= 2 && counts.Marksman >= 1) style = 'poke/siege';
  else if (counts.Fighter >= 2 && avgAttack >= 7) style = 'split';
  const denom = (picks && picks.length) ? picks.length : 5;
  const confidence = +Math.max(0.2, Math.min(0.6, (known / denom) * 0.6)).toFixed(2);
  return { style, confidence };
}
```
Atualize export: `module.exports = { fairOdds, computeEdge, phaseEdges, expectedTime, winCondition, compStyle, _loadArtifacts };`

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: `✓` em todos.

- [ ] **Step 5: Commit**

```bash
git add lib/lol-game-profile.js tests/test-lol-game-profile.js
git commit -m "feat(match-lab): qualitative comp style from Riot class tags"
```

---

## Task 7: Qualidade + integração `computeGameProfile`

**Files:**
- Modify: `lib/lol-game-profile.js`
- Modify: `tests/test-lol-game-profile.js`

- [ ] **Step 1: Adicionar testes**

Em `tests/test-lol-game-profile.js`:
```js
  t.test('qualityBlock: full known + good sample -> alta', () => {
    const q = gp.qualityBlock({ knownChamps: 10, totalChamps: 10, laneMatchups: [{ n: 100 }, { n: 80 }], eloConfidence: 1 });
    assert.strictEqual(q.tier, 'alta', `got ${q.tier}`);
    assert.strictEqual(q.avgLaneN, 90, 'avgLaneN=90');
    assert.strictEqual(q.warnings.length, 0, 'no warnings');
  });
  t.test('qualityBlock: missing champs -> warning + lower tier', () => {
    const q = gp.qualityBlock({ knownChamps: 7, totalChamps: 10, laneMatchups: [{ n: 50 }], eloConfidence: 0.5 });
    assert.strictEqual(q.tier, 'média', `got ${q.tier}`);
    assert.ok(q.warnings.some(w => /sem dado/.test(w)), 'warns missing champs');
  });
  t.test('computeGameProfile: full output with draft', () => {
    const out = gp.computeGameProfile({
      draft: DRAFT, probTeam1: 0.7345, bookOdds: 1.85, eloConfidence: 1,
      laneMatchups: [{ n: 100 }, { n: 90 }], knownChamps: 4, totalChamps: 4,
    }, ART);
    assert.ok(out.phases && out.phases.early.winner === 'blue', 'phases present');
    assert.ok(out.expectedTime && out.compStyle && out.fairOdds, 'all blocks present');
    assert.ok(Math.abs(out.fairOdds.team1 - 1.36) < 0.01, 'fairOdds wired');
    assert.ok(out.edge !== null, 'edge computed when bookOdds given');
    assert.ok(out.quality && out.quality.tier, 'quality present');
  });
  t.test('computeGameProfile: no draft -> phases null, odds still present', () => {
    const out = gp.computeGameProfile({ draft: null, probTeam1: 0.6, bookOdds: null, eloConfidence: 1, laneMatchups: [], knownChamps: 0, totalChamps: 10 }, ART);
    assert.strictEqual(out.phases, null, 'phases null without draft');
    assert.strictEqual(out.compStyle, null, 'compStyle null without draft');
    assert.ok(out.fairOdds && out.edge === null, 'odds present, edge null');
  });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: `✗` ("gp.qualityBlock is not a function").

- [ ] **Step 3: Implementar**

Em `lib/lol-game-profile.js`, antes do `module.exports`:
```js
// ── Quality badge ──
function qualityBlock({ knownChamps = 0, totalChamps = 10, laneMatchups = [], eloConfidence = 0 }) {
  const avgLaneN = (laneMatchups && laneMatchups.length)
    ? Math.round(laneMatchups.reduce((s, l) => s + (l.n || 0), 0) / laneMatchups.length) : 0;
  const warnings = [];
  if (knownChamps < totalChamps) warnings.push(`${totalChamps - knownChamps} campeões sem dado`);
  if (laneMatchups && laneMatchups.length && avgLaneN < 20) warnings.push('amostra de rota baixa');
  const frac = totalChamps ? knownChamps / totalChamps : 0;
  let tier = 'baixa';
  if (frac >= 0.9 && avgLaneN >= 30 && eloConfidence >= 0.6) tier = 'alta';
  else if (frac >= 0.7) tier = 'média';
  return { knownChamps, totalChamps, avgLaneN, eloConfidence: +(eloConfidence || 0).toFixed(2), tier, warnings };
}

// ── Top-level: assemble the display-only game profile ──
function computeGameProfile(input, artifacts) {
  const art = artifacts || _loadArtifacts();
  const { draft, probTeam1, bookOdds = null, eloConfidence = 0, laneMatchups = [], knownChamps = 0, totalChamps = 10 } = input;

  let phases = null, expTime = null, winCond = null, comp = null;
  if (draft && Array.isArray(draft.blue) && draft.blue.length > 0) {
    phases = phaseEdges(draft, art.timing);
    const allPicks = [...draft.blue, ...(draft.red || [])];
    expTime = expectedTime(allPicks, art.timing);
    winCond = winCondition(phases);
    comp = { blue: compStyle(draft.blue, art.tags), red: compStyle(draft.red || [], art.tags) };
  }
  return {
    phases,
    expectedTime: expTime,
    winCondition: winCond,
    compStyle: comp,
    fairOdds: fairOdds(probTeam1),
    edge: computeEdge(probTeam1, bookOdds),
    quality: qualityBlock({ knownChamps, totalChamps, laneMatchups, eloConfidence }),
  };
}
```
Atualize export final:
```js
module.exports = { fairOdds, computeEdge, phaseEdges, expectedTime, winCondition, compStyle, qualityBlock, computeGameProfile, _loadArtifacts };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: `[lol-game-profile]` com `✓` em todos (e a suíte inteira segue verde — confirme `N passed, 0 failed`).

- [ ] **Step 5: Commit**

```bash
git add lib/lol-game-profile.js tests/test-lol-game-profile.js
git commit -m "feat(match-lab): quality badge + computeGameProfile assembler"
```

---

## Task 8: Wire no endpoint `/api/lol-match-analyze`

**Files:**
- Modify: `server.js` (bloco do endpoint, ~5334–5356)

- [ ] **Step 1: Ler o bloco atual pra confirmar contexto**

Run: `node -e "const s=require('fs').readFileSync('server.js','utf8').split('\n').slice(5332,5357).join('\n'); console.log(s)"`
Expected: ver o handler que chama `predictMatch` e faz `sendJson(res, { ok: true, ...out })`.

- [ ] **Step 2: Editar o handler**

Substitua, dentro do `try` do handler `/api/lol-match-analyze`, o trecho que vai de `const out = predictMatch({...})` até `sendJson(res, { ok: true, ...out });` por:
```js
        const out = predictMatch(db, {
          team1: json?.team1 || null,
          team2: json?.team2 || null,
          side: json?.side === 'red' ? 'red' : 'blue',
          draft,
          league: json?.league || null,
        });

        // Display-only game-profile enrichment (phases/odds/win-condition/quality).
        // Graceful: any failure (e.g. missing artifact) -> gameProfile null, base payload intact.
        let gameProfile = null;
        try {
          const { computeGameProfile } = require('./lib/lol-game-profile');
          let laneMatchups = [], knownChamps = 0, totalChamps = 10;
          if (draft) {
            const { computeDraftWinProb } = require('./lib/lol-draft-model');
            const d = computeDraftWinProb(draft);
            laneMatchups = d.breakdown.laneMatchups;
            knownChamps = d.breakdown.knownChamps;
            totalChamps = d.breakdown.totalChamps;
          }
          const bookOdds = (typeof json?.bookOdds === 'number') ? json.bookOdds : null;
          gameProfile = computeGameProfile({
            draft,
            probTeam1: out.prob,
            bookOdds,
            eloConfidence: (out.components && out.components.elo) ? out.components.elo.confidence : 0,
            laneMatchups, knownChamps, totalChamps,
          });
        } catch (e) {
          log('WARN', 'MATCH-LAB', `game-profile err: ${e.message}`);
          gameProfile = null;
        }

        sendJson(res, { ok: true, ...out, gameProfile });
```

- [ ] **Step 3: Validar sintaxe**

Run: `node -c server.js`
Expected: sem erro (exit 0).

- [ ] **Step 4: Rodar a suíte completa (nada quebrou)**

Run: `npm test`
Expected: `N passed, 0 failed`.

- [ ] **Step 5: Smoke local do endpoint** (precisa dos artefatos das Tasks 1–2 commitados)

Run:
```bash
node -e "
const Database=require('better-sqlite3');
const db=new Database('sportsedge.db',{readonly:true});
const { predictMatch }=require('./lib/lol-match-predict');
const { computeGameProfile }=require('./lib/lol-game-profile');
const { computeDraftWinProb }=require('./lib/lol-draft-model');
const draft={blue:[{champion:'Aatrox',role:'top'},{champion:'Jinx',role:'bot'}],red:[{champion:'Gnar',role:'top'},{champion:'Caitlyn',role:'bot'}]};
const out=predictMatch(db,{team1:'T1',team2:'Gen.G',side:'blue',draft});
const d=computeDraftWinProb(draft);
const gp=computeGameProfile({draft,probTeam1:out.prob,bookOdds:1.85,eloConfidence:out.components.elo?out.components.elo.confidence:0,laneMatchups:d.breakdown.laneMatchups,knownChamps:d.breakdown.knownChamps,totalChamps:d.breakdown.totalChamps});
console.log(JSON.stringify({prob:out.prob,gameProfile:gp},null,2));
db.close();
"
```
Expected: JSON com `gameProfile.phases.early.winner`, `fairOdds`, `edge` (≈ number), `quality.tier`.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat(match-lab): attach gameProfile to /api/lol-match-analyze (bookOdds optional)"
```

> **Nota P4 (não corrigir agora):** `computeDraftWinProb` roda duas vezes por request (uma dentro de `predictMatch`, outra aqui pro breakdown). Display-only, baixo volume — aceitável. Otimização futura: `predictMatch` expor o breakdown.

---

## Task 9: UI — seções no painel + input de odd da casa

**Files:**
- Modify: `public/lol-live-dashboard.html` (`dlRenderMatchResult`, ~2131)

- [ ] **Step 1: Localizar a função de render**

Run: `node -e "const s=require('fs').readFileSync('public/lol-live-dashboard.html','utf8').split('\n').slice(2130,2200).join('\n'); console.log(s)"`
Expected: ver `function dlRenderMatchResult(data, team1, team2)` e o uso do helper `el(tag, attrs, ...children)`.

- [ ] **Step 2: Adicionar a função de render do game-profile**

Logo após o fim de `dlRenderMatchResult`, adicione:
```js
function dlRenderGameProfile(root, data, team1, team2) {
  const gp = data.gameProfile;
  if (!gp) return;
  const sideName = (w) => (w === 'blue' ? (team1 || 'Azul') : (team2 || 'Vermelho'));
  const bar = (n) => '▰'.repeat(Math.max(0, n)) + '▱'.repeat(Math.max(0, 5 - n));

  // Fair odds + edge input
  const odds = el('div', { class: 'dl-gp-odds' },
    el('span', {}, `Odd justa: ${team1 || 'T1'} ${gp.fairOdds.team1}  ·  ${team2 || 'T2'} ${gp.fairOdds.team2}`));
  const edgeOut = el('span', { class: 'dl-gp-edge' }, gp.edge != null ? `edge: ${(gp.edge * 100).toFixed(1)}%` : '');
  const input = el('input', { type: 'number', step: '0.01', min: '1.01', placeholder: 'odd da casa', class: 'dl-gp-bookodds' });
  input.addEventListener('input', () => {
    const o = parseFloat(input.value);
    if (o > 1 && typeof data.prob === 'number') {
      const e = data.prob * o - 1;
      edgeOut.textContent = `edge: ${(e * 100).toFixed(1)}%  (modelo é leitura, não recomendação)`;
    } else { edgeOut.textContent = ''; }
  });
  odds.appendChild(el('div', { class: 'dl-gp-edgewrap' }, input, edgeOut));
  root.appendChild(odds);

  // Phases
  if (gp.phases) {
    const ph = el('div', { class: 'dl-gp-phases' }, el('div', { class: 'dl-gp-h' }, 'QUEM DOMINA CADA FASE'));
    const earlyAnchor = gp.phases.early.anchor;
    ph.appendChild(el('div', { class: 'dl-gp-row dl-gp-measured' },
      `EARLY  ${bar(gp.phases.early.bars)}  ${gp.phases.early.winner === 'even' ? '—' : sideName(gp.phases.early.winner)}`,
      el('span', { class: 'dl-gp-note' }, ` medido · ${earlyAnchor.golddiff15 >= 0 ? '+' : ''}${earlyAnchor.golddiff15}g, ${earlyAnchor.xpdiff15 >= 0 ? '+' : ''}${earlyAnchor.xpdiff15}xp @15`)));
    ph.appendChild(el('div', { class: 'dl-gp-row dl-gp-est' },
      `MID    ${bar(gp.phases.mid.bars)}  ${gp.phases.mid.winner === 'even' ? '—' : sideName(gp.phases.mid.winner)}`,
      el('span', { class: 'dl-gp-note' }, ' estimativa')));
    ph.appendChild(el('div', { class: 'dl-gp-row dl-gp-badge' },
      el('span', { class: 'dl-gp-note' }, `LATE · ${gp.phases.late.winner === 'even' ? 'equilibrado' : 'leve vantagem ' + sideName(gp.phases.late.winner)} ~ (scaling, sinal fraco)`)));
    root.appendChild(ph);
  }

  // Win condition + style + time
  if (gp.winCondition) {
    const wc = el('div', { class: 'dl-gp-wc' }, el('div', { class: 'dl-gp-h' }, 'COMO O JOGO TENDE A SER'));
    if (gp.expectedTime) wc.appendChild(el('div', {}, `• Tempo esperado: ${gp.expectedTime.bucket} (~${Math.round(gp.expectedTime.seconds / 60)} min)`));
    if (gp.compStyle) wc.appendChild(el('div', {}, `• Estilo: ${team1 || 'Azul'} ${gp.compStyle.blue.style} · ${team2 || 'Vermelho'} ${gp.compStyle.red.style}`));
    wc.appendChild(el('div', {}, `• ${gp.winCondition}`));
    root.appendChild(wc);
  }

  // Quality
  const q = gp.quality;
  const qtxt = `QUALIDADE: ${q.knownChamps}/${q.totalChamps} campeões · ${q.tier}` + (q.warnings.length ? ` · ⚠ ${q.warnings.join(', ')}` : '');
  root.appendChild(el('div', { class: 'dl-gp-quality' }, qtxt));
  root.appendChild(el('div', { class: 'dl-gp-warn' }, '⚠ draft é sinal fraco — leitura, não ordem de aposta'));
}
```

- [ ] **Step 3: Chamar a função no fim de `dlRenderMatchResult`**

No fim de `dlRenderMatchResult(data, team1, team2)`, antes do `}` de fechamento (após o bloco que renderiza os confrontos de rota já existente), adicione:
```js
  dlRenderGameProfile(root, data, team1, team2);
```

- [ ] **Step 4: Adicionar CSS mínimo**

Localize o `<style>` do dashboard (`node -e "const s=require('fs').readFileSync('public/lol-live-dashboard.html','utf8'); console.log(s.indexOf('</style>'))"`) e, antes do `</style>`, insira:
```css
.dl-gp-odds,.dl-gp-phases,.dl-gp-wc{margin-top:10px;padding-top:8px;border-top:1px solid #1a2a3a}
.dl-gp-h{color:#5a7a9a;font-size:11px;letter-spacing:1px;margin-bottom:4px}
.dl-gp-row{font-family:monospace;font-size:13px;line-height:1.6}
.dl-gp-measured{color:#cfe}.dl-gp-est{color:#9ab}.dl-gp-badge{color:#789;font-style:italic}
.dl-gp-note{color:#678;font-size:11px}
.dl-gp-edgewrap{margin-top:4px}.dl-gp-bookodds{width:90px;background:#0a1520;border:1px solid #1a2a3a;color:#cfe;padding:2px 6px}
.dl-gp-edge{margin-left:8px;color:#7c9}
.dl-gp-quality{margin-top:8px;color:#678;font-size:11px}
.dl-gp-warn{margin-top:4px;color:#a86;font-size:11px}
```

- [ ] **Step 5: Verificar que o markup foi inserido**

Run: `node -e "const s=require('fs').readFileSync('public/lol-live-dashboard.html','utf8'); console.log('renderGP:', s.includes('dlRenderGameProfile'), 'call:', (s.match(/dlRenderGameProfile/g)||[]).length, 'css:', s.includes('dl-gp-phases'))"`
Expected: `renderGP: true call: 2 css: true` (1 definição + 1 chamada).

- [ ] **Step 6: Commit**

```bash
git add public/lol-live-dashboard.html
git commit -m "feat(match-lab): UI sections (phases/odds/edge/win-condition/quality)"
```

---

## Task 10: Smoke de produção (pós-merge/deploy)

**Files:** nenhum (verificação)

- [ ] **Step 1: Merge da branch + push** (libera deploy Railway)

Conforme o fluxo de finalização (superpowers:finishing-a-development-branch). `git push origin main` é autorizado por padrão.

- [ ] **Step 2: Smoke prod** (após o deploy subir — confira `code_sha` novo em `/health`)

PowerShell (Invoke-RestMethod funciona no ambiente):
```powershell
$BASE='https://sportsedge-bot-production.up.railway.app'
$body=@{team1='T1';team2='Gen.G';side='blue';bookOdds=1.85;
  blue=@(@{champion='Aatrox';role='top'},@{champion='Jinx';role='bot'});
  red=@(@{champion='Gnar';role='top'},@{champion='Caitlyn';role='bot'})} | ConvertTo-Json
$r=Invoke-RestMethod -Uri "$BASE/api/lol-match-analyze" -Method POST -Body $body -ContentType 'application/json'
$r | ConvertTo-Json -Depth 6
```
Expected: `ok=true`, `prob` presente, `gameProfile.phases.early.winner`, `gameProfile.fairOdds`, `gameProfile.edge` numérico, `gameProfile.quality.tier`.

- [ ] **Step 3: Smoke da UI**

```powershell
$edge=Invoke-WebRequest -Uri "$BASE/edge" -UseBasicParsing
"hasRenderGP=$($edge.Content -match 'dlRenderGameProfile')  status=$($edge.StatusCode)"
```
Expected: `hasRenderGP=True status=200`.

- [ ] **Step 4: Atualizar a memory**

Anexar resultado ao arquivo de projeto do Match Lab (`memory/project_match_lab_2026_06_01.md`): game-profile shipped, commit final, resultado do smoke.

---

## Self-Review

**1. Cobertura do spec:**
- §1 quatro blocos → Tasks 4 (fases), 3 (odds/edge), 5 (tempo/win-cond), 6 (estilo), 7 (quality). ✓
- §2 medido/estimado/qualitativo → flags `measured`/`label`/confidence em phaseEdges (T4) e compStyle cap 0.6 (T6). ✓
- §3 display-only / `prob` byte-idêntico → T8 só anexa `gameProfile`, não toca `out`. ✓
- §4 fontes → T1 (tags) + T2 (timing). ✓
- §5 arquitetura/reuso (normalize, sem dep/migration) → T1–T3 reusam `lol-champions`; nenhum `require` de lib npm nova. ✓
- §6 matemática → shrinkRate/aggregateTiming (T2), phaseEdges/expectedTime/compStyle/quality (T4–T7). ✓
- §7 contrato API (`bookOdds` in, `gameProfile` out) → T8. ✓
- §8 layout (early barra, mid esmaecido, late selo) → T9 classes `dl-gp-measured/est/badge`. ✓
- §9 edge cases (champ desconhecido neutro, sem draft → null, artefato ausente → null+log) → T6/T7 tests + T8 try/catch. ✓
- §10 testes → arquivos de teste em T1–T7. ✓

**2. Placeholder scan:** sem TBD/TODO; todo step de código tem código completo. ✓

**3. Consistência de tipos:** artefato `byChampRole["champ|role"]={golddiff15,xpdiff15,csdiff15,n}` e `scaling["champ"]={index,...}` idênticos entre T2 (geração) e T4/T5 (consumo). `computeGameProfile` retorna o shape do §7, consumido em T9 (`gp.phases.early.bars`, `gp.fairOdds.team1`, `gp.quality.tier`). `compStyle` retorna `{style,confidence}` usado em T9 (`gp.compStyle.blue.style`). ✓
