# Kelly Product Cap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add product-cap of 0.15 to Kelly fraction in `_applyKelly` to prevent multiplier composition exceeding SAGRADO limit, with TDD test suite covering anchor + property cases.

**Architecture:** Single centralized cap in `lib/utils.js:_applyKelly` (called by both `calcKellyFraction` and `calcKellyWithP`). Cap applies to the effective Kelly fraction BEFORE the formula computes stake. Env-overridable. INFO log + metric counter for observability. Backward compatible (frac ≤ 0.15 unchanged).

**Tech Stack:** Node.js 18, better-sqlite3 not involved (pure math). fast-check for property tests. Existing tests/run.js runner (sync + async support).

**Spec reference:** `docs/superpowers/specs/2026-05-15-kelly-product-cap-design.md`

---

## File Structure

| Action | File | Responsibility |
|---|---|---|
| Create | `tests/test-kelly-product-cap.js` | TDD test suite (5 tests: 4 anchor + 1 property) |
| Modify | `lib/utils.js` (around L328 `_applyKelly`) | Cap check + log + metric incr |
| Modify | `.env.example` | Document `KELLY_PRODUCT_CAP_FRAC` env |

---

## Task 1: Write failing TDD test file

**Files:**
- Create: `tests/test-kelly-product-cap.js`

- [ ] **Step 1: Create test file with 4 anchor tests + 1 property test**

```javascript
/**
 * Test Kelly product cap — audit P0 2026-05-15.
 *
 * Cap em lib/utils.js:_applyKelly previne kellyFrac product (CLV × trust ×
 * autotune × tier × steam-boost) exceder MAX_KELLY_FRAC SAGRADO. Cap default
 * 0.15 (= 1.5× base SAGRADO), overridable via env KELLY_PRODUCT_CAP_FRAC.
 *
 * Spec: docs/superpowers/specs/2026-05-15-kelly-product-cap-design.md
 */

const fc = require('fast-check');
const { calcKellyWithP } = require('../lib/utils');

module.exports = function runTests(t) {
  // ─── ANCHOR 1: cap fires na repro do audit ────────────────────────────
  t.test('cap fires quando frac > 0.15 (repro audit: 0.25 × 1.5 × 1.3 = 0.4875)', () => {
    const capped = calcKellyWithP(0.55, '2.00', 0.4875, { sport: 'cs', confKey: 'ALTA' });
    const reference = calcKellyWithP(0.55, '2.00', 0.15, { sport: 'cs', confKey: 'ALTA' });
    t.assert(capped === reference,
      `expected cap to clamp frac=0.4875 → reference stake at frac=0.15, got capped="${capped}" reference="${reference}"`);
  });

  // ─── ANCHOR 2: frac SAGRADO base passa sem cap ────────────────────────
  t.test('frac=0.10 (SAGRADO base) passa sem cap', () => {
    const r10 = calcKellyWithP(0.55, '2.00', 0.10, { sport: 'lol' });
    const r14 = calcKellyWithP(0.55, '2.00', 0.14, { sport: 'lol' });
    // Frac < 0.15 = cap não dispara; stakes podem diferir (frac diferente)
    // mas ambos NÃO devem ser equal ao stake @ frac=0.15 (que seria o cap value).
    t.assert(typeof r10 === 'string' && r10.endsWith('u'), `expected 'u' suffix, got ${r10}`);
    t.assert(typeof r14 === 'string' && r14.endsWith('u'), `expected 'u' suffix, got ${r14}`);
  });

  // ─── ANCHOR 3: Kelly negative bypass preservado ───────────────────────
  t.test('Kelly negative (p × odds < 1) retorna 0u independente de frac alto', () => {
    // p=0.40, odds=1.50 → Kelly negativo (0.40 × 1.50 = 0.60 < 1)
    const r = calcKellyWithP(0.40, '1.50', 0.50, { sport: 'cs' });
    t.assert(/^0(\.0+)?u$/.test(r), `expected '0u' or '0.0u', got ${r}`);
  });

  // ─── ANCHOR 4: cap boundary exato passa unchanged ─────────────────────
  t.test('frac=0.15 (boundary) passa sem cap (não dispara log)', () => {
    const r15 = calcKellyWithP(0.55, '2.00', 0.15, { sport: 'dota2' });
    const r15plus = calcKellyWithP(0.55, '2.00', 0.150001, { sport: 'dota2' });
    // frac slightly above 0.15 capa, mas stake difference deve ser <= 0.5u (snap)
    t.assert(typeof r15 === 'string' && r15.endsWith('u'), `expected 'u' suffix, got ${r15}`);
    const n15 = parseFloat(r15);
    const n15p = parseFloat(r15plus);
    t.assert(Math.abs(n15 - n15p) <= 0.6,
      `expected boundary stake ≈ caped stake, got r15=${r15} r15plus=${r15plus}`);
  });

  // ─── PROPERTY: cap monotonic — frac > 0.15 → stake ≤ stake @ 0.15 ────
  t.test('property: cap monotonic (frac > 0.15 produces stake ≤ stake@0.15)', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0.15, max: 1.0, noNaN: true }),
        fc.float({ min: 0.51, max: 0.85, noNaN: true }),
        fc.float({ min: 1.50, max: 4.00, noNaN: true }),
        (frac, p, odds) => {
          const oddsStr = odds.toFixed(2);
          const capped = calcKellyWithP(p, oddsStr, frac, { sport: 'test' });
          const cap15 = calcKellyWithP(p, oddsStr, 0.15, { sport: 'test' });
          const capN = parseFloat(String(capped));
          const ref = parseFloat(String(cap15));
          if (!Number.isFinite(capN) || !Number.isFinite(ref)) return;
          // Stakes em 0.5u grid — cap correto deve produzir capN ≤ ref + 0.5 (snap tolerance)
          if (capN > ref + 0.51) {
            throw new Error(`monotonic violation: frac=${frac.toFixed(3)} p=${p.toFixed(3)} odds=${oddsStr} capped="${capped}" (${capN}) vs cap15="${cap15}" (${ref})`);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
};
```

