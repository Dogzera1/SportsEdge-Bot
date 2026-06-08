# CS Match Lab v1 (Elo-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar um painel "CS Match Lab" no `/edge` que prevê P(team1 vence) por Elo (cs2), mostra odd justa + edge e uma explicação por IA — display-only, espelhando o Dota Match Lab.

**Architecture:** Instância Elo própria (`createEloSystem('cs2')`, NÃO o money-path `cs-ml.js`) calibrada por isotônica gerada num backtest walk-forward. Libs novas `cs-match-predict`/`cs-match-explain` + endpoints `/api/cs-*` + overlay `#csLab`. Puramente aditivo; nada toca stake/EV/tips.

**Tech Stack:** Node 18 (http nativo), better-sqlite3, `lib/elo-rating.js`, Anthropic Sonnet (`aiPost`), runner de testes caseiro (`tests/run.js`).

**Spec:** `docs/superpowers/specs/2026-06-08-cs-match-lab-v1-design.md`

**Molde a espelhar (ler antes):** `lib/dota-match-predict.js`, `lib/dota-match-explain.js`, `scripts/backtest-dota-match.js`, endpoints `server.js:5449-5526`, overlay `#dotaLab` em `public/lol-live-dashboard.html`.

**Invariante money-path (vale pra TODAS as tasks):** os arquivos novos NÃO podem conter `cs-ml`, `getCsElo`, `stake`, `kelly`, `bankroll`, `getLolProbability`, `tips`. Verificado na Task 8.

---

## Task 1: Backtest + artefatos (valida o Elo cs2 — GATE do projeto)

**Files:**
- Create: `scripts/backtest-cs-match.js`
- Generates: `lib/cs-match-meta.json`, `lib/cs-match-calib.json`

- [ ] **Step 1: Criar o script** (cópia de `scripts/backtest-dota-match.js` trocando `dota2`→`cs2` e labels `[dota]`→`[cs]`; sem draft/form, igual o molde):

```javascript
'use strict';
// Point-in-time Elo replay for the CS match predictor (display-only).
// Predicts P(team1 wins); getP() BEFORE rate() (no leakage). Mirrors backtest-dota-match.js.
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
  WHERE game='cs2' AND winner IS NOT NULL AND winner!=''
    AND team1 IS NOT NULL AND team2 IS NOT NULL
  ORDER BY resolved_at ASC
`).all();

const elo = createEloSystem(ELO_CONFIG);
const samples = [];
for (const g of games) {
  const pred = elo.getP(g.team1, g.team2);
  const y = (String(g.winner).toLowerCase() === String(g.team1).toLowerCase()) ? 1 : 0;
  if (pred.foundA && pred.foundB && pred.confidence > 0) samples.push({ p: pred.pA, y, date: g.resolved_at });
  const winner = y ? g.team1 : g.team2, loser = y ? g.team2 : g.team1;
  const sc = String(g.final_score || '').match(/(\d+)\s*[-:]\s*(\d+)/);
  const margin = sc ? Math.max(1, Math.abs(parseInt(sc[1]) - parseInt(sc[2]))) : 1;
  elo.rate(winner, loser, margin, g.resolved_at);
}
db.close();

samples.sort((a, b) => String(a.date) < String(b.date) ? -1 : 1);
const cut = Math.floor(samples.length * 0.7);
const train = samples.slice(0, cut), test = samples.slice(cut);
const pStar = train.reduce((s, x) => s + x.y, 0) / Math.max(1, train.length);

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

console.log(`[cs] n=${samples.length} (train=${train.length} test=${test.length}) baseRate(team1)=${pStar.toFixed(4)}`);
console.log(`[cs] Elo raw:   Brier=${brierRaw.toFixed(4)} ECE=${M.ece(testRaw).toFixed(4)}`);
console.log(`[cs] baseline:  Brier=${baselineBrier.toFixed(4)}`);
console.log(`[cs] Elo beats base-rate OOS? ${brierRaw < baselineBrier ? 'YES' : 'NO'}  | calib kept? ${keptOOS}`);

