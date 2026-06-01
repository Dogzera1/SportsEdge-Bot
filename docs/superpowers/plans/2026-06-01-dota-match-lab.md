# Dota Match Lab (leve) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Painel "Dota Lab" no `/edge` que prevê P(vitória) por Elo (calibrado) + leitura de draft pela IA, display-only.

**Architecture:** Backtest valida o Elo de Dota e grava calibração; `dota-match-predict` prevê via Elo+calib (draft = leitura separada); `dota-match-explain` pede ao Sonnet a leitura de draft com o conhecimento dele; endpoints + painel próprio na UI. Espelha o Match Lab de LoL, sem o game-profile de fases.

**Tech Stack:** Node 18, better-sqlite3, http nativo, `createEloSystem`, `dota-hero-features`, `aiPost`. Runner `node tests/run.js`. Sem dep npm, sem migration.

**Spec:** `docs/superpowers/specs/2026-06-01-dota-match-lab-design.md`

---

## Convenções
- Suíte: `npm test` (`tests/test-*.js`). Suites novas: `[dota-match-predict]`, `[dota-match-explain]`. Fail=`✗`+exit1.
- Teste: `module.exports = function(t){ t.test('nome', () => {...}); }`, `const assert=require('assert')`.
- Commits inglês + trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Estrutura de arquivos
| Arquivo | Responsabilidade |
|---|---|
| `scripts/backtest-dota-match.js` (criar) | Replay Elo em `match_results` dota2 → Brier/ECE vs base-rate → isotônica opcional → `lib/dota-match-{meta,calib}.json` |
| `lib/dota-match-predict.js` (criar) | `predictMatch(db,{team1,team2,side,draft})` → Elo+calib (prob) + draft como leitura |
| `lib/dota-match-explain.js` (criar) | `buildDotaExplainPrompt` + `parseDotaExplain` (4 seções) |
| `tests/test-dota-match-predict.js`, `tests/test-dota-match-explain.js` (criar) | testes |
| `server.js` (modificar ~5384, após `/api/lol-teams`) | 4 endpoints dota |
| `public/lol-live-dashboard.html` (modificar) | overlay "Dota Lab" + render |

---

## Task 1: Backtest + calibração do Elo de Dota

**Files:** Create `scripts/backtest-dota-match.js`; Output `lib/dota-match-meta.json` + `lib/dota-match-calib.json`.

Este é um SCRIPT de geração (não TDD) — espelha a parte "series replay" de `scripts/backtest-lol-match.js` (linhas 113-184 + `fitIsotonicPav`), mas SEM draft/form join (Dota não tem). Reusa `lib/lol-match-metrics` (`M.brier/logloss/ece`) e `_applyIsotonicBlocks` de `lib/brier-holdout-eval`.

- [ ] **Step 1: Escrever o script** — `scripts/backtest-dota-match.js`:
```js
'use strict';
// Point-in-time Elo replay for the Dota match predictor. No draft/form (Dota has no
// historical draft in match_results). Predicts P(team1 wins); getP() BEFORE rate() (no leakage).
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { createEloSystem } = require('../lib/elo-rating');
const { _applyIsotonicBlocks } = require('../lib/brier-holdout-eval');
const M = require('../lib/lol-match-metrics');

const db = new Database(path.join(__dirname, '..', 'sportsedge.db'), { readonly: true });
const ELO_CONFIG = { kBase: 32, kMin: 10, kScale: 40, halfLifeDays: 0, confidenceScale: 20, confidenceFloor: 5 };
const clamp01 = (p) => Math.max(1e-6, Math.min(1 - 1e-6, p));

const games = db.prepare(`
  SELECT team1, team2, winner, final_score, resolved_at
  FROM match_results
  WHERE game='dota2' AND winner IS NOT NULL AND winner!=''
    AND team1 IS NOT NULL AND team2 IS NOT NULL
  ORDER BY resolved_at ASC
