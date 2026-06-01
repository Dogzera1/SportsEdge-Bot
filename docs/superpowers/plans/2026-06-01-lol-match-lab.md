# Match Lab — Plano 1: Modelo + Validação (offline)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir e **validar** offline um preditor de partida LoL calibrado (Elo+form+player+draft+side), reusando os sub-modelos existentes read-only, com ship-gate baseado em walk-forward — sem tocar no betting ao vivo.

**Architecture:** Backtest point-in-time replay do `match_results` (24k jogos) usando a Elo engine incremental existente; fit dos pesos do blend (logistic) + calibração isotonic na janela onde há draft (OE overlap); artefatos `lib/lol-match-meta.json` + `lib/lol-match-calib.json`; função de display `lib/lol-match-predict.js`. Spec: `docs/superpowers/specs/2026-06-01-lol-match-lab-design.md`.

**Tech Stack:** Node 18, better-sqlite3, `lib/elo-rating.js` (`createEloSystem`), `lib/lol-model.js` (sub-modelos), `lib/lol-draft-model.js` (`computeDraftWinProb`), `lib/calibration.js` + `lib/brier-holdout-eval.js` (isotonic/Brier/ECE — reuso).

**Escopo deste plano (Plano 1):** modelo + harness + validação + artefatos + `predictMatch()`. **Fora deste plano (Plano 2, gated no ship-gate):** endpoint `POST /api/lol-match-analyze`, `GET /api/lol-teams`, e a UI Match Lab no `/edge`.

**Money-path guard:** nenhuma task altera comportamento de `getLolProbability`, EV, stake, Kelly ou dispatch. As edições em `lib/lol-model.js` são **aditivas** (export + param opcional com default que preserva o comportamento), com teste de regressão provando saída idêntica.

---

## Estrutura de arquivos

**Criar**
- `scripts/backtest-lol-match.js` — harness point-in-time: replay Elo, features as-of, fit pesos+calibração, métricas, ship-gate.
- `lib/lol-match-predict.js` — `predictMatch(db, {team1,team2,side,draft})` (display blend + apply calibração).
- `lib/lol-match-meta.json` — pesos do blend + config (output do harness).
- `lib/lol-match-calib.json` — isotonic blocks (output do harness).
- `tests/test-lol-match-predict.js` — unit tests do blend/apply.
- `tests/test-lol-model-asof.js` — regressão: `_formSubModel` com `asOfDate` default == comportamento atual.

**Modificar (aditivo, sem mudança de comportamento)**
- `lib/lol-model.js` — exportar sub-modelos read-only; `_formSubModel` ganha param opcional `asOfDate` (default = agora).

**Intocado (guard):** qualquer coisa em bet/stake/EV/Kelly/dispatch; o blend interno de `getLolProbability`.

---

### Task 1: Sincronizar dados OE 2024-2025

**Files:**
- Run only (popula `oracleselixir_players` / `oracleselixir_games`)

- [ ] **Step 1: Rodar o sync dos anos faltantes**

A tabela hoje só tem 2026 (4104 jogos). Mais jogos = tabelas draft/player-champ mais densas.

Run:
```bash
node scripts/sync-oracleselixir.js --year=2024 --year=2025
```
Expected: log `[sync] upserted N rows` para cada ano (cada ano ≈ 9-10k jogos ≈ ~110k rows).

- [ ] **Step 2: Verificar a cobertura**

Run:
```bash
node -e "const D=require('better-sqlite3');const db=new D('sportsedge.db',{readonly:true});console.log(db.prepare(\"SELECT year, COUNT(DISTINCT gameid) g FROM oracleselixir_players GROUP BY year ORDER BY year\").all());db.close();"
```
Expected: linhas para 2024, 2025 e 2026 (cada ano com milhares de jogos). Se só aparecer 2026, o sync falhou — investigar antes de prosseguir.

- [ ] **Step 3: Commit (nenhum arquivo — só dados).** Pular commit; anotar contagens no PR/handoff.

---

### Task 2: Tornar os sub-modelos reusáveis (export + form as-of)

Necessário para: (a) o harness computar form **point-in-time** (sem leakage de "now"); (b) `lib/lol-match-predict.js` compor os sub-modelos diretamente. Mudança **aditiva** — callers existentes inalterados.

**Files:**
- Modify: `lib/lol-model.js` (assinatura `_formSubModel`, bloco `module.exports`)
- Test: `tests/test-lol-model-asof.js`

