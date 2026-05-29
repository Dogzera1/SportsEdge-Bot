# Audit Banco de Dados — 2026-05-25

**Scope:** SQLite better-sqlite3 (sportsedge.db ~155MB) + WAL. 126 migrations aplicadas. 129 indexes criados em mig. lib/database.js cria schema v1 baseline (tips, match_results, tip_factor_log, etc.) — mig só evolui.

**Totais:** 1 P0, 9 P1, 7 P2.

---

## TOP 5 FINDINGS

1. **P0 — `/record-tip` faz 5-7 writes não-atômicos por tip** (INSERT tips + UPDATE updateTipOpenOdds + UPDATE learned_correction_id + UPDATE match_end_at + UPDATE line_shop + UPDATE pinnacle_odd + INCREMENT api_usage). Crash entre passos deixa tip parcialmente preenchida (open_odds/pinnacle_odd NULL → impacta CLV downstream).
2. **P1 — WAL sem checkpoint scheduled** (mig + bot.js + server.js sem `wal_checkpoint(PASSIVE)`). Apenas `journal_size_limit=100MB` configurado (lib/database.js:43). Auto-checkpoint default better-sqlite3 (1000 pages) pode acumular durante burst de cron writes.
3. **P1 — 7 libs de cron OLAP heavy SEM `isMemCritical()` guard** (ev-calibration, shadow-vs-real-drift, gate-attribution, league-trust, readiness-learner, mt-auto-promote, kelly-auto-tune). Railway 512MB cap + hourly heavy crons = OOM risk re-aparecendo.
4. **P1 — `mt-auto-promote` query agrega `market_tips_shadow` GROUP BY sport sem index ideal** (lib/mt-auto-promote.js:215+308+367). Cobre por `idx_mts_archived_settled` parcial mas `created_at >=` + GROUP BY com mais 6 colunas requer full scan dentro do partial.
5. **P2 — `cross_significance_snapshots` (mig 124) retention configurada por env mas não há cron dedicado** (apenas DELETE inline em bot.js:28899 no mesmo path do INSERT — pode falhar silenciosamente).

---

## P0 (1) — DB inconsistent OR query >10s em hot path

### P0-1 — /record-tip multi-write não-atômico
**Arquivo:** `server.js:29236-29400` (área `/record-tip` POST handler)
**Problema:** Após `stmts.insertTip.run(...)` (linha 29236), há 5-7 writes adicionais SEM `db.transaction()`:
- `stmts.updateTipOpenOdds.run(...)` (29259)
- `UPDATE tips SET learned_correction_id = ?` (29267-29275)
- `UPDATE tips SET match_end_at = ?` (29278-29286)
- `stmts.updateTipLineShop.run(...)` (29294-29302)
- `UPDATE tips SET pinnacle_odd = ?` (29329-29335)
- `stmts.incrementApiUsage.run(...)` (29337)

**Impacto:** Crash entre INSERT e UPDATE deixa tip emitida MAS sem open_odds/pinnacle_odd → CLV capture (lib/clv-capture.js depends de close_odd ∝ Pinnacle anchor) registra valor incompleto → métricas CLV/leak guards usam dados parciais.

**Fix sugerido:**
```sql
const tx = db.transaction(() => {
  const r = stmts.insertTip.run({...});
  if (oddsN != null) stmts.updateTipOpenOdds.run(...);
  if (r.lastInsertRowid && _appliedCorrections?.length) db.prepare(`UPDATE tips SET learned_correction_id = ? WHERE id = ?`).run(...);
  // ... etc
  stmts.incrementApiUsage.run(...);
  return r;
});
const result = tx();
```

**Verify query:**
```sql
SELECT COUNT(*) FROM tips
 WHERE COALESCE(is_shadow, 0) = 0
   AND archived = 0
   AND sent_at >= datetime('now', '-7 days')
   AND open_odds IS NULL;   -- esperado 0 ou bem baixo
```

---

## P1 (9) — Slow query OR missing idx

