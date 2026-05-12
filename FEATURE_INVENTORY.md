# Feature Inventory

**Antes de adicionar feature NOVA, grep esta lista.** Cases reais de overfeaturing (hour-gate redundante com TIME_OF_DAY_AUTO) aconteceram por não verificar.

Live state via `GET /admin/feature-inventory?key=<KEY>` (snapshot atual de envs + crons + disables).

## Gates & filtros (em cascata, pré-emit)

| Feature | Arquivo | Env opt-in default | Função |
|---|---|---|---|
| **Segment gate** | `lib/esports-segment-gate.js` | ON | Skip se Brier histórico > threshold per (sport, tier, bestOf) |
| **Sharp divergence** | `bot.js _sharpDivergenceGate` | ON | Reject se model vs Pinnacle > 12pp (configurable) |
| **Tier-aware EV min/max** | `bot.js` per scanner | ON (defaults hardcoded) | EV min/max per (sport, tier) — LoL tier3 min 10, max 25 |
| **Per-market EV gate** | `bot.js perMarketEvGate` | ON | EV min per (sport, market) via env `<SPORT>_MT_<MARKET>_MIN_EV` |
| **Permanent disable list** | env `MT_PERMANENT_DISABLE_LIST` | OFF (csv) | Block hardcoded de (sport, market, side) |
| **Runtime disable** | `market_tips_runtime_state` table | ON | Auto-disable via 4 sources (clv/roi/early_roi/streak) + manual |
| **Bucket gate** | `lib/odds-bucket-gate.js` | ON | Skip se bucket de odd está flagged |
| **League trust** | `lib/league-trust.js` | ON (`LEAGUE_TRUST_DISABLED=true` opt-out) | Mult Kelly por (sport, league) historical ROI |
| **CLV→Kelly feedback** | `bot.js fetchClvMultiplier` | ON (`CLV_AUTO_KELLY=true`) | Mult Kelly por (sport, league) CLV 30d |
| **Pre-match bonus** | `lib/pre-match-gate.js` | ON | EV +2pp obrigatório pre-game vs live |
| **Daily tip limit** | `_getDailyTipLimit` | OFF (per-sport env) | Cap diário tips per sport |
| **MT min odd** | `MT_MIN_ODD=1.40` | ON | Floor de odd (var assimetria desfavorável <1.40) |
| **EV ceiling trained-aware** | `evCeilingFor` | ON | Sanity cap overshoot (40% default) |
| **Time-of-day auto** | `server.js TIME_OF_DAY_AUTO` | ON (`true`) | Block hora UTC com ROI ≤-25% n≥8 per (sport, hour, market). **Não criar hour-gate paralelo** |

## Multipliers Kelly (em produto)

| Layer | Arquivo | Default | Range |
|---|---|---|---|
| 1. Base fraction per conf | `getKellyFraction` `_KELLY_DEFAULTS` | ALTA 0.10 / MEDIA 0.066 / BAIXA 0.04 | hardcoded |
| 2. Sport mult (lift-based) | `_KELLY_SPORT_MULT` | varia per sport | [0.20, 1.50] |
| 3. Auto-tune mult | `lib/kelly-auto-tune.js` daily | 1.00 (neutral) | [0.20, 1.50] |
| 4. Tier mult | `_getTierKellyMultiplier` | tier1=1.20-1.30 / tier3=0.30-0.70 | configurable env |
| 5. CLV mult | `fetchClvMultiplier` cache 5min | 1.00 (neutral) | [0, 1.5] |
| 6. League trust mult | `getLeagueTrust` cache 30min | 1.00 (neutral) | [0.15, 1.20] |

Effective stake = baseline × 6 multipliers. **Não adicionar 7º sem evidência forte.**

## Auto-disable sources

| Source | Trigger | Restore |
|---|---|---|
| `auto_clv_leak` | CLV < -2% n ≥ 30 (10 league / 20 tier / 15 side) | CLV ≥ 0% |
| `auto_roi_leak` | ROI < -15% sided | (manual) |
| `auto_early_roi_leak` | n=4 ROI≤-70% / n=6 ROI≤-50% / n=8 ROI≤-35% | ROI ≥ 0% AND n ≥ max(8, original+4) |
| `auto_loss_streak` | 4L consecutivas (14d window) | 3 W consecutivas pós-cooldown 24h |
| `auto_validation` | `/admin/mt-calib-validation` falha | (manual) |
| `auto_bucket` | bucket de odd com leak | (auto via cron) |
| `manual` | `/admin/mt-disable` | `/admin/mt-restore` |

## Crons (84 total em bot.js — top significativos)

| Cron | Freq | Função | Opt-out |
|---|---|---|---|
| `mt_leak_guard` | 1h | CLV/ROI/early/streak guards | `MT_LEAK_GUARD_AUTO=false` |
| `mt_auto_promote` | 12h | Promote shadow → real | `MT_AUTO_PROMOTE_AUTO=false` |
| `ml_auto_promote` | 12h | Idem ML | `ML_AUTO_PROMOTE_AUTO=false` |
| `kelly_auto_tune` | daily | Tune Kelly mult per sport | `KELLY_AUTO_TUNE=false` |
| `nightly_retrain` | daily 3 UTC | Refit isotonic + Markov | `NIGHTLY_RETRAIN_AUTO=false` |
| `live_risk_monitor` | 10min | Block live tips se DD > threshold | `LIVE_RISK_MONITOR_AUTO=false` |
| `risk_metrics_monitor` | 12h | DM admin Sharpe/DD/Conc | `RISK_METRICS_MONITOR_AUTO=false` |
| `overfeaturing_audit` | weekly (Mon 14 UTC) | DM admin features dormentes | `OVERFEATURING_MONITOR_AUTO=false` |
| `scraper_health` | 30min | Alerta casas BR down | `SCRAPER_HEALTH_DISABLED=true` |
| `shadow_vs_real_drift` | 24h | Detect drift entre shadow/real | `SHADOW_VS_REAL_DRIFT_AUTO=false` |
| `gate_attribution` | weekly | Counterfactual saved/lost per gate | `GATE_ATTRIBUTION_AUTO=false` |
| `tennis_sources` | 6h | Refresh ESPN/Sackmann/Sofascore | (always) |
| `clv_capture` | 5min | Captura CLV pre-match | (always) |
| `settle_completed` | 10min | Resolve tips win/loss | (always) |
| `force_settle` | 1h | Force-settle stale matches | `FORCE_SETTLE_AUTO=false` |
| `auto_void_stuck` | 6h | Void tips zumbi >14d | `AUTO_VOID_STUCK_AUTO=false` |