- [ ] **Step 1: Escrever o teste de regressão (falha primeiro)**

```javascript
// tests/test-lol-model-asof.js
const assert = require('assert');
const Database = require('better-sqlite3');
const path = require('path');
const lm = require('../lib/lol-model');

const db = new Database(path.join(__dirname, '..', 'sportsedge.db'), { readonly: true });

// 1) sub-modelos agora são exportados
assert.strictEqual(typeof lm._formSubModel, 'function', '_formSubModel deve ser exportado');
assert.strictEqual(typeof lm._eloSubModel, 'function', '_eloSubModel deve ser exportado');

// 2) _formSubModel sem asOfDate == com asOfDate=null (comportamento atual preservado)
const a = lm._formSubModel(db, 'T1', 'Gen.G', null);
const b = lm._formSubModel(db, 'T1', 'Gen.G', null, null);
assert.deepStrictEqual({ pA: a.pA, conf: a.confidence }, { pA: b.pA, conf: b.confidence },
  'default asOfDate deve preservar o comportamento');

// 3) asOfDate no passado distante => menos/zero dados de form (confidence <= atual)
const past = lm._formSubModel(db, 'T1', 'Gen.G', null, '2022-02-01 00:00:00');
assert.ok(past.confidence <= a.confidence + 1e-9, 'as-of passado não pode ter mais form que agora');

db.close();
console.log('OK test-lol-model-asof');
```

- [ ] **Step 2: Rodar — falha (sub-modelos não exportados)**

Run: `node tests/test-lol-model-asof.js`
Expected: FAIL no primeiro assert (`_formSubModel deve ser exportado`).

- [ ] **Step 3: Adicionar `asOfDate` opcional ao `_formSubModel`**

Em `lib/lol-model.js`, a assinatura (linha ~253) e as duas queries de form. Trocar a âncora temporal de `datetime('now', ...)` por um parâmetro com default `'now'`.

Assinatura:
```javascript
// de:
function _formSubModel(db, team1, team2, enrich) {
// para:
function _formSubModel(db, team1, team2, enrich, asOfDate) {
  const _ref = asOfDate || 'now';            // default preserva comportamento
  const _refExpr = asOfDate ? '?' : "'now'"; // bind só quando custom
```

Nas duas queries de form (team1 e team2), trocar `datetime('now', '-60 days')` por `datetime(${_refExpr}, '-60 days')` e, quando `asOfDate`, adicionar `AND resolved_at < datetime(?, '0 days')` (corta futuro) + passar `_ref` nos binds. Manter a versão sem-asOfDate **idêntica** à atual (mesma SQL string, mesmos binds) via branch.

> Nota de implementação para o executor: preserve a SQL exata no caminho default (sem `asOfDate`) para garantir o teste de regressão (Step 1, assert 2). Só o caminho `asOfDate` adiciona o filtro `resolved_at < asOfDate`.

- [ ] **Step 4: Exportar os sub-modelos (read-only)**

No `module.exports` de `lib/lol-model.js` (linha ~888-891), adicionar os sub-modelos e `_getElo`:
```javascript
module.exports = {
  getLolProbability,
  classifyLeague,
  _eloSubModel, _compSubModel, _formSubModel, _oeSubModel, _playerSubModel,
  _getElo,
  // ...mantém o que já existe
};
```

- [ ] **Step 5: Rodar o teste de regressão — passa**

Run: `node tests/test-lol-model-asof.js`
Expected: `OK test-lol-model-asof`.

- [ ] **Step 6: Provar que `getLolProbability` não mudou**

Run: `node -c lib/lol-model.js && node tests/run-all.js 2>&1 | tail -3` (ou o runner do projeto)
Expected: suíte existente continua verde (898 passed). Se o projeto tiver teste específico de `getLolProbability`, rodar e confirmar saída idêntica.

- [ ] **Step 7: Commit**

```bash
git add lib/lol-model.js tests/test-lol-model-asof.js
git commit -m "feat(lol-model): export sub-models + optional asOfDate on _formSubModel (additive, behavior unchanged)"
```

---

### Task 3: Métricas reusáveis (Brier/ECE/baseline)

Reuso de `lib/brier-holdout-eval.js` (`_brierScore`, `_computeEce`). Expor essas helpers se ainda não exportadas; criar só um wrapper fino com o baseline blue-side.

