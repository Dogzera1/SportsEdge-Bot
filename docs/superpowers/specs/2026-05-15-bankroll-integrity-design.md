# Bankroll Integrity — Design Spec

**Data:** 2026-05-15
**Origem:** Architecture audit P0 2026-05-15 (data flow + state agents)
**Status:** Approved approach, pronto pra writing-plans
**Estratégia:** Defense-in-depth (prevenção + detecção)

---

## Contexto

3 findings P0 architectural relacionados a bankroll/profit accounting integrity, detectados em audit paralelo 2026-05-15:

1. **Double-credit risk em shadow re-settle** (lib/mt-result-propagator.js:266-273)
   - `settleShadowTips` chama propagator em loop; propagator tx faz `if (changes > 0) bumpBankroll.run(profitR, sport)`.
   - Guard depende de `tips.result IS NULL` filter no UPDATE.
   - Cenário: `/admin/restore-voided-market-tips` re-abre shadow row (clears result) → propagator re-invocado → tip pode ter sido settled antes mas `tips.result IS NULL` foi limpado → `bumpBankroll` re-credita SEM reverter delta anterior.
   - Não existe `tip_settlement_audit` row gravada pelo propagator (só `/settle` registra).

2. **Shadow + propagator NÃO-transacional** (lib/market-tips-shadow.js:1409-1438)
   - Comentário 2026-05-03 explica: better-sqlite3 dispara "cannot start a transaction within a transaction" se envelopar shadow UPDATE + propagator em tx única.
   - Voltaram ao padrão "shadow commit + propagator separado".
   - Crash mid-flow (SIGKILL OOM, deploy) entre `UPDATE market_tips_shadow SET result=win` (commit) e `propagateMtResultToTips(...)` deixa `market_tips_shadow.result='win'` mas `tips.result IS NULL` pra MT-promoted tip → tip stuck pending forever → cleanup #3 voida em 14d sem restaurar bankroll.

3. **Force-sync-bankroll skip ambiguous esports** (server.js:14127-14145)
   - `/admin/force-sync-bankroll?apply=1` infere bucket (lol/dota2/cs/val) via prefix de `match_id` quando `tip.sport='esports'` (legado pre-Abr/2026).
   - Tudo fora dos prefixos conhecidos → `ambiguousEsportsTips++` → SKIPPED do recompute.
   - Resultado: REGRAVA `current_banca` SEM contar profit das ambíguas → drift permanente entre stored banca e profit real, sem warning visible além de JSON response.

**User decisão (2026-05-15):** Defense-in-depth — prevention + detection.

**Threshold reconciliation drift:** R$0.10 ABS (conservative — captura cents-level, suficiente sensitivity pra detectar bug 2026-05-12 R$6.58 em <30min).

---

## Architecture

5 components: 4 prevention + 1 detection.

```
┌────────────────────────────────────────────────────────────────┐
│ EXISTING:                                                       │
│ shadow tip → settleShadowTips → propagator → bumpBankroll       │
│              (commit)            (tx separate)                  │
│                                                                 │
│ BUG WINDOWS:                                                    │
│   - crash entre shadow commit + propagator (item #2)            │
│   - restore-voided → re-settle (item #1)                        │
│   - force-sync com ambiguous esports (item #3)                  │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│ NEW PREVENTION (root cause fixes):                              │
│                                                                 │
│ A) Propagator audit trail                                       │
│    propagator.js → grava tip_settlement_audit (source=propagator)│
│    Provides traceability + double-credit detection input        │
│                                                                 │
│ B) Propagator idempotency guard                                 │
│    Pre-check: tip já tem audit row source=propagator com same   │
│    prev→new transition? Skip bumpBankroll se sim.               │
│                                                                 │
│ C) Settle gap detector cron (daily 5h UTC)                      │
│    Find: market_tips_shadow.result NOT NULL + tips.result NULL  │
│    Match via norm(p1)+norm(p2)+sport+market_type+window 14d.    │
│    Action: re-fire propagator (idempotent via #B).              │
│                                                                 │
│ D) Force-sync ambiguous block                                   │
│    server.js /admin/force-sync-bankroll: se ambiguous_count>0   │
│    AND apply=1, retornar 409 com detail + tips_list.            │
│    Workflow: clean ambiguous primeiro, então apply.             │
│                                                                 │
│ NEW DETECTION (operational invariant):                          │
│                                                                 │
│ E) Bankroll reconciliation cron daily (4h UTC)                  │
│    For each sport: expected = sum(profit_reais WHERE            │
│      is_shadow=0 AND archived=0 AND result IN ('win','loss')    │
│      AND profit_reais IS NOT NULL).                             │
│    Compare to bankroll.current_banca - bankroll.initial_banca.  │
│    If ABS(drift) > R$0.10, DM admin + log to                    │
│    bankroll_drift_log table (new, via migration 110).           │
└────────────────────────────────────────────────────────────────┘
```

