# Kelly Product Cap — Design Spec

**Data:** 2026-05-15
**Origem:** Audit P0 adversarial 2026-05-15 (commit `be65abe` batches 1-7)
**Status:** Approved, pronto pra implementação via writing-plans

---

## Contexto

Auditoria adversarial 2026-05-15 detectou que o cálculo de Kelly fraction no
SportsEdge-Bot compõe múltiplos multiplicadores (CLV × trust × autotune ×
tier × steam-boost × stage) sem cap final no produto. Cada multiplicador é
individualmente bound, mas o produto pode exceder `MAX_KELLY_FRAC=0.10`
(limite SAGRADO em CLAUDE.md, declarado em `lib/market-tip-processor.js:27`).

**Cenário de risco:** Base=0.25 (ALTA) × autotune=1.5 × tier=1.3 = **0.4875**
= 4.9× o limite SAGRADO. Sob casa hostil com line move artificial → CLV mult
inflado → produto ainda maior. Tip stake explode 2-4× em janela 24-72h.

**Interpretação SAGRADO confirmada (user 2026-05-15):** SOFT CAP em 0.15
(= 1.5× base). Permite boost intencional de CLV+tier pra capturar edge
superior, mas tampa downside catastrophic. Equilibra intent original
("4 multipliers ... mantidos pq usam proxy diferente, overlap monitored")
+ audit P0 concern (cap matemático ausente).

---

## Architecture

Cap centralizado em `lib/utils.js:_applyKelly(p, odds, frac, opts)`.

**Justificativa centralização:**
- `_applyKelly` é a ÚNICA função onde todos paths convergem antes da fórmula Kelly final
- Tanto `calcKellyFraction` quanto `calcKellyWithP` (callers per-sport) invocam `_applyKelly`
- DRY: 1 mudança cobre 11 sports cross-sport por construção (P5)
- Reverte via env: `KELLY_PRODUCT_CAP_FRAC=99` desativa cap se ajuste necessário

**Fluxo atual (sem cap):**
```
bot.js per-sport (cs/lol/dota/tennis/football/...):
  let kellyFrac = baseFraction(sport, conf, market)  // 0.25 ALTA típico
  kellyFrac = kellyFrac * tierMult           // [0.30, 1.30]
  kellyFrac = kellyFrac * autoTuneMult       // [0.20, 1.50]
  kellyFrac = kellyFrac * clvMult            // [proxy CLV history]
  kellyFrac = kellyFrac * steamBoostMult     // [1.0, 1.5]
  // → product up to 0.4875 (cs) OR more under hostile odds warp
  → calcKellyWithP(modelP, oddStr, kellyFrac, opts)
    → _applyKelly(p, odds, frac=kellyFrac, opts)
      → kellyFull * frac * _kellyCal × evMult usado em stake calc
```

**Fluxo pós-fix:**
```
_applyKelly(p, odds, frac, opts):
  const KELLY_PRODUCT_CAP = parseFloat(process.env.KELLY_PRODUCT_CAP_FRAC || '0.15');
  let effFrac = frac;
  if (frac > KELLY_PRODUCT_CAP) {
    effFrac = KELLY_PRODUCT_CAP;
    log('INFO', 'KELLY-CAP', `${opts?.sport || '?'} ${opts?.confKey || '?'}: kellyFrac=${frac.toFixed(3)} > cap=${KELLY_PRODUCT_CAP} → capped`);
    try { require('./metrics').incr('kelly_product_capped', { sport: opts?.sport || 'unknown' }); } catch (_) {}
  }
  // ... resto do _applyKelly usa effFrac em vez de frac
```

---

## Components

**Modified file:** `lib/utils.js`
- Function `_applyKelly` — adicionar cap check no topo (antes de kellyFull calc)
- Variável local `effFrac` substitui `frac` em todas referências internas
- Log + metric counter quando cap dispara

**Modified file:** `.env.example`
- Adicionar entry `KELLY_PRODUCT_CAP_FRAC=0.15` com comentário

**New tests:** `tests/test-kelly-product-cap.js` (~80 LoC)
- Property test: monotonic — `frac > cap` produces stake ≤ stake at cap
- Anchor tests:
  - `_applyKelly(0.55, 2.0, 0.4875)` (repro 0.25 × 1.5 × 1.3) → stake = stake at frac=0.15
  - `_applyKelly(0.55, 2.0, 0.10)` (base SAGRADO) → no cap, normal output
  - `_applyKelly(0.55, 2.0, 0)` (Kelly negative) → '0u' bypass preservado
  - `_applyKelly(0.55, 2.0, 0.15)` (cap exact boundary) → unchanged
  - `_applyKelly(0.55, 1.5, 0.20)` (cap fires, low odds) → capped stake correct