**Files:**
- Modify: `lib/brier-holdout-eval.js` (exportar `_brierScore`, `_computeEce` se faltar)
- Create: `lib/lol-match-metrics.js`
- Test: `tests/test-lol-match-metrics.js`

- [ ] **Step 1: Teste com valores conhecidos (falha primeiro)**

```javascript
// tests/test-lol-match-metrics.js
const assert = require('assert');
const m = require('../lib/lol-match-metrics');

// Brier: pred 1.0 e outcome 1 => 0; pred 0.5 sempre => 0.25
assert.ok(Math.abs(m.brier([{p:1,y:1},{p:0,y:0}]) - 0) < 1e-9);
assert.ok(Math.abs(m.brier([{p:0.5,y:1},{p:0.5,y:0}]) - 0.25) < 1e-9);

// Baseline blue-side: prediz sempre a base-rate p* => Brier = p*(1-p*)
const samples = [{p:0,y:1},{p:0,y:0},{p:0,y:1}]; // base-rate y = 2/3
const b = m.blueSideBaseline(samples);
assert.ok(Math.abs(b.pStar - 2/3) < 1e-9);
assert.ok(Math.abs(b.brier - (2/3)*(1/3)) < 1e-9);

// ECE de previsões perfeitamente calibradas ~ 0
const cal = Array.from({length:100}, (_,i)=>({p:0.7, y: i<70?1:0}));
assert.ok(m.ece(cal) < 0.05);

console.log('OK test-lol-match-metrics');
```

- [ ] **Step 2: Rodar — falha (módulo inexistente)**

Run: `node tests/test-lol-match-metrics.js`
Expected: FAIL `Cannot find module '../lib/lol-match-metrics'`.

- [ ] **Step 3: Implementar o wrapper, reusando helpers existentes**

```javascript
// lib/lol-match-metrics.js
// Reuso das helpers de brier-holdout-eval; só adiciona o baseline blue-side.
const be = require('./brier-holdout-eval');

// samples: Array<{ p:number(0..1), y:0|1 }>
function brier(samples) {
  let s = 0; for (const x of samples) s += (x.p - x.y) ** 2;
  return samples.length ? s / samples.length : NaN;
}
function logloss(samples) {
  let s = 0; for (const x of samples) { const p = Math.min(1-1e-9, Math.max(1e-9, x.p)); s += -(x.y*Math.log(p)+(1-x.y)*Math.log(1-p)); }
  return samples.length ? s / samples.length : NaN;
}
function ece(samples, bins = 10) {
  // reusa _computeEce se exportado; senão impl local equivalente (10 bins)
  if (typeof be._computeEce === 'function') return be._computeEce(samples.map(x => ({ p: x.p, outcome: x.y })));
  let e = 0; const B = Array.from({length:bins},()=>({n:0,sp:0,sy:0}));
  for (const x of samples){ const i=Math.min(bins-1,Math.floor(x.p*bins)); B[i].n++; B[i].sp+=x.p; B[i].sy+=x.y; }
  const N = samples.length || 1;
  for (const b of B){ if(!b.n) continue; e += (b.n/N)*Math.abs(b.sp/b.n - b.sy/b.n); }
  return e;
}
// Baseline: prediz sempre a base-rate global (≈ blue-side win rate) — o alvo real a bater
function blueSideBaseline(samples) {
  const pStar = samples.length ? samples.reduce((a,x)=>a+x.y,0)/samples.length : 0.5;
  return { pStar, brier: brier(samples.map(x => ({ p: pStar, y: x.y }))) };
}
module.exports = { brier, logloss, ece, blueSideBaseline };
```

Se `_computeEce`/`_brierScore` não estiverem exportados em `lib/brier-holdout-eval.js`, adicioná-los ao `module.exports` desse arquivo (aditivo).

- [ ] **Step 4: Rodar — passa**

Run: `node tests/test-lol-match-metrics.js`
Expected: `OK test-lol-match-metrics`.

- [ ] **Step 5: Commit**

```bash
git add lib/lol-match-metrics.js tests/test-lol-match-metrics.js lib/brier-holdout-eval.js
git commit -m "feat(lol-match): reusable Brier/logloss/ECE + blue-side baseline metrics"
```

---

### Task 4: Harness — Elo point-in-time (baseline)

