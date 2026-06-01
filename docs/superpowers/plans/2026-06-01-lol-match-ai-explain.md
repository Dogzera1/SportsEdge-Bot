# Match Lab — Análise da IA (LLM explain) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar um botão "Análise da IA" ao painel Match Lab que pede ao Claude Sonnet uma leitura de partida em seções, ancorada nos dados do game-profile (display-only).

**Architecture:** `lib/lol-match-explain.js` (puro: monta o prompt a partir do game-profile + parseia a resposta JSON). Um endpoint `POST /api/lol-match-explain` recomputa o game-profile (reusa `predictMatch`+`computeGameProfile`) e chama o Sonnet via `aiPost`, com cap diário. A UI mostra as seções sob demanda.

**Tech Stack:** Node 18, http nativo, `aiPost` (`lib/utils.js`), runner custom (`node tests/run.js`). Sem dep npm, sem migration.

**Spec:** `docs/superpowers/specs/2026-06-01-lol-match-ai-explain-design.md`

---

## Convenções

- **Rodar a suíte:** `npm test` (executa `tests/test-*.js`). Procure a seção `[lol-match-explain]`. "Falhar" = `✗` + exit 1; "passar" = `✓` + exit 0.
- **Padrão de teste:** `module.exports = function(t){ t.test('nome', () => { assert.ok(...) }); }`, `const assert = require('assert')`. Lógica pura com fixtures (sem rede).
- Commits em inglês, terminando com `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `lib/lol-match-explain.js` (criar) | `buildExplainPrompt(input)` (prompt a partir do game-profile) + `parseExplainResponse(text)` (JSON→seções ou null) |
| `tests/test-lol-match-explain.js` (criar) | testa as duas funções |
| `server.js` (modificar ~5384, após `/api/lol-teams`) | handler `POST /api/lol-match-explain` |
| `public/lol-live-dashboard.html` (modificar `dlRenderGameProfile` ~2230 + CSS) | botão + render das seções |

---

## Task 1: `lib/lol-match-explain.js` — prompt + parse

**Files:**
- Create: `lib/lol-match-explain.js`
- Test: `tests/test-lol-match-explain.js`

- [ ] **Step 1: Escrever o teste**

`tests/test-lol-match-explain.js`:
```js
'use strict';
const assert = require('assert');
const { buildExplainPrompt, parseExplainResponse } = require('../lib/lol-match-explain');

const GP = {
  phases: {
    early: { winner: 'red', bars: 2, measured: true, anchor: { golddiff15: -120, xpdiff15: -50, csdiff15: -4 }, confidence: 0.8 },
    mid:   { winner: 'even', bars: 0, measured: false, label: 'transição', confidence: 0.4 },
    late:  { winner: 'blue', bars: 3, measured: false, label: 'estimativa', confidence: 0.45 },
  },
  expectedTime: { seconds: 1980, bucket: 'médio' },
  winCondition: 'Azul quer arrastar; vermelho quer fechar cedo.',
  compStyle: { blue: { style: 'teamfight', confidence: 0.6 }, red: { style: 'pick', confidence: 0.5 } },
  fairOdds: { team1: 1.36, team2: 3.77 },
  edge: 0.138,
};
const DRAFT = { blue: [{ champion: 'Aatrox', role: 'top' }], red: [{ champion: 'Gnar', role: 'top' }] };
const TEAMS = { blue: 'T1', red: 'Gen.G' };