---

## Data Flow

```
[caller per-sport]
  kellyFrac (raw product) ──> calcKellyWithP / calcKellyFraction
                                        │
                                        ▼
                                  _applyKelly(p, odds, frac=kellyFrac, opts)
                                        │
                              ┌─────────┴─────────┐
                              ▼                   ▼
                       cap check + log     [if frac > 0.15]
                              │                   │
                              ▼                   ▼
                       effFrac = frac       effFrac = 0.15
                              │                   │
                              └─────────┬─────────┘
                                        ▼
                              Kelly formula (kellyFull × effFrac × _kellyCal × evMult)
                                        ▼
                              stake snapped + capped → returned
```

---

## Edge Cases

| Input | Behavior | Justificativa |
|---|---|---|
| `frac > 0.15` | Cap to 0.15, log INFO, metric incr | Cap principal |
| `frac == 0.15` exact | Pass through (no cap log) | Boundary clean |
| `frac < 0.15` | Pass through unchanged | Sem amplificação preocupante |
| `frac == 0` | Pass through; Kelly returns '0u' | Negative-Kelly bypass preservado |
| `frac == null/undefined` | Default `0.25` (existing behavior) | Sem regressão |
| `frac == NaN` | Defer pra existing handling (NaN propaga) | Não introduzir nova path |
| `KELLY_PRODUCT_CAP_FRAC=99` | Cap efetivo desativado | Escape hatch |
| `KELLY_PRODUCT_CAP_FRAC=0.10` | Strict mode (cap em SAGRADO base) | Future tighten option |

---

## Error Handling

- Cap check é puro (sem I/O, sem throw) — não pode falhar
- Metric increment dentro de try/catch (lib metrics opcional)
- Log via helper existente (não introduz dep nova)

---

## Testing Strategy (TDD)

**Test file:** `tests/test-kelly-product-cap.js`

```js
const fc = require('fast-check');
const { calcKellyWithP } = require('../lib/utils');

module.exports = function(t) {
  t.test('cap fires quando frac > 0.15 (anchor repro audit)', () => {
    // Pre-cap: 0.25 × 1.5 × 1.3 = 0.4875
    const capped = calcKellyWithP(0.55, '2.00', 0.4875, { sport: 'cs', confKey: 'ALTA' });
    const reference = calcKellyWithP(0.55, '2.00', 0.15, { sport: 'cs', confKey: 'ALTA' });
    t.assert(capped === reference, `expected cap, got capped=${capped} ref=${reference}`);
  });

  t.test('frac=0.10 (SAGRADO base) passa sem cap', () => {
    const r = calcKellyWithP(0.55, '2.00', 0.10, { sport: 'lol' });
    const rPlus = calcKellyWithP(0.55, '2.00', 0.10001, { sport: 'lol' });
    // 0.10 < 0.15 = cap não dispara; 0.10001 também não → mesma stake
    t.assert(r === rPlus, `expected no cap effect on values < 0.15`);
  });

  t.test('Kelly negative (frac não importa) retorna 0u', () => {
    const r = calcKellyWithP(0.40, '1.50', 0.50, { sport: 'cs' });
    // p=0.40, odds=1.50, Kelly negativo → 0u (cap irrelevante)
    t.assert(/0(\.0+)?u/.test(r), `expected 0u, got ${r}`);
  });

  t.test('property: cap monotonic — frac > 0.15 sempre ≤ stake at 0.15', () => {
    fc.assert(fc.property(
      fc.float({ min: 0.15, max: 1.0, noNaN: true }),
      fc.float({ min: 0.51, max: 0.85, noNaN: true }),
      fc.float({ min: 1.50, max: 4.00, noNaN: true }),
      (frac, p, odds) => {
        const capped = calcKellyWithP(p, String(odds.toFixed(2)), frac, { sport: 'test' });
        const cap15 = calcKellyWithP(p, String(odds.toFixed(2)), 0.15, { sport: 'test' });
        // capped stake ≤ cap15 stake (monotonic property)
        const capN = parseFloat(String(capped).replace('u', ''));
        const ref = parseFloat(String(cap15).replace('u', ''));
        if (!Number.isFinite(capN) || !Number.isFinite(ref)) return;
        // Stakes em 0.5u grid — equal OR within rounding
        if (Math.abs(capN - ref) > 0.51) {
          throw new Error(`monotonic violation: frac=${frac.toFixed(3)} capped=${capped} (${capN}) vs cap15=${cap15} (${ref})`);
        }
      }
    ), { numRuns: 100 });
  });

  t.test('env override KELLY_PRODUCT_CAP_FRAC=99 desativa cap', () => {
    const orig = process.env.KELLY_PRODUCT_CAP_FRAC;
    process.env.KELLY_PRODUCT_CAP_FRAC = '99';
    try {
      // Reset internal cap se cached (lib pode ter parsed env once)
      const r1 = calcKellyWithP(0.55, '2.00', 0.50, { sport: 'test' });
      const r2 = calcKellyWithP(0.55, '2.00', 0.15, { sport: 'test' });
      // Sem cap: stake @ frac=0.50 deve ser MAIOR que @ frac=0.15
      const n1 = parseFloat(String(r1).replace('u', '')) || 0;
      const n2 = parseFloat(String(r2).replace('u', '')) || 0;
      t.assert(n1 >= n2, `env override deveria permitir stake maior: r1=${r1} (${n1}) r2=${r2} (${n2})`);
    } finally {
      if (orig !== undefined) process.env.KELLY_PRODUCT_CAP_FRAC = orig;
      else delete process.env.KELLY_PRODUCT_CAP_FRAC;
    }
  });
};
```