Primeiro corte do backtest: só Elo, replay incremental. Prova a infra de não-leakage e que Elo sozinho bate o base-rate.

**Files:**
- Create: `scripts/backtest-lol-match.js`

- [ ] **Step 1: Replay Elo point-in-time + métricas**

```javascript
// scripts/backtest-lol-match.js
const path = require('path');
const Database = require('better-sqlite3');
const { createEloSystem } = require('../lib/elo-rating');
const { classifyLeague } = require('../lib/lol-model');
const M = require('../lib/lol-match-metrics');

const db = new Database(path.join(__dirname, '..', 'sportsedge.db'), { readonly: true });

// Todos os jogos LoL resolvidos, em ordem cronológica (sem leakage).
const games = db.prepare(`
  SELECT team1, team2, winner, final_score, league, resolved_at
  FROM match_results
  WHERE game='lol' AND winner IS NOT NULL AND winner!=''
    AND team1 IS NOT NULL AND team2 IS NOT NULL
  ORDER BY resolved_at ASC
`).all();

const elo = createEloSystem({ kBase: 32, kMin: 10, kScale: 40, halfLifeDays: 60, confidenceScale: 20, confidenceFloor: 5 });
const samples = []; // { p: P(team1 vence), y: 1 se team1 venceu }

for (const g of games) {
  const tier = classifyLeague(g.league);
  // PREVISÃO as-of (usa só o passado já processado)
  const pred = elo.getP(g.team1, g.team2, tier);
  const y = (String(g.winner).toLowerCase() === String(g.team1).toLowerCase()) ? 1 : 0;
  if (pred.foundA && pred.foundB && pred.confidence > 0) {
    samples.push({ p: pred.pA, y, date: g.resolved_at, league: g.league });
  }
  // DEPOIS atualiza o Elo com o resultado
  const winner = y ? g.team1 : g.team2, loser = y ? g.team2 : g.team1;
  const sc = String(g.final_score || '').match(/(\d+)\s*[-:]\s*(\d+)/);
  const margin = sc ? Math.max(1, Math.abs(parseInt(sc[1])-parseInt(sc[2]))) : 1;
  elo.rate(winner, loser, margin, g.resolved_at, tier);
}

const base = M.blueSideBaseline(samples);
console.log(`[backtest] n=${samples.length}`);
console.log(`[backtest] Elo-only:  Brier=${M.brier(samples).toFixed(4)}  logloss=${M.logloss(samples).toFixed(4)}  ECE=${M.ece(samples).toFixed(4)}`);
console.log(`[backtest] baseline:  Brier=${base.brier.toFixed(4)} (pStar=${base.pStar.toFixed(3)})`);
console.log(`[backtest] Elo beats baseline OOS? ${M.brier(samples) < base.brier ? 'YES' : 'NO'}`);

db.close();
```

- [ ] **Step 2: Rodar e ler o baseline**

Run: `node scripts/backtest-lol-match.js`
Expected: imprime `n=` (milhares), Brier do Elo **menor** que o baseline (`Elo beats baseline OOS? YES`). Se `NO`, parar e investigar (provável bug de leakage invertido ou normalização de nomes).

- [ ] **Step 3: Commit**

```bash
git add scripts/backtest-lol-match.js
git commit -m "feat(backtest): point-in-time Elo replay baseline for LoL match predictor"
```

---

### Task 5: Harness — features as-of (form, draft, player-champ) + join OE

Adiciona as features que precisam de point-in-time e do join `match_results` ↔ `oracleselixir_*`.

**Files:**
- Modify: `scripts/backtest-lol-match.js`

- [ ] **Step 1: Form as-of via `_formSubModel(asOfDate)`**

No loop, antes do `elo.rate`, expandir **o mesmo objeto** que a Task 4 dá push em `samples` (mantém `p: pred.pA` para o baseline Elo já existente, e **adiciona** os componentes). Trocar o `samples.push({ p: pred.pA, y, ... })` da Task 4 por:
```javascript
const lm = require('../lib/lol-model');
// ...dentro do loop, junto com `pred`:
const form = lm._formSubModel(db, g.team1, g.team2, null, g.resolved_at); // as-of: sem leakage
const sample = { p: pred.pA, pElo: pred.pA, cElo: pred.confidence,
                 pForm: form.confidence>0 ? form.pA : null, cForm: form.confidence,
                 pDraft: null, cDraft: 0, team1IsBlue: null,
                 y, date: g.resolved_at, league: g.league };
samples.push(sample); // métricas Elo-only da Task 4 seguem válidas (usam sample.p)
```