`).all();

const elo = createEloSystem(ELO_CONFIG);
const samples = []; // { p: P(team1 wins), y }
for (const g of games) {
  const pred = elo.getP(g.team1, g.team2);              // PREDICT first
  const y = (String(g.winner).toLowerCase() === String(g.team1).toLowerCase()) ? 1 : 0;
  if (pred.foundA && pred.foundB && pred.confidence > 0) samples.push({ p: pred.pA, y, date: g.resolved_at });
  const winner = y ? g.team1 : g.team2, loser = y ? g.team2 : g.team1;
  const sc = String(g.final_score || '').match(/(\d+)\s*[-:]\s*(\d+)/);
  const margin = sc ? Math.max(1, Math.abs(parseInt(sc[1]) - parseInt(sc[2]))) : 1;
  elo.rate(winner, loser, margin, g.resolved_at);        // UPDATE after
}
db.close();

// Walk-forward 70/30 by date
samples.sort((a, b) => String(a.date) < String(b.date) ? -1 : 1);
const cut = Math.floor(samples.length * 0.7);
const train = samples.slice(0, cut), test = samples.slice(cut);
const pStar = train.reduce((s, x) => s + x.y, 0) / Math.max(1, train.length); // base rate (team1 win)

// PAV isotonic on TRAIN (same shape as backtest-lol-match fitIsotonicPav)
function fitIsotonicPav(smp, nBins = 12) {
  if (!smp.length) return [];
  const bins = Array.from({ length: nBins }, () => ({ sumP: 0, sumY: 0, n: 0 }));
  for (const { p, y } of smp) { let i = Math.floor(clamp01(p) * nBins); i = Math.max(0, Math.min(nBins - 1, i)); bins[i].sumP += p; bins[i].sumY += y; bins[i].n++; }
  let arr = bins.filter(b => b.n >= 3).map(b => ({ pMin: b.sumP / b.n, pMax: b.sumP / b.n, yMean: b.sumY / b.n, n: b.n }));
  if (arr.length < 2) return [];
  let i = 0;
  while (i < arr.length - 1) {
    if (arr[i].yMean > arr[i + 1].yMean) { const a = arr[i], b = arr[i + 1], n = a.n + b.n; arr.splice(i, 2, { pMin: Math.min(a.pMin, b.pMin), pMax: Math.max(a.pMax, b.pMax), yMean: (a.yMean * a.n + b.yMean * b.n) / n, n }); if (i > 0) i--; } else i++;
  }
  arr.sort((a, b) => a.pMin - b.pMin);
  for (let k = 0; k < arr.length; k++) { arr[k].pMin = (k === 0) ? 0 : (arr[k - 1].pMax + arr[k].pMin) / 2; arr[k].pMax = (k === arr.length - 1) ? 1 : arr[k].pMax; }
  for (let k = 0; k < arr.length - 1; k++) { const mid = (arr[k].pMax + arr[k + 1].pMin) / 2; arr[k].pMax = mid; arr[k + 1].pMin = mid; }
  return arr.map(b => ({ pMin: +b.pMin.toFixed(6), pMax: +b.pMax.toFixed(6), yMean: +b.yMean.toFixed(6), n: b.n }));
}
let blocks = fitIsotonicPav(train);
const testRaw = test.map(s => ({ p: s.p, y: s.y }));
const testCal = test.map(s => ({ p: _applyIsotonicBlocks(blocks, s.p), y: s.y }));
const brierRaw = M.brier(testRaw);
const brierCal = blocks.length ? M.brier(testCal) : Infinity;
const keptOOS = blocks.length > 0 && brierCal < brierRaw;
if (!keptOOS) blocks = [];
const baselineBrier = M.brier(test.map(s => ({ p: pStar, y: s.y })));

console.log(`[dota] n=${samples.length} (train=${train.length} test=${test.length}) baseRate(team1)=${pStar.toFixed(4)}`);
console.log(`[dota] Elo raw:   Brier=${brierRaw.toFixed(4)} ECE=${M.ece(testRaw).toFixed(4)}`);
console.log(`[dota] baseline:  Brier=${baselineBrier.toFixed(4)}`);
console.log(`[dota] Elo beats base-rate OOS? ${brierRaw < baselineBrier ? 'YES' : 'NO'}  | calib kept? ${keptOOS}`);

fs.writeFileSync(path.join(__dirname, '..', 'lib', 'dota-match-meta.json'), JSON.stringify({
  game: 'dota2', level: 'match', predicts: 'P(team1 wins)', eloConfig: ELO_CONFIG, trainedAt: new Date().toISOString(),
  n: samples.length, walkForward: { trainN: train.length, testN: test.length }, baseRate: +pStar.toFixed(6),
  oos: { baselineBrier: +baselineBrier.toFixed(6), eloRawBrier: +brierRaw.toFixed(6), eloRawEce: +M.ece(testRaw).toFixed(6), beatsBaseline: brierRaw < baselineBrier },
}, null, 2));
fs.writeFileSync(path.join(__dirname, '..', 'lib', 'dota-match-calib.json'), JSON.stringify({ method: 'isotonic_pav', blocks, keptOOS }, null, 2));
console.log('[dota] wrote lib/dota-match-meta.json + lib/dota-match-calib.json');
```

- [ ] **Step 2: Rodar o backtest** — `node scripts/backtest-dota-match.js`. Expected: imprime `n=...`, Brier do Elo vs baseline, `beatsBaseline`, e escreve os 2 artefatos. **GATE DE HONESTIDADE:** anote no report se `beatsBaseline` é YES ou NO (se NO, o controller avisa o user — não exibimos um modelo que não supera o coinflip sem aviso).

- [ ] **Step 3: Verificar os artefatos** — `node -e "const m=require('./lib/dota-match-meta.json'); console.log(JSON.stringify(m.oos), 'eloConfig:', !!m.eloConfig); const c=require('./lib/dota-match-calib.json'); console.log('calib blocks:', c.blocks.length, 'kept:', c.keptOOS)"`. Expected: meta com `oos.beatsBaseline` + eloConfig presente; calib válido.