**Caveat:** o ENV override test depende de lib NÃO cachear o env value (parse on each call OR module-load only). Verificar implementação real — se cache module-load, o teste precisa adjust (use child_process com env diferente OR skip).

---

## Rollout Plan

1. **TDD step:** Adicionar tests/test-kelly-product-cap.js com 5 tests (4 anchor + 1 property)
2. **Verify RED:** Rodar tests sem implementação — devem FALHAR (cap não existe ainda)
3. **GREEN:** Aplicar cap em lib/utils.js:_applyKelly
4. **Verify:** npm test 568 + 5 = 573 passed; integration tests passam
5. **Doc env:** .env.example +KELLY_PRODUCT_CAP_FRAC
6. **Commit:** fix(audit): Kelly product cap + tests + env doc
7. **Push pra main**
8. **Monitor 7d:** /admin/metrics expose `kelly_product_capped` — calibrate threshold se cap fires > N/dia

---

## Cross-sport (P5)

Fix é cross-sport por construção: `_applyKelly` é chamado por todos os sports
via `calcKellyFraction` / `calcKellyWithP`. 11 callsites cobertos sem editar
cada um. P5 audit dispensado (single point of change).

---

## Validation Criteria

- ✅ tests/test-kelly-product-cap.js: 5/5 passed
- ✅ npm test cumulativo: 573/0
- ✅ node -c lib/utils.js OK
- ✅ Pre-commit hook passa (4 hard gates)
- ✅ Repro original (frac=0.4875) caps to 0.15 effective

---

## Devils Advocate

3 razões pra estar errado:

1. **Cap 0.15 pode ser apertado demais** — quando CLV sinaliza edge muito forte (e.g., line move 30%+ favorável), 0.15 limita captura legítima. Counter: env override + metric expose permite calibrar empiricamente em 7-14d. Se data mostra cap firing >50% das tips ALTA, soltar pra 0.18-0.20.

2. **Cap fora de _applyKelly poderia ser mais explícito** — caller per-sport não vê o cap (transparent). Pode confundir debug em 6 meses. Counter: log INFO + metric expone visibility. Trade-off DRY vs explicit; DRY win em 11 sports.

3. **Env override KELLY_PRODUCT_CAP_FRAC=99 cria escape hatch perigoso** — sysadmin pode desativar accidentalmente. Counter: log INFO `KELLY-CAP` para de aparecer = signal observable. Plus, CLAUDE.md SAGRADO list não inclui esse env (não tem mesmo peso).

---

## Memory References

- `feedback_devils_advocate_manual_2026_05_14` — devils advocate manual antes claim P0 done
- `project_full_audit_2026_05_14` — audit dinheiro/financeiro patterns
- CLAUDE.md "Limites SAGRADOS" — MAX_KELLY_FRAC=0.10 declarado

## Related Audit Findings (2026-05-15)

- Dinheiro agent: bot.js:21253 + 11 cross-sport call sites (lol 3185, dota2 16269, mma 17199, tennis 18809, football 20027, cs 21265, val 21901, darts 22270, snk 22525, basket 22882, tt 20432)
- Adversarial agent: Atk #1 "Casa hostil drena banca via Kelly composto sem cap"