- [ ] **Step 2: Join com OE para draft/player-champ (só janela com OE)**

OE tem `gameid, date, teamname, side, position, champion, playername, result`. Casar por **data + nomes de time** (normalização) é frágil; reusar o resolver de nomes existente. Construir um índice OE por (dia, teamname-normalizado) → champ list por side:
```javascript
const { findByName } = require('../lib/elo-rating'); // _norm interno via findByName
const { computeDraftWinProb } = require('../lib/lol-draft-model');

// Index OE games: Map<gameid, {date, blue:{team,champs[]}, red:{team,champs[]}}>
const oeRows = db.prepare(`SELECT gameid, date, teamname, side, position, champion, playername, result
  FROM oracleselixir_players WHERE position IN ('top','jng','mid','bot','sup')`).all();
const oeByGame = new Map();
for (const r of oeRows) {
  if (!oeByGame.has(r.gameid)) oeByGame.set(r.gameid, { date: r.date, blue:{team:null,champs:[]}, red:{team:null,champs:[]} });
  const G = oeByGame.get(r.gameid); const s = String(r.side).toLowerCase()==='blue'?G.blue:G.red;
  s.team = r.teamname; s.champs.push({ champion: r.champion, role: r.position });
}
// Index por (dateDay|teamNorm) -> [gameids] para casar com match_results
const norm = (s)=>String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
const oeIndex = new Map();
for (const [gid, G] of oeByGame) {
  const day = String(G.date).slice(0,10);
  for (const side of ['blue','red']) { const k = `${day}|${norm(G[side].team)}`; (oeIndex.get(k)||oeIndex.set(k,[]).get(k)).push({ gid, side }); }
}
```
No loop, **antes do `samples.push(sample)`**, casar o `match_results` game ao OE (mesmo dia ± 1, nomes normalizados); se achar, mutar o `sample`:
```javascript
const m = matchOeDraft(g, oeIndex, oeByGame, norm); // retorna { draft:{blue:[{champion,role}],red:[...]}, team1IsBlue:bool } ou null
if (m) {
  const d = computeDraftWinProb(m.draft);            // prob do lado BLUE
  sample.pDraft = m.team1IsBlue ? d.prob : 1 - d.prob; // alinha à orientação team1
  sample.cDraft = d.confidence;
  sample.team1IsBlue = m.team1IsBlue;
}
```
Implementar `matchOeDraft(g, oeIndex, oeByGame, norm)` como helper no script — contrato: localiza o gameid OE cujo dia bate `g.resolved_at` (±1) e cujos dois `teamname` normalizados batem `g.team1/g.team2`; retorna o draft `{blue,red}` (champs por role) + `team1IsBlue` (qual lado OE é o `team1` do match_results); descarta casamentos ambíguos/múltiplos (retorna `null`). **Player-champ history:** análogo, computar WR shrunk por (playername, champion) com OE rows `date < g.resolved_at`; **adiar para a Task 7 (ablation)** — só adicionar como 5ª feature se o draft já estiver casando bem.

- [ ] **Step 3: Logar cobertura do join**

```javascript
console.log(`[backtest] draft coverage: ${samples.filter(s=>s.pDraft!=null).length}/${samples.length}`);
```
Run: `node scripts/backtest-lol-match.js`
Expected: cobertura de draft > 0 e concentrada em 2024-2026 (janela OE). Se ~0, o join está quebrado — debugar a normalização de nomes antes de seguir.

- [ ] **Step 4: Commit**

```bash
git add scripts/backtest-lol-match.js
git commit -m "feat(backtest): as-of form + OE draft/player-champ join for match predictor"
```

---

### Task 6: Fit dos pesos do blend + calibração isotonic

**Files:**
- Modify: `scripts/backtest-lol-match.js`
- Create (output): `lib/lol-match-meta.json`, `lib/lol-match-calib.json`

- [ ] **Step 1: Montar o vetor de features em logit-space e fitar logistic**

Para cada sample com componentes presentes, `x = [logit(pElo), logit(pForm||0.5), logit(pDraft||0.5), sideTerm]` (side: +1 se team1 é blue, senão -1; termo aprende o viés ~+2-3pp). Reusar `fitLogistic` de `lib/lol-draft-train.js`. **Walk-forward:** ordenar por data, treinar nos primeiros 70%, avaliar nos 30% finais. Componentes ausentes entram como neutro (0.5 → logit 0) com um flag de presença.