---

## Components Detail

### A) Propagator audit trail

**File:** `lib/mt-result-propagator.js`

**Change:** wrap bumpBankroll in tx que ALSO inserts `tip_settlement_audit` row.

```javascript
// PSEUDOCODE — actual writing-plans skill produces concrete code
db.transaction(() => {
  const r = updateTipResult.run(tipId, result, profitR);  // existing
  if (r.changes > 0) {
    insertSettlementAudit.run({
      tip_id: tipId,
      sport,
      prev_result: null,
      new_result: result,
      prev_profit_reais: null,
      new_profit_reais: profitR,
      actor: 'system',
      reason: 'mt-result-propagator',
      source: 'lib/mt-result-propagator.js',
    });
    if (profitR !== 0) bumpBankroll.run(profitR, sport);  // existing
  }
})();
```

**Schema:** `tip_settlement_audit` already exists (server.js:17767 uses it). No new column needed.

### B) Propagator idempotency guard

**File:** `lib/mt-result-propagator.js`

**Change:** before tx, check if audit already records `tip_id + source='mt-result-propagator'`. If yes AND new_result matches current `result`, skip entire tx (idempotent re-fire of settle gap detector).

```javascript
const existing = db.prepare(`
  SELECT 1 FROM tip_settlement_audit
  WHERE tip_id = ? AND source = 'lib/mt-result-propagator.js' AND new_result = ?
  LIMIT 1
`).get(tipId, result);
if (existing) {
  log('DEBUG', 'PROPAGATOR-IDEMPOTENT', `tip#${tipId} já creditado via propagator; skip`);
  return { skipped: true };
}
```

### C) Settle gap detector cron

**File:** `bot.js` (new cron) + helper em `lib/settle-gap-detector.js` (extract pra testability)

**Schedule:** daily 5h UTC (após reconciliation às 4h).

**Logic:**
```sql
-- Encontra shadow settled SEM propagation correspondente
SELECT mts.id AS shadow_id, mts.sport, mts.market, mts.team1, mts.team2,
       mts.result, mts.profit_pct, mts.line, mts.created_at
FROM market_tips_shadow mts
WHERE mts.result IS NOT NULL
  AND mts.created_at >= datetime('now', '-30 days')
  AND NOT EXISTS (
    SELECT 1 FROM tips t
    WHERE t.sport = mts.sport
      AND UPPER(t.market_type) = UPPER(mts.market)
      AND COALESCE(t.is_shadow, 0) = 0
      AND ABS(julianday(t.sent_at) - julianday(mts.created_at)) < 14
      AND t.result IS NOT NULL
      AND <norm(p1,p2) match>
  )
LIMIT 50;
```

For each gap, re-fire `propagateMtResultToTips(...)` — idempotency guard B ensures no double-credit.

DM admin if N gaps > 5 (signal de crash-mid-flow recorrente, não normal "no match yet").

### D) Force-sync ambiguous block

**File:** `server.js` `/admin/force-sync-bankroll`

**Change:** após computar `ambiguousEsportsTips`, se `apply=1 AND ambiguousEsportsTips.length > 0`, retornar 409 com error + sample tips_list.

```javascript
if (apply && ambiguousEsportsTips.length > 0) {
  sendJson(res, {
    ok: false,
    error: 'ambiguous_esports_tips_blocked',
    ambiguous_count: ambiguousEsportsTips.length,
    sample_tips: ambiguousEsportsTips.slice(0, 10),
    detail: 'Resolve sport label nessas tips antes de force-sync. Use /admin/tip-resport-sport ou UPDATE manual.',
  }, 409);
  return;
}
```

Workflow operacional: admin resolve `tip.sport='esports' → 'lol'/'cs'/'dota2'/'val'` baseado em `match_id` ambíguo (precisa /admin/tip-resport-sport endpoint OR direct SQL). Re-run force-sync.

### E) Bankroll reconciliation cron daily

**File:** `bot.js` (new cron) + helper em `lib/bankroll-reconciliation.js`

**Schedule:** daily 4h UTC.

**Logic:**
```sql
-- Por cada sport, expected banca delta = sum profit_reais real
SELECT sport,
       SUM(COALESCE(profit_reais, 0)) AS expected_delta