module.exports = function(t) {
  t.test('buildExplainPrompt includes anchored data + JSON+no-stake instruction', () => {
    const p = buildExplainPrompt({ gameProfile: GP, draft: DRAFT, teams: TEAMS, probPct: 73, label: 'forte' });
    assert.ok(/P\(Azul vence\) ~ 73% \(forte\)/.test(p), 'prob line');
    assert.ok(/Odd justa: Azul 1\.36 \/ Vermelho 3\.77/.test(p), 'fair odds line');
    assert.ok(/edge vs odd da casa: 13\.8%/.test(p), 'edge line when present');
    assert.ok(/EARLY \(medido\): Vermelho/.test(p) && /-120g, -50xp, -4cs/.test(p), 'early anchor');
    assert.ok(/APENAS um JSON/.test(p), 'json-only instruction');
    assert.ok(/NÃO recomende stake/.test(p), 'no-stake instruction');
  });
  t.test('buildExplainPrompt omits edge line when edge is null', () => {
    const gp2 = Object.assign({}, GP, { edge: null });
    const p = buildExplainPrompt({ gameProfile: gp2, draft: DRAFT, teams: TEAMS, probPct: 73, label: 'forte' });
    assert.ok(!/edge vs odd da casa/.test(p), 'no edge line');
    assert.ok(/Odd justa: Azul 1\.36/.test(p), 'still shows fair odds');
  });
  t.test('parseExplainResponse extracts JSON with prose around it', () => {
    const txt = 'Claro! {"early":"a","mid":"b","late":"c","winCondition":"d","keyMatchup":"e","verdict":"f"} pronto';
    const o = parseExplainResponse(txt);
    assert.strictEqual(o.early, 'a'); assert.strictEqual(o.verdict, 'f');
  });
  t.test('parseExplainResponse returns null for non-JSON', () => {
    assert.strictEqual(parseExplainResponse('sem json aqui'), null);
  });
  t.test('parseExplainResponse fills missing keys with empty string', () => {
    const o = parseExplainResponse('{"early":"x"}');
    assert.strictEqual(o.early, 'x'); assert.strictEqual(o.mid, ''); assert.strictEqual(o.verdict, '');
  });
};
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npm test`
Expected: `[lol-match-explain]` com `✗` (módulo inexistente), exit 1.

- [ ] **Step 3: Implementar**

`lib/lol-match-explain.js`:
```js
'use strict';
/**
 * lol-match-explain.js — Display-only LLM "match reading".
 * Pure helpers: build the prompt from the already-computed game-profile, and parse
 * the model's JSON answer into sections. No network here (the endpoint calls aiPost).
 *
 * DISPLAY-ONLY: the analysis is qualitative; it must never feed stake/EV/Kelly.
 */
const KEYS = ['early', 'mid', 'late', 'winCondition', 'keyMatchup', 'verdict'];

function _side(w) { return w === 'blue' ? 'Azul' : w === 'red' ? 'Vermelho' : 'equilíbrio'; }

function buildExplainPrompt({ gameProfile, draft, teams, probPct, label }) {
  const gp = gameProfile || {};
  const t = teams || {};
  const lines = [];
  lines.push('Dados da partida de LoL (modelo estatístico display-only — NÃO são apostas):');
  lines.push(`- Times: Azul=${t.blue || '(não informado)'}, Vermelho=${t.red || '(não informado)'}`);
  if (probPct != null) lines.push(`- P(Azul vence) ~ ${probPct}% (${label || ''}), via Elo do time`);
  if (gp.fairOdds) {
    let odds = `- Odd justa: Azul ${gp.fairOdds.team1} / Vermelho ${gp.fairOdds.team2}`;
    if (gp.edge != null) odds += `; edge vs odd da casa: ${(gp.edge * 100).toFixed(1)}%`;
    lines.push(odds);
  }
  if (gp.phases) {
    const { early, mid, late } = gp.phases;
    if (early && early.anchor) lines.push(`- EARLY (medido): ${_side(early.winner)} — Δ aos 15min ${early.anchor.golddiff15}g, ${early.anchor.xpdiff15}xp, ${early.anchor.csdiff15}cs`);
    if (mid) lines.push(`- MID (estimado): ${_side(mid.winner)}`);
    if (late) lines.push(`- LATE (estimado/scaling): ${_side(late.winner)}`);
  }
  if (gp.expectedTime) lines.push(`- Tempo esperado: ${gp.expectedTime.bucket} (~${Math.round(gp.expectedTime.seconds / 60)} min)`);
  if (gp.winCondition) lines.push(`- Win condition (computada): ${gp.winCondition}`);
  if (gp.compStyle) lines.push(`- Estilo de comp: Azul=${gp.compStyle.blue.style}, Vermelho=${gp.compStyle.red.style}`);
  if (draft) {
    const fmt = (arr) => (arr || []).map(p => `${p.role}:${p.champion}`).join(' ');
    lines.push(`- Draft Azul: ${fmt(draft.blue)}  | Draft Vermelho: ${fmt(draft.red)}`);
  }
  lines.push('');
  lines.push('Você é um analista de LoL. Com base SOMENTE nos dados acima, escreva a leitura em PT-BR.');
  lines.push('Responda APENAS um JSON compacto, nada fora dele:');
  lines.push('{"early":"…","mid":"…","late":"…","winCondition":"…","keyMatchup":"…","verdict":"…"}');
  lines.push('Regras: cada campo 1-2 frases; seja MEDIDO — draft sozinho é sinal fraco, o Elo do time domina o resultado; NÃO recomende stake nem diga "aposte"; no verdict comente valor apenas em relação à odd justa; não invente nada fora dos dados acima.');
  return lines.join('\n');
}