### P1-1 — WAL: sem `wal_checkpoint` scheduled
**Arquivo:** `lib/database.js:24-66` (pragmas init)
**Problema:** Apenas `journal_mode = WAL` + `journal_size_limit = 100MB`. Não há `PRAGMA wal_autocheckpoint = N` explícito (default 1000 pages = ~4MB) E NÃO há `setInterval` chamando `db.pragma('wal_checkpoint(PASSIVE)')`.

**Impacto:** Crons hourly heavy (mt_auto_promote, kelly_auto_tune, shadow_vs_real_drift, gate_attribution, mt_calib_refit, mr_reconcile, clv_capture) podem flushar muitas páginas durante a janela "vazia" antes auto-checkpoint disparar. WAL pode crescer mesmo dentro do `journal_size_limit` (auto-checkpoint do better-sqlite3 não é garantido em janelas idle).

**Fix sugerido:** cron 30min `db.pragma('wal_checkpoint(PASSIVE)')` + log resultado. Guard com `isMemCritical()`. Threshold: alert se `unfinished_pages > 10000`.

**Verify query (em /admin/boot-diag):**
```sql
PRAGMA wal_checkpoint(PASSIVE);
-- retorna {busy, log, checkpointed}
```

### P1-2 — 7 crons OLAP heavy SEM `isMemCritical()` guard
**Arquivos:**
- `lib/ev-calibration.js` (337 LoC, 0 refs)
- `lib/shadow-vs-real-drift.js` (494 LoC, 0 refs) — cron 60min
- `lib/gate-attribution.js` (280 LoC, 0 refs) — cron 60min
- `lib/league-trust.js` (220 LoC, 0 refs)
- `lib/readiness-learner.js` (1073 LoC, 0 refs) — opt-in OFF mas heavy quando ligar
- `lib/mt-auto-promote.js` (12h cron) — agrega market_tips_shadow ~150k+ rows
- `lib/kelly-auto-tune.js` (cron 60min) — 12 sports × N markets queries

**Impacto:** Memória crítica + cron heavy = OOM. Histórico (commit 8401ffe) confirma OOM no DB cache. Bot.js já protege `runReconciliationCycle` e `runMatchResultSourcesCleanup` (linhas 26212+26244) com `isMemCritical()`; libs invocadas pelas crons não checam.

**Fix sugerido:** wrappers em bot.js que chamam `_runShadowVsRealDriftDaily` etc deveriam `if (isMemCritical()) return;` antes de `require`. Caller paths já fazem isso em alguns crons mas não em todos.

**Verify:**
```bash
grep -L isMemCritical lib/{ev-calibration,shadow-vs-real-drift,gate-attribution,league-trust,readiness-learner,mt-auto-promote,kelly-auto-tune}.js
```

### P1-3 — mt-auto-promote query — GROUP BY sport sem cobertura ideal
**Arquivo:** `lib/mt-auto-promote.js:215-258` (`_statsBySportShadow`), `:300-330` (`_statsBySportReal`), `:367+` (`_statsBySportLeague`)
**Problema:** Query agrega `market_tips_shadow` com `WHERE sport = ? AND created_at >= ? AND result IN (...) GROUP BY sport, market, league`. Index existente `idx_mts_readiness_agg(sport, market, side, league, result)` cobre WHERE+GROUP por (sport, market, league) mas posiciona `side` antes de `league` → SQLite pode preferir scan por `idx_mt_shadow_sport_created` (sport, created_at) e ordenar/agregar em memória.

**Impacto:** Em 12h cron mt_auto_promote, scan da janela 30d em ~150k rows. DB-SLOW WARNs históricos (audit log 24min: 1654ms SELECT analytics).

**Fix sugerido:** `CREATE INDEX idx_mts_promote_agg ON market_tips_shadow(sport, created_at, market, league, result)` partial WHERE result IS NOT NULL.

**Verify:**
```sql
EXPLAIN QUERY PLAN
SELECT sport, market, league, COUNT(*) FROM market_tips_shadow
 WHERE sport = 'lol' AND created_at >= datetime('now','-30 days')
   AND result IN ('win','loss')
 GROUP BY sport, market, league;
```