fs.writeFileSync(path.join(__dirname, '..', 'lib', 'cs-match-meta.json'), JSON.stringify({
  game: 'cs2', level: 'match', predicts: 'P(team1 wins)', eloConfig: ELO_CONFIG, trainedAt: new Date().toISOString(),
  n: samples.length, walkForward: { trainN: train.length, testN: test.length }, baseRate: +pStar.toFixed(6),
  oos: { baselineBrier: +baselineBrier.toFixed(6), eloRawBrier: +brierRaw.toFixed(6), eloRawEce: +M.ece(testRaw).toFixed(6), beatsBaseline: brierRaw < baselineBrier },
}, null, 2));
fs.writeFileSync(path.join(__dirname, '..', 'lib', 'cs-match-calib.json'), JSON.stringify({ method: 'isotonic_pav', blocks, keptOOS }, null, 2));
console.log('[cs] wrote lib/cs-match-meta.json + lib/cs-match-calib.json');
```

- [ ] **Step 2: Rodar o backtest**

Run: `node scripts/backtest-cs-match.js`
Expected: imprime `[cs] n=...`, e a linha `[cs] Elo beats base-rate OOS? YES` + cria os 2 JSONs.

- [ ] **Step 3: GATE — checar `beatsBaseline`**

Abrir `lib/cs-match-meta.json` e confirmar `oos.beatsBaseline === true`.
- Se **YES** (esperado, ~28k jogos): seguir.
- Se **NO**: **PARAR o plano** e reportar ao usuário — o Elo cs2 não bate base-rate OOS, então não há sinal pra exibir; reavaliar config do Elo ou a fonte de dados antes de construir o resto.

- [ ] **Step 4: Commit**

```bash
git add scripts/backtest-cs-match.js lib/cs-match-meta.json lib/cs-match-calib.json
git commit -m "feat(cs-lab): backtest-cs-match + Elo cs2 meta/calib artifacts"
```

---

## Task 2: `lib/cs-match-predict.js` (predictor Elo, display-only)

**Files:**
- Create: `lib/cs-match-predict.js`
- Test: `tests/test-cs-match-predict.js`

- [ ] **Step 1: Escrever o teste que falha**

```javascript
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

module.exports = function (t) {
  const { predictMatch } = require('../lib/cs-match-predict');
  const db = new Database(path.join(__dirname, '..', 'sportsedge.db'), { readonly: true });

  t.test('cs-predict: 2 times reais → prob em (0,1), elo presente, label válido', () => {
    const top = db.prepare(`SELECT team1 t, COUNT(*) n FROM match_results WHERE game='cs2' AND team1!='' GROUP BY team1 ORDER BY n DESC LIMIT 2`).all();
    t.assert(top.length === 2, 'precisa de 2 times no cs2');
    const out = predictMatch(db, { team1: top[0].t, team2: top[1].t });
    t.assert(out.prob > 0 && out.prob < 1, `prob fora de (0,1): ${out.prob}`);
    t.assert(out.components.elo && typeof out.components.elo.ratingTeam1 === 'number', 'elo ausente');
    t.assert(['forte', 'lean', 'lean fraco'].includes(out.label), `label inválido: ${out.label}`);
    t.assert(Math.abs(out.prob - out.probTeam1) < 1e-9, 'prob != probTeam1');
  });

  t.test('cs-predict: times inexistentes → prob 0.5, elo null, lean fraco', () => {
    const out = predictMatch(db, { team1: 'ZZZ_fake_aaa', team2: 'ZZZ_fake_bbb' });
    t.assert(out.prob === 0.5, `esperava 0.5, veio ${out.prob}`);
    t.assert(out.components.elo === null, 'elo deveria ser null');
    t.assert(out.label === 'lean fraco', `label: ${out.label}`);
  });

  t.test('cs-predict: airtight money-path (source sem refs proibidas)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cs-match-predict.js'), 'utf8');
    for (const bad of ['cs-ml', 'getCsElo', 'stake', 'kelly', 'bankroll', 'getLolProbability']) {
      t.assert(!src.includes(bad), `referência proibida no predict: ${bad}`);
    }
  });

  db.close();
};
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test 2>&1 | findstr cs-match-predict`
Expected: FAIL (`Cannot find module '../lib/cs-match-predict'`).

- [ ] **Step 3: Implementar** (`lib/cs-match-predict.js` — molde `dota-match-predict.js` sem draft, team1/team2 direto):

```javascript
'use strict';
/**
 * cs-match-predict.js — Display-only CS match predictor.
 * prob = Elo cs2 (calibrated). DISPLAY-ONLY: must not feed stake/EV/Kelly.
 * Mirrors dota-match-predict.js; no draft (CS has no comp data in v1).
 */