```javascript
const { fitLogistic, sigmoid } = require('../lib/lol-draft-train');
const lg = (p)=>Math.log(Math.min(1-1e-6,Math.max(1e-6,p))/(1-Math.min(1-1e-6,Math.max(1e-6,p))));
const feats = samples.map(s => ({
  x: [ lg(s.pElo), s.pForm!=null?lg(s.pForm):0, s.pDraft!=null?lg(s.pDraft):0, s.team1IsBlue===true?1:(s.team1IsBlue===false?-1:0) ],
  y: s.y, date: s.date,
}));
feats.sort((a,b)=> String(a.date).localeCompare(String(b.date)));
const cut = Math.floor(feats.length*0.7);
const train = feats.slice(0,cut), test = feats.slice(cut);
const w = fitLogistic(train, { epochs: 600, lr: 0.1, l2: 0.05 }); // l2 forte: anti-overfit (P3)
const predict = (f)=> sigmoid(w[0] + f.x.reduce((a,xi,i)=>a+xi*w[i+1],0));
```

- [ ] **Step 2: Capar o peso de draft (sinal OOS ~0.002)**

Depois do fit, se `|w[draftIdx]|` dominar (ex.: > peso do Elo), capar explicitamente: `w[3] = Math.sign(w[3]) * Math.min(Math.abs(w[3]), Math.abs(w[1]) * 0.5)`. Documentar o cap aplicado no meta.

- [ ] **Step 3: Fit isotonic (PAV) na saída do blend, reusando `lib/calibration.js`**

Coletar `{p: predict(f), y: f.y}` no **train**, fitar isotonic PAV (reusar o fitter de `lib/calibration.js`; se o fit não for exportado, exportá-lo — aditivo) → blocks `[{pMin,pMax,yMean,n}]`. Aplicar via `_applyIsotonicBlocks` (de `lib/brier-holdout-eval.js`) no **test**. **Só manter a calibração se melhorar o Brier OOS** (senão, identidade).

- [ ] **Step 4: Escrever artefatos**

Usa as variáveis definidas nos steps anteriores: `draftCapApplied` (boolean do Step 2), `blocks` + `keptOOS` (do Step 3 — `blocks=[]` e `keptOOS=false` se a isotonic não melhorou OOS):
```javascript
const fs = require('fs');
fs.writeFileSync(path.join(__dirname,'..','lib','lol-match-meta.json'), JSON.stringify({
  weights: w, featureOrder: ['elo','form','draft','side'], draftCapApplied, trainedAt: new Date().toISOString(),
  n: feats.length, walkForward: { trainN: train.length, testN: test.length },
}));
fs.writeFileSync(path.join(__dirname,'..','lib','lol-match-calib.json'), JSON.stringify({ method:'isotonic_pav', blocks, keptOOS }));
```

- [ ] **Step 5: Rodar e inspecionar pesos**

Run: `node scripts/backtest-lol-match.js`
Expected: imprime os pesos; Elo deve ser o maior; draft pequeno (capado). Artefatos escritos em `lib/`.

- [ ] **Step 6: Commit**

```bash
git add scripts/backtest-lol-match.js lib/lol-match-meta.json lib/lol-match-calib.json lib/calibration.js lib/brier-holdout-eval.js
git commit -m "feat(backtest): fit blend weights (capped draft) + isotonic calibration artifacts"
```

---

### Task 7: Ship-gate — avaliar e decidir

**Files:**
- Modify: `scripts/backtest-lol-match.js` (relatório final)
- Modify: `docs/superpowers/specs/2026-06-01-lol-match-lab-design.md` (apêndice de resultados)

- [ ] **Step 1: Relatório OOS no holdout + por componente**

No `test` (30% finais), computar Brier/logloss/ECE do blend **calibrado** e comparar com: (a) baseline blue-side, (b) Elo-only, (c) Elo+form (sem draft). Imprimir tabela. Ablation: remover cada componente e medir delta no Brier OOS — é assim que se decide quais gaps (§6 do spec) ficam.