- [ ] **Step 4: Commit**
```bash
git add scripts/backtest-dota-match.js lib/dota-match-meta.json lib/dota-match-calib.json
git commit -m "feat(dota-lab): Elo backtest + calibration artifacts (honesty gate)"
```

---

## Task 2: `lib/dota-match-predict.js`

**Files:** Create `lib/dota-match-predict.js`; Test `tests/test-dota-match-predict.js`. Espelha `lib/lol-match-predict.js` mas: SÓ Elo no prob (sem blend de draft); draft é leitura via `getDraftMatchupFactor`.

- [ ] **Step 1: Escrever o teste** — `tests/test-dota-match-predict.js`:
```js
'use strict';
const assert = require('assert');
const Database = require('better-sqlite3');
const path = require('path');
const { predictMatch } = require('../lib/dota-match-predict');
const db = new Database(path.join(__dirname, '..', 'sportsedge.db'), { readonly: true });

module.exports = function(t) {
  // pick two real dota teams with history
  const teams = db.prepare("SELECT team1, COUNT(*) n FROM match_results WHERE game='dota2' AND team1 IS NOT NULL AND team1!='' GROUP BY team1 ORDER BY n DESC LIMIT 2").all().map(r => r.team1);
  const T1 = teams[0], T2 = teams[1];

  t.test('prob in [0,1] for known teams', () => {
    const out = predictMatch(db, { team1: T1, team2: T2, side: 'blue' });
    assert.ok(typeof out.prob === 'number' && out.prob >= 0 && out.prob <= 1, `prob in [0,1], got ${out.prob}`);
    assert.ok(out.components && 'elo' in out.components, 'components.elo present');
  });
  t.test('no teams -> prob 0.5, lean fraco', () => {
    const out = predictMatch(db, { team1: null, team2: null, side: 'blue' });
    assert.strictEqual(out.prob, 0.5); assert.strictEqual(out.label, 'lean fraco');
  });
  t.test('side red flips probBlue orientation', () => {
    const a = predictMatch(db, { team1: T1, team2: T2, side: 'blue' });
    const b = predictMatch(db, { team1: T1, team2: T2, side: 'red' });
    assert.ok(a.prob >= 0 && b.prob >= 0, 'both valid');
    if (a.components.elo && b.components.elo) assert.ok(Math.abs(a.components.elo.pBlue + b.components.elo.pBlue - 1) < 0.001, 'elo pBlue complementary');
  });
  t.test('draft present -> components.draft populated (or null if heroes unknown)', () => {
    const out = predictMatch(db, { team1: T1, team2: T2, side: 'blue', draft: { blue: ['Invoker','Juggernaut','Crystal Maiden','Axe','Lion'], red: ['Pudge','Anti-Mage','Lina','Tidehunter','Witch Doctor'] } });
    assert.ok(out.components.draft === null || (typeof out.components.draft.blueWR === 'number'), 'draft read shape');
  });
  console.log('Sample dota predictMatch:', JSON.stringify(predictMatch(db, { team1: T1, team2: T2, side: 'blue' })));
  db.close();
};
```

- [ ] **Step 2: Rodar e ver falhar** — `npm test`. Expected: `[dota-match-predict]` `✗` (módulo inexistente).

- [ ] **Step 3: Implementar** — `lib/dota-match-predict.js`:
```js
'use strict';
/**
 * dota-match-predict.js — Display-only Dota match predictor.
 * prob = Elo (calibrated). Draft is a SEPARATE read (WR), not in the number.
 * DISPLAY-ONLY: must not feed stake/EV/Kelly.
 */
const { createEloSystem } = require('./elo-rating');
const { getDraftMatchupFactor } = require('./dota-hero-features');
const { _applyIsotonicBlocks } = require('./brier-holdout-eval');
const META = require('./dota-match-meta.json');
const CALIB = require('./dota-match-calib.json');

let _elo = null, _eloTs = 0;
const ELO_TTL = 3600_000;
function _dotaElo(db) {
  if (_elo && Date.now() - _eloTs < ELO_TTL) return _elo;
  _elo = createEloSystem(META.eloConfig);
  _elo.bootstrap(db, 'dota2', () => undefined, { maxAgeDays: 100000 });
  _eloTs = Date.now();
  return _elo;
}

function predictMatch(db, { team1, team2, side = 'blue', draft = null } = {}) {
  const blueTeam = (side === 'blue') ? team1 : team2;
  const redTeam  = (side === 'blue') ? team2 : team1;

  let pEloBlue = null, eloConf = 0, ratingBlue = null, ratingRed = null;
  if (blueTeam && redTeam) {
    const e = _dotaElo(db).getP(blueTeam, redTeam);
    if (e.foundA && e.foundB && e.confidence > 0) { pEloBlue = e.pA; eloConf = e.confidence; ratingBlue = e.ratingA; ratingRed = e.ratingB; }
  }

  let probBlue = (pEloBlue == null) ? 0.5 : pEloBlue;
  if (pEloBlue != null && CALIB.blocks && CALIB.blocks.length > 0) probBlue = _applyIsotonicBlocks(CALIB.blocks, probBlue);
  probBlue = Math.max(0, Math.min(1, probBlue));
  const probTeam1 = (side === 'blue') ? probBlue : (1 - probBlue);

  // Draft READ (separate from the prob).
  let draftRead = null;
  if (draft && Array.isArray(draft.blue) && draft.blue.length > 0) {
    const f = getDraftMatchupFactor(db, draft.blue, draft.red || []);
    if (f) draftRead = { blueWR: f.blueWR, redWR: f.redWR, factor: f.factor };
  }

  let confidence, label;
  if (pEloBlue !== null) { confidence = eloConf; label = eloConf > 0.6 ? 'forte' : 'lean'; }
  else { confidence = 0.2; label = 'lean fraco'; }

  return {
    prob: +probTeam1.toFixed(4), probBlue: +probBlue.toFixed(4),
    components: {
      elo: pEloBlue !== null ? { pBlue: +pEloBlue.toFixed(4), confidence: +eloConf.toFixed(2), ratingBlue, ratingRed } : null,
      draft: draftRead,
    },
    confidence: +confidence.toFixed(2), label,
  };
}
module.exports = { predictMatch };
```