### P1-4 — `tips.dm_dispatched_at` (mig 121) sem index
**Arquivo:** `migrations/index.js:3200` (mig 121), `server.js:22801-22825` (query)
**Problema:** Mig 121 adicionou coluna mas não criou index. Query `/admin/dm-dispatch-audit`:
```sql
SELECT ... FROM tips WHERE is_shadow=0 AND archived=0
  AND dm_dispatched_at IS NULL
  AND sent_at < datetime('now','-5 minutes')
  AND sent_at > datetime('now','-24 hours')
```
sem partial index sobre `(dm_dispatched_at IS NULL, sent_at)`.

**Impacto:** O endpoint admin scan tabela inteira. Quando rodado em cron monitoring (não vi rodando, mas é candidato), causa burst.

**Fix sugerido:**
```sql
CREATE INDEX IF NOT EXISTS idx_tips_dm_pending
 ON tips(sent_at, sport)
 WHERE dm_dispatched_at IS NULL AND COALESCE(is_shadow, 0) = 0 AND COALESCE(archived, 0) = 0;
```

### P1-5 — `match_result_sources` 7280ms INSERT (log audit 24min)
**Arquivo:** `lib/database.js:631` (`insertMatchResultSource`), 19 callsites em server.js + bot.js
**Problema:** mig 114 criou UNIQUE INDEX (match_id, game, source) + INSERT OR IGNORE pattern. Não há transaction wrap nas callsites — cada INSERT individual fsync no WAL. Log audit 24min mostrou 7280ms para um INSERT.

**Possíveis causas:**
1. **fsync stall** quando WAL grande não consegue checkpoint (vide P1-1)
2. **Write contention** com cron paralelo (mt_auto_promote 12h roda em horário fixo, pode coincidir com PandaScore sync)
3. **busy_timeout = 5000ms** (lib/database.js:25) deveria limitar a 5s mas 7280ms > 5s indica write+fsync, não busy_lock

**Fix sugerido:** Wrap callsites batch em `db.transaction()`. Já existem 70 transactions no código mas insertMatchResultSource é called individually em loops. Exemplo correto: server.js:32088 está dentro de `txInsertPs` transaction; mas outros callsites (server.js:8383, 8432, 8446, 8501, 8517, 8566, 8597, 8627, 8658, 8708, 8781, 9597, 21282, 32016) são individuais.

**Verify:**
```sql
PRAGMA wal_checkpoint(PASSIVE);  -- ver page count
PRAGMA wal_autocheckpoint;        -- confirmar default
```

### P1-6 — shadow-vs-real-drift query — 12 sports × 4 SELECTs hourly
**Arquivo:** `lib/shadow-vs-real-drift.js:80-180` (`_shadowRoi` + `_realRoi`), cron `bot.js:28726` (60min)
**Problema:** Hourly cron itera 12 sports e faz 4 SELECTs each (recent shadow ML+MT, baseline shadow ML+MT, recent real ML+MT, baseline real ML+MT) com janela 14d × 2. Total: 48 queries por ciclo na `tips` + `market_tips_shadow`. Cada query é covering (idx_tips_realonly serve real, idx_mt_shadow_sport_created serve MTS), mas `tips WHERE is_shadow=1` NÃO tem partial index dedicado.

**Impacto:** Cada SELECT ~50-150ms × 48 = 2.4-7.2s por ciclo. Multiplique por 24/dia. CPU/IO inflado mas dentro de SLA.

**Fix sugerido (P2 priority):**
```sql
CREATE INDEX IF NOT EXISTS idx_tips_shadow_sport_sent
 ON tips(sport, sent_at, result)
 WHERE is_shadow = 1 AND COALESCE(archived, 0) = 0;
```
OU diminuir cron pra cada 6h (já é gated por `SHADOW_VS_REAL_DRIFT_INTERVAL_H=6` default, fine).