```javascript
function evalSet(set, predFn){ const s=set.map(f=>({p:predFn(f),y:f.y})); return {brier:M.brier(s),ll:M.logloss(s),ece:M.ece(s)}; }
console.log('[gate] baseline    ', M.blueSideBaseline(test.map(f=>({p:0,y:f.y}))));
console.log('[gate] elo-only     ', evalSet(test, f=>f.x[0]!==undefined? 1/(1+Math.exp(-f.x[0])):0.5));
console.log('[gate] blend+calib  ', evalSet(test, f=>applyCalib(predict(f))));
```

- [ ] **Step 2: Aplicar o ship-gate (critério de aceite)**

- **PASS** se: `blend+calib Brier(OOS) < baseline Brier` **e** `blend+calib logloss(OOS) < baseline` **e** `ECE(OOS) <= 0.03`.
- Para cada gap (side/draft/player-champ): manter **só se** melhora o Brier OOS no ablation; caso contrário, zerar o peso e re-escrever o meta.
- Se o **blend completo não bater o baseline**, fazer fallback para **Elo+form** calibrado e marcar draft/player/side como `disabled` no meta (o spec já prevê isso).

- [ ] **Step 3: Escrever apêndice de resultados no spec**

Adicionar uma seção "## 13. Resultados da validação (preenchido na execução)" no spec com: n, Brier/logloss/ECE de cada variante, quais gaps sobreviveram, pesos finais, e o veredito do gate. Sem isso, o handoff perde a evidência.

- [ ] **Step 4: Commit**

```bash
git add scripts/backtest-lol-match.js docs/superpowers/specs/2026-06-01-lol-match-lab-design.md
git commit -m "feat(backtest): ship-gate report + ablation; record validation results in spec"
```

---

### Task 8: `predictMatch()` de display (consome os artefatos validados)

**Files:**
- Create: `lib/lol-match-predict.js`
- Test: `tests/test-lol-match-predict.js`

- [ ] **Step 1: Teste do blend (falha primeiro)**

```javascript
// tests/test-lol-match-predict.js
const assert = require('assert');
const Database = require('better-sqlite3');
const path = require('path');
const { predictMatch } = require('../lib/lol-match-predict');
const db = new Database(path.join(__dirname,'..','sportsedge.db'), { readonly: true });

const out = predictMatch(db, { team1:'T1', team2:'Gen.G', side:'blue', draft:null });
assert.ok(out.prob >= 0 && out.prob <= 1, 'prob em [0,1]');
assert.ok(out.components && 'elo' in out.components, 'breakdown com elo');
assert.ok(['forte','lean','lean fraco'].includes(out.label), 'label honesto');

// só-draft (sem times) => label "lean fraco"
const d = predictMatch(db, { team1:null, team2:null, side:'blue',
  draft:{ blue:[{champion:'Aatrox',role:'top'}], red:[{champion:'Gnar',role:'top'}] } });
assert.strictEqual(d.label, 'lean fraco');
console.log('OK test-lol-match-predict');
db.close();
```

- [ ] **Step 2: Rodar — falha (módulo inexistente)**

Run: `node tests/test-lol-match-predict.js`
Expected: FAIL `Cannot find module '../lib/lol-match-predict'`.

- [ ] **Step 3: Implementar `predictMatch`**