- [ ] **Step 4: Rodar e ver passar** — `npm test`. Expected: `[dota-match-predict]` `✓`, suíte `0 failed`.

- [ ] **Step 5: Commit**
```bash
git add lib/dota-match-predict.js tests/test-dota-match-predict.js
git commit -m "feat(dota-lab): Elo-calibrated match predictor (draft as read, display-only)"
```

---

## Task 3: `lib/dota-match-explain.js`

**Files:** Create `lib/dota-match-explain.js`; Test `tests/test-dota-match-explain.js`. Espelha `lib/lol-match-explain.js` mas: 4 seções, autoriza conhecimento próprio da IA.

- [ ] **Step 1: Escrever o teste** — `tests/test-dota-match-explain.js`:
```js
'use strict';
const assert = require('assert');
const { buildDotaExplainPrompt, parseDotaExplain } = require('../lib/dota-match-explain');

const PRED = { prob: 0.59, probBlue: 0.59, components: { elo: { pBlue: 0.59, confidence: 1, ratingBlue: 1535, ratingRed: 1470 }, draft: { blueWR: 0.53, redWR: 0.51, factor: 1.3 } }, label: 'lean' };
const DRAFT = { blue: ['Invoker','Juggernaut','Crystal Maiden','Axe','Lion'], red: ['Pudge','Anti-Mage','Lina','Tidehunter','Witch Doctor'] };

module.exports = function(t) {
  t.test('prompt has Elo, ratings, draft, heroes + own-knowledge + no-stake', () => {
    const p = buildDotaExplainPrompt({ pred: PRED, draft: DRAFT, teams: { blue: 'Team A', red: 'Team B' }, fairOdds: { team1: 1.69, team2: 2.44 }, edge: null });
    assert.ok(/Elo/.test(p) && /1535/.test(p), 'elo + ratings');
    assert.ok(/Invoker/.test(p) && /Anti-Mage/.test(p), 'heroes');
    assert.ok(/conhecimento/i.test(p), 'authorizes own knowledge');
    assert.ok(/APENAS um JSON/.test(p) && /NÃO recomende stake/.test(p), 'json + no-stake');
  });
  t.test('parse 4 keys with prose around', () => {
    const o = parseDotaExplain('ok {"overview":"a","draftRead":"b","keyHeroes":"c","verdict":"d"} fim');
    assert.strictEqual(o.overview, 'a'); assert.strictEqual(o.verdict, 'd');
  });
  t.test('parse null for non-json; fills missing keys', () => {
    assert.strictEqual(parseDotaExplain('nada'), null);
    const o = parseDotaExplain('{"overview":"x"}'); assert.strictEqual(o.overview, 'x'); assert.strictEqual(o.verdict, '');
  });
};
```

- [ ] **Step 2: Rodar e ver falhar** — `npm test`. Expected: `[dota-match-explain]` `✗`.