function parseExplainResponse(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const hasAny = KEYS.some(k => typeof obj[k] === 'string' && obj[k].trim());
  if (!hasAny) return null;
  const out = {};
  for (const k of KEYS) out[k] = (typeof obj[k] === 'string') ? obj[k] : '';
  return out;
}

module.exports = { buildExplainPrompt, parseExplainResponse };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: `[lol-match-explain]` com `✓` nos 5 testes; suíte `N passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add lib/lol-match-explain.js tests/test-lol-match-explain.js
git commit -m "feat(match-lab): AI explain prompt builder + response parser (display-only)"
```

---

## Task 2: Endpoint `POST /api/lol-match-explain`

**Files:**
- Modify: `server.js` (inserir após o handler `/api/lol-teams`, que termina ~`server.js:5397`)

- [ ] **Step 1: Confirmar o ponto de inserção**

Run: `node -e "const s=require('fs').readFileSync('server.js','utf8').split('\n').slice(5395,5400).join('\n'); console.log(s)"`
Expected: ver o fim do handler `/api/lol-teams` (`return; }`) — você insere o novo handler logo depois.

- [ ] **Step 2: Inserir o handler**

Adicione este bloco imediatamente após o `}` de fechamento do `if (p === '/api/lol-teams' ...)` (antes do comentário do `/api/lol-draft-parse-print`):
```js
  // Match Lab — AI match reading (display-only). Sonnet explains the game-profile; never feeds stake.
  if (p === '/api/lol-match-explain' && req.method === 'POST') {
    _readPostBody(req, res, async (body) => {
      if (body == null) return;
      try {
        const KEY = process.env.ANTHROPIC_API_KEY;
        if (!KEY) { sendJson(res, { ok: false, error: 'vision_disabled', tip: 'set ANTHROPIC_API_KEY' }, 503); return; }
        const json = safeParse(body, null);
        const draft = (Array.isArray(json?.blue) && Array.isArray(json?.red) && json.blue.length && json.red.length)
          ? { blue: json.blue.slice(0, 5), red: json.red.slice(0, 5) } : null;
        if (!json?.team1 && !json?.team2 && !draft) { sendJson(res, { ok: false, error: 'empty_match' }, 400); return; }

        // Daily cap per (IP, day). Reserve BEFORE the paid call so failures count (anti-abuse).
        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
        const cap = parseInt(process.env.AI_ANALYSIS_DAILY_CAP || '30', 10);
        const _amap = (global._aiAnalysisDayMap = global._aiAnalysisDayMap || new Map());
        const dayKey = `${ip}|${new Date().toISOString().slice(0, 10)}`;
        const usedN = _amap.get(dayKey) || 0;
        if (usedN >= cap) { sendJson(res, { ok: false, error: 'daily_cap_reached', cap }, 429); return; }
        _amap.set(dayKey, usedN + 1);

        const { predictMatch } = require('./lib/lol-match-predict');
        const { computeGameProfile } = require('./lib/lol-game-profile');
        const { computeDraftWinProb } = require('./lib/lol-draft-model');
        const { buildExplainPrompt, parseExplainResponse } = require('./lib/lol-match-explain');

        const side = json?.side === 'red' ? 'red' : 'blue';
        const out = predictMatch(db, { team1: json?.team1 || null, team2: json?.team2 || null, side, draft, league: json?.league || null });
        let laneMatchups = [], knownChamps = 0, totalChamps = 10;
        if (draft) { const d = computeDraftWinProb(draft); laneMatchups = d.breakdown.laneMatchups; knownChamps = d.breakdown.knownChamps; totalChamps = d.breakdown.totalChamps; }
        const bookOdds = (typeof json?.bookOdds === 'number') ? json.bookOdds : null;
        const gameProfile = computeGameProfile({ draft, probTeam1: out.prob, bookOdds,
          eloConfidence: (out.components && out.components.elo) ? out.components.elo.confidence : 0,
          laneMatchups, knownChamps, totalChamps });

        const teams = { blue: side === 'blue' ? (json?.team1 || null) : (json?.team2 || null),
                        red:  side === 'blue' ? (json?.team2 || null) : (json?.team1 || null) };
        const prompt = buildExplainPrompt({ gameProfile, draft, teams, probPct: Math.round(out.probBlue * 100), label: out.label });
        const model = process.env.AI_ANALYSIS_MODEL || 'claude-sonnet-4-5';
        const payload = { model, max_tokens: 700, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] };
        const r = await aiPost('anthropic', 'https://api.anthropic.com/v1/messages', payload,
          { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' }, { timeoutMs: 30000, retry: { maxAttempts: 2 } });
        try { stmts.incrApiUsage.run('anthropic', new Date().toISOString().slice(0, 7)); } catch (_) {}

        const rj = r ? safeParse(r.body, {}) : {};
        const text = (rj?.content || []).map(c => c.text || '').join('');
        const analysis = parseExplainResponse(text);
        if (analysis) sendJson(res, { ok: true, analysis });
        else if (text && text.trim()) sendJson(res, { ok: true, analysis: null, raw: text.slice(0, 1200) });
        else sendJson(res, { ok: false, error: 'ai_failed' }, 500);
      } catch (e) {
        log('WARN', 'MATCH-LAB', `match-explain err: ${e.message}`);
        sendJson(res, { ok: false, error: 'ai_failed' }, 500);
      }
    });
    return;
  }
```