```javascript
// lib/lol-match-predict.js — DISPLAY ONLY. Não chamar de paths de stake/EV.
const fs = require('fs'); const path = require('path');
const lm = require('./lol-model');
const { computeDraftWinProb } = require('./lol-draft-model');
const { sigmoid } = require('./lol-draft-train');
const { _applyIsotonicBlocks } = require('./brier-holdout-eval');

const META = JSON.parse(fs.readFileSync(path.join(__dirname,'lol-match-meta.json'),'utf8'));
const CALIB = JSON.parse(fs.readFileSync(path.join(__dirname,'lol-match-calib.json'),'utf8'));
const lg = (p)=>Math.log(Math.min(1-1e-6,Math.max(1e-6,p))/(1-Math.min(1-1e-6,Math.max(1e-6,p))));

function predictMatch(db, { team1, team2, side, draft }) {
  const w = META.weights; const comp = {};
  let xElo=0, xForm=0, xDraft=0, xSide=0, have=0, need=0;

  if (team1 && team2) {
    const elo = lm._eloSubModel(db, team1, team2, ''); need++;
    if (elo.foundA && elo.foundB && elo.confidence>0) { xElo=lg(elo.pA); comp.elo={p:elo.pA,conf:elo.confidence}; have++; }
    const form = lm._formSubModel(db, team1, team2, null); 
    if (form.confidence>0) { xForm=lg(form.pA); comp.form={p:form.pA,conf:form.confidence}; }
  }
  if (draft && draft.blue && draft.red) {
    const d = computeDraftWinProb(draft);              // prob do BLUE
    const team1IsBlue = (side||'blue')==='blue';
    const pD = team1IsBlue ? d.prob : 1-d.prob;
    xDraft = lg(pD); comp.draft={p:pD,conf:d.confidence};
  }
  xSide = (side||'blue')==='blue' ? 1 : -1; comp.side={p:null};

  // blend em logit-space com os pesos validados (componentes ausentes = neutro 0)
  const z = w[0] + w[1]*xElo + w[2]*xForm + w[3]*xDraft + w[4]*xSide;
  let prob = sigmoid(z);
  if (CALIB.keptOOS && Array.isArray(CALIB.blocks) && CALIB.blocks.length) prob = _applyIsotonicBlocks(CALIB.blocks, prob);

  // confiança + label honestos
  const hasTeams = !!(team1 && team2 && comp.elo);
  const label = !hasTeams ? 'lean fraco' : (comp.elo && comp.elo.conf>0.6 ? 'forte' : 'lean');
  const confidence = hasTeams ? Math.min(1, (comp.elo?.conf||0)) : 0.2;
  return { prob:+prob.toFixed(4), components: comp, confidence:+confidence.toFixed(2), label };
}
module.exports = { predictMatch };
```

- [ ] **Step 4: Rodar — passa**

Run: `node tests/test-lol-match-predict.js`
Expected: `OK test-lol-match-predict`.

- [ ] **Step 5: Rodar a suíte completa + syntax**

Run: `node -c lib/lol-match-predict.js && node tests/run-all.js 2>&1 | tail -3`
Expected: tudo verde (≥898 passed).

- [ ] **Step 6: Commit**

```bash
git add lib/lol-match-predict.js tests/test-lol-match-predict.js
git commit -m "feat(lol-match): predictMatch() display blend consuming validated weights + calibration"
```

---

## Definition of Done (Plano 1)

- [ ] OE 2024-2025 sincronizado; cobertura confirmada.
- [ ] `_formSubModel` parametrizado por `asOfDate` + sub-modelos exportados; **suíte existente verde** (regressão).
- [ ] Harness `scripts/backtest-lol-match.js` roda point-in-time sem leakage; cobertura de draft logada.
- [ ] Pesos fitados (draft capado) + isotonic; artefatos `lib/lol-match-{meta,calib}.json` commitados.
- [ ] **Ship-gate avaliado e registrado no spec (§13).** Veredito explícito: PASS (blend completo) ou FALLBACK (Elo+form calibrado).
- [ ] `predictMatch()` implementado e testado, consumindo os artefatos validados.
- [ ] Nenhuma mudança de comportamento em `getLolProbability`/betting.

**Gate para o Plano 2 (UI):** só iniciar se a Task 7 deu PASS ou FALLBACK utilizável (i.e., existe um número calibrado que bate o baseline). Se nem Elo+form bater o baseline OOS, **parar e reavaliar** — não construir UI.

---

## Self-review (writing-plans)

- **Cobertura do spec:** §3 arquitetura → Tasks 2,8; §4 harness/ship-gate → Tasks 4-7; §5 blend+calib → Tasks 6; §6 gaps (side/unify-draft/player-champ) → Tasks 5-7 (validados por ablation); §7 dados → Task 1. **§8 UI e endpoints → Plano 2 (gated), intencionalmente fora.** §10 riscos endereçados (leakage: Task 4 point-in-time; overfit: l2 forte + cap + ship-gate; money-path: Task 2 aditiva + regressão).
- **Placeholders:** valores empíricos (pesos finais, quais gaps sobrevivem, blocks isotonic) são **outputs do harness**, não placeholders — registrados na execução (§13 do spec). `matchOeDraft`/`team1IsBlue`/`matchOeDraft` são helpers a implementar dentro do script (Task 5) — escopo explícito.
- **Consistência de tipos:** `samples`=`{p,y}`; `feats`=`{x:number[],y,date}`; `predictMatch` retorna `{prob,components,confidence,label}` — usado igual no teste (Task 8) e no Plano 2.