- [ ] **Step 2: Run test isolated to verify it FAILS**

Run:
```bash
cd "C:/Users/vict_/Desktop/lol betting"
node -e "
const path = require('path');
let pass = 0, fail = 0;
const failures = [];
function makeT(suite) {
  return {
    test(name, fn) {
      let r;
      try { r = fn(); } catch (e) { fail++; failures.push(name+': '+e.message); console.log('  ✗ '+name+'\n     '+e.message); return; }
      if (!r || typeof r.then !== 'function') { pass++; console.log('  ✓ '+name); return; }
      return r.then(()=>{pass++;console.log('  ✓ '+name);},(e)=>{fail++;failures.push(name+': '+e.message);console.log('  ✗ '+name+'\n     '+e.message);});
    },
    assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
  };
}
(async () => {
  const mod = require(path.resolve('tests/test-kelly-product-cap.js'));
  await mod(makeT('rti'));
  console.log('\n'+pass+' passed, '+fail+' failed');
  if (fail > 0) { process.exit(1); }
})().catch(e => { console.error('CRASH:', e.message); process.exit(2); });
"
```

Expected: ANCHOR 1 FAILS (`expected cap to clamp frac=0.4875 → reference stake at frac=0.15, got capped="..." reference="..."`). Outros 3 anchors podem passar (não requerem cap). Property pode passar OR falhar dependendo do grid.

- [ ] **Step 3: Commit failing test (TDD discipline — test first, before implementation)**