- [ ] **Step 3: Validar sintaxe**

Run: `node -c server.js`
Expected: exit 0, sem erro.

- [ ] **Step 4: Rodar a suíte (nada quebrou)**

Run: `npm test`
Expected: `N passed, 0 failed`.

- [ ] **Step 5: Smoke local do prompt+parse end-to-end (sem rede)**

Run:
```bash
node -e "
const Database=require('better-sqlite3');
const db=new Database('sportsedge.db',{readonly:true});
const { predictMatch }=require('./lib/lol-match-predict');
const { computeGameProfile }=require('./lib/lol-game-profile');
const { computeDraftWinProb }=require('./lib/lol-draft-model');
const { buildExplainPrompt, parseExplainResponse }=require('./lib/lol-match-explain');
const draft={blue:[{champion:'Aatrox',role:'top'},{champion:'Jinx',role:'bot'}],red:[{champion:'Gnar',role:'top'},{champion:'Caitlyn',role:'bot'}]};
const out=predictMatch(db,{team1:'T1',team2:'Gen.G',side:'blue',draft});
const d=computeDraftWinProb(draft);
const gp=computeGameProfile({draft,probTeam1:out.prob,bookOdds:1.55,eloConfidence:out.components.elo?out.components.elo.confidence:0,laneMatchups:d.breakdown.laneMatchups,knownChamps:d.breakdown.knownChamps,totalChamps:d.breakdown.totalChamps});
const prompt=buildExplainPrompt({gameProfile:gp,draft,teams:{blue:'T1',red:'Gen.G'},probPct:Math.round(out.probBlue*100),label:out.label});
console.log(prompt);
console.log('--- parse roundtrip ---', JSON.stringify(parseExplainResponse('x {\"early\":\"a\",\"mid\":\"b\",\"late\":\"c\",\"winCondition\":\"d\",\"keyMatchup\":\"e\",\"verdict\":\"f\"} y')));
db.close();
"
```
Expected: o prompt impresso com as linhas de dados reais (P(Azul vence), odd justa, EARLY medido, draft) + a instrução JSON; o parse roundtrip mostra as 6 chaves.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat(match-lab): POST /api/lol-match-explain (Sonnet, capped, display-only)"
```

> **Nota:** `aiPost`, `stmts`, `safeParse`, `sendJson`, `log`, `_readPostBody`, `db` já estão no escopo do `server.js` (o handler do print-parse usa os mesmos). Não adicione requires no topo.

---

## Task 3: UI — botão + render das seções

**Files:**
- Modify: `public/lol-live-dashboard.html` (`dlRenderGameProfile`, ~2196; CSS antes de `</style>`)

- [ ] **Step 1: Localizar o fim de `dlRenderGameProfile`**

Run: `node -e "const s=require('fs').readFileSync('public/lol-live-dashboard.html','utf8'); const i=s.indexOf('draft é sinal fraco — leitura'); console.log(s.slice(i-180,i+120));"`
Expected: ver as últimas linhas de `dlRenderGameProfile` (o `dl-gp-quality` e o `dl-gp-warn`) — você adiciona o botão logo após, ainda dentro da função.

- [ ] **Step 2: Adicionar o botão no fim de `dlRenderGameProfile`**

Logo antes do fechamento `}` de `dlRenderGameProfile` (após o `root.appendChild` do `dl-gp-warn`), adicione:
```js
  // AI analysis (on demand — paid call, capped server-side)
  const aiWrap = el('div', { class: 'dl-gp-ai' });
  const aiOut = el('div', { class: 'dl-ai-out' });
  const aiBtn = el('button', { class: 'dl-ai-btn' }, '🤖 Análise da IA');
  aiBtn.addEventListener('click', () => dlExplainMatch(aiBtn, aiOut));
  aiWrap.appendChild(aiBtn);
  aiWrap.appendChild(aiOut);
  root.appendChild(aiWrap);