FROM tips
WHERE is_shadow = 0
  AND (archived IS NULL OR archived = 0)
  AND result IN ('win', 'loss')
  AND profit_reais IS NOT NULL
GROUP BY sport;
```

Compare ao stored `current_banca - initial_banca`:
- Se `ABS(expected_delta - stored_delta) > 0.10`: drift detected.
- Log to new table `bankroll_drift_log`:
  - `sport, expected_delta, stored_delta, drift_amount, detected_at`
- DM admin com top drifts.

**New migration:** `110_bankroll_drift_log`
```sql
CREATE TABLE IF NOT EXISTS bankroll_drift_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sport TEXT NOT NULL,
  expected_delta REAL NOT NULL,
  stored_delta REAL NOT NULL,
  drift_amount REAL NOT NULL,
  threshold REAL NOT NULL DEFAULT 0.10,
  detected_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bankroll_drift_log_sport_ts
  ON bankroll_drift_log(sport, detected_at DESC);
```

---

## Data Flow

```
┌───────────────────────────────────────────────────────────────┐
│ DAILY 4h UTC — Reconciliation cron (E):                        │
│  → Compare expected_delta vs stored                            │
│  → If drift > R$0.10: log + DM admin                           │
│  → Outputs: bankroll_drift_log row                             │
└───────────────────────────────────────────────────────────────┘
                              ↓
┌───────────────────────────────────────────────────────────────┐
│ DAILY 5h UTC — Settle gap detector (C):                        │
│  → SELECT shadow_settled + tips_pending                        │
│  → Re-fire propagator (idempotent via B)                       │
│  → If gaps > 5: DM admin                                       │
└───────────────────────────────────────────────────────────────┘

PER tip settle (mt-result-propagator):
┌───────────────────────────────────────────────────────────────┐
│ propagator entry:                                              │
│  → check idempotency (B): audit row exists? skip               │
│  → tx { update tips + insert audit + bump bankroll (A) }       │
│  → return { settled: 1 } OR { skipped: 1, reason }             │
└───────────────────────────────────────────────────────────────┘