- [ ] **Step 3: Implementar** — `lib/dota-match-explain.js`:
```js
'use strict';
/**
 * dota-match-explain.js — Display-only Dota AI reading.
 * Prob is the Elo (the model). The AI reads the draft using its OWN Dota knowledge
 * (synergies/counters/timings) — labeled as general knowledge (may not match the live patch).
 */
const KEYS = ['overview', 'draftRead', 'keyHeroes', 'verdict'];

function buildDotaExplainPrompt({ pred, draft, teams, fairOdds, edge }) {
  const t = teams || {};
  const el = pred.components && pred.components.elo;
  const dr = pred.components && pred.components.draft;
  const lines = [];
  lines.push('Dados da partida de Dota 2 (modelo estatístico display-only — NÃO são apostas):');
  lines.push(`- Times: Azul=${t.blue || '(não informado)'}, Vermelho=${t.red || '(não informado)'}`);
  if (el) lines.push(`- P(Azul vence) ~ ${Math.round((pred.probBlue) * 100)}% (${pred.label}); Elo: Azul ${el.ratingBlue} vs Vermelho ${el.ratingRed}`);
  if (fairOdds) { let o = `- Odd justa: Azul ${fairOdds.team1} / Vermelho ${fairOdds.team2}`; if (edge != null) o += `; edge vs odd da casa: ${(edge * 100).toFixed(1)}%`; lines.push(o); }
  if (dr) lines.push(`- Força de draft (winrate meta, dado): Azul ${(dr.blueWR * 100).toFixed(1)}% vs Vermelho ${(dr.redWR * 100).toFixed(1)}%`);
  if (draft) { const f = (a) => (a || []).join(', '); lines.push(`- Heróis Azul: ${f(draft.blue)}`); lines.push(`- Heróis Vermelho: ${f(draft.red)}`); }
  lines.push('');
  lines.push('Você é um analista de Dota 2. O prob acima vem do Elo (NÃO o altere). Para a leitura do draft, USE O SEU CONHECIMENTO sobre os heróis (sinergias, counters, win conditions, power spikes, timings).');
  lines.push('Responda APENAS um JSON compacto, nada fora dele, em PT-BR:');
  lines.push('{"overview":"…","draftRead":"…","keyHeroes":"…","verdict":"…"}');
  lines.push('Regras: cada campo 1-2 frases; o verdict se apoia no Elo/odd justa (não invente probabilidade); a leitura de draft é o seu conhecimento geral (pode não refletir o patch atual); NÃO recomende stake nem diga "aposte".');
  return lines.join('\n');
}

function parseDotaExplain(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj; try { obj = JSON.parse(m[0]); } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (!KEYS.some(k => typeof obj[k] === 'string' && obj[k].trim())) return null;
  const out = {}; for (const k of KEYS) out[k] = (typeof obj[k] === 'string') ? obj[k] : '';
  return out;
}
module.exports = { buildDotaExplainPrompt, parseDotaExplain };
```

- [ ] **Step 4: Rodar e ver passar** — `npm test`. Expected: `[dota-match-explain]` `✓`.

- [ ] **Step 5: Commit**
```bash
git add lib/dota-match-explain.js tests/test-dota-match-explain.js
git commit -m "feat(dota-lab): AI explain prompt (own-knowledge draft read) + parser"
```

---

## Task 4: Endpoints

**Files:** Modify `server.js` — inserir após o handler `/api/lol-teams` (~5397), antes do print-parse.

- [ ] **Step 1: Confirmar o ponto de inserção** — `node -e "const s=require('fs').readFileSync('server.js','utf8').split('\n').slice(5395,5400).join('\n'); console.log(s)"`. Localize o `}` do `/api/lol-teams` via Grep e insira depois.