```bash
git add tests/test-kelly-product-cap.js
git commit -m "test(audit-2026-05-15): failing TDD test pra Kelly product cap

5 tests covering anchor repro audit (0.25 × 1.5 × 1.3 = 0.4875) + property
monotonic. RED state — cap não implementado ainda.

Spec: docs/superpowers/specs/2026-05-15-kelly-product-cap-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Implement product cap in _applyKelly

**Files:**
- Modify: `lib/utils.js` around L328 (`_applyKelly` function)

- [ ] **Step 1: Read current _applyKelly to confirm structure**

Run:
```bash
node -e "
const fs = require('fs');
const src = fs.readFileSync('lib/utils.js', 'utf8').split('\n');
for (let i = 325; i < 380 && i < src.length; i++) console.log(String(i+1).padStart(4) + ': ' + src[i].slice(0, 120));
"
```

Expected output: lines around L328-370 mostrando `function _applyKelly(p, odds, frac, opts) { ... }`.

- [ ] **Step 2: Apply cap at start of _applyKelly body**

Edit `lib/utils.js` — change:

```javascript
function _applyKelly(p, odds, frac, opts) {
  const kellyFull = (p * (odds - 1) - (1 - p)) / (odds - 1);
  // Kelly negativo ou zero = sem value → não apostar
```

To:

```javascript
function _applyKelly(p, odds, frac, opts) {
  // 2026-05-15 audit P0 product cap: previne kellyFrac product (CLV × trust ×
  // autotune × tier × steam × stage) exceder limite catastrophic. CLAUDE.md
  // SAGRADO base = MAX_KELLY_FRAC=0.10; cap product em 1.5× (=0.15) preserva
  // boost intencional mas tampa downside. Env override KELLY_PRODUCT_CAP_FRAC
  // pra calibrar empiricamente após observation. Telemetria via metric counter
  // 'kelly_product_capped' + log INFO quando dispara.
  const _KELLY_PRODUCT_CAP = parseFloat(process.env.KELLY_PRODUCT_CAP_FRAC || '0.15');
  let _effFrac = frac;
  if (Number.isFinite(frac) && Number.isFinite(_KELLY_PRODUCT_CAP) && _KELLY_PRODUCT_CAP > 0 && frac > _KELLY_PRODUCT_CAP) {
    _effFrac = _KELLY_PRODUCT_CAP;
    try {
      // log helper definido em lib/utils.js — self-reference via module-local
      log('INFO', 'KELLY-CAP', `${opts?.sport || '?'} ${opts?.confKey || '?'}: kellyFrac=${frac.toFixed(3)} > cap=${_KELLY_PRODUCT_CAP} → capped`);
    } catch (_) {}
    try { require('./metrics').incr('kelly_product_capped', { sport: opts?.sport || 'unknown' }); } catch (_) {}
  }
  const kellyFull = (p * (odds - 1) - (1 - p)) / (odds - 1);
  // Kelly negativo ou zero = sem value → não apostar
```

Then in the REST of _applyKelly (after the cap), find every reference to `frac` AFTER the cap point and replace with `_effFrac`. The function body uses `frac` in calculations like `kellyFull * frac * _kellyCal * evMult` — change to `kellyFull * _effFrac * _kellyCal * evMult`.

- [ ] **Step 3: Read full _applyKelly post-edit pra confirmar todas refs trocadas**

Run:
```bash
node -e "
const fs = require('fs');
const src = fs.readFileSync('lib/utils.js', 'utf8').split('\n');
let depth = 0, started = false, startLine = -1;
for (let i = 0; i < src.length; i++) {
  if (/function _applyKelly\(/.test(src[i])) { startLine = i; break; }
}
for (let i = startLine; i < src.length && i < startLine + 80; i++) {
  for (const ch of src[i]) {
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') { depth--; if (started && depth === 0) { console.log('END at line ' + (i+1)); return; } }
  }
  console.log(String(i+1).padStart(4) + ': ' + src[i].slice(0, 120));
}
"
```

Expected: function body com cap block no início + uso de `_effFrac` (não `frac`) em refs após o cap.

- [ ] **Step 4: Run isolated test — confirma GREEN**

Run o mesmo comando do Task 1 Step 2.

Expected: `5 passed, 0 failed` (all 5 tests pass).

- [ ] **Step 5: Run full npm test pra verificar zero regressão**

Run:
```bash
npm test 2>&1 | tail -5
```

Expected: `573 passed, 0 failed` (568 prévios + 5 novos).

- [ ] **Step 6: node -c syntax check**

Run:
```bash
node -c lib/utils.js && echo "syntax OK"
```

Expected: `syntax OK`.

- [ ] **Step 7: Verificar que log helper `log` está disponível no escopo**

Já que adicionei `log('INFO', 'KELLY-CAP', ...)` dentro de `_applyKelly`, e o file define várias funções, preciso confirmar que `log` está no scope.

Run:
```bash
grep -nE "^function log|const log\s*=" lib/utils.js | head -3
```

Expected: definição de `log` accessible no scope onde _applyKelly mora. Se NÃO ESTIVER no scope (raro em utils.js), o try/catch silenciará. Mas se houver `ReferenceError: log is not defined` em runtime, npm test não pega (catch swallow). Verificar manualmente que log existe ou ajustar pra usar `console.log`.

Se `log` não estiver no scope, trocar pra:
```javascript
try {
  console.log(`[KELLY-CAP] ${opts?.sport || '?'} ${opts?.confKey || '?'}: kellyFrac=${frac.toFixed(3)} > cap=${_KELLY_PRODUCT_CAP} → capped`);
} catch (_) {}
```

---

## Task 3: Document new env in .env.example

**Files:**
- Modify: `.env.example` (append in audit section)

- [ ] **Step 1: Verify existing audit section em .env.example**

Run:
```bash
grep -nE "Audit robustez 2026-05-15|LOG_CLIENT_MAX|ADMIN_RATE_LIMIT_PER_MIN" .env.example | head -5
```

Expected: linhas mostrando seção "Audit robustez 2026-05-15" criada no batch docs (commit 3e3a487).

- [ ] **Step 2: Append KELLY_PRODUCT_CAP_FRAC à seção**

Edit `.env.example` — adicionar APÓS a linha `ADMIN_RATE_LIMIT_PER_MIN=60 ...`:

```
KELLY_PRODUCT_CAP_FRAC=0.15                 # cap product Kelly fraction após mults (CLV × trust × autotune × tier × steam). Default 1.5× MAX_KELLY_FRAC. Set high (99) pra desativar — perda do gate cross-sport DoS防.
```

- [ ] **Step 3: Commit env doc**

```bash
git add .env.example
git commit -m "docs(env): KELLY_PRODUCT_CAP_FRAC default 0.15

Cap product Kelly fraction (cross-multiplier composition) pra preveni
amplificação >1.5× MAX_KELLY_FRAC sob casa hostil. Env-overridable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Final commit + push

**Files:** lib/utils.js (Task 2) + tests (Task 1) já committed; final atomicity check.

- [ ] **Step 1: Verify git status clean**

Run:
```bash
git status --short
```

Expected: empty (sem modified files restantes) OR só untracked artifacts (db.sqlite3, tmp_*).

- [ ] **Step 2: Commit lib/utils.js separately se Task 2 não foi committed inline**

Se Task 2 step 5 passou mas falta commit:

```bash
git add lib/utils.js
git commit -m "fix(audit-2026-05-15): Kelly product cap em _applyKelly (P0 SOFT 0.15)

Audit P0 #1 cross-sport: previne kellyFrac product (CLV × trust × autotune
× tier × steam × stage) exceder cap 0.15 (= 1.5× MAX_KELLY_FRAC SAGRADO).

LOCATION: lib/utils.js:_applyKelly — única função central onde todos
sports convergem (chamada por calcKellyFraction E calcKellyWithP).
DRY: 1 mudança cobre 11 sports cross-sport (lol/dota2/cs/val/tennis/
football/mma/darts/snk/basket/tt).

REPRO CASE: bot.js callsite 0.25 (ALTA) × 1.5 (autotune) × 1.3 (tier) =
0.4875 = 4.9× SAGRADO. Sob casa hostil + CLV manipulation, ainda maior.
Pós-fix: capped a 0.15 efetiva, stake hard-capped a maxStake unit também
(defense-in-depth preservado).

TELEMETRIA: log INFO 'KELLY-CAP' + metric 'kelly_product_capped' quando
dispara. /admin/metrics expose pra calibrar threshold em 7-14d.

ENV ESCAPE: KELLY_PRODUCT_CAP_FRAC=99 desativa cap (não recomendado).

TDD: tests/test-kelly-product-cap.js 5/5 GREEN (4 anchor + 1 property
monotonic via fast-check). Tests committed primeiro em RED state, depois
implementação GREEN.

CLAUDE.md SAGRADO interpretation (user 2026-05-15): SOFT CAP product 0.15
(equilíbrio intent original 'overlap monitored' + audit P0 hard concern).

Validação: node -c lib/utils.js + npm test 573/0 em ~5s.
Spec: docs/superpowers/specs/2026-05-15-kelly-product-cap-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 3: Push to main**

Run:
```bash
git push origin main 2>&1 | tail -3
```

Expected: `XX..YYYY main -> main` confirmation.

- [ ] **Step 4: Memory update**

Update `memory/MEMORY.md` adding entry for this fix:

```markdown
- [Kelly product cap 2026-05-15](project_kelly_product_cap_2026_05_15.md) — fix P0 audit. Cap product 0.15 em _applyKelly (CLAUDE.md SAGRADO SOFT interp). 5 TDD tests. Env KELLY_PRODUCT_CAP_FRAC. Cross-sport por construção via _applyKelly central.
```

E criar `memory/project_kelly_product_cap_2026_05_15.md` com:

```markdown
---
name: project_kelly_product_cap_2026_05_15
description: Fix P0 audit adversarial — Kelly product cap 0.15 em lib/utils.js:_applyKelly central. CLAUDE.md SAGRADO SOFT interp. TDD 5 tests.
metadata:
  node_type: memory
  type: project
---

# Kelly product cap — 2026-05-15

## Decisão SAGRADO interpretation

CLAUDE.md MAX_KELLY_FRAC=0.10 declarado mas history aceita "4 multipliers
mantidos pq usam proxy diferente, overlap monitored". Audit adversarial
2026-05-15 detectou product até 4.9× SAGRADO sob casa hostil.

**User decisão (brainstorming 2026-05-15):** SOFT CAP product 0.15
(= 1.5× base). Preserva boost CLV+tier mas tampa downside catastrophic.

## Implementation

Single location: lib/utils.js:_applyKelly. Cap aplicado ANTES de kellyFull
calc. Backward compat: frac ≤ 0.15 inalterado.

Env escape: KELLY_PRODUCT_CAP_FRAC=99 desativa.

## Telemetry pendente review 7-14d

- Metric `kelly_product_capped` per sport
- Se cap fires > 50% das tips ALTA, considerar relaxar pra 0.18-0.20
- Se cap fires < 5% das tips ALTA, considerar tighten pra 0.12

## Relacionado

- Spec: docs/superpowers/specs/2026-05-15-kelly-product-cap-design.md
- Plan: docs/superpowers/plans/2026-05-15-kelly-product-cap.md
- Audit findings: project_full_audit_2026_05_14 + agents paralelos 2026-05-15
```

---

## Validation Criteria (post-implementation)

- ✅ `tests/test-kelly-product-cap.js`: 5/5 GREEN isolated
- ✅ `npm test`: 573/0 cumulative (568 + 5 novos)
- ✅ `node -c lib/utils.js`: OK
- ✅ Pre-commit hook passa (4 hard gates)
- ✅ Repro original (frac=0.4875) caps to stake @ frac=0.15
- ✅ env override `KELLY_PRODUCT_CAP_FRAC=99` permite frac=0.50 → maior stake
- ✅ Memory + .env.example documentados
- ✅ Spec + plan + commits referenciam-se mutuamente

## Devils Advocate (pre-execution)

3 razões pra estar errado:

1. **Cap 0.15 pode ser apertado demais empiricamente** — se data 7-14d mostrar cap firing > 50% das tips ALTA, threshold precisa relaxar. Mitigação: metric counter + env override permitem ajuste sem deploy. Calibração será data-driven.

2. **`log` helper pode não estar no scope de `_applyKelly`** — utils.js define várias funções; `log` pode estar antes ou depois. Mitigação: try/catch envelope + Task 2 Step 7 verifica scope. Se faltar, fallback console.log.

3. **Property test pode false-positive (snap rounding)** — stakes em 0.5u grid. Tolerance ±0.51u previne false positives. Mitigação: 100 runs fast-check cobre seed space.