```

- [ ] **Step 3: Adicionar `dlExplainMatch` e `dlRenderAiAnalysis`**

Logo após a função `dlRenderGameProfile` (depois do seu `}`), adicione:
```js
async function dlExplainMatch(btn, outEl) {
  const team1 = (document.getElementById('dl_blueTeam')?.value || '').trim() || null;
  const team2 = (document.getElementById('dl_redTeam')?.value  || '').trim() || null;
  const draft = dlCollectDraft();
  const oddRaw = parseFloat((document.querySelector('.dl-gp-bookodds')?.value) || '');
  if (!team1 && !team2 && !draft) { outEl.textContent = 'Informe os times e/ou o draft.'; return; }
  const old = btn.textContent; btn.disabled = true; btn.textContent = 'analisando…'; outEl.innerHTML = '';
  try {
    const reqBody = { team1, team2, side: 'blue', blue: draft?.blue, red: draft?.red };
    if (oddRaw > 1) reqBody.bookOdds = oddRaw;
    const r = await fetch('/api/lol-match-explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody) });
    const data = await r.json();
    if (!data.ok) {
      outEl.textContent = data.error === 'daily_cap_reached' ? 'Limite diário de análises atingido.'
        : data.error === 'vision_disabled' ? 'IA indisponível (sem chave configurada).'
        : data.error === 'empty_match' ? 'Informe os times e/ou o draft.'
        : 'Falha na análise.';
      return;
    }
    dlRenderAiAnalysis(outEl, data);
  } catch (e) { outEl.textContent = 'Falha: ' + e.message; }
  finally { btn.disabled = false; btn.textContent = old; }
}

function dlRenderAiAnalysis(outEl, data) {
  outEl.innerHTML = '';
  if (data.analysis) {
    const a = data.analysis;
    [['EARLY', a.early], ['MID', a.mid], ['LATE', a.late], ['WIN', a.winCondition], ['CHAVE', a.keyMatchup], ['VEREDITO', a.verdict]]
      .forEach(([k, v]) => { if (v) outEl.appendChild(el('div', { class: 'dl-ai-row' }, el('span', { class: 'dl-ai-k' }, k), el('span', {}, v))); });
  } else if (data.raw) {
    outEl.appendChild(el('div', { class: 'dl-ai-raw' }, data.raw));
  }
  outEl.appendChild(el('div', { class: 'dl-gp-warn' }, '⚠ leitura da IA — não é sinal de aposta'));
}
```

- [ ] **Step 4: Adicionar CSS antes de `</style>`**

```css
.dl-gp-ai{margin-top:10px;padding-top:8px;border-top:1px solid #1a2a3a}
.dl-ai-btn{background:#13283a;border:1px solid #2a4a66;color:#cfe;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:12px}
.dl-ai-btn:disabled{opacity:.6;cursor:default}
.dl-ai-out{margin-top:8px}
.dl-ai-row{font-size:13px;line-height:1.6;margin-bottom:3px}
.dl-ai-k{display:inline-block;min-width:74px;color:#5a7a9a;font-size:11px;letter-spacing:1px}
.dl-ai-raw{font-size:13px;line-height:1.6;white-space:pre-wrap;color:#cfe}
```

- [ ] **Step 5: Verificar inserção + sintaxe JS**

Run:
```bash
node -e "
const s=require('fs').readFileSync('public/lol-live-dashboard.html','utf8');
const m=[...s.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]; const vm=require('vm'); let ok=true;
m.forEach((b,i)=>{ if(!b[1].trim())return; try{ new vm.Script(b[1]); }catch(e){ ok=false; console.log('block',i,'ERR:',e.message);} });
console.log('JS OK:',ok,'| btn:',s.includes('dlExplainMatch')&&s.includes('Análise da IA'),'| render:',s.includes('dlRenderAiAnalysis'),'| css:',s.includes('dl-ai-btn'));
"
```
Expected: `JS OK: true | btn: true | render: true | css: true`.

- [ ] **Step 6: Commit**

```bash
git add public/lol-live-dashboard.html
git commit -m "feat(match-lab): AI analysis button + sections render in panel"
```

---

## Task 4: Smoke de produção (pós-merge/deploy)

**Files:** nenhum (verificação)

- [ ] **Step 1: Merge + push** (`git push origin main` autorizado). Aguardar o deploy (confirmar `code_sha` novo em `/health`).

- [ ] **Step 2: Smoke real (1 chamada paga de Sonnet)**

PowerShell:
```powershell
$BASE='https://sportsedge-bot-production.up.railway.app'
$body=@{team1='T1';team2='Gen.G';side='blue';bookOdds=1.55;
  blue=@(@{champion='Aatrox';role='top'},@{champion='Jinx';role='bot'});
  red=@(@{champion='Gnar';role='top'},@{champion='Caitlyn';role='bot'})} | ConvertTo-Json -Depth 5
$r=Invoke-RestMethod -Uri "$BASE/api/lol-match-explain" -Method POST -Body $body -ContentType 'application/json'
"ok=$($r.ok)"; $r.analysis | ConvertTo-Json -Depth 4
```
Expected: `ok=True` e `analysis` com as 6 seções preenchidas em PT-BR (ou `raw` se o modelo não devolver JSON limpo). Se `vision_disabled`, confirmar `ANTHROPIC_API_KEY` no Railway.

- [ ] **Step 3: Smoke da UI**

```powershell
$edge=Invoke-WebRequest -Uri "$BASE/edge" -UseBasicParsing
"hasBtn=$($edge.Content -match 'dlExplainMatch')  status=$($edge.StatusCode)"
```
Expected: `hasBtn=True status=200`.

- [ ] **Step 4: Atualizar a memory** (`project_match_lab_2026_06_01.md`): AI explain shipped, commit final, resultado do smoke, modelo usado.

---

## Self-Review

**1. Cobertura do spec:**
- §4 lib (`buildExplainPrompt`/`parseExplainResponse`) → Task 1. ✓
- §5 contrato (request/response, fallback raw, erros) → Task 2 (handler retorna `analysis` | `raw` | erros `vision_disabled`/`empty_match`/`daily_cap_reached`/`ai_failed`). ✓
- §6 prompt (dados ancorados + instrução) → Task 1 `buildExplainPrompt`. ✓
- §7 parse + fallback → Task 1 `parseExplainResponse` + Task 2 (raw quando null). ✓
- §8 UI (botão, loading, seções, fallback, erros, disclaimer) → Task 3. ✓
- §9 cap/custo (`AI_ANALYSIS_DAILY_CAP` 30, `incrApiUsage`, `AI_ANALYSIS_MODEL`) → Task 2. ✓
- §10 edge cases (sem key, sem match, cap, ai_failed, JSON inválido→raw) → Task 2 + Task 1. ✓
- §11 testes → Task 1 (5 testes) + Task 4 smoke. ✓

**2. Placeholder scan:** sem TBD/TODO; todo step com código tem código completo. ✓

**3. Consistência de tipos:** `buildExplainPrompt({gameProfile,draft,teams,probPct,label})` e `parseExplainResponse(text)→{early,mid,late,winCondition,keyMatchup,verdict}|null` idênticos entre Task 1 (def), Task 2 (uso no endpoint) e Task 3 (render lê `data.analysis.{early…verdict}` + `data.raw`). O endpoint usa `out.probBlue`/`out.label`/`out.components.elo.confidence` (shape real de `predictMatch`) e `computeGameProfile(...)` com os mesmos campos da Task 7 do game-profile. ✓