### P1-7 — `tip_factor_log` JOIN tips sem covering index
**Arquivo:** `lib/database.js:709` (`getUnsettledFactorLogs`)
**Query:**
```sql
SELECT tlf.tip_id, tlf.factor, tlf.predicted_dir, t.result, t.tip_participant, t.participant1
  FROM tip_factor_log tlf JOIN tips t ON t.id = tlf.tip_id
 WHERE tlf.actual_winner IS NULL AND t.result IS NOT NULL
```
**Problema:** sem WHERE em t.sport/t.archived. Scan `tip_factor_log` (sem index em actual_winner direta), JOIN com `tips.id` (PK OK), mas filtro `t.result IS NOT NULL` aplicado pós-join. Tabela cresce ~5-10x tips/dia. mig 104 criou `idx_tfl_settled_logged(logged_at, factor) WHERE actual_winner IS NOT NULL` — query oposta (`IS NULL`).

**Impacto:** Cron `runWeeklyRecalc` (`bot.js:25817`) chama via lib/ml-weights.js — pode demorar com tabela grande.

**Fix sugerido:**
```sql
CREATE INDEX IF NOT EXISTS idx_tfl_unsettled
 ON tip_factor_log(tip_id)
 WHERE actual_winner IS NULL;
```

### P1-8 — `tip_factor_log` sem retention cron
**Arquivo:** Sem cleanup detectado (`grep -rn "DELETE FROM tip_factor_log"` = 0 hits)
**Problema:** Tabela cresce ~5-10x tips/dia sem retention. Mig 097 + 104 indexam mas não pruning. Em 6 meses tabela pode ter 1-3M rows.

**Fix sugerido:** Adicionar entry no `runAuditTablesRetention` (bot.js:26298):
```js
{ table: 'tip_factor_log', col: 'logged_at', days: 180, extraWhere: '' },
```

### P1-9 — `market_tips_shadow` sem retention cron (apenas admin endpoint)
**Arquivo:** `server.js:11679` (`/admin/purge-voided-market-tips`)
**Problema:** Tabela MT shadow cresce em ~5-15k rows/dia × 11 sports. mig 107 adicionou `archived` col + `idx_mts_archived_settled` mas sem cron auto-archive/delete. Apenas admin endpoint manual.

Memory MEMORY.md cita retention 45d como esperado, mas grep não encontra `MARKET_TIPS_SHADOW_RETENTION` env nem cron. Tabela pode chegar a 500k+ rows em produção, ampliando custo de TODAS as queries OLAP que tocam ela (mt-auto-promote, shadow-vs-real-drift, gate-attribution, ev-calibration, readiness-learner, mt_calib_refit, csa).

**Fix sugerido:** Cron 24h pra `UPDATE market_tips_shadow SET archived = 1 WHERE result IS NOT NULL AND settled_at < datetime('now', '-45 days')` + `DELETE WHERE archived = 1 AND settled_at < datetime('now', '-90 days')`.

**Verify:**
```sql
SELECT COUNT(*), MIN(created_at), MAX(created_at) FROM market_tips_shadow;
SELECT COUNT(*) FROM market_tips_shadow WHERE archived = 1;
```

---

## P2 (7) — Info/improvement

### P2-1 — Schema drift: `tips` table criada em lib/database.js, evolui via migrations
**Arquivo:** `lib/database.js:177-196` (CREATE TABLE tips v1 baseline)
**Issue:** Schema v1 tem 18 columns; após mig 002, 003, 005, 006, 023, ..., 121, 123 a tabela acumulou ~40+ columns (clv_odds, open_odds, stake_reais, profit_reais, market_type, is_shadow, archived, code_sha, model_p_pick, gate_state, tip_context_json, learned_correction_id, match_end_at, settle_notified_at, dm_dispatched_at, pinnacle_bet_id, pinnacle_bet_status, pinnacle_actual_odd, pinnacle_bet_at, model_p_raw, etc.).

**Recomendação:** documentar schema atual em `docs/schema.md` ou criar `/admin/schema-snapshot` endpoint (`PRAGMA table_info(tips)`).

### P2-2 — Migration 030 e 082 — gaps de numeração intencionais (confirmado)
**Confirm:** `id: '030_league_blocks'` (linha 559) e `id: '082_perf_indexes'` (linha 1979) existem. Gaps 30→32 e 82→84 NÃO são gaps reais — só pulou nomenclatura.