const { createEloSystem } = require('./elo-rating');
const { _applyIsotonicBlocks } = require('./brier-holdout-eval');
const META = require('./cs-match-meta.json');
const CALIB = require('./cs-match-calib.json');

let _elo = null, _eloTs = 0;
const ELO_TTL = 3600_000;
function _csElo(db) {
  if (_elo && Date.now() - _eloTs < ELO_TTL) return _elo;
  _elo = createEloSystem(META.eloConfig);
  _elo.bootstrap(db, 'cs2', () => undefined, { maxAgeDays: 100000 });
  _eloTs = Date.now();
  return _elo;
}

function predictMatch(db, { team1, team2 } = {}) {
  let pElo = null, eloConf = 0, ratingT1 = null, ratingT2 = null, gamesT1 = 0, gamesT2 = 0;
  if (team1 && team2) {
    const e = _csElo(db).getP(team1, team2);
    if (e.foundA && e.foundB && e.confidence > 0) { pElo = e.pA; eloConf = e.confidence; ratingT1 = e.ratingA; ratingT2 = e.ratingB; gamesT1 = e.gamesA; gamesT2 = e.gamesB; }
  }
  let probTeam1 = (pElo == null) ? 0.5 : pElo;
  if (pElo != null && CALIB.blocks && CALIB.blocks.length > 0) probTeam1 = _applyIsotonicBlocks(CALIB.blocks, probTeam1);
  probTeam1 = Math.max(0, Math.min(1, probTeam1));

  let confidence, label;
  if (pElo !== null) { confidence = eloConf; label = eloConf > 0.6 ? 'forte' : 'lean'; }
  else { confidence = 0.2; label = 'lean fraco'; }

  return {
    prob: +probTeam1.toFixed(4), probTeam1: +probTeam1.toFixed(4),
    components: {
      elo: pElo !== null ? { pTeam1: +pElo.toFixed(4), confidence: +eloConf.toFixed(2), ratingTeam1: ratingT1, ratingTeam2: ratingT2, gamesTeam1: gamesT1, gamesTeam2: gamesT2 } : null,
    },
    confidence: +confidence.toFixed(2), label,
  };
}
module.exports = { predictMatch };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test 2>&1 | findstr cs-match-predict`
Expected: 3× `✓`.

- [ ] **Step 5: Commit**

```bash
git add lib/cs-match-predict.js tests/test-cs-match-predict.js
git commit -m "feat(cs-lab): cs-match-predict (Elo cs2 calibrated, display-only)"
```

---

## Task 3: `lib/cs-match-explain.js` (prompt + parse da IA)

**Files:**
- Create: `lib/cs-match-explain.js`
- Test: `tests/test-cs-match-explain.js`

- [ ] **Step 1: Escrever o teste que falha**

```javascript
'use strict';
module.exports = function (t) {
  const { buildCsExplainPrompt, parseCsExplain } = require('../lib/cs-match-explain');

  t.test('cs-explain: prompt inclui times, prob e instrução de não alterar', () => {
    const pred = { probTeam1: 0.62, label: 'lean', components: { elo: { ratingTeam1: 1700, ratingTeam2: 1600 } } };
    const s = buildCsExplainPrompt({ pred, teams: { team1: 'FaZe', team2: 'NAVI' }, fairOdds: { team1: 1.61, team2: 2.63 }, edge: 0.05 });
    t.assert(s.includes('FaZe') && s.includes('NAVI'), 'times ausentes no prompt');
    t.assert(s.includes('62%'), 'prob ausente');
    t.assert(/NÃO o altere|não altere/i.test(s), 'falta instrução de preservar o prob');
    t.assert(s.includes('overview') && s.includes('verdict'), 'schema JSON ausente');
  });

  t.test('cs-explain: parse extrai os campos do JSON', () => {
    const out = parseCsExplain('lixo {"overview":"a","matchupRead":"b","verdict":"c"} fim');
    t.assert(out && out.overview === 'a' && out.matchupRead === 'b' && out.verdict === 'c', 'parse falhou');
  });

  t.test('cs-explain: parse de texto sem JSON → null', () => {
    t.assert(parseCsExplain('sem json aqui') === null, 'deveria ser null');
  });
};
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test 2>&1 | findstr cs-match-explain`
Expected: FAIL (módulo não encontrado).

- [ ] **Step 3: Implementar** (`lib/cs-match-explain.js` — molde `dota-match-explain.js` sem draft/heroes; KEYS `overview/matchupRead/verdict`):

```javascript
'use strict';
/**
 * cs-match-explain.js — Display-only CS AI reading.
 * Prob is the Elo (the model). The AI reads the matchup using its OWN CS knowledge
 * (form, playstyle, context) — must NOT invent map/player stats we don't have.
 */