- [ ] **Step 2: Inserir os 4 handlers:**
```js
  // Dota Lab — team autocomplete (display-only)
  if (p === '/api/dota-teams' && req.method === 'GET') {
    try {
      const rows = db.prepare(`SELECT team1 t FROM match_results WHERE game='dota2' AND team1 IS NOT NULL AND team1!=''
                               UNION SELECT team2 t FROM match_results WHERE game='dota2' AND team2 IS NOT NULL AND team2!=''`).all();
      sendJson(res, { ok: true, teams: [...new Set(rows.map(r => r.t))].sort((a, b) => a.localeCompare(b)) });
    } catch (e) { sendJson(res, { ok: false, error: 'teams_failed' }, 500); }
    return;
  }
  // Dota Lab — hero autocomplete (display-only)
  if (p === '/api/dota-heroes' && req.method === 'GET') {
    try {
      const rows = db.prepare(`SELECT DISTINCT localized_name n FROM dota_hero_stats WHERE localized_name IS NOT NULL AND localized_name!='' ORDER BY localized_name`).all();
      sendJson(res, { ok: true, heroes: rows.map(r => r.n) });
    } catch (e) { sendJson(res, { ok: false, error: 'heroes_failed' }, 500); }
    return;
  }
  // Dota Lab — match analyze (Elo + draft read, display-only)
  if (p === '/api/dota-match-analyze' && req.method === 'POST') {
    _readPostBody(req, res, (body) => {
      if (body == null) return;
      try {
        const json = safeParse(body, null);
        const { predictMatch } = require('./lib/dota-match-predict');
        const draft = (Array.isArray(json?.blue) && Array.isArray(json?.red) && json.blue.length && json.red.length)
          ? { blue: json.blue.slice(0, 5), red: json.red.slice(0, 5) } : null;
        const out = predictMatch(db, { team1: json?.team1 || null, team2: json?.team2 || null, side: json?.side === 'red' ? 'red' : 'blue', draft });
        const p1 = Math.max(1e-6, Math.min(1 - 1e-6, out.prob));
        const fairOdds = { team1: +(1 / p1).toFixed(2), team2: +(1 / (1 - p1)).toFixed(2) };
        const bookOdds = (typeof json?.bookOdds === 'number' && json.bookOdds > 1) ? json.bookOdds : null;
        const edge = bookOdds ? +((out.prob * bookOdds) - 1).toFixed(3) : null;
        sendJson(res, { ok: true, ...out, fairOdds, edge });
      } catch (e) { log('WARN', 'DOTA-LAB', `analyze err: ${e.message}`); sendJson(res, { ok: false, error: 'dota_analyze_failed' }, 500); }
    });
    return;
  }
  // Dota Lab — AI explain (Sonnet, capped, display-only)
  if (p === '/api/dota-match-explain' && req.method === 'POST') {
    _readPostBody(req, res, async (body) => {
      if (body == null) return;
      try {
        const KEY = process.env.ANTHROPIC_API_KEY;
        if (!KEY) { sendJson(res, { ok: false, error: 'vision_disabled' }, 503); return; }
        const json = safeParse(body, null);
        const draft = (Array.isArray(json?.blue) && Array.isArray(json?.red) && json.blue.length && json.red.length)
          ? { blue: json.blue.slice(0, 5), red: json.red.slice(0, 5) } : null;
        if (!json?.team1 && !json?.team2 && !draft) { sendJson(res, { ok: false, error: 'empty_match' }, 400); return; }
        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
        const cap = parseInt(process.env.AI_ANALYSIS_DAILY_CAP || '30', 10);
        const _amap = (global._aiAnalysisDayMap = global._aiAnalysisDayMap || new Map());
        const dayKey = `${ip}|${new Date().toISOString().slice(0, 10)}`;
        const usedN = _amap.get(dayKey) || 0;
        if (usedN >= cap) { sendJson(res, { ok: false, error: 'daily_cap_reached', cap }, 429); return; }
        _amap.set(dayKey, usedN + 1);
        const { predictMatch } = require('./lib/dota-match-predict');
        const { buildDotaExplainPrompt, parseDotaExplain } = require('./lib/dota-match-explain');
        const side = json?.side === 'red' ? 'red' : 'blue';
        const out = predictMatch(db, { team1: json?.team1 || null, team2: json?.team2 || null, side, draft });
        const p1 = Math.max(1e-6, Math.min(1 - 1e-6, out.prob));
        const fairOdds = { team1: +(1 / p1).toFixed(2), team2: +(1 / (1 - p1)).toFixed(2) };
        const bookOdds = (typeof json?.bookOdds === 'number' && json.bookOdds > 1) ? json.bookOdds : null;
        const edge = bookOdds ? +((out.prob * bookOdds) - 1).toFixed(3) : null;
        const teams = { blue: side === 'blue' ? (json?.team1 || null) : (json?.team2 || null), red: side === 'blue' ? (json?.team2 || null) : (json?.team1 || null) };
        const prompt = buildDotaExplainPrompt({ pred: out, draft, teams, fairOdds, edge });
        const model = process.env.AI_ANALYSIS_MODEL || 'claude-sonnet-4-5';
        const r = await aiPost('anthropic', 'https://api.anthropic.com/v1/messages',
          { model, max_tokens: 700, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] },
          { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' }, { timeoutMs: 30000, retry: { maxAttempts: 2 } });
        try { stmts.incrApiUsage.run('anthropic', new Date().toISOString().slice(0, 7)); } catch (_) {}
        const rj = r ? safeParse(r.body, {}) : {};
        const text = (rj?.content || []).map(c => c.text || '').join('');
        const analysis = parseDotaExplain(text);
        if (analysis) sendJson(res, { ok: true, analysis });
        else if (text && text.trim()) sendJson(res, { ok: true, analysis: null, raw: text.slice(0, 1200) });
        else sendJson(res, { ok: false, error: 'ai_failed' }, 500);
      } catch (e) { log('WARN', 'DOTA-LAB', `explain err: ${e.message}`); sendJson(res, { ok: false, error: 'ai_failed' }, 500); }
    });
    return;
  }
```
> `aiPost`, `stmts`, `safeParse`, `sendJson`, `log`, `_readPostBody`, `db` já estão no escopo (handlers LoL usam). Não adicione requires no topo.

- [ ] **Step 3: Validar** — `node -c server.js` (exit 0). `npm test` (`0 failed`).

- [ ] **Step 4: Smoke local** — `node -e "const Database=require('better-sqlite3'); const db=new Database('sportsedge.db',{readonly:true}); const {predictMatch}=require('./lib/dota-match-predict'); const t=db.prepare(\"SELECT team1 FROM match_results WHERE game='dota2' AND team1 IS NOT NULL GROUP BY team1 ORDER BY COUNT(*) DESC LIMIT 2\").all().map(r=>r.team1); console.log(JSON.stringify(predictMatch(db,{team1:t[0],team2:t[1],side:'blue'}))); db.close();"`. Expected: JSON com prob + components.elo.

- [ ] **Step 5: Commit**
```bash
git add server.js
git commit -m "feat(dota-lab): /api/dota-{teams,heroes,match-analyze,match-explain}"
```

---

## Task 5: UI — painel Dota Lab

**Files:** Modify `public/lol-live-dashboard.html`.

