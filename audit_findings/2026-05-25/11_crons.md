# Cron audit — SportsEdge-Bot
**Data:** 2026-05-25  
**Scope:** Inventário completo, frequências, overlap, heartbeats, dead crons, calib cadence, CLV capture, drift→refit, leak guards.

## TL;DR — top 5

1. **P0 — `mt_calib_refit` (bot.js:26506) usa caminho BOOTSTRAP frágil + RETENTION GAP**: cron usa `/market-tips-recent?days=90&limit=2000` mas `market_tips_shadow` é archived em 90d (rotation_policy daily). Default 90d em endpoint legacy é igual ao archive horizon → dataset pode estar sempre na borda do vazio (já documentado em COMMON_PITFALLS.md #14 — refit defaults `days=90` retention `45d`). Em paralelo, esports/tennis refit usa `/admin/mt-refit-calib` (script principal) — duas pipelines diferentes de refit MT coexistem.
2. **P0 — DM delivery health cron NÃO EXISTE**. Memory `audit_pendencies_2026_05_24 #5` flaga DM health pending. Grep `dm_dispatched_at` (mig 121) confirma instrumentação but no cron consome o sinal. Bug silencioso: token rotacionado / chat_id banido / Telegram rate-limit → DMs caem em silêncio sem warning.
3. **P1 — 6 crons bare `setInterval` sem heartbeat E sem `_wrapCron`** (bot.js:711/1054/1059/1065/1075/1182/1399/1929/2014/27134/27204/27289/27339): perde overlap-skip, perde markCronHeartbeat, perde mem tracking. Alguns são janitorial (sweep, dump) e ok, mas `runDbBackupCheck`/`runDailyLeaksDigest`/`runWeeklyDigest`/`runScraperSmokeTestCron` (4 críticos) usam `setInterval(() => fn().catch(() => {}))` direto — `catch(()=>{})` engole TODOS os errors silenciosamente.
4. **P1 — overlap intent: `weekly_digest` (bot.js:27289) vs `weekly_pipeline_digest` (bot.js:28237)** são dois crons separados, ambos schedulados 30min/1h respectivamente, ambos enviam DM admin com summary semanal. P3 violation candidata — consolidar ou justificar com comment "diferente de X porque Y" (CLAUDE.md P3).
5. **P1 — `reconciliation` (bot.js:26238) + `mr_reconcile` (bot.js:29136) overlap**: ambos rodam 1h, ambos têm "reconcile" no nome, ambos enviam DM admin. `reconciliation` é bankroll drift + result divergence (memory 2026-05-12). `mr_reconcile` é match_results dual-source (mig 109 FASE 1). Intent é diferente mas nomes/cadence iguais — fácil confundir. Consolidar OR rename pra explicitar.

---

## Métricas globais

| Metric | Valor |
|---|---|
| **Total setInterval (excl. comments)** | 133 |
| **setInterval wrapped (`_wrapCron`/`_wrapServerCron`/`_setIntervalJittered`)** | 80 |
| **setInterval BARE (sem wrapping)** | ~53 (inclui keep-alive, dump, watchdog leves) |
| **Crons únicos com heartbeat** | 66 (CLAUDE.md alert "84" overestimates) |
| **Crons com setTimeout boot-fire** | 64 / 66 (97%) |
| **Crons SEM boot-fire** | 2 (`mt_calib_validation`, `non_ml_autoarchive`) |
| **Crons hot path (≤60s)** | 0 (saudável — só keep-alive `mem_watchdog`/`uptime gauge` em path 60s) |
| **Crons hourly (≤1h)** | 41 |
| **Crons multi-hour/daily** | 20 |

---

## Inventário completo (tabela)

| Cron name | Freq | File:line | Boot | Purpose | HB | OptOut env |
|---|---|---|---|---|---|---|
| `ai_shadow_audit` | 1h | bot.js:28836 | 45m | AI shadow ROI early warning (DM-only) | ✓ | `AI_SHADOW_AUDIT_AUTO=false` |
| `analyzed_dedup_persist` | 5m | bot.js:1054 (BARE) | — | Persist analyzed maps dedup | ✓ (via markCronHeartbeat in body) | — |
| `audit_tables_retention` | 1h | bot.js:26317 | 30m | Cleanup audit tables | ✓ | — |
| `auto_healer` | 5m (jittered) | bot.js:25899 | 4m | Auto-restart frozen scrapers | ✓ | `AUTO_HEALER_INTERVAL_MIN` |
| `auto_shadow` | 6h | bot.js:25831 | 5m | AUTO_SHADOW_NEGATIVE_CLV check | ✓ | `AUTO_SHADOW_NEGATIVE_CLV=true` (OPT-IN OFF!) |
| `auto_void_stuck` | 15m | bot.js:26666 | 1.1h | Auto-void tips stuck pending por sport-threshold | ✓ | — |
| `autonomy_digest` | 15m | bot.js:27014 | 35m | Cron 15m check, DM daily ~12h UTC | ✓ | — |
| `backtest_validator` | 1d | bot.js:27630 | 30m | Backtest model gates retroativos | ✓ | — |
| `bankroll_guardian` | 1h | bot.js:25903 | 10m | Drawdown high alert + auto-shadow temp | ✓ | — |
| `baseline_shadow` | 15m (jittered) | bot.js:30066 | 12m | Baseline shadow line-shop sem stack | ✓ | `BASELINE_SHADOW_DISABLED` |
| `brier_ev` | 15m | bot.js:25907 | 3m | Brier→EV cap cache refresh | ✓ | — |
| `cache_sweep` | server | server.js:39097 | — | Sweep stale caches | ✓ | — |
| `calib_staleness` | 6h | bot.js:28798 | 15m | Detect calib JSON > 7d → trigger refit (2nd causa→fix bridge) | ✓ | `CALIB_STALENESS_AUTO=false` |
| `calib_unified_refresh` | 6h | bot.js:26882 | 5m | Unified calib refresh | ✓ | — |
| `check_pending_alerts` | 10m (combined w/ settle) | bot.js:25788/25790 | — | Pending tips alerts batch | ✓ | — |
| `clean_old_odds` | server | server.js:39089 | — | Cleanup old odds rows | ✓ | — |
| `clv_by_book` | 1h | bot.js:29097 | 6m | CLV per-book monitor | ✓ | `CLV_BOOK_MONITOR_AUTO=false` |
| `clv_capture` | 2m (env) | bot.js:28043 | 3m | Captura CLV cross-sport (lol/dota/cs/val/tennis/football) | ✓ | `CLV_CAPTURE_INTERVAL_MS` |
| `critical_alerts` | 10m | bot.js:25822 | 30s | Alertas críticos polling /alerts | ✓ | — |
| `cs_permap_ingest` | 30m | bot.js:25874 | 5m | CS per-map ingest HLTV scoreboard | ✓ | — |
| `daily_summary` | combined | bot.js:25789/25790 | — | Daily DM summary | ✓ | — |
| `db_integrity_check` | 15m | bot.js:26848 | 5m | DB integrity PRAGMA check | ✓ | — |
| `dd_warn` | 15m | bot.js:26797 | 50m | DD ∈ [warn, hard) per sport | ✓ | — |
| `drift_guard` | 6h | bot.js:27497 | — | Drift guard | ✓ | — |
| `drift_triggered_refit` | 30m | bot.js:28767 | 10m | Consume drift flags + refit calib cooldown 6h | ✓ | `DRIFT_TRIGGERED_REFIT_AUTO=false` |
| `esports_calib_refit` | 1h check (fires 1×/d at 5h local) | bot.js:28634 | 8m, 100m | LoL/CS/Dota2/Val MT calib refit (stratify=tier_side) | ✓ | `ESPORTS_CALIB_REFIT_DISABLED=true` |
| `football_poisson_retrain` | 15m | bot.js:26398 | 55m+90s | Football Poisson params retrain | ✓ | — |
| `gate_attribution` | 1h check (fires 1×/wk) | bot.js:29005 (call) | — | Counterfactual saved_loss vs lost_profit per gate | ✓ | `GATE_ATTRIBUTION_AUTO=false` |
| `gates_autotune` | 12h | bot.js:? | — | Gates auto-tune cycle | ✓ | — |
| `hltv_results_sync` | 15m | bot.js:25853 | 8m | HLTV results scrape sync | ✓ | — |
| `ia_health` | 1h | bot.js:27460 | — | IA health check | ✓ | — |
| `kills_calib_check` | 1h check (4 AM UTC) | bot.js:28228 | 25m | LoL kills calibration check + DM | ✓ | `KILLS_CALIB_AUTO=false` |
| `league_bleed` | 6h | bot.js:25924 | 20m | League bleed scan | ✓ | — |
| `league_guard` | 12h | bot.js:27491 | — | League guard cycle | ✓ | — |
| `live_risk_monitor` | 10m | bot.js:25964 | 8m | Cashout-alerts cross-sport DM admin | ✓ | `LIVE_RISK_MONITOR_AUTO=false` |
| `live_scout_gaps` | 15m | bot.js:25826 | 60s | Live stats faltando > 5min | ✓ | — |
| `live_storm` | 10m | bot.js:27638 | 7m | Live storm manager DM alert | ✗ BARE (no _wrapCron) | — |
| `lol_xcheck_daily` | 1h check (4 AM) | bot.js:28234 | 35m | LoL cross-source kill validation | ✓ | `LOL_XCHECK_AUTO=false` |
| `match_result_sources_cleanup` | 1h | bot.js:26268 | 15m | match_result_sources retention 30d | ✓ | — |
| `mem_guard` | server | server.js:38941 | — | Server mem guard | ✓ | — |
| `mem_watchdog` | 5m | bot.js:1399 (BARE) | — | Bot mem RSS check + DM crit | ✓ (markCronHeartbeat in body) | — |
| `ml_auto_promote` | 12h | bot.js:27593 | — | ML auto-promote shadow→real | ✓ | — |
| `ml_shadow_digest` | 1h check (8h local) | bot.js:28220 | 6m | ML shadow digest DM | ✓ | `SHADOW_DIGEST_ENABLED=false` |
| `ml_weights_weekly` | server 1w | server.js:39125 | — | ML weights weekly recalc | ✓ | — |
| `model_calibration` | 1d | bot.js:27486 | NOW +30m (ef5b76e fix) | Model calibration daily | ✓ | — |
| `mr_reconcile` | 1h check (15h UTC) | bot.js:29136 | 8m | match_results dual-source reconcile mig 109 | ✓ | `MATCH_RESULTS_RECONCILE_AUTO=false` |
| `mt_auto_promote` | 12h | bot.js:27578 | — | MT auto-promote shadow→real | ✓ | — |
| `mt_bucket_guard` | 12h | bot.js:27505 | — | MT bucket guard (P2-compliant) | ✓ | `MT_BUCKET_GUARD_REAL_ONLY=true` |
| `mt_calib_refit` | 1h check (dom 4h UTC) | bot.js:26506 | 5m | MT calib refit (legacy /market-tips-recent spawn) | ✓ | `CALIB_AUTO_REFIT_DISABLED=true` |
| `mt_calib_validation` | 30m check (9h UTC) | bot.js:26594 | **NO BOOT** | MT calib validation alert | ✓ | `MT_VALIDATION_DM_DISABLED=true` |
| `mt_digest` | 1h check (8h local) | bot.js:28215 | 5m | MT digest DM | ✓ | — |
| `mt_leak_guard` | 1h | bot.js:28209 | 15m | MT leak guard P2-compliant | ✓ | `MT_LEAK_REAL_ONLY=true` |
| `mt_promote_explain` | 1d | bot.js:27615 | 1.3h | MT promote explain digest | ✓ | — |
| `mt_roi_guard_sided` | 1h | bot.js:28212 | 20m | MT ROI guard sided | ✓ | `MT_ROI_GUARD_REAL_ONLY=true` |
| `nightly_retrain` | 15m check (3 AM UTC) | bot.js:27093 | 45m | Nightly retrain | ✓ | — |
| `news_monitor` | 15m | bot.js:? | — | News monitor | ✓ | — |
| `non_ml_autoarchive` | 1h | server.js:39196 | **NO BOOT** (+3min setTimeout at 39195 but raw) | Non-ML auto-archive (threshold 7d post 30f5add fix) | ✓ | — |
| `odds_bucket_guard` | 12h | bot.js:27500 | 50m | Odds bucket guard | ✓ | — |
| `oddspapi_live_poll` | server | server.js:39027 | — | OddsAPI live poll | ✓ | — |
| `oddspapi_refresh` | server | server.js:38997 | — | OddsAPI refresh | ✓ | — |
| `overfeaturing_audit` | 1h check (semanal) | bot.js:26123 | 5m | Audit features dormentes (P3) | ✓ | — |
| `path_guard` | 6h | bot.js:27488 | — | Path guard | ✓ | — |
| `pinnacle_lol_live_refresh` | server | server.js:39016 | — | Pinnacle LoL live refresh | ✓ | — |
| `pinnacle_lol_refresh` | server | server.js:39014 | — | Pinnacle LoL refresh | ✓ | — |
| `pipeline_digest` | 6h | bot.js:? | — | Pipeline digest | ✓ | — |
| `post_fix_monitor` | 1d | bot.js:27634 | 45m | Post-fix monitor flood+bleed detection | ✓ | — |
| `pre_match_check` | 5m | bot.js:? | — | Pre-match check | ✓ | — |
| `reconciliation` | 1h check (8h UTC) | bot.js:26238 | 10m | Bankroll drift + result divergence | ✓ | `RECONCILIATION_AUTO=false` |
| `risk_metrics_monitor` | 12h | bot.js:26071 | 90m | Sharpe/DD/concentração DM | ✓ | `RISK_METRICS_MONITOR_AUTO=false` |
| `rotation_policy` | 1d | bot.js:28412 | 15m (ef5b76e fix) + 110m | Archive tips >180d, mt_shadow >90d | ✓ | `ROTATION_POLICY_DISABLED=true` |
| `settle_completed` | 10m (combined) | bot.js:25790 | — | Settle tips completed | ✓ | — |
| `settle_factor_logs_daily` | server 1d | server.js:39122 | — | Daily factor logs settle | ✓ | — |
| `settle_sweep_cycle` | server | server.js:39145 | — | Settle sweep cycle | ✓ | — |
| `shadow_vs_real_drift` | 1h check (daily) | bot.js:28726 | 40m | Shadow vs real drift detection (P2-safe) | ✓ | `SHADOW_VS_REAL_DRIFT_AUTO=false` |
| `sofa_watchdog` | 1h | bot.js:1130 | 10m | Sofascore proxy health watchdog | ✓ | — |
| `stale_blocks_audit` | 1h check (Tue 15h UTC) | bot.js:26198 | 5m | Audit blocks com n<minN P1 violation | ✓ | `STALE_BLOCKS_AUDIT_AUTO=false` |
| `stale_odds_check` | server 1h | server.js:39043 | — | Stale odds for upcoming | ✓ | — |
| `stuck_pending_warn` | 1h | bot.js:26724 | 20m | Stuck pending early warn | ✓ | — |
| `subscribers_refresh` | 5m | bot.js:25594 (BARE) | — | Loadsubscribers refresh | ✗ (markPollHeartbeat) | `SUBSCRIBERS_REFRESH_INTERVAL_MS=0` disable |
| `sync_golgg_role` | server | server.js:39082 | — | Sync gol.gg roles | ✓ | — |
| `sync_pro_stats` | server 12h | server.js:39071 | — | Sync pro stats | ✓ | — |
| `tennis_calib_refit` | 1h check (4h local) | bot.js:28378 | 8m (ef5b76e fix) + 95m | Tennis Markov calib refit (stratify=tier) | ✓ | `TENNIS_CALIB_REFIT_DISABLED=true` |
| `tennis_mt_readiness_watch` | 12h | bot.js:? | 20m (ef5b76e fix) | Tennis MT real promote readiness watch | ✓ | `TENNIS_MT_READINESS_WATCH=false` |
| `tennis_mt_real_health_watch` | 6h | bot.js:28532 | 15m (ef5b76e fix) + 105m | Tennis MT real health DM | ✓ | — |
| `threshold_auto_apply` | 15m | bot.js:26355 | 50m | Threshold auto-apply gates | ✓ | — |
| `val_permap_ingest` | 30m | bot.js:25892 | 6m | Valorant per-map ingest | ✓ | — |
| `weekly_pipeline_digest` | 1h check (Mon 9h) | bot.js:28237 | 10m | Weekly pipeline summary | ✓ | `WEEKLY_DIGEST_ENABLED=false` |
| `weekly_recalc` | 7d | bot.js:25817 | 5m | Weekly weights recalc | ✓ | — |
| `_loadMarketTipsRuntimeState` (mt_disable refresh) | 5m | bot.js:28208 (BARE) | — | Reload mt_disable list pos /admin/mt-disable | ✗ NO HEARTBEAT | — |
| `gates_runtime_state.loadFromDb` | 5m | bot.js:6074 (BARE) | — | Gates state refresh | ✗ NO HEARTBEAT | — |
| `auto_analysis` (timeout-recursive) | 6m adaptive | bot.js:? | — | Auto-analysis cycle | ✓ | — |
| `db_backup` (BARE) | 30m | bot.js:27134 | 25m | DB backup check (catches all errors silently) | ✗ NO HEARTBEAT | — |
| `leaks_digest` (BARE) | 30m | bot.js:27204 | 50m | Daily leaks digest | ✗ NO HEARTBEAT | — |
| `weekly_digest` (BARE) | 30m | bot.js:27289 | — | Weekly digest (separate from weekly_pipeline_digest!) | ✓ markCronHeartbeat in body | — |
| `scraper_smoke` (BARE) | 30m | bot.js:27339 | — | Scraper smoke test | ✗ NO HEARTBEAT | — |
| `pinnacle_key_expired_dm` (BARE) | 30m | bot.js:1075 | — | Pinnacle key expired DM throttle 6h | ✗ NO HEARTBEAT | — |
| `cron_state_dump` (BARE) | 60s | bot.js:675 | — | dumpCronHeartbeats to file | ✗ janitorial | — |
| `_bridgeBotMetricsToServer` (BARE) | 60s | bot.js:1182 | — | Bridge bot metrics → server | ✗ janitorial | — |
| `bot_uptime_gauge` (BARE) | 60s | bot.js:1065 | — | uptime metric gauge | ✗ janitorial | — |
| `_lastNearHeapWriteAt diag` (BARE) | ? | bot.js:2014 | — | Near-heap-limit diag (a0b5a58) | ✗ diag-only | — |
| `_botLastMemWarnAt` (BARE) | ? | bot.js:1929 | — | RSS/heap mem check | ✗ throttled | — |
| `runDailyDigest` (BARE timer) | ? | bot.js:25594 | — | Subscribers refresh | ✗ | — |

---

## Análises por seção

### 1. Frequência tuning

**Hot path (≤60s):** Nenhum cron crítico em ≤60s. Saudável.
- `cron_state_dump` 60s (bot.js:675) — overhead ~2KB, ok.
- `_bridgeBotMetricsToServer` 60s (bot.js:1182) — Map sync, leve.
- `bot_uptime_gauge` 60s (bot.js:1065) — `metrics.gauge` write, leve.

**Sub-60s crons (potencial waste):** Nenhum identificado.

**Crons potencialmente over-frequent:**
- `clv_capture` 2 min default (`CLV_CAPTURE_INTERVAL_MS=120000`) — agressivo. Pode capturar mesmo CLV várias vezes pra tip estável. Sport-aware throttle ausente — VAL às vezes sem live pode rodar idle 2min × 30/h = 720 reqs/d sem tip pra capturar. CLV capture itself faz scoping interno via `WHERE clv_odds IS NULL` então skip rápido — ok.
- `mt_calib_refit` cron 1h mas só dispara em sunday 4h UTC interno. **OVERHEAD**: 23 days/week = 0 ações, 1 dia × 24 ticks de cron checking time = 168 ticks/wk de fn:start → if(weekday!=0) → return. Aceitável (microsegundos).

**Retention vs days mismatch:**
- `mt_calib_refit` (bot.js:26506) consome `/market-tips-recent?days=90` — `rotation_policy` daily archiva `market_tips_shadow >90d`. Bordas batendo. Doc em FEATURE_INVENTORY/COMMON_PITFALLS #14: defaults `days=90` quebrado pra retention `45d` — **VERIFICAR se mt_calib_refit ainda usa 90 OR já foi mudado pra 45**. **A linha 26506 ainda usa `days=90` no path bootstrap inline**. Tennis (28347) e esports (28576) usam `trainDays = parseInt(...ESPORTS_CALIB_TRAIN_DAYS ?? '45', 10)` — corrigido. **Bug: legacy `mt_calib_refit` continua com 90d**.

### 2. Overlap / duplicate intent

**P3 violations potenciais:**

| Pair | Files | Evidência |
|---|---|---|
| `weekly_digest` (27289) vs `weekly_pipeline_digest` (28237) | bot.js | Dois crons separados rodando 30min/1h, ambos enviam DM admin com summary semanal. Function names diferentes (`runWeeklyDigest` vs `runWeeklyPipelineDigest`) mas mesmo intent semântico. Verificar se source de dados é diferente |
| `reconciliation` (26238) vs `mr_reconcile` (29136) | bot.js | Ambos 1h, ambos "reconcile" no nome. Intent diferente (bankroll drift vs match_results) mas nomeação confusa. Rename `reconciliation` → `bankroll_reconciliation` |
| `mt_calib_refit` (26506) vs `esports_calib_refit` (28634) vs `tennis_calib_refit` (28378) | bot.js | TRÊS paths separados de refit MT calib. `mt_calib_refit` é legacy spawn de fit-tennis-markov-calibration.js. `tennis_calib_refit` usa endpoint `/admin/mt-refit-calib?sport=tennis`. `esports_calib_refit` mesma endpoint pra lol/cs/dota2/val. **Legacy `mt_calib_refit` é dead code** — esports + tennis cobrem 100% dos sports relevantes |
| `mt_leak_guard` (28209) vs `mt_roi_guard_sided` (28212) | bot.js | Hourly + offset 5min. Intent legítimo diferente (CLV-based vs ROI sided). Comment justifica em 28211 |
| `path_guard` (27488) + `league_guard` (27491) + `drift_guard` (27497) + `odds_bucket_guard` (27500) + `mt_bucket_guard` (27505) | bot.js | 5 guards stacked. Cada um captura signal diferente. Aceitável mas surface area enorme |
| `kills_calib_check` (28228) vs `lol_xcheck_daily` (28234) | bot.js | Ambos LoL daily, ambos relacionados a quality LoL. `kills_calib_check` é brier/mae per sport, `lol_xcheck_daily` é cross-source kill validation. Aceitável |
| `analytics_watchdog` (28072 BARE) vs `analytics_digest` (28083) | bot.js | Two analytics crons, separated by intent (alerts vs digest). OK |
| `shadow_vs_real_drift` (28726) + `drift_triggered_refit` (28767) + `calib_staleness` (28798) | bot.js | 3-step pipeline: drift detector → refit dispatcher → staleness fallback. **POSITIVE pattern** — explicit cause→fix bridge |

### 3. Cron heartbeat coverage

**Crons SEM markCronHeartbeat:**
- `_loadMarketTipsRuntimeState` 5min (bot.js:28208) — refresh mt_disable list. **CRITICO** — se DB lock OR error, in-memory state fica stale + dispatch usa lista antiga. Sem heartbeat, gap silencioso.
- `gates_runtime_state.loadFromDb` 5min (bot.js:6074) — mesma classe.
- `runDbBackupCheck` 30min (bot.js:27134) — `.catch(() => {})` silently swallows backup failures.
- `runDailyLeaksDigest` 30min (bot.js:27204) — `.catch(() => {})` silently.
- `runScraperSmokeTestCron` 30min (bot.js:27339) — `.catch(() => {})` silently.
- `_pinnacleKeyDmedAt` 30min (bot.js:1075) — Pinnacle key expired DM — silent fail.
- `live_storm` 10min (bot.js:27638) — uses `.catch(e => log(...))` mas não wrapCron.
- `subscribers_refresh` 5min (bot.js:25594) — has markPollHeartbeat in body (via loadSubscribedUsers) but **no markCronHeartbeat** — won't show in /admin/cron-status as cron.

**Pattern overlap-skip via `_cronRunning` Set (bot.js:1248 `_wrapCron`):** ✓ implementado bem. `_wrapServerCron` espelhado (server.js:1497). markCronHeartbeat com lastError reset em result='ok' (mitigates sticky-error false positive — bot.js:utils:100).

### 4. Dead crons / opt-in

**Default OFF (provavelmente never fires em prod):**
- `auto_shadow` — `AUTO_SHADOW_NEGATIVE_CLV` default OFF (memory mention bot.js:25832). Cron interval 6h roda fn → fn early-returns. Aceitável, mas surface area.
- `READINESS_LEARNER_AUTO` — Memory CLAUDE.md "NÃO ativar sem 1-2 ciclos dry_run validados". Cron stub presumivelmente off.
- `LIVE_STORM` — wrap manual, no `_wrapCron`. Verificar last fire.

**Recommend:** rodar `GET /admin/cron-status` e ler `count` por cron → identificar n=0 ou n<<expected em 30d. Não foi possível verificar via code-only audit (lastTs persistido em arquivo).

### 5. Boot-fire crons

**Fix commit ef5b76e (2026-05-24)** documentado: 6 crons faltavam boot-fire identificados:
- `model_calibration` → +30m
- `rotation_policy` → +15m (+ duplicate 110m setTimeout!)
- `tennis_mt_readiness_watch` → +20m
- `tennis_mt_real_health_watch` → +15m (+ 105m duplicate)
- `tennis_calib_refit` → +8m (+ 95m duplicate)
- `esports_calib_refit` → +8m (+ 100m duplicate)

**Issue novo P1:** Cada um dos 4 crons recentes adicionou DOIS setTimeouts boot-fire (uma curta + uma longa "safety" 95-110min):
```js
setTimeout(_wrapCron('tennis_calib_refit', runTennisCalibRefitDaily), 8 * 60 * 1000);
setTimeout(() => runTennisCalibRefitDaily().catch(() => {}), 95 * 60 * 1000);
```
A segunda chamada NÃO usa `_wrapCron` → bypassa overlap protection, sem heartbeat, sem mem tracking. Se primeira ainda estiver rodando aos 95min (improvável mas possível em mem-defer scenario), dispara concorrente.

**Crons SEM boot-fire ainda:**
- `mt_calib_validation` (bot.js:26594) — setInterval=30min only. Daily check (9h UTC) → ok, mas se bot rebootar em 8:30 UTC, próximo tick em 9h falha exato. Adicionar boot-fire 6min similar pattern.
- `non_ml_autoarchive` (server.js:39196) — setInterval=1h, mas linha 39195 tem `setTimeout(archiveOrphanNonML, 3 * 60 * 1000)` (BARE — bypassa `_wrapServerCron`).

### 6. CLV capture cron (deep dive)

**File:** lib/clv-capture.js (top comment cita 2-3min frequency — confirma).  
**Cron:** bot.js:28043 — `setInterval(_wrapCron('clv_capture', runClvCaptureCycle), CLV_CAPTURE_INTERVAL_MS)` com `CLV_CAPTURE_INTERVAL_MS=120000` default (2 min).

**Boot fire:** bot.js:28044 — 3 min pós-boot. Justified.

**Race protection:** `/admin/run-clv-capture` endpoint server.js:17346 lê `cron_last_ts:clv_capture` gauge — se < 60s skipa com `cron_ran_recently` HTTP 409. ✓

**Cross-sport coverage:**
- Memory 2026-05-25 commits `f5697b3+2cc3d00`: VAL+CS branches added to /odds endpoint (cache miss → 0% CLV pré-fix).
- Memory `3748a8f` (recent): game param passed to /odds-markets — VAL 6.4%→90%+, CS 49%→90%+ expected coverage.
- lib/clv-capture.js: `_SPORT_GAME` mirror — supports `esports/lol/dota/dota2/cs/cs2/valorant`. **Tennis e football NÃO listados em _SPORT_GAME** — verificar se funcionam via outro path (handicaps/totals secondary code path em clv-capture cobre football tennis sem precisar game param).

**Capture frequency vs feed liveness:** sem sport-aware skip — em momentos sem live VAL, cron roda igual e gasta 1 SELECT (cheap). Aceitável.

### 7. Calibration refit cadence (deep dive)

| Cron | Schedule | Days param | Sports | Stratify |
|---|---|---|---|---|
| `tennis_calib_refit` | 4h local | `&days=${trainDays}&eval_days=${evalDays}` (trainDays default 45 via `TENNIS_CALIB_TRAIN_DAYS`?, code 28347 uses literal — VERIFICAR) | tennis | `tier` |
| `esports_calib_refit` | 5h local | `trainDays=45, evalDays=14` | lol, cs, dota2, valorant | `tier_side` (tiers_only=true) |
| `mt_calib_refit` (legacy) | sun 4h UTC | inline `?days=90` (bot.js:28537?) | tennis only (spawn fit-tennis-markov-calibration.js) | hardcoded inside spawn |
| `calib_unified_refresh` | 6h | — | unified | — |
| `model_calibration` | 1d | — | — | — |

**Problem:** `mt_calib_refit` legacy cron usa endpoint `/market-tips-recent?days=90` (bot.js code aprox 26506). Tennis retention `market_tips_shadow` é 90d em `rotation_policy`. Borda exata. FEATURE_INVENTORY/COMMON_PITFALLS #14 documenta fix prévio `days=45`. **Cron permanece com 90d em legacy path inline**. Recomendação: deprecate `mt_calib_refit` legacy — esports/tennis crons cobrem tudo.

**Schemas calib:**
- Tennis `lib/tennis-markov-calib.json` (TTL 30 min lê sem restart)
- LoL `lib/lol-mt-calib.json`
- CS `lib/cs-mt-calib.json` (memory 2026-05-21 commit 038f0db CRIOU este — antes não existia)
- Dota2 / Valorant: n=15/10 insufficient (memory pending sample)

**Calib stale bridge (calib_staleness):** bot.js:28798 ✓ implementado. Lê fittedAt de 3 calib files (tennis/lol/cs), se age > 7d → marca em `_driftTriggeredCalibRefit` Map → consumed por `drift_triggered_refit` cron. Closed-loop OK.

**Drift → refit bridge:** bot.js:28726 (`shadow_vs_real_drift`) → 28767 (`drift_triggered_refit`). Cooldown 6h evita thrashing. P2-safe (refit é causa fix, não disable). ✓

### 8. Leak guard cron (P2-compliant)

| Cron | Interval | Real-only? |
|---|---|---|
| `mt_leak_guard` (28209) | 1h | `MT_LEAK_REAL_ONLY=true` default |
| `mt_roi_guard_sided` (28212) | 1h | `MT_ROI_GUARD_REAL_ONLY=true` |
| `mt_bucket_guard` (27505) | 12h | `MT_BUCKET_GUARD_REAL_ONLY=true` |

✓ Memory documenta 9/9 violators corrigidos (waves 1+2+3).

**Concern:** `_loadMarketTipsRuntimeState` (28208 BARE) é o consumer in-memory. Sem heartbeat, se DB lock impedir reload por 30 min, dispatcher usa mt_disable list **outdated** — pode dispatchar tip que admin acabou de bloquear via /admin/mt-disable.

### 9. Auto-promote cron

| Cron | Interval | Source |
|---|---|---|
| `mt_auto_promote` (27578) | 12h | shadow + real (memory: PROMOTE shadow=ok/eval, REVERT/LEAGUE=real/sintoma) |
| `ml_auto_promote` (27593) | 12h | shadow + real |
| `mt_promote_explain` (27615) | 1d | summary digest |

✓ Memory `MT_AUTO_PROMOTE_REAL_ONLY=true` opt-out for REVERT path.

### 10. Healer cron

`auto_healer` (25899) — `_setIntervalJittered` with 60s jitter + 4min boot. Default 5 min interval (`AUTO_HEALER_INTERVAL_MIN=5`). Memory documenta cooldown 30 min (commit a1eef8a) anti-thrashing. ✓

### 11. Sport silent watchdog

`sofa_watchdog` (1130) — 1h interval, throttle 6h DM. Probe `/admin/sofascore-proxy-health` ✓  
**Missing pattern:** No equivalent watchdog for `pinnacle_*` (only DM gauge poll 1075). No watchdog for `riot_*`, `steam_*`, `hltv_*`, `pandascore_*` silent failures.

### 12. Gate attribution cron

bot.js:29005 (`runGateAttribution`) — week-cooldown via `_lastGateAttrWeek`. Fires on first hourly tick of new ISO week. ✓ P2-compliant (DM only).

### 13. DM delivery health — MISSING

Memory `audit_pendencies_2026_05_24 #5 DM delivery health cron`. Mig 121 added `tips.dm_dispatched_at` column (commit 88e333c). Grep `dm_dispatched_at` shows column populated em `lib/` and `bot.js:4031`. **No cron consumes the signal**. Pendency confirmed: DM rate-limit / token rotation / chat_id banido fica silencioso.

Recommend: cron 30 min check `SELECT COUNT(*) FROM tips WHERE sent_at < now-1h AND dm_dispatched_at IS NULL AND archived=0` → DM admin if > threshold.

### 14. OLAP query in cron

✓ `isMemCritical()` guard in 17+ crons (search `isMemCritical()` hits: bot.js:25977, 26081, 26137, 26209, 26249, 26291, 26427, 26679, 26860, 27045, 28320, 28477, 28555, 28735). Each defers cycle when Railway 512MB cap nearby.

**Crons faltando isMemCritical guard:**
- `clv_capture` (28043) — 2 min cadence, faz N HTTP requests + UPDATE per tip pending. Em peak mem, pode amplificar OOM.
- `mt_leak_guard`, `mt_roi_guard_sided` — DB-heavy joins, no guard found in initial grep (need verify).
- `_loadMarketTipsRuntimeState` (28208) — small select, ok.

### 15. Cron documentation

Maior parte dos crons tem comment header `// 2026-05-XX: <intent>`. Recente commits adicionaram boot-fire + cross-references. Padrão **bom** comparado aos ~1.039 envs.

---

## Findings priorizados

### P0 (cron quebrado afetando dispatch/$$$)

**P0-1.** `mt_calib_refit` legacy (bot.js:26506) usa `/market-tips-recent?days=90` mas `rotation_policy` archiva `market_tips_shadow >90d`. **Borda exata** → calib pode treinar com dataset quase vazio dependendo do timing. Memory COMMON_PITFALLS #14 docs fix prévio mas legacy path mantido.  
**Cross-sport:** Tennis (já refit via tennis_calib_refit endpoint). Esports já refit via esports_calib_refit endpoint. **Legacy `mt_calib_refit` é tech debt — pode ser deletado** (P4 cleanup candidate).  
**Action:** Deprecate `mt_calib_refit` legacy OR mudar `days=90` para `days=45` (espelhar esports defaults).

**P0-2.** DM delivery health cron NÃO EXISTE. Memory pendency #5 confirmed. Telegram token rotation / chat banido / rate-limit cause silent DM drops. Mig 121 column populated mas cron ausente.  
**Action:** Adicionar cron 30 min check `tips.dm_dispatched_at IS NULL AND sent_at < now-1h` → DM admin se > 5 tips silenciosas em última hora.

**P0-3.** `_loadMarketTipsRuntimeState` (28208) BARE sem heartbeat. Se DB lock 5 min, in-memory mt_disable lag → dispatcher emite tip que admin BLOQUEOU manualmente (e.g. via /admin/mt-disable em emergency). Silent — admin não vê warning.  
**Action:** Wrap em `_wrapCron('mt_disable_refresh', _loadMarketTipsRuntimeState)`.

### P1 (degradation operacional)

**P1-1.** 4 crons BARE críticos com `.catch(() => {})` engolindo errors (bot.js:27134/27204/27289/27339). DB backup falhar em silêncio = perda de safety. Daily leaks digest falhar em silêncio = admin pensa "sem leaks" quando na verdade cron deu throw.  
**Action:** Replace `.catch(() => {})` por `.catch(e => log('ERROR', 'CRON', e.message))` mínimo. Wrap em `_wrapCron` for heartbeat.

**P1-2.** `weekly_digest` (27289) vs `weekly_pipeline_digest` (28237) — dois crons separados rodando semanal, ambos DM admin. Verificar se são complementares (data source diferente) ou redundantes (P3 violation).

**P1-3.** Duplicate setTimeout boot-fire em 4 crons recentes:
```js
setTimeout(_wrapCron('tennis_calib_refit', fn), 8 * 60 * 1000);
setTimeout(() => fn().catch(() => {}), 95 * 60 * 1000);  // ← bypass wrapping
```
Bot.js:28379-28380, 28412-28414, 28533-28534, 28635-28636. Second setTimeout não usa `_wrapCron` → bypassa overlap-skip, sem heartbeat, sem mem tracking. Se primeira ainda rodando aos 95 min (mem-defer scenario), dispara concorrente sem proteção.  
**Action:** Remove duplicate OR wrap. Provavelmente safety-net que ficou — choose um.

**P1-4.** `mt_calib_validation` (bot.js:26594) SEM boot-fire setTimeout. Fix ef5b76e ignorou esse cron. setInterval=30 min only.  
**Action:** Adicionar `setTimeout(_wrapCron('mt_calib_validation', fn), 6 * 60 * 1000)`.

**P1-5.** No watchdog cron for `pinnacle_*`/`riot_*`/`steam_*`/`hltv_*`/`pandascore_*` silent failures. Só `sofa_watchdog` cobre Sofascore. Memory documenta `pinnacle_key_expired_dm` (bot.js:1075) mas é BARE setInterval sem heartbeat.  
**Action:** Wrap pinnacle_key_dm em `_wrapCron`. Considerar generic source_silent_watchdog per source.

**P1-6.** `reconciliation` (26238) vs `mr_reconcile` (29136) — mesma cadência, nomes confusos, intents diferentes. P3 risk. Rename `reconciliation` → `bankroll_reconciliation` pra explicit.

**P1-7.** `subscribers_refresh` 5 min (bot.js:25594) usa `markPollHeartbeat` (via `loadSubscribedUsers`) mas **não aparece em /admin/cron-status** (que lista markCronHeartbeat). Tag renamed [BOOT]→[SUBS] em 7affe04 (memory) mas ainda invisible no dashboard.  
**Action:** Add `markCronHeartbeat('subscribers_refresh', { result: 'ok' })` no fim de loadSubscribedUsers, OR wrap em `_wrapCron`.

**P1-8.** `analytics_watchdog` (28072) BARE — `setInterval(runAnalyticsWatchdog, WATCHDOG_INTERVAL_MS)` sem `_wrapCron`. Default 6h. Sem heartbeat, sem overlap-skip. Se falhar 6h sequencial, ninguém saberá.

### P2 (cleanup)

**P2-1.** `mt_calib_refit` legacy (26506) tech debt — esports + tennis crons cobrem 100% sports. Deletable.

**P2-2.** `auto_shadow` (25831) cron rodando 6 h interval mas opt-in OFF (`AUTO_SHADOW_NEGATIVE_CLV`). Cycle só early-return. Aceitável (cheap) mas surface area.

**P2-3.** `live_storm` (27638) BARE — wrap em `_wrapCron` pra heartbeat.

**P2-4.** Endpoint `/admin/cron-status` (server.js:15013) `_expectedMs` map duplicates info que está nos `setInterval` literals em bot.js. Cada vez que cron interval muda, dev precisa atualizar 2 lugares. Refactor candidate: bot.js exposes `getRegisteredCronIntervals()` via metric bridge, server.js consome.

**P2-5.** CLAUDE.md alert "84 crons" overestimates. Real: 66 nomes únicos. Update CLAUDE.md.

**P2-6.** Memory CRON_STATE_FILE persistence (lib/utils.js:118) salva cron heartbeats pra survive restart. Bom. Mas frequência de dump 60s (bot.js:675) — overhead minor mas se ~20 crons rodam por minuto, escreve duplicado. Aceitável.

---

## Cross-sport check

**P5:** Crons cross-sport iteram `for (sport of [...])` — `live_risk_monitor` (25936), `esports_calib_refit` (28575), `mt_auto_promote`, `ml_auto_promote`. Sem isolamento per-sport, throw em sport X aborta ciclo todos. Pattern atual: try/catch per-sport iteration. ✓ verificado em `esports_calib_refit`.

---

## Observações finais

**Positivos:**
- `_wrapCron` helper sólido (overlap-skip, heartbeat, mem tracking).
- `isMemCritical()` guard em maioria das crons OLAP-heavy.
- Boot-fire pattern padronizado (ef5b76e fix).
- Closed-loop drift→refit→staleness bridge implementado (P2-safe).
- CRON_STATE_FILE persistence sobrevive restart.

**Negativos:**
- DM delivery health gap (pendency #5).
- 6 crons BARE críticos sem heartbeat (mt_disable refresh, db_backup, leaks_digest, weekly_digest, scraper_smoke, live_storm, pinnacle_key_dm).
- Legacy `mt_calib_refit` tech debt + retention borda.
- Duplicate setTimeout boot-fires (95-110 min safety-net unwrapped).
- `mt_calib_validation` missing boot-fire.

**Cross-cron action items pra próxima sessão:**
1. Adicionar DM delivery health cron (P0).
2. Wrap `_loadMarketTipsRuntimeState` em `_wrapCron` (P0).
3. Deletar OR migrar `mt_calib_refit` legacy (P0).
4. Fix `.catch(() => {})` silent swallowing em 4 BARE crons (P1).
5. Audit `weekly_digest` vs `weekly_pipeline_digest` overlap (P1).
6. Add boot-fire `mt_calib_validation` (P1).
7. Remove duplicate setTimeout safety-net OR wrap (P1).