const KEYS = ['overview', 'matchupRead', 'verdict'];

function buildCsExplainPrompt({ pred, teams, fairOdds, edge }) {
  const t = teams || {};
  const el = pred.components && pred.components.elo;
  const lines = [];
  lines.push('Dados da partida de Counter-Strike (CS2) — modelo estatístico display-only, NÃO são apostas:');
  lines.push(`- Times: ${t.team1 || '(não informado)'} vs ${t.team2 || '(não informado)'}`);
  if (el) lines.push(`- P(${t.team1 || 'Time 1'} vence) ~ ${Math.round((pred.probTeam1) * 100)}% (${pred.label}); Elo: ${t.team1 || 'T1'} ${el.ratingTeam1} vs ${t.team2 || 'T2'} ${el.ratingTeam2}`);
  if (fairOdds) { let o = `- Odd justa: ${t.team1 || 'T1'} ${fairOdds.team1} / ${t.team2 || 'T2'} ${fairOdds.team2}`; if (edge != null) o += `; edge vs odd da casa: ${(edge * 100).toFixed(1)}%`; lines.push(o); }
  lines.push('');
  lines.push('Você é um analista de Counter-Strike. O prob acima vem do Elo (NÃO o altere). Explique o confronto com o seu conhecimento (forma recente, estilo de jogo, contexto do confronto/rivalidade).');
  lines.push('Responda APENAS um JSON compacto, nada fora dele, em PT-BR:');
  lines.push('{"overview":"…","matchupRead":"…","verdict":"…"}');
  lines.push('Regras: cada campo 1-2 frases; NÃO invente estatísticas que não estão nos dados (sem winrate por mapa, sem rating de jogador específico); o verdict se apoia no Elo/odd justa (não invente probabilidade); NÃO recomende stake nem diga "aposte".');
  return lines.join('\n');
}