O painel Draft/Match Lab de LoL é um overlay aberto por um botão na topbar (`⚗ Draft Lab`). Replique o padrão pra Dota: um botão `⚗ Dota Lab` na mesma topbar + um overlay `#dotaLab` com inputs e um `#dotaResult`.

- [ ] **Step 1: Localizar a topbar e o overlay do Draft Lab** — `node -e "const s=require('fs').readFileSync('public/lol-live-dashboard.html','utf8'); console.log('draftLab btn at', s.indexOf('Draft Lab'), '| #draftLab at', s.indexOf('id=\"draftLab\"'));"`. Leia ~40 linhas em volta de cada pra copiar o padrão (botão topbar + estrutura do overlay + como abre/fecha com `.open`).

- [ ] **Step 2: Adicionar o botão na topbar** — ao lado do botão `⚗ Draft Lab`, adicione um `⚗ Dota Lab` que faz `document.getElementById('dotaLab').classList.add('open')` (espelhe exatamente o handler do Draft Lab).

- [ ] **Step 3: Adicionar o overlay `#dotaLab`** (espelhando `#draftLab`, com botão ✕/Esc pra fechar). Conteúdo:
```html
<div id="dotaLab" class="dl-overlay">
  <div class="dl-overlay-head"><span>Dota Lab</span><button class="dl-close" onclick="document.getElementById('dotaLab').classList.remove('open')">✕</button></div>
  <datalist id="dotaTeamList"></datalist>
  <datalist id="dotaHeroList"></datalist>
  <div class="dl-teamrow">
    <input id="dota_blueTeam" class="dl-team-input" list="dotaTeamList" placeholder="Time (azul)" autocomplete="off">
    <input id="dota_redTeam" class="dl-team-input" list="dotaTeamList" placeholder="Time (vermelho)" autocomplete="off">
  </div>
  <div class="dl-heroes" id="dotaBlueHeroes"></div>
  <div class="dl-heroes" id="dotaRedHeroes"></div>
  <button id="dotaAnalyzeBtn" class="dl-ai-btn">Analisar partida</button>
  <div id="dotaResult"></div>
</div>
```

- [ ] **Step 4: Adicionar o JS** (no mesmo `<script>` do dashboard, após o IIFE do Draft Lab):
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