## Detectores P2-compliant (research-only, DM admin)

| Detector | Cron | Fonte | Auto-action? |
|---|---|---|---|
| `lib/shadow-vs-real-drift.js` | 24h | Cross-check shadow vs real ROI | ❌ (só DM) |
| `lib/gate-attribution.js` | weekly | Counterfactual saved_loss vs lost_profit | ❌ (só DM) |
| `lib/overfeaturing-monitor.js` | weekly | Dead opt-in envs / dormant disables / low crons | ❌ (só DM) |
| `risk_metrics_monitor` | 12h | Sharpe / DD / concentração | ❌ (só DM) |

## Endpoints admin (50+, top mais usados)

| Endpoint | Função |
|---|---|
| `/health` | Status geral, alertas, pending tips |
| `/admin/p2-status` | Compliance P2 + commit deployed |
| `/admin/risk-metrics?days=30` | Sharpe/DD/concentração per sport |
| `/admin/sport-correlation?days=30` | Pearson matrix daily PnL |
| `/admin/sport-detail?sport=X` | ROI real/shadow + top markets |
| `/admin/mt-disable-list` | Disables ativos com source |
| `/admin/mt-promote-explain?...` | Why tip não promove |
| `/admin/holdout-status` | Frozen holdout per sistema |
| `/admin/overfeaturing-audit?days=30` | Dormant features + dead envs |
| `/admin/time-of-day-analysis?days=60` | ROI per hour BRT |
| `/admin/mt-refit-calib?sport=X` | Walk-forward refit calib |
| `/admin/mt-shadow-by-ev?sport=X` | Shadow ROI per EV bucket |
| `/admin/mt-shadow-by-league?sport=X` | Shadow ROI per liga |
| `/admin/scraper-health` | Status casas BR aggregator |
| `/admin/tip-archive?id=X` | Archive tip manualmente |

## Auto-tunes (com FROZEN_HOLDOUT 60d default)

| Sistema | Lê | Decide |
|---|---|---|
| `kelly_auto_tune` | `tips` (is_shadow=0) 30d | mult Kelly per (sport, market) |
| `mt_auto_promote` | `tips` (real) | PROMOTE shadow→real / REVERT real-only |
| `ml_auto_promote` | `tips` (real) | PROMOTE ML / REVERT |
| `ev_calibration` | `tips` (real) | mult EV per (sport, bucket) |
| `learned_corrections` | `tips` (real) | Ajustes específicos |
| `readiness_learner` | shadow snapshot + verify (real) | Marcar (sport, market) ready (opt-in OFF) |
| `gates_autotune` | `tips` (real) | Ajustes threshold gates |
| `mt_leak_guard` | shadow + real JOIN | Disable segments |
| `mt_bucket_guard` | shadow + real | Bucket-level disable |
| `mt_validation` | `tips` (real) | Validation auto-disable |
| `league_guard` | `tips` (real) | League-level decisions |

## Análises não-numéricas

| Feature | Arquivo | Pipeline | Default |
|---|---|---|---|
| **DeepSeek API** | `bot.js callAI` | Scoreboard JSON → opinião structured | ON (`AI_DISABLED=false`) |
| **Claude API fallback** | `bot.js callClaude` | Fallback se DeepSeek down | ON |
| **News monitor** | `lib/agents-extended.runNewsMonitor` | RSS scrape per sport (cron 15min) → classify critical/warning → match tip → DM admin + populate cache | ON |
| **News-impact gate** | `lib/news-impact.js` + `/record-tip` | Cache in-memory team_norm→severity; critical→skip emit / warning→flag forensics | ON (`NEWS_IMPACT_GATE_DISABLED=true` opt-out) |
| **Tip-reason** | `lib/tip-reason.js` | Gera texto justificativa pra DM user | ON |
| **MT-promote-explain** | `lib/mt-promote-explain.js` | Explica decisão promote/revert pra DM admin | ON |

## DORMANT (não usar — marker pra cron overfeaturing-audit)

| Feature | Arquivo | Status | Razão |
|---|---|---|---|
| **Polymarket consensus** | `lib/polymarket-watcher.js` | stub return null | Cobertura esports/tennis fraca, ROI duvidoso vs custo dev ~5-7d. Decisão 2026-05-12 audit "corrija gaps". Revisitar 30d se API estruturada surgir. |
| **Social sentiment (Twitter/Reddit)** | (não existe) | not-implemented | Out-of-scope: infraestrutura grande (API keys, scraping rate-limits, NLP pipeline). Signal-to-noise ratio em esports/tennis curtos não justifica vs alternativas (news monitor já cobre lineup/injury). |
| **Computer vision scoreboard** | (não existe) | not-implemented | Out-of-scope: requires CV pipeline + video ingestion. Scoreboards textuais já cobertos por Sofascore/ESPN/VLR/HLTV. Não é gap real, é overkill. |