function parseCsExplain(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj; try { obj = JSON.parse(m[0]); } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  if (!KEYS.some(k => typeof obj[k] === 'string' && obj[k].trim())) return null;
  const out = {}; for (const k of KEYS) out[k] = (typeof obj[k] === 'string') ? obj[k] : '';
  return out;
}
module.exports = { buildCsExplainPrompt, parseCsExplain };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test 2>&1 | findstr cs-match-explain`
Expected: 3× `✓`.

- [ ] **Step 5: Commit**

```bash
git add lib/cs-match-explain.js tests/test-cs-match-explain.js
git commit -m "feat(cs-lab): cs-match-explain (Sonnet prompt + parse, display-only)"
```

---

## Task 4: Endpoints `/api/cs-teams` + `/api/cs-match-analyze`

**Files:**
- Modify: `server.js` (inserir imediatamente ANTES da linha `if (p === '/api/dota-teams' && req.method === 'GET') {`)

- [ ] **Step 1: Inserir os dois endpoints** (molde `server.js:5449-5483`, sem draft):

```javascript
  // CS Match Lab — team autocomplete (display-only)
  if (p === '/api/cs-teams' && req.method === 'GET') {
    try {
      const rows = db.prepare(`SELECT team1 t FROM match_results WHERE game='cs2' AND team1 IS NOT NULL AND team1!=''
                               UNION SELECT team2 t FROM match_results WHERE game='cs2' AND team2 IS NOT NULL AND team2!=''`).all();
      sendJson(res, { ok: true, teams: [...new Set(rows.map(r => r.t))].sort((a, b) => a.localeCompare(b)) });
    } catch (e) { sendJson(res, { ok: false, error: 'teams_failed' }, 500); }
    return;
  }
  // CS Match Lab — match analyze (Elo, display-only)
  if (p === '/api/cs-match-analyze' && req.method === 'POST') {
    _readPostBody(req, res, (body) => {
      if (body == null) return;
      try {
        const json = safeParse(body, null);
        const { predictMatch } = require('./lib/cs-match-predict');
        const out = predictMatch(db, { team1: json?.team1 || null, team2: json?.team2 || null });
        const p1 = Math.max(1e-6, Math.min(1 - 1e-6, out.prob));
        const fairOdds = { team1: +(1 / p1).toFixed(2), team2: +(1 / (1 - p1)).toFixed(2) };
        const bookOdds = (typeof json?.bookOdds === 'number' && json.bookOdds > 1) ? json.bookOdds : null;
        const edge = bookOdds ? +((out.prob * bookOdds) - 1).toFixed(3) : null;
        sendJson(res, { ok: true, ...out, fairOdds, edge });
      } catch (e) { log('WARN', 'CS-LAB', `analyze err: ${e.message}`); sendJson(res, { ok: false, error: 'cs_analyze_failed' }, 500); }
    });
    return;
  }
```

- [ ] **Step 2: Validar sintaxe**

Run: `node -c server.js`
Expected: sem saída (exit 0).

- [ ] **Step 3: Smoke local do analyze** (sobe o server numa porta de teste e bate no endpoint):

```bash
node -e "const http=require('http');const cp=require('child_process');const s=cp.spawn('node',['server.js'],{env:{...process.env,PORT:'8799'},stdio:'ignore'});setTimeout(()=>{const r=http.request({port:8799,path:'/api/cs-teams',method:'GET'},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{console.log('cs-teams ok=',JSON.parse(d).ok,'n=',JSON.parse(d).teams.length);s.kill();process.exit(0);});});r.end();},6000);"
```
Expected: `cs-teams ok= true n= <número grande>`.
(Se o boot local falhar por env faltando, pular o smoke local e validar via prod na Task 8 — anotar.)

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(cs-lab): /api/cs-teams + /api/cs-match-analyze endpoints"
```

---

## Task 5: Endpoint `/api/cs-match-explain` (IA Sonnet)

**Files:**
- Modify: `server.js` (inserir logo após o bloco `/api/cs-match-analyze` da Task 4)

- [ ] **Step 1: Inserir o endpoint** (molde `server.js:5485-5526`, sem draft; reusa o cap diário `_aiAnalysisDayMap` e `aiPost`):

```javascript
  // CS Match Lab — AI explain (Sonnet, capped, display-only)
  if (p === '/api/cs-match-explain' && req.method === 'POST') {
    _readPostBody(req, res, async (body) => {
      if (body == null) return;
      try {
        const KEY = process.env.ANTHROPIC_API_KEY;
        if (!KEY) { sendJson(res, { ok: false, error: 'vision_disabled' }, 503); return; }
        const json = safeParse(body, null);
        if (!json?.team1 || !json?.team2) { sendJson(res, { ok: false, error: 'empty_match' }, 400); return; }
        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
        const cap = parseInt(process.env.AI_ANALYSIS_DAILY_CAP || '30', 10);
        const _amap = (global._aiAnalysisDayMap = global._aiAnalysisDayMap || new Map());
        const dayKey = `${ip}|${new Date().toISOString().slice(0, 10)}`;
        const usedN = _amap.get(dayKey) || 0;
        if (usedN >= cap) { sendJson(res, { ok: false, error: 'daily_cap_reached', cap }, 429); return; }
        _amap.set(dayKey, usedN + 1);
        const { predictMatch } = require('./lib/cs-match-predict');
        const { buildCsExplainPrompt, parseCsExplain } = require('./lib/cs-match-explain');
        const out = predictMatch(db, { team1: json.team1, team2: json.team2 });
        const p1 = Math.max(1e-6, Math.min(1 - 1e-6, out.prob));
        const fairOdds = { team1: +(1 / p1).toFixed(2), team2: +(1 / (1 - p1)).toFixed(2) };
        const bookOdds = (typeof json?.bookOdds === 'number' && json.bookOdds > 1) ? json.bookOdds : null;
        const edge = bookOdds ? +((out.prob * bookOdds) - 1).toFixed(3) : null;
        const prompt = buildCsExplainPrompt({ pred: out, teams: { team1: json.team1, team2: json.team2 }, fairOdds, edge });
        const model = process.env.AI_ANALYSIS_MODEL || 'claude-sonnet-4-5';
        const r = await aiPost('anthropic', 'https://api.anthropic.com/v1/messages',
          { model, max_tokens: 700, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] },
          { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' }, { timeoutMs: 30000, retry: { maxAttempts: 2 } });
        try { stmts.incrApiUsage.run('anthropic', new Date().toISOString().slice(0, 7)); } catch (_) {}
        const rj = r ? safeParse(r.body, {}) : {};
        const text = (rj?.content || []).map(c => c.text || '').join('');
        const analysis = parseCsExplain(text);
        if (analysis) sendJson(res, { ok: true, analysis });
        else if (text && text.trim()) sendJson(res, { ok: true, analysis: null, raw: text.slice(0, 1200) });
        else sendJson(res, { ok: false, error: 'ai_failed' }, 500);
      } catch (e) { log('WARN', 'CS-LAB', `explain err: ${e.message}`); sendJson(res, { ok: false, error: 'ai_failed' }, 500); }
    });
    return;
  }
```

- [ ] **Step 2: Validar sintaxe**

Run: `node -c server.js`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(cs-lab): /api/cs-match-explain (Sonnet, capped, display-only)"
```

---

## Task 6: UI — overlay `#csLab` no dashboard

**Files:**
- Modify: `public/lol-live-dashboard.html`

**Antes de codar:** ler o overlay molde `#dotaLab` (HTML ~linhas 1057-1330), o botão `#dotaLabBtn` (~1327) e o bloco JS de fetch (~2593-2740). Espelhar com estas diferenças:
- IDs: `#csLab` / `#csLabBtn` / `toggleCsLab()` / listas `csTeamList`.
- **Sem** heróis/draft: o painel tem só 2 inputs de time (autocomplete via `/api/cs-teams`) + 2 inputs de odd opcionais.
- Botões: "Analisar" → `POST /api/cs-match-analyze` `{team1,team2,bookOdds?}`; "IA explica" → `POST /api/cs-match-explain` `{team1,team2,bookOdds?}`.
- Render do resultado: `pred.probTeam1` (%), `components.elo.ratingTeam1/ratingTeam2`, `fairOdds.team1/team2`, `edge`, `label`; seção IA com `analysis.overview/matchupRead/verdict`.
- Título do painel: "CS Match Lab" + selo "display-only".

- [ ] **Step 1: Adicionar o botão no header** — espelhar `#dotaLabBtn`, com `id="csLabBtn"` e `onclick="toggleCsLab()"`, label "CS Lab".

- [ ] **Step 2: Adicionar o overlay `#csLab`** — espelhar o container de `#dotaLab` (mesmas classes de overlay/fixed/close), conteúdo conforme as diferenças acima.

- [ ] **Step 3: Adicionar o JS** — `toggleCsLab()`, carregar `/api/cs-teams` no datalist, handler "Analisar" (fetch analyze → render), handler "IA explica" (fetch explain → render). Espelhar os handlers do Dota Lab.

- [ ] **Step 4: Verificar que a página carrega** (HTML não quebrou):

Run: `node -e "const h=require('fs').readFileSync('public/lol-live-dashboard.html','utf8'); const o=(h.match(/id=\"csLab\"/g)||[]).length, b=(h.match(/csLabBtn/g)||[]).length; console.log('csLab=',o,'csLabBtn=',b); process.exit(o>=1&&b>=1?0:1);"`
Expected: `csLab= 1 csLabBtn= 2` (1 overlay + botão referenciado no header e na função).

- [ ] **Step 5: Commit**

```bash
git add public/lol-live-dashboard.html
git commit -m "feat(cs-lab): #csLab overlay + UI (analyze + IA), mirrors Dota Lab"
```

---

## Task 7 (separável): lista de jogos ao vivo `/api/cs-live-matches`

> Se o plano estiver grande/tempo curto, esta task vira v1.1 — o core (Tasks 1-6) já entrega o lab com input manual.

**Files:**
- Modify: `server.js` (após `/api/cs-match-explain`)
- Modify: `public/lol-live-dashboard.html` (lista no `#csLab`)

- [ ] **Step 1: Endpoint proxy** — `GET /api/cs-live-matches`: faz GET em `${process.env.HLTV_PROXY_BASE}/api/matches` (reusar o padrão de fetch HTTP já usado no projeto; ver `lib/hltv.js` pra o cliente), normaliza pra `{ ok, matches: [{ matchId, teams:[t1,t2], event, live }] }`. Se `HLTV_PROXY_BASE` ausente ou erro → `{ ok: true, matches: [] }` (degradação graciosa, sem 500).

```javascript
  // CS Match Lab — live/upcoming matches from HLTV proxy (display-only, optional)
  if (p === '/api/cs-live-matches' && req.method === 'GET') {
    (async () => {
      try {
        const base = (process.env.HLTV_PROXY_BASE || '').trim().replace(/\/+$/, '');
        if (!base) { sendJson(res, { ok: true, matches: [] }); return; }
        const raw = await cachedHttpGet(`${base}/api/matches`, { timeoutMs: 8000 }).catch(() => null);
        const j = raw ? safeParse(raw.body || raw, {}) : {};
        const matches = (j.matches || []).slice(0, 60).map(m => ({ matchId: m.matchId, teams: (m.teams || []).slice(0, 2), event: m.event || null, live: !!m.live }));
        sendJson(res, { ok: true, matches });
      } catch (e) { sendJson(res, { ok: true, matches: [] }); }
    })();
    return;
  }
```
**Nota ao implementador:** confirmar o helper HTTP correto do projeto (`cachedHttpGet`/`serverGet`/equivalente em `lib/utils.js` ou como `lib/hltv.js` faz) e usar o mesmo — não introduzir cliente HTTP novo.

- [ ] **Step 2:** `node -c server.js` (exit 0).

- [ ] **Step 3: UI** — no `#csLab`, um botão "Jogos ao vivo" que faz `GET /api/cs-live-matches` e lista; clicar numa partida preenche os 2 inputs de time.

- [ ] **Step 4: Commit**

```bash
git add server.js public/lol-live-dashboard.html
git commit -m "feat(cs-lab): /api/cs-live-matches + live picker in UI"
```

---

## Task 8: Airtight + smoke final

- [ ] **Step 1: Grep airtight money-path** nos arquivos novos:

Run: `node -e "const fs=require('fs');const files=['lib/cs-match-predict.js','lib/cs-match-explain.js','scripts/backtest-cs-match.js'];const bad=['cs-ml','getCsElo','stake','kelly','bankroll','getLolProbability','tips'];let hit=0;for(const f of files){const s=fs.readFileSync(f,'utf8');for(const b of bad){if(s.includes(b)){console.log('HIT',f,b);hit++;}}}console.log(hit===0?'AIRTIGHT OK':'AIRTIGHT FAIL');process.exit(hit?1:0);"`
Expected: `AIRTIGHT OK`.
(Nota: o `server.js` contém money-path no resto do arquivo; o grep é só nos arquivos NOVOS. Confira manualmente que os blocos CS adicionados no server.js não referenciam stake/kelly/cs-ml.)

- [ ] **Step 2: Suite completa verde**

Run: `npm test`
Expected: `✓ ... passed, 0 failed` (1060 anteriores + os novos cs-match-predict/explain).

- [ ] **Step 3: Push** (dispara deploy do bot no Railway)

```bash
git push origin main
```

- [ ] **Step 4: Smoke em prod** (após deploy subir; usa PowerShell + admin key — `/api/*` do lab são públicos, sem key):

```powershell
$base='https://sportsedge-bot-production.up.railway.app'
# pega 2 times reais
$teams=(Invoke-WebRequest "$base/api/cs-teams" -UseBasicParsing).Content; $t=($teams.Substring($teams.IndexOf('{'))|ConvertFrom-Json).teams
$body=@{team1=$t[0];team2=$t[1];bookOdds=1.8}|ConvertTo-Json
$r=Invoke-WebRequest "$base/api/cs-match-analyze" -Method POST -Body $body -ContentType 'application/json' -UseBasicParsing
Write-Output $r.Content
```
Expected: JSON `ok:true` com `prob`, `components.elo`, `fairOdds`, `edge`, `label`.

- [ ] **Step 5: Atualizar memória** — marcar o CS Match Lab v1 SHIPPED em `memory/` (evolui `project_cs_match_lab_pendency_2026_06_02`): Webshare validado mas /stats têm CF JS-challenge → v1 Elo-only entregue; caminho B (navegador-solver) documentado como próximo passo opcional.

---

## Self-review (preenchido)

- **Spec coverage:** predict (T2), explain (T3), backtest+gate (T1), endpoints teams/analyze/explain (T4-5), UI (T6), live-matches opcional (T7), airtight+smoke (T8). ✓ Tudo coberto.
- **Money-path airtight:** invariante declarada no topo + teste no T2 + grep no T8. ✓
- **Type consistency:** `predictMatch` retorna `{prob, probTeam1, components:{elo:{pTeam1,confidence,ratingTeam1,ratingTeam2,gamesTeam1,gamesTeam2}}, confidence, label}` — usado igual em T2/T4/T5; `parseCsExplain` → `{overview,matchupRead,verdict}` usado em T3/T5/T6. ✓
- **Gate:** T1 Step 3 pára o plano se o Elo não bater base-rate OOS. ✓