function dotaCollect() {
  const grab = (id) => [...document.getElementById(id).querySelectorAll('.dota-hero')].map(i => i.value.trim()).filter(Boolean);
  return { team1: (document.getElementById('dota_blueTeam').value || '').trim() || null, team2: (document.getElementById('dota_redTeam').value || '').trim() || null, blue: grab('dotaBlueHeroes'), red: grab('dotaRedHeroes') };
}
async function dotaAnalyze() {
  const c = dotaCollect();
  if (!c.team1 && !c.team2 && !c.blue.length && !c.red.length) { document.getElementById('dotaResult').textContent = 'Informe times e/ou heróis.'; return; }
  const root = document.getElementById('dotaResult'); root.innerHTML = 'analisando…';
  try {
    const r = await fetch('/api/dota-match-analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...c, side: 'blue' }) });
    const d = await r.json();
    if (!d.ok) { root.textContent = 'Falha na análise.'; return; }
    dotaRender(root, d, c);
  } catch (e) { root.textContent = 'Falha: ' + e.message; }
}
function dotaRender(root, d, c) {
  root.innerHTML = '';
  const pct = (d.prob * 100).toFixed(1);
  root.appendChild(el('div', { class: 'dl-gp-row' }, `P(${c.team1 || 'Azul'} vence): ${pct}%  ·  ${d.label}`));
  root.appendChild(el('div', { class: 'dl-gp-row' }, `Odd justa: ${c.team1 || 'Azul'} ${d.fairOdds.team1} · ${c.team2 || 'Vermelho'} ${d.fairOdds.team2}${d.edge != null ? '  ·  edge: ' + (d.edge * 100).toFixed(1) + '%' : ''}`));
  if (d.components.elo) root.appendChild(el('div', { class: 'dl-gp-note' }, `Elo: ${d.components.elo.ratingBlue} vs ${d.components.elo.ratingRed}`));
  if (d.components.draft) root.appendChild(el('div', { class: 'dl-gp-note' }, `Força de draft (WR): azul ${(d.components.draft.blueWR * 100).toFixed(1)}% vs vermelho ${(d.components.draft.redWR * 100).toFixed(1)}%`));
  const aiOut = el('div', { class: 'dl-ai-out' });
  const aiBtn = el('button', { class: 'dl-ai-btn' }, '🤖 Análise da IA');
  aiBtn.addEventListener('click', () => dotaExplain(aiBtn, aiOut, c));
  root.appendChild(el('div', { class: 'dl-gp-ai' }, aiBtn, aiOut));
  root.appendChild(el('div', { class: 'dl-gp-warn' }, '⚠ display-only — não é sinal; draft = leitura da IA (pode não refletir o patch)'));
}
async function dotaExplain(btn, outEl, c) {
  const old = btn.textContent; btn.disabled = true; btn.textContent = 'analisando…'; outEl.innerHTML = '';
  try {
    const r = await fetch('/api/dota-match-explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...c, side: 'blue' }) });
    const d = await r.json();
    if (!d.ok) { outEl.textContent = d.error === 'daily_cap_reached' ? 'Limite diário atingido.' : d.error === 'vision_disabled' ? 'IA indisponível.' : 'Falha.'; return; }
    if (d.analysis) { [['VISÃO', d.analysis.overview], ['DRAFT', d.analysis.draftRead], ['HERÓIS-CHAVE', d.analysis.keyHeroes], ['VEREDITO', d.analysis.verdict]].forEach(([k, v]) => { if (v) outEl.appendChild(el('div', { class: 'dl-ai-row' }, el('span', { class: 'dl-ai-k' }, k), el('span', {}, v))); }); }
    else if (d.raw) outEl.appendChild(el('div', { class: 'dl-ai-raw' }, d.raw));
    outEl.appendChild(el('div', { class: 'dl-gp-warn' }, '⚠ leitura da IA — não é sinal de aposta'));
  } catch (e) { outEl.textContent = 'Falha: ' + e.message; }
  finally { btn.disabled = false; btn.textContent = old; }
}
```
> Reusa as classes CSS `dl-overlay`/`dl-ai-btn`/`dl-ai-row`/`dl-gp-*` já existentes (do Draft Lab / Match Lab). Se `.dl-overlay`/`.dl-teamrow`/`.dl-heroes` não existirem com nome igual, copie do `#draftLab` e ajuste o seletor.

- [ ] **Step 5: Verificar inserção + sintaxe JS** — `node -e "const s=require('fs').readFileSync('public/lol-live-dashboard.html','utf8'); const m=[...s.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]; const vm=require('vm'); let ok=true; m.forEach((b,i)=>{if(!b[1].trim())return; try{new vm.Script(b[1])}catch(e){ok=false;console.log('blk',i,e.message)}}); console.log('JS OK:',ok,'| dotaLab:',s.includes('initDotaLab')&&s.includes('id=\"dotaLab\"')&&s.includes('dotaAnalyze'));"`. Expected: `JS OK: true | dotaLab: true`.

- [ ] **Step 6: Commit**
```bash
git add public/lol-live-dashboard.html
git commit -m "feat(dota-lab): Dota Lab panel (teams/heroes inputs + analyze + AI)"
```

---

## Task 6: Smoke de produção (pós-merge/deploy)

- [ ] **Step 1: Merge + push** (`git push origin main` autorizado). Aguardar deploy (confirmar `code_sha` em `/health`).
- [ ] **Step 2: Smoke** (PowerShell):
```powershell
$BASE='https://sportsedge-bot-production.up.railway.app'
(Invoke-RestMethod "$BASE/api/dota-teams").teams.Count
$t=(Invoke-RestMethod "$BASE/api/dota-teams").teams | Select-Object -First 2
$body=@{team1=$t[0];team2=$t[1];side='blue';blue=@('Invoker','Juggernaut','Crystal Maiden','Axe','Lion');red=@('Pudge','Anti-Mage','Lina','Tidehunter','Witch Doctor')}|ConvertTo-Json
$r=Invoke-RestMethod -Uri "$BASE/api/dota-match-analyze" -Method POST -Body $body -ContentType 'application/json'
"prob=$($r.prob) fair=$($r.fairOdds.team1)/$($r.fairOdds.team2) draftWR=$($r.components.draft.blueWR)"
$e=Invoke-RestMethod -Uri "$BASE/api/dota-match-explain" -Method POST -Body $body -ContentType 'application/json'
"ok=$($e.ok)"; $e.analysis | ConvertTo-Json -Depth 4
$edge=Invoke-WebRequest "$BASE/edge" -UseBasicParsing; "hasDotaLab=$($edge.Content -match 'initDotaLab')"
```
Expected: teams count > 0; analyze com prob+fairOdds; explain com 4 seções (ou raw); `hasDotaLab=True`.
- [ ] **Step 3: Atualizar memory** (`project_match_lab_2026_06_01.md` ou novo `project_dota_lab`): shipped, commit, backtest `beatsBaseline`, modelo.

---

## Self-Review

**1. Cobertura do spec:** §6 predict→T2; §7 backtest→T1; §8 API→T4; §9 UI→T5; §10 IA→T3; smoke→T6. ✓
**2. Placeholder scan:** sem TBD; código completo nos steps. ✓
**3. Type consistency:** `predictMatch`→`{prob,probBlue,components:{elo:{pBlue,confidence,ratingBlue,ratingRed},draft:{blueWR,redWR,factor}},confidence,label}` igual em T2(def), T4(endpoint usa out.prob/probBlue/components), T5(render lê fairOdds/components.elo/draft). `buildDotaExplainPrompt({pred,draft,teams,fairOdds,edge})` + `parseDotaExplain`→4 chaves, igual T3(def)/T4(uso)/T5(render lê analysis.{overview,draftRead,keyHeroes,verdict}). Backtest grava `meta.eloConfig`+`calib.blocks`, lidos por T2. ✓