PER /admin/force-sync-bankroll?apply=1:
┌───────────────────────────────────────────────────────────────┐
│ pre-apply check:                                               │
│  → if ambiguous_count > 0: 409 (D)                             │
│  → else: proceed existing logic                                │
└───────────────────────────────────────────────────────────────┘
```

---

## Edge Cases

| Cenário | Behavior |
|---|---|
| Propagator re-fired após restore-voided + audit já existe | Idempotency guard B: skip (no double-credit) |
| Crash mid-flow shadow→propagator | Settle gap detector C pega no próximo 5h UTC + re-fire (idempotent) |
| Reconciliation drift exatamente R$0.10 | `> 0.10` check: NÃO trigga (threshold é strict) |
| Reconciliation drift R$0.11 | Trigga DM + log |
| Force-sync com ambiguous=0 | Funciona normalmente (block aplica só se > 0) |
| Force-sync apply=0 (dry-run) | Sem block, retorna preview incluindo ambiguous_count |
| Propagator audit insert fails (FK violation) | tx rollback (existing behavior — tip update + bankroll bump undone) |
| Multiple drifts mesmo dia | Cada drift row separado (timestamp distingue) |

---

## Migrations

**Migration 110_bankroll_drift_log** (new):
- Table: `bankroll_drift_log` (id, sport, expected_delta, stored_delta, drift_amount, threshold, detected_at)
- Index: `idx_bankroll_drift_log_sport_ts ON (sport, detected_at DESC)`

**Schema_migrations declaration:** add as 110 (verificar gap — audit detectou 031, 083 vagos; safer add 110 sequential).

**No new column em existing tables** — `tip_settlement_audit` já cobre A+B; force-sync usa existing JSON response shape (just adds 409 path).

---

## Testing Strategy (TDD)

**Test file 1:** `tests/test-bankroll-reconciliation.js` (~120 LoC)
- Property: drift abs > threshold → return drift detected
- Anchor: tips win R$10 + loss R$8 → expected delta R$2; stored banca matches → no drift
- Anchor: tips win R$10 + loss R$8 → expected delta R$2; stored banca off by R$0.15 → drift detected
- Anchor: tips win R$10 + loss R$8; stored banca off by R$0.05 (below threshold) → no drift

**Test file 2:** `tests/test-propagator-idempotency.js` (~80 LoC)
- Anchor: first call → bumps bankroll + writes audit
- Anchor: second call same tip+result → skipped (returns skipped:1, no audit row added)
- Anchor: second call same tip DIFFERENT result → proceeds (audit row mismatch)

**Test file 3:** `tests/test-settle-gap-detector.js` (~80 LoC)
- Seed: shadow settled (result=win) + tips pending matching pair
- Anchor: detector finds gap, re-fires propagator → tips settled, audit row added
- Anchor: second invocation finds 0 gaps (idempotent)

**Integration:** existing `tests/test-record-tip-integration.js` should continue passing (no regression).

---

## Rollout Plan

**Sprint:** 4-5h total

1. **Migration 110** — bankroll_drift_log table (15min)
2. **Test E** + helper lib/bankroll-reconciliation.js (45min, TDD)
3. **Cron E wiring** em bot.js (15min)
4. **Test A+B** — propagator audit + idempotency (60min, TDD)
5. **Impl A+B** em lib/mt-result-propagator.js (30min)
6. **Test C** + helper lib/settle-gap-detector.js (45min, TDD)
7. **Cron C wiring** em bot.js (15min)
8. **Test D** — manual via curl (10min)
9. **Impl D** em server.js force-sync (10min)
10. **Final integration test** + manual smoke (30min)
11. **Commit + push + memory** (15min)

---

## Validation Criteria

- ✅ tests/test-bankroll-reconciliation.js: GREEN
- ✅ tests/test-propagator-idempotency.js: GREEN
- ✅ tests/test-settle-gap-detector.js: GREEN
- ✅ npm test cumulative: 573 + ~12 novos = ~585 GREEN
- ✅ node -c × 4 files OK
- ✅ Migration 110 applied successfully
- ✅ Manual smoke: `/admin/force-sync-bankroll?apply=1` com tips ambíguas → 409
- ✅ Manual smoke: trigger reconciliation cron → no drift inicial (clean state)

---

## Devils Advocate

3 razões pra estar errado:

1. **Cron E daily 4h UTC pode ser tarde demais** — se bot.js restart em horário ruim, cron N+1h gap = potencial 28h sem reconciliation. Counter: drift R$0.10 não é catastrófico em 28h window. Se preocupação, dropar pra cron 6h (4×/day). Decisão atual: 24h é suficiente pra capturar drift trends.

2. **Idempotency guard B pode false-positive em legit re-settle (settle dispatched then reverted via /admin/tip-resettle)**: se admin re-settle muda result, audit B precisa detectar (new_result diff = proceed). Counter: B explicitly checks `new_result = ?` matching. Se admin troca result, B proceeds.

3. **Settle gap detector C pode dispatch propagator em tip já cleanup #3 voidada** — shadow settled, tip cleanup voidou em 14d, gap detector vê shadow_settled + tips.result NULL → tenta propagator → mas matching SQL inclui `t.result IS NOT NULL`. Cleanup voida `result='void'` → NOT NULL → gap detector NÃO acha gap. Correct behavior. Counter: revisar JOIN condition pra confirmar.

---

## Memory References

- `project_bankroll_avg_bug_2026_05_12` — R$6.58 mirror drift unresolved root cause
- `project_mt_settle_mismatch_2026_05_09` — cleanup #3 strict-eq context
- `project_record_tip_catch_scope_p0_2026_05_15` — settle dispatch patterns

## Audit Origin

- Architecture audit 2026-05-15 (data flow agent): items #1+#2+#3
- Architecture audit 2026-05-15 (state agent): _marketTipsDisabledRuntime drift (related class)