**Status:** OK, mas confuso. Documentar.

### P2-3 — Duplicate index name `idx_tips_unique_active` recriado 3x
**Arquivos:** mig 096, mig 102, mig 120 fazem `DROP INDEX IF EXISTS` + `CREATE UNIQUE INDEX idx_tips_unique_active`.
**Status:** funcional (idempotent), mas se replicar DB pra dev sem rodar todas as migrations, scope final difere. Confirmar `applyMigrations` é estritamente sequencial.

### P2-4 — `idx_match_results_game_resolved` criado 2x em lib/database.js
**Arquivo:** `lib/database.js` (2 ocorrências de mesmo CREATE INDEX — output do grep mostra 2x).
**Status:** Idempotent (`IF NOT EXISTS`), mas indica copy-paste.

### P2-5 — `tip_factor_log` sem ON DELETE CASCADE em FK tips
**Arquivo:** `lib/database.js:347` — `PRIMARY KEY (tip_id, factor)` sem FOREIGN KEY declarada.
**Issue:** Mig 097 adicionou `learned_correction_id` em tips + idx, mas FK não está definida. Com `PRAGMA foreign_keys = ON` (lib/database.js:31), DELETE tip pode falhar se ainda houver rows em tip_factor_log.

**Status:** Cosmético — DELETE tips raro fora de zombies cleanup.

### P2-6 — `match_results.match_id` é parte da PK mas sem index dedicado em `match_id` sozinho
**Arquivo:** `lib/database.js:219-228` — `PRIMARY KEY (match_id, game)` cobre `WHERE match_id = ? AND game = ?` mas queries `WHERE match_id = ?` sem game (server.js:28199 `SELECT resolved_at FROM match_results WHERE match_id = ? LIMIT 1`) podem usar PK leftmost prefix OK (`match_id` é leftmost).

**Status:** OK. PK cobre. Anotado como verificação.

### P2-7 — `cross_significance_snapshots` cleanup inline + sem env documentation
**Arquivo:** `bot.js:28859-28902` (`runCsaDaily`)
**Issue:** DELETE inline no mesmo path do INSERT (`bot.js:28899`). Se INSERT falhar, DELETE ainda roda mas cleanup pode falhar silenciosamente em try/catch wide.

**Recomendação:** mover DELETE pra `runAuditTablesRetention` (bot.js:26298) com entry dedicada.

---

## VALIDAÇÃO RUN-IN-PROD (queries pra admin)

```sql
-- 1. WAL state + checkpoint
PRAGMA wal_checkpoint(PASSIVE);
PRAGMA wal_autocheckpoint;
PRAGMA journal_size_limit;

-- 2. tips growth
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN COALESCE(is_shadow,0)=1 THEN 1 ELSE 0 END) AS shadow,
  SUM(CASE WHEN COALESCE(archived,0)=1 THEN 1 ELSE 0 END) AS archived,
  MIN(sent_at), MAX(sent_at)
FROM tips;

-- 3. market_tips_shadow growth (sem retention cron — P1-9)
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN COALESCE(archived,0)=1 THEN 1 ELSE 0 END) AS archived,
  SUM(CASE WHEN result IS NOT NULL THEN 1 ELSE 0 END) AS settled,
  MIN(created_at), MAX(created_at)
FROM market_tips_shadow;

-- 4. orphan tips: open_odds NULL em tip real settled (P0-1 evidência)
SELECT COUNT(*) FROM tips
 WHERE COALESCE(is_shadow,0)=0 AND archived=0
   AND result IN ('win','loss')
   AND open_odds IS NULL
   AND sent_at >= datetime('now','-30 days');

-- 5. dm_dispatched_at index missing (P1-4)
SELECT COUNT(*) FROM tips
 WHERE COALESCE(is_shadow,0)=0 AND archived=0
   AND dm_dispatched_at IS NULL
   AND sent_at < datetime('now','-5 minutes')
   AND sent_at > datetime('now','-24 hours');

-- 6. tip_factor_log growth (P1-8)
SELECT COUNT(*), MIN(logged_at), MAX(logged_at) FROM tip_factor_log;

-- 7. match_result_sources retention (mig 109 cleanup roda — confirmar)
SELECT COUNT(*), MIN(recorded_at), MAX(recorded_at) FROM match_result_sources;

-- 8. WAL file size (FS level)
-- ls -lh sportsedge.db sportsedge.db-wal sportsedge.db-shm
```

---

## NOTAS DE ARQUITETURA (positivas — não findings)

- **Schema migrations:** 126 sequenciais, todas com try/catch + log + idempotent (`IF NOT EXISTS`/`addColumnIfMissing`). Excelente.
- **Settle paths usam `db.transaction()`:** 70 instâncias `db.transaction(...)`. Settle (server.js:4914, 18085, 18332, 21898, etc.) é atômico tip+bankroll. Bom.
- **`/record-tip` UPDATE bankroll está só em settle** — não em emit. Banco reflete apenas tips settled. Confirma que bankroll drift cron (lib/bankroll-reconciliation.js) detecta mismatch.
- **Pragma config bem documentada:** `journal_mode=WAL`, `synchronous=NORMAL`, `cache_size=-8000`, `mmap_size=0`, `journal_size_limit=100MB`, `foreign_keys=ON`. Pós OOM fix (commit 8401ffe) está aplicado.
- **DB-SLOW wrapper em lib/database.js:71-110** — wraps run/get/all/iterate com timing. Threshold default 100ms via `DB_SLOW_QUERY_MS`. Suporta detection de regressões.
- **Partial indexes muito bem usados:** idx_tips_realonly, idx_tips_pending, idx_mt_shadow_unsettled, idx_mts_clv_pending, idx_mts_archived_settled, idx_tfl_settled_logged, idx_lc_active/expires, idx_league_blocks_active, idx_mtrs_tier, idx_bst_unsettled. Mostra investimento em performance.
- **mig 102+120** corrigiram `idx_tips_unique_active` pra excluir void/push + incluir is_shadow scope. Boa evolução documentada.
- **Retention crons existem:** `audit_tables_retention` (4 tables 60-90d), `match_result_sources_cleanup`. Falta apenas `tip_factor_log` (P1-8) + `market_tips_shadow` (P1-9) + `cross_significance_snapshots` em local centralizado (P2-7).

---

## DELTA vs ESCOPO ORIGINAL

| Solicitado | Status |
|---|---|
| Migrations sequência | ✅ 126 aplicadas, gaps 30→32 e 82→84 são intencionais |
| Mig 091/117/118/120/121/122/123 | ✅ Todas presentes e documentadas |
| Slow queries em hot path | ✅ 3 SELECT COUNT(CASE) em mt-auto-promote; 7280ms INSERT mrs (P1-5); 1654ms analytics |
| Multi-JOIN sem index | ✅ 0 multi-JOIN (>=2 JOIN) detectado |
| Índices tips/mts/match_results/mtrs/grs | ✅ Confirm — todos OK exceto P1-4 (dm_dispatched_at), P1-7 (tfl unsettled) |
| OLAP em hot path | ✅ P1-2 (7 libs sem isMemCritical), P1-6 (shadow-vs-real-drift heavy) |
| Soft-delete consistency | ✅ Todos paths críticos (kelly, leak, stake, bankroll-recon, propagator) filtram archived+is_shadow corretamente |
| WAL contention | ✅ P1-1 (sem wal_checkpoint scheduled), P1-2 (mem critical guard ausente) |
| Transação scope | ⚠️ P0-1 (record-tip multi-write não-atômico); settle paths OK |
| DB-SLOW logging | ✅ Confirmado em lib/database.js:71-110 |
| Schema drift | ⚠️ P2-1 (tips v1 vs current); P2-3/2-4 (duplicate index names cosmético) |
| DB size growth | ⚠️ P1-9 (market_tips_shadow sem retention); P1-8 (tip_factor_log); P2-7 (csa snapshots) |
