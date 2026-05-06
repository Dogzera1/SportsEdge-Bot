# WORKFLOW SPORTSEDGE BOT

Documentação do fluxo end-to-end interno: do momento que uma partida aparece nas APIs até a tip cair no Telegram do usuário, settlement, CLV capture, calibração contínua, e como o sistema se monitora/cura/reporta sozinho.

**Última atualização:** 2026-05-06
**Estado:** Maio/2026 — pós audit-leaks 2026-05-04, recovery ROI ondas A/B/C, ML auto-route shadow

---

## 0. Arquitetura geral

```
┌───────────────────────────────────────────────────────────────────┐
│                       RAILWAY (1 deploy)                          │
│                                                                   │
│   start.js (launcher)                                             │
│      • Spawn server.js + bot.js, auto-restart backoff exponencial │
│        (3s → 6s → 12s → 24s → 60s)                                │
│      • Port retry on EADDRINUSE                                   │
│      • Captura stdout/stderr → POST /logs/ingest (batched 500ms)  │
│      • Persiste exit signature em last_child_exit_*.json          │
│        (mesmo em SIGKILL/OOM o launcher captura)                  │
│      • SIGTERM/SIGINT propagado (graceful shutdown)               │
│      │                                                            │
│      ├──► server.js (HTTP API + dashboards, port $PORT)           │
│      │      • ~28k linhas                                         │
│      │      • SQLite WAL via volume Railway (/data/sportsedge.db) │
│      │      • Endpoints discovery (/lol-matches /odds ...)        │
│      │      • Endpoints admin (/admin/*) cookie-session ou key    │
│      │      • Endpoints calibration (/admin/mt-refit-calib ...)   │
│      │      • Agentes (/agents/*)                                 │
│      │      • SSE /logs/stream                                    │
│      │      • DeepSeek proxy /claude (rate-limit + retry)         │
│      │      • Healthcheck cached 10s                              │
│      │      • Migrations on boot (91 migrations idempotentes)     │
│      │                                                            │
│      └──► bot.js (Telegram + análise + crons)                     │
│             • ~24k linhas                                         │
│             • Polls de cada sport (cron adaptativo per sport)     │
│             • runAutoAnalysis (LoL/Dota), pollSport (CS/Val/...)  │
│             • IA (DeepSeek) via /claude                           │
│             • 33+ crons defensivos (auto-healer, guardian, ...)   │
│             • 6 Telegram bots (1 token por sport bucket)          │
└───────────────────────────────────────────────────────────────────┘
```

### Por que dois processos

- **Isolamento de falhas:** crash bot.js (Telegram polling, scrapers HTML) não derruba HTTP API.
- **Restart independente:** isotonic refresh ou OOM em scrapers reinicia só bot.js.
- **DB compartilhada via WAL:** leituras paralelas, writes serializados.

### Comunicação entre processos

- **bot.js → server.js:** HTTP localhost (`http://localhost:$PORT/...`). Padrão para `/odds`, `/record-tip`, `/claude`, `/agents/*` e self-call em `/admin/*` (ex.: cron tennis_calib_refit).
- **server.js → bot.js:** indireta — bot polla DB pra detectar mudanças (ex: tips voided manualmente, runtime state changes).
- **start.js → server.js:** POST `/logs/ingest` batched.

---

## 1. Pipeline de tip (do mercado → DM)

Cada sport segue o ciclo conceitual; variações em quem polla, quais APIs, e quais gates específicos.

### 1.1 Descoberta de partida

```
[Bot loop por sport — cron adaptativo 6-30min]
    │
    │  Cadência adaptativa baseada em totalLive (sport):
    │    LoL/Dota/CS:  6→24min upcoming, 60s live
    │    Valorant:     20min default, 90s live
    │    Tennis:       10min, sticky post-live 20min
    │    Football:     10min
    │    MMA:          15min
    │    Darts/Snk:    30min
    │    TT:           15min
    ▼
serverGet('/<sport>-matches')
    │
    ▼
[Server agrega APIs paralelas — Promise.allSettled]
    │
    ├── Pinnacle Guest (LoL, Dota, CS, Val, Tennis, Snk, TT, MMA, NBA)
    │   getMatchupHandicaps + getMatchupMoneylineByPeriod (per-map LoL/Dota)
    ├── SX.Bet (LoL/Dota live per-map nativo)
    ├── PandaScore (LoL/Dota live status, compositions)
    ├── Sofascore proxy (Darts, Tennis live, Football, TT)
    ├── The Odds API (MMA, Tennis, Football, NBA — free 500/mo + paid)
    ├── Riot LoL Esports API (LoL live livestats, gameids)
    ├── OpenDota + Steam Realtime API (Dota live, ~15s vs 3min)
    ├── VLR.gg HTML (Valorant — regex re-escrito 2026-04 com lookahead)
    ├── HLTV scoreboard (CS live)
    ├── ESPN (Football, NBA, MMA, Tennis fallback)
    ├── API-Football (Soccer fixtures, H2H, standings)
    ├── football-data.co.uk CSV (xG/SoT/cards/corners — fd_features)
    ├── gol.gg (LoL kills/objectives scraping)
    ├── OracleElixir S3 (LoL feature mining 26k+ rows)
    ├── Stratz GraphQL (Dota draft matchups — needs token)
    ├── Sherdog/ufcstats (MMA records)
    └── Supabase BR aggregator (vw_jogos_publicos: Bet365/Betano/Sportingbet)
    │
    ▼
[Merge / dedup / normalize per sport]
    │  Pinnacle = primary quando disponível; outras como _alternative
    │  ON CONFLICT escapa por slug (ESPN ATP+WTA dup)
    │  Pinnacle live TTL: 45s (Dota), 3min (default)
    │  Sport-specific routing (ML→ML, OVER/UNDER→shadow, etc.)
    ▼
[{ id, team1, team2, league, status, time, odds: {primary, _allOdds, _alternative}, ... }]
    │
    ▼
[Bot filtra: live + upcoming <6h + relevant league + not in cooldown]
```

### 1.2 Pré-filtro ML (antes de IA — economiza tokens)

```js
// lib/ml.js → esportsPreFilter (genérico esports)
// lib/<sport>-ml.js → wrapper específico

const { modelP1, modelP2, edge, factorCount, direction, score } = preFilter(match, ctx);
if (factorCount === 0 || Math.abs(edge) < 3) return; // skip — sem fatores ou edge negligível
```

**Modelos invocados por sport:**

| Sport | Modelo principal | Componentes |
|---|---|---|
| LoL | `lib/lol-model.js` | series-model + map-model + regional-strength + OE features |
| Dota | `lib/dota-map-model.js` | hero-features + roster-detect + momentum |
| CS | `lib/cs-ml.js` + `cs-map-model.js` | Elo + HLTV form + per-map CT advantage |
| Valorant | `lib/valorant-ml.js` | Elo + Bayesian map→série + isotonic |
| Tennis | `lib/tennis-model.js` + `tennis-model-trained.js` + `tennis-markov-model.js` | Sackmann Elo + trained logistic + Markov + features-v2 |
| Football | `lib/football-ml.js` + `football-poisson-trained.js` + `football-data-features.js` | Poisson + DC + xG/SoT + home boost + fd_features |
| MMA | `lib/mma-ml.js` (in bot.js) | record + ufcstats |
| Darts | `lib/darts-ml.js` | 3DA + WR sample-weighted |
| Snooker | `lib/snooker-ml.js` | ranking-log + WR |
| TT | `lib/tabletennis-ml.js` | Elo + form |
| Basket NBA | `lib/basket-trained.js` + `basket-elo.js` + `basket-mt-scanner.js` | logistic+isotonic blend Elo (w=0.65) |

### 1.3 Enrichment de contexto (paralelo)

```
- collectGameContext (live stats: gold, kills, dragons, towers, baron, comp, score, momentum)
- fetchEnrichment (forma, H2H, ESPN records, Sofascore stats)
- fetchMatchNews (Google News RSS, 48h — opt-out via NEWS_MONITOR_DISABLED)
- Patch meta (LoL ddragon, 14d cache)
- Tournament tier (lib/league-tier.js, mt-tier-classifier.js)
- League trust (lib/league-trust.js)
- Player-level features (oracleselixir-player-features, tennis-player-stats)
- Roster sub detection (lol-roster-sub, dota-roster-detect — downweight ×0.85/0.70/0.55)
- Tennis Markov (Barnett-Clarke + sets + tiebreak + totals)
- Tennis fatigue decay (até -70 pts Elo)
- Tennis injury risk (RET/W/O/bagels — downgrade conf + shrink P)
- Tennis tiebreak rolling (TB W/L per jogador 12m)
- Tennis momentum (streak+wr_last10+elo_sq)
- Dota draft matchup (lib/stratz-dota-scraper)
- Dota side detection (team1IsRadiant via /opendota-live → ±1.5pp shift)
- CS HLTV form + Elo + per-map CT advantage (Anubis 5%, Dust2 1%)
- Football fd_features (xG/SoT/cards/corners CSV-driven)
- Esports correlation (lib/esports-correlation.js)
```

### 1.4 Cálculo de P final + odds

```
P pipeline:
1. preFilter → modelP_raw
2. Calibração isotonic (lib/<sport>-isotonic.json) → modelP_calib
   Status:
     LoL:      DISABLED (refit Brier piorou 2026-04-24)
     Dota2:    ATIVO (ECE -35%)
     CS2:      ATIVO (ECE -70%)
     Valorant: ATIVO
     Tennis:   DISABLED (overshoot bucket 2.20-3.00, ROI -64%)
3. Calibração Markov (tennis only, lib/tennis-markov-calib.js)
   PAV + Beta smoothing per market (handicapGames, totalGames)
   Refit nightly cron 04h via /admin/mt-refit-calib
   Cache TTL 30min sem restart
4. Markov shrink universal pós-calib (tennis)
   pShrink = 0.5 + k * (pCalib - 0.5)
   k_handicap=0.75, k_total=0.65 (audit 2026-05-04)
5. CLV calibration layer (lib/clv-calibration.js)
   Puxa em direção closing line; default blend 0.30
   Wired em LoL/Tennis/Dota2/CS2 trained
6. Learned corrections (lib/learned-corrections.js, mig 090)
   Per (sport, regime, tier, market) corrections
7. Readiness corrections (lib/readiness-learner.js, mig 089)

Odds pipeline:
1. Pinnacle = sharp anchor primary
2. Devig (lib/devig.js — power method)
3. impliedP_dejuiced = (1-vig) / odd
4. Edge = modelP_final - impliedP_dejuiced
5. EV = modelP_final × odd - 1
```

### 1.5 IA (DeepSeek) — segunda opinião opcional

```
Bot envia contextBlock (Elo, form, H2H, live stats, news) + P_modelo
    │
    ▼
POST /claude (server.js proxy)
    │  Rate-limit + retry exponencial
    │  Per-sport tracking → table api_usage
    │  AI_DISABLED=true desativa cross-sport
    ▼
DeepSeek retorna { pick, P_ia, conf, reason }
    │
    ▼
_validateTipPvsModel(P_ia, P_modelo, tolPp=8)
    Se |P_ia - P_modelo| > 8pp → REJEITA (IA alucinou)
    │
    ▼
IA NÃO decide P; só sugere
```

**Observação:** MMA/Darts/Snooker disabled default (2026-05-04) — IA não roda nesses sports.

### 1.6 Gates pós-IA (camadas de proteção)

Em ordem de aplicação:

```
1.  Dedup match+market+side+line+book (TTL 48h)
2.  Cross-bucket dedup esports↔lol/dota2 (mig 042 fuzzy)
3.  Sharp divergence gate (|modelP - impliedP_pinnacle| > cap_sport)
        LoL/Dota:    15pp
        CS:          12pp
        Tennis:      20pp (relaxado de 15 em 2026-04-18)
        Valorant:    12pp
        Football:    10pp
        MMA:         10pp
        Darts/Snk:   15pp
        TT:          20pp
4.  Bucket gate (ODDS_BUCKET_BLOCK + per-sport overrides)
        LoL: 3.00-99
        Valorant: 2.20-99
5.  EV gate (EV >= <SPORT>_MIN_EV + PRE_MATCH_EV_BONUS)
        CS pre +5, LoL/Val pre +4
6.  EV cap per-sport (TIP_EV_MAX_PER_SPORT)
        LoL/CS/Dota/Football MT: 20
        Tennis MT: 25
        Default: 25-35
7.  Brier auto-cap (BRIER_AUTO_EV_CAP=true)
        Reduz EV ceiling quando Brier degrada
8.  HIGH_EV_THROTTLE (default ON, mult 0.6 em buckets EV>12%)
9.  Conf gate (BAIXA bloqueada em vários sports)
10. Tier-aware caps
        CS tier 2+: EV >=8%, conf MÉDIA, stake 1u
        MMA non-sharp book: EV >=12%, conf rebaixada, stake 1u
        Tennis Q1/R1/R2 (early): stake ×0.5
        Football tier1_la_liga totals: stake ×0.7
11. MT leak guard (auto-disable (sport,market,league,tier) com CLV leak)
12. Match stop-loss (MATCH_STOP_LOSS_UNITS=2 — máx perda por match)
13. DAILY_TIP_LIMIT per sport (default 8)
14. maxPerMatch (LoL/Dota 2, CS 3, Tennis 3, Val 2)
15. MAX_TIPS_PER_TOURNAMENT_PER_DAY=8
16. CLV pre-dispatch gate (odd subiu >2.5% em 10min = stale; CLV_PREDISPATCH_GATE=true)
17. Stale line gate (Pinnacle moveu mas casa não — possível stale)
18. Min/max odds (TENNIS_MIN_ODDS=1.40, TENNIS_MAX_ODDS=5.00)
19. League blocklist (manual + auto via league-bleed cron 6h)
20. Path-guard (rejeita pipeline path com regressão Brier sustentada)
21. Odds bucket guard (auto-block sport+bucket com ROI<-10% n>=30; cron 12h)
22. ML disabled gate (LOL_ML_DISABLED, CS_ML_DISABLED, TENNIS_ML_DISABLED)
        Default 2026-05-05: auto-route shadow ao invés de hard reject
        ML_DISABLED_HARD_REJECT=true → opt-in hard reject
23. AI validation (IA reverter divergência grande)
```

### 1.7 Risk / staking (Kelly fracionado)

```js
// lib/risk-manager.js::computeKellyStake(P, odd, opts)
f_kelly = (P*(odd-1) - (1-P)) / (odd-1)
mult    = KELLY_MULT_<SPORT>_<CONF> || KELLY_<CONF> || default
stake   = f_kelly * mult
        × pre_match_multiplier
        × stake_context_mult (lib/stake-adjuster.js)
            ultra_low ×0.70 / low ×0.90 / high ×1.05  (cs/dota)
clamp(MIN_STAKE, MAX_STAKE_UNITS)
```

**Defaults conservadores:**
- ALTA: 0.40 / MÉDIA: 0.25 / BAIXA: 0.10
- Dota2 cut: 0.20 (CLV -45% leak 2026-04-23)

**Auto-tune diário** `runKellyAutoTune` (cron 8h local):
- Rolling 30d ROI+CLV per sport
- Step up +0.05 / down -0.10
- Bounds [0.20, 1.20]
- Persiste em `gates_runtime_state` table
- DM admin com sports que mudaram

### 1.8 Persistência + DM

```
POST /record-tip
    │  Validações: tipParticipant não vazio, tipOdd>1, tipP entre 0.01-0.99
    │  Skipped reason logado se rejeitado
    ▼
INSERT tips (...
    sport, match_id, market_type, line, side, p_model, odd,
    stake_units, stake_reais, ev_pct,
    clv_pct (será updated pós-kickoff),
    is_live, is_shadow, regime_tag, code_sha, gate_state,
    tip_context_json (mig 072 — full snapshot p/ rastreabilidade),
    tip_user_action (mig 076)
)
    ▼
[Build msg Telegram]
    🎯 Aposta: <pick> ML @ <odd>
    🏦 Casa: Pinnacle (alt SX.Bet: ...)
    📈 EV: +X.X%
    💵 Stake: Xu (⅙ Kelly)
    🟢 Confiança: <CONF> | ML: X.Xpp
    📋 <league>
    🔴 LIVE (mig 054 is_live label)
    [Apostar] inline button (lib/book-deeplink.js)
    ▼
sendDM(token, userId, msg)
    403 → unsubscribe automático (TG403 → mig auto-unsub)
    ▼
markAdminDmSent (mig 062 — dedup 24h por (match,market,line,side))
    ▼
[Per-sport metrics: tip_count++, ev_avg, log [INFO] [AUTO]]
```

### 1.9 Settlement automático

```
[Cron 30min — settleCompletedTips per sport]
    │
    ▼
[Pre-sync match_results das APIs]
    │  Sofascore, ESPN, Pinnacle, gol.gg, HLTV, OpenDota, ufcstats
    │  Sport-specific syncs (sync-pandascore-history, sync-tennis-stats, ...)
    │  TX batch (commit em chunks pra reduzir lock contention)
    ▼
[Iterar pending tips em janela]
    │  Esports: -24h/+7d (esports MT shadow name matching)
    │  Tennis: stricter (pickBest com league overlap)
    │  Football: pre-sync com sofascore antes
    ▼
[Match lookup fuzzy via lib/name-match.js]
    │  Strategies: strict → fuzzy → lastname
    │  Threshold score >= 0.5
    │  Aliases (BIG vs IG, T1 vs T10 false-positive resolved)
    │  Tennis: tiebreak via league overlap
    │  pickBestTennisSettleRow (mig 028 archived_flag aware)
    ▼
[settleTip(id, result)]
    │  result = win/loss/push/void
    │  profit_reais = stake × (odd-1) se win, -stake se loss, 0 se push/void
    │  bankroll[sport].current_amount += profit_reais
    │  Settlement audit row em tip_settlement_audit (mig 073)
    ▼
[Result propagator (lib/mt-result-propagator.js)]
    │  tips ↔ market_tips_shadow same match → mesmo result
    │  Mig 074 consolidou cs2 bucket paralelo
    ▼
[CLV update]
    │  updateTipCLV (lib/database.js:428)
    │  Fix 2026-05-02: removido WHERE clv_odds IS NULL OR =0 que bloqueava re-captura
    │  Race fix migs 081/082
```

### 1.10 CLV capture pós-kickoff

```
[Cron close-line capture]
    │  Captura odd Pinnacle no momento do kickoff (cap 1.15× tip_odd)
    ▼
// server.js:13779 — raw/raw (vig cancela na razão quando estável)
clv_pct = (tip_odd / close_odd - 1) * 100
    ▼
UPDATE tips SET clv_pct = ?, close_odd = ? WHERE id = ?  (mig 080)
UPDATE market_tips_shadow SET clv_pct = ?  (mig 026)
    ▼
[Throttle DM CLV<-5% pra audit liga]
    [CLV-CAPTURE] log throttle (audit 2026-05-01)
```

---

## 2. Schedulers (loops em bot.js)

### 2.1 Polls de descoberta (emitem tips)

| Loop | Cadência adaptativa | Sport bucket |
|---|---|---|
| `runAutoAnalysis` | 6→24min upcoming, 60s live | LoL+Dota |
| `pollDota` | 6min default, 90s live | Dota |
| `pollCs` | 6min default, 90s live | CS2 |
| `pollValorant` | 20min default, 90s live | Valorant |
| `pollTennis` | 10min, sticky 20min post-live | Tennis |
| `pollMma` | 6h | MMA |
| `pollFootball` | 10min | Football |
| `runAutoDarts` | 30min | Darts |
| `runAutoSnooker` | 30min | Snooker |
| `pollTableTennis` | 15min | TT |
| `pollBasket` | 10min | Basket NBA (shadow) |

**Adaptive polling (`_computeAdaptivePollMs`):**
- Pre-game: 6→24min cap baseado em totalUpcoming+kickoffWindow
- CS/Val: 5→20min
- Sticky post-live: 20min idle base após último live (não cai pra cron longo imediatamente)
- Safety <30min antes de kickoff: força poll mais frequente

### 2.2 Crons de manutenção / automação

**33+ crons defensivos** — heartbeat tracking em `/cron-heartbeats`:

| Cron | Cadência | Função | Default |
|---|---|---|---|
| `auto_shadow` | 6h | Shadow stats summary | ON |
| `auto_healer` | 5min | Detecta + cura anomalias | ON |
| `bankroll_guardian` | 1h | Adaptive DD thresholds per sport | ON |
| `weekly_recalc` | 7d | Recalc weights/baselines | ON |
| `autonomy_digest` | 24h (12h UTC) | DM admin daily digest | `AUTONOMY_DIGEST_AUTO=true` |
| `db_backup` | 24h (4h UTC) | VACUUM INTO snapshot 7d retention | `DB_BACKUP_AUTO=true` |
| `leaks_digest` | 24h (13h UTC) | DM top leaks (n≥20, ROI≤-15%) | `DAILY_LEAKS_DIGEST_AUTO=true` |
| `mt_restore` | 24h (14h UTC) | Sugere remover bloqueados que recuperaram | `MT_RESTORE_AUTO=true` |
| `scraper_smoke` | 24h | Daily scraper health check | ON |
| `weekly_digest` | 7d (Mon 14h UTC) | Weekly summary | `WEEKLY_DIGEST_AUTO=true` |
| `nightly_retrain` | 24h (3h UTC) | refresh-all-isotonics.js | `NIGHTLY_RETRAIN_AUTO=true` |
| `tennis_calib_refit` | 24h (4h local) | /admin/mt-refit-calib?sport=tennis (commit fe16e55) | `TENNIS_CALIB_REFIT_DISABLED=false` |
| `path_guard` | 6h | Pipeline path regression detect | ON |
| `league_bleed` | 6h | Detect liga sangrando | `LEAGUE_BLEED_AUTO=true` |
| `pipeline_digest` | 6h | Pipeline summary | ON |
| `mt_bucket_guard` | 12h | MT scanner odd floor/cap auto-tune | ON |
| `gates_autotune` | 12h | EV bonus + stake cap auto-tune | `GATES_AUTOTUNE_AUTO=true` |
| `league_guard` | 12h | League-level kelly_mult tune | ON |
| `odds_bucket_guard` | 12h | (sport, bucket) auto-block leaks | `ODDS_BUCKET_GUARD_AUTO=true` |
| `mt_auto_promote` | 12h | Promote/revert (sport, market, tier) | ON |
| `model_calibration` | 24h | Calibration drift check | ON |
| `backtest_validator` | 24h | Validate model via gates retroativos | ON |
| `post_fix_monitor` | 24h | Alert se sport sangra pós gate-fix | ON |
| `live_storm` | 10min | Flip into/out-of storm mode | ON |
| `kelly_auto_tune` | 24h (8h local) | Per-sport kelly_mult tune | `KELLY_AUTO_TUNE=true` |
| `roi_drift_cusum` | 24h (9h local) | CUSUM regime change detect | `ROI_CUSUM_DISABLED=false` |
| `mem_watchdog` | continuous | RSS P95×1.3 baseline | `MEM_WATCHDOG_AUTO=true` |
| `polymarket_watcher` | 5min | Cross-validation copy-trading | ON |
| `stale_line_detector` | 5min | Pinnacle moveu vs casa não | `STALE_LINE_DISABLED=false` |
| `super_odd_detector` | 5min | Book>20% acima Pinnacle | ON |
| `arb_detector` | 5min | Arb 2-way esports + 3-way football | ON |
| `velocity_tracker` | 5min | Pinnacle >3%/5min = sharp money | ON |
| `book_bug_finder` | 5min | Anomalias de odds | ON |
| `clv_capture` | per match | Captura close line | ON |

**Loops defensivos default-ON (2026-05-05):**
- `BRIER_AUTO_EV_CAP=true`
- `LIVE_RISK_MONITOR_AUTO=true`
- `AUTO_VOID_STUCK_AUTO=true` (3d, era 14d)
- `AUTONOMY_DIGEST_AUTO=true`
- `MT_LEAK_GUARD_AUTO=true`

---

## 3. Camadas de calibração (em ordem de aplicação)

### 3.1 Isotonic per-sport

`lib/<sport>-isotonic.json` — função monotônica P_raw → P_calib via PAV (Pool Adjacent Violators) + Beta smoothing. Treinado contra outcome real settled.

**Status atual:**
| Sport | Status | Razão |
|---|---|---|
| LoL | DISABLED | Refit Brier 0.25→0.27 piorou (2026-04-24) |
| Dota2 | ATIVO | Brier ECE -35% |
| CS2 | ATIVO | ECE -70% |
| Valorant | ATIVO | Re-ativado pós momentum integration |
| Tennis | DISABLED | Overshoot bucket 2.20-3.00, ROI -64% |
| Football | (Poisson trained substitui) | — |

Refit nightly via `scripts/refresh-all-isotonics.js` (cron `NIGHTLY_RETRAIN_AUTO=true`, 3h UTC).

### 3.2 Markov calib (tennis only)

`lib/tennis-markov-calib.js` + `tennis-markov-calib.json` — PAV + Beta smoothing per market sobre P do Markov pre-jogo.

**Mecanismo:**
- Resolve overconfidence sistemática (P_med 0.78 em handicapGames com hit real <70%)
- Cache TTL 30min (pega nightly retrain sem restart)
- mtime check evita re-parse desnecessário
- Refit nightly cron 04h local (`tennis_calib_refit`, commit `fe16e55`)

**Resultado refit 2026-05-06 (n=537 vs antigo n=115):**
- PRE_raw: ROI -2.2% / Brier 0.253 / ECE 0.165
- POST_calib: ROI **+12.4%** / Brier 0.222 / ECE **0.054** (-67%)

### 3.3 Markov shrink universal

Pós-isotonic, shrink linear em direção 0.5:
```
pShrink = 0.5 + k * (pCalib - 0.5)
```
- `k_handicapGames = 0.75` (audit 2026-05-04: gap -27.3pp em pModel 80%+)
- `k_totalGames = 0.65` (audit: gap -37.2pp em pModel 65-70%)
- Override via `TENNIS_MARKOV_SHRINK_<MARKET>` env
- Kill switch: `TENNIS_MARKOV_SHRINK_DISABLED=true`

### 3.4 EV → ROI calibration

`lib/ev-calibration.js` — data-driven per (sport, ev_bucket). Sobrescreve `HIGH_EV_THROTTLE` quando n≥10. Cron 6h.

**Aprendizados:**
- CS bucket 8-12%: ROI +29.9% (preserva)
- EV>30% sangra catastrófico em 5 sports (gap +40-115pp) — aplica throttle severo
- Endpoint: `/admin/ev-calibration`

### 3.5 CLV calibration layer

`lib/clv-calibration.js` — terceira camada pós-isotonic puxa P em direção da closing line.

- Lit: arxiv 2410.21484
- Default blend `CLV_CALIB_BLEND=0.30`
- Wired em LoL/Tennis/Dota2/CS2 trained
- Opt-out: `CLV_CALIB_DISABLED=true`

### 3.6 Learned corrections + readiness learner

- `lib/learned-corrections.js` (mig 090) — per (sport, regime, tier, market) corrections
- `lib/readiness-learner.js` (mig 089) — observa decisões readiness (block/OK) e aprende corrections incrementais
- Wired em 5 sistemas de correção (commit `1846d03`: granularity per-market)

---

## 4. Market Tips (MT) system

Sistema paralelo em **markets secundários** (handicap, totals, kills, sets, etc.).

### 4.1 Pipeline

```
[Scanner per sport]
    │  lib/<sport>-mt-scanner.js + lib/odds-markets-scanner.js
    │  lib/lol-extra-markets.js, lib/dota-extras-scanner.js
    ▼
[lib/market-tip-processor.js]
    │  Gate EV>=8% + pModel>=55% + Kelly 0.10 + tier classifier
    ▼
[Shadow log primeiro]
    │  lib/market-tips-shadow.js
    │  market_tips_shadow table (migs 024/025/026/054/055/088/091)
    │  is_live + model_version + regime_tag + tier
    ▼
[Backtest periódico]
    │  scripts/backtest-market-tips.js
    │  /admin/mt-shadow-comprehensive-audit
    ▼
[Auto-promote — lib/mt-auto-promote.js]
    │  Critérios: n≥30 + CLV≥0 + ROI≥0 em 14d
    │  loadMtMarketLeagueBlocklist no boot
    │  Cron 12h
    │  mt_auto_promote table (mig 077)
    ▼
[Promote: dispatch real (DM admin → DM users)]
    │  mt_runtime_state side+league+tier (migs 050/051/063/091)
    │  permanent_disable list (MT_PERMANENT_DISABLE_LIST)
    ▼
[Leak guard — auto-disable]
    │  MT_LEAK_GUARD_AUTO=true (default ON)
    │  (sport,market,league,tier) com CLV leak persistente
    │  tier-level granularity (commit 9e99953)
    ▼
[Result propagator — lib/mt-result-propagator.js]
    │  tips ↔ market_tips_shadow same match → mesmo result
    │  Race fix: tips delete antes de propagator (audit P0)
```

### 4.2 Tier classifier

`lib/mt-tier-classifier.js`:

**Tennis:**
- `tier1_slam` (Australian/French/US/Wimbledon)
- `tier2_atp_500` / `tier2_masters`
- `tier3_atp_250` / `tier3_wta125`
- `tier4_challenger`
- `tier_quali_or_early` (Q1/Q2/R1/R2)

**LoL:**
- `tier1_la_liga` (Spain football, mas reused name)
- `tier2_regional` (LCK CL)

**CS2:**
- `tier1_premier`
- `tier2_secondary` (ESL Challenger SA, CCT SA)

**Stake mults aplicados (audit 2026-05-04):**

| Sport | Tier | Mult | Razão |
|---|---|---|---|
| cs2 | tier2_secondary | 1.3× | +63% ROI CLV+14% |
| lol | tier2_regional | 1.2× | +26% ROI |
| tennis | tier4_challenger | 0.6× | -10% (Francavilla -81%, Wuxi -25%) |
| football | tier1_la_liga totals | 0.7× | -18% n=20 hit 20% |
| football | brasileirão B | 1.15× | +42% n=13 |
| tennis | Q1/R1/R2 | 0.5× | high variance + ranking unreliable |

### 4.3 MT promovido (estado atual Maio/2026)

- **Football MT** (2026-05-03) — ROI +40,9%, hit 71%, CLV 0
- **CS2 MT** (2026-05-04) — CLV+12 confirmado
- **Dota2 MT** (2026-05-04) — CLV+10,6 confirmado

### 4.4 Markets cobertos

- **Tennis:** handicapGames, totalGames, sets handicap, sets total, aces total
- **Football:** OVER/UNDER 2.5, BTTS, AH, totals, halves
- **LoL:** total kills (player+map, Poisson — `LOL_KILLS_SCAN_MIN_EV=5`), total dragons, total towers, handicap maps
- **Dota:** total kills, handicap maps
- **CS2:** total maps, handicap maps
- **NBA:** spread + totals (Normal CDF μ=rolling pace/def σ=18/13)

---

## 5. Shadow mode

Toggle global por sport via `<SPORT>_SHADOW=true`. Quando shadow:

1. Tip passa por todos os gates igual modo real
2. **Não dispatcha DM**
3. Persiste em `tips` com `is_shadow=1` (mig 015) e `tip_context.shadow_reason`
4. Settlement normal pra cálculo retroativo de ROI/CLV/Brier
5. Cards dashboard "🥷 ML Shadow" mostram performance per sport
6. **PROMOVER** badge quando n≥30 + ROI≥0 + CLV≥0

### 5.1 Use cases

- **Sport novo** (Basket NBA fase 1)
- **ML real disabled** (LoL/CS/Tennis ML — bleeding ROI mas mantém data)
- **A/B test gates** (sprint experimental)
- **Pre-deploy validation**

### 5.2 Regime tag (mig 088)

Separação A/B/C entre regimes pra audits cruzando datas com mudanças significativas:
- Regime mudança 2026-04-22 (bucket gate + auto-guard + tennis isotonic disable)
- Regime mudança 2026-05-03 (audit P0 13 fixes)
- Análises cruzando essas datas têm 2 regimes mistos

Filter em 3 endpoints (`mt-shadow-by-league`, `mt-shadow-by-ev`, comprehensive-audit).

### 5.3 ML disabled auto-route (2026-05-05)

Em vez de **rejeitar** tip, **rota pra shadow**. Hard reject opt-in via `ML_DISABLED_HARD_REJECT=true`.

Wired em LoL/CS/Tennis quando `<SPORT>_ML_DISABLED=true`.

### 5.4 Focus funnel (2026-04-24)

- **Primary** (full dispatch): LoL, CS2, Tennis
- **Shadow** (`<SPORT>_SHADOW=true`): Dota2, Valorant, MMA, Darts, Snooker, Football (até 2026-05-03), TT
- **Disabled hard:** MMA, Darts, Snooker (2026-05-04 default `<SPORT>_ENABLED=false`)

---

## 6. Detectores cross-book

Loops 5min que comparam odds entre books pra detectar oportunidades sem depender de modelo.

### 6.1 Stale Line Detector

`lib/stale-line-detector.js` (mig 057):
- Pinnacle moveu >5% em 15min
- Casa soft permanece na odd antiga = stale
- DM admin (cooldown 1h por match)
- Cobertura: football (DM), LoL (silent log)

### 6.2 Super-Odd Detector

`lib/super-odd-detector.js` (mig 058):
- Book >20% acima Pinnacle (promo/erro de pricing)
- Devig aplicado pra evitar falso-positivo em market structure diferente
- DM football
- Sameodd lock min age (audit P0 2026-05-03)

### 6.3 Arb Detector

`lib/arb-detector.js` (mig 059):
- Arb 2-way esports + 3-way football
- DM stake split com payout garantido
- Stake reference R$100 → split per outcome

### 6.4 Velocity Tracker

`lib/velocity-tracker.js` (mig 060):
- Pinnacle >3% em 5min = sharp money entrou
- Reusa ring buffer compartilhado com stale_line
- `VELOCITY_WINDOW_MIN=10`

### 6.5 Book Bug Finder

`lib/book-bug-finder.js` (mig 061):
- Anomalias de pricing (odd duplicada com line diferente, totals invertidos, etc.)
- `/book-bugs` Telegram cmd

### 6.6 Bookmaker Delta BR

`lib/bookmaker-delta.js` (mig 056):
- Calibra book BR (Bet365/Betano/Sportingbet via Supabase) vs Pinnacle
- `/odd-sample` POST sample
- `/admin/bookmaker-deltas` analytics

### 6.7 Cross-book sem Pinnacle

Quando Pinnacle ausente, detectores funcionam com **mediana** das casas como reference (audit 2026-04-25).

---

## 7. Polymarket integration (mini-Predex)

Cross-validation copy-trading (2026-05-04, migs 084-086).

### 7.1 Sinais

- **$1000+ DCA aggregate** — wallets com DCA agressivo recente
- **Multi-wallet consensus** (≥3 sharps) — DM com tip context
- **Auto-discovery sport sharps** — wallets recorrentes em sports
- **Realized PnL via outcome resolution** (mig 086)

### 7.2 Workflow

```
[lib/polymarket-watcher.js cron 5min]
    │  Polla wallets known sharps
    │  Detecta alertas
    ▼
[Persiste em polymarket_consensus_alerts]
    │  Mig 084 + 085 (wallet metadata)
    ▼
[DM admin com context cruzado]
    │  Inclui tips ativas em sport relacionado se sobreposição
    ▼
[Resolution capture (mig 086)]
    │  Update market_resolutions quando outcome conhecido
    │  Calcula realized PnL
    ▼
[Paper trades (mig 087)]
    │  Simula copy-trade pra validar antes de promote
```

### 7.3 BI dashboard

`/pm` — Polymarket BI custom (cards consensus alerts, wallet leaderboard, realized PnL).

`POLYMARKET_DISCOVERY_AUTO_APPLY=true` — auto-discovery de sport sharps.

---

## 8. Agents (lib/dashboard.js + lib/agents-extended.js)

### 8.1 Agents de observação

| Agent | Função | Endpoint |
|---|---|---|
| `live-scout` | Detecta gaps stats live (no_pandascore_data, stats_disabled, coverage_missing) | `/agents/live-scout` |
| `feed-medic` | Diagnostica saúde APIs externas (HTTP, latência, rate-limits) | `/agents/medic` |
| `roi-analyst` | Analisa ROI/calibração por janela | `/agents/roi-analyst` |
| `weekly-review` | Review semanal (ROI, CLV, Brier, hit) | `/agents/weekly-review` |
| `health-sentinel` | Detecta anomalias operacionais | `/agents/sentinel` |
| `bankroll-guardian` | Adaptive DD per sport | `/agents/bankroll-guardian` |
| `pre-match-final-check` | Re-valida tips pendentes <30min antes match | `/agents/pre-match-check` |
| `model-calibration-watcher` | Detecta drift calib | `/agents/model-calibration` |
| `cut-advisor` | Sugere sports/ligas pra cortar | `/agents/cut-advisor` |
| `live-storm-manager` | Detecta storm (totalLive>15) e flip mode | `/agents/live-storm` |
| `ia-health-monitor` | Monitora rate-limit + parse_fail DeepSeek | `/agents/ia-health` |
| `news-monitor` | Google News RSS para times com tip pendente | `/agents/news-monitor` |
| `decision-tree` | Sugere ações baseadas em stats atuais | `/agents/decision-tree` |
| `gate-optimizer` | Sugere caps ótimos via backtest retroativo | `/agents/gate-optimizer?sport=X&days=N` |
| `post-fix-monitor` | Alert se sport sangra pós gate-fix | `/agents/post-fix-monitor` |

### 8.2 Agent de ação

`auto-healer` — registry de fixes (ver seção 9).

### 8.3 Decision tree (sugere, não age)

`getDecisionTree()` retorna lista de actions sugeridas:
- Cortar sport com ROI<-15% n>=30 60d
- Apertar gate sport com Brier degraded
- Promover MT (sport, market) com critérios atingidos
- Reverter MT promotion com ROI atual<0
- Auto-shadow sport com DD>15%

---

## 9. Auto-healer (registry de fixes)

`lib/auto-healer.js` — cada fix tem:

```js
{
  severity: 'critical' | 'warning',
  description: string,
  precondition: ({ ctx, anomaly }) => { ok: bool, reason?: string },
  action: ({ ctx, anomaly, pre }) => { applied: string },
  validate: ({ ctx, anomaly }) => { ok: bool }
}
```

### 9.1 Fixes registrados

| anomaly_id | Severity | Action |
|---|---|---|
| `mutex_stale` | critical | `autoAnalysisMutex.locked = false` |
| `poll_silent_lol` | warning | Re-invoca `runAutoAnalysis()` |
| `poll_silent_dota` | warning | Re-invoca `pollDota(true)` |
| `poll_silent_cs` | warning | Re-invoca `pollCs(true)` |
| `poll_silent_valorant` | warning | Re-invoca `pollValorant(true)` |
| `poll_silent_tennis` | warning | Re-invoca `pollTennis(true)` |
| `poll_silent_mma` | warning | Re-invoca `pollMma(true)` |
| `poll_silent_darts` | warning | Re-invoca `runAutoDarts()` |
| `poll_silent_snooker` | warning | Re-invoca `runAutoSnooker()` |
| `poll_silent_tt` | warning | Re-invoca `pollTableTennis(true)` |
| `ai_backoff_long` | warning | `global.__deepseekBackoffUntil = 0` |
| `auto_shadow_not_running` | warning | Força `checkAutoShadow()` |
| `vlr_zero_unexpected` | warning | `vlrModule._clearCache()` |
| `feed_stale_<provider>` | warning | Force-refresh provider cache |

### 9.2 Fluxo

```
[Cron 5min] runAutoHealerCycle()
   │
   ▼
[1] runHealthSentinel(serverBase, db) → { anomalies, healthy, summary }
   │
   ▼
[2] Se 0 anomalies → log debug, return (silencioso)
   │
   ▼
[3] Build ctx com refs do bot (mutex, pollFns, vlrModule, log, db)
   │
   ▼
[4] runAutoHealer({ anomalies, ctx }) → { applied, skipped, errors }
   │
   ▼
[5] Filtra newApplied (cooldown 30min/anomaly_id anti-spam)
[6] Filtra criticalUnresolved (exclui self-resolved por precondition false)
   │
   ▼
[7] Se há fixes novos OU criticals pendentes → DM admin
```

---

## 10. Orchestrator (workflows compostos)

`lib/agent-orchestrator.js` define chains. Cada step pode ser:
- `{ agent: 'name' }` — invoca agent
- `{ custom: fn(ctx) }` — função arbitrária com short-circuit
- `{ compare: (post, pre) => ... }` — compara antes/depois

### 10.1 Workflows registrados

| Workflow | Steps | Quando usar |
|---|---|---|
| `full_diagnostic` | sentinel → check_actionable → auto_healer → sentinel_post (compare) | Diagnóstico geral |
| `coverage_investigation` | live-scout → check_gaps → feed-medic | Investigar gaps de cobertura |
| `weekly_full` | weekly_review + roi_analyst + health_sentinel | Review semanal |
| `tip_emergency` | pre-match-check + news-monitor → check_alerts (short-circuit) → feed-medic | Tips em risco |
| `daily_health` | weekly_review + bankroll_guardian + health_sentinel + ia_health + cut_advisor | Cron 8h BRT |
| `incident_response` | sentinel → scout + medic + healer → sentinel_post | Resposta a critical |
| `model_check` | backtest_validator + model_calibration + ia_health + bankroll_guardian | Saúde dos modelos |

### 10.2 Endpoint

```
GET /agents/orchestrator?workflow=daily_health
GET /agents/orchestrator                    # lista workflows
```

---

## 11. Risk management

### 11.1 Banca per-sport (tier-based)

`lib/sport-unit.js` — cada sport tem `unit_value` independente baseado em tier:

```
0.5u → low-tier (darts/snk legacy)
0.6u
0.8u
1.0u → default
1.2u → cs2/dota2 promoted
1.5u
2.0u
3.0u → tennis premium
```

Migrações 033-038 (split → bump → revert → rebuild → align).

**Operações:**
- `scripts/rebalance-bankroll-1000.js` — 10 sports × R$100
- `scripts/reset-equity.js` — snapshot DB + archive + rebaseline (`--dry-run`/`--confirm`)
- `/bankroll-audit` — diff stored vs recomputed (mig 044 fixed key sync)
- `/admin/force-sync-bankroll` POST

### 11.2 Bankroll Guardian adaptive thresholds

`runBankrollGuardian` cron 1h.

**Por banca size:**
- Small (<R$100): DD 45/28/18%
- Big (≥R$100): DD 35/20/12%

**Ações:**
- DD>18%/12% → warn DM admin
- DD>28%/20% → auto-shadow temp
- DD>45%/35% → block dispatch (em construção)

Skip esports legacy bucket (mig 074 consolidou cs2 paralelo).

### 11.3 Match stop-loss

`MATCH_STOP_LOSS_UNITS=2` — máx 2 unidades perdidas por match. Aplicado pré-dispatch.

### 11.4 Per-sport limits

```
DAILY_TIP_LIMIT=8 (per sport)
MAX_TIPS_PER_TOURNAMENT_PER_DAY=8
TENNIS_MARKET_MAX_PER_MATCH=3
maxPerMatch:
  LoL/Dota: 2
  CS: 3
  Val: 2
  Tennis: 3
```

---

## 12. CLV tracking

CLV = Closing Line Value = % a favor da odd da tip vs odd Pinnacle no kickoff. Métrica gold-standard pra detectar edge real.

### 12.1 Capture

```
[Cron close-line per match]
    │
    ▼
// server.js:13779 — raw/raw, vig cancela na razão quando estável
clv_pct = (tip_odd / close_odd - 1) * 100
    │  Cap 1.15× tip_odd (anti-outlier sameOdd lock)
    │  Devig power method (lib/devig.js) — usado em outros gates, não no CLV
    │  Lock min age (audit P0 2026-05-03)
    │
    │  Por que raw/raw é OK: vig estável (Pinnacle ~2.5%) cancela em
    │  tip_odd/close_odd = (tip_dej × 1.025) / (close_dej × 1.025).
    │  Bias só se vig variar entre captura e close (raro em sharp book).
    ▼
UPDATE tips SET clv_pct = ?, close_odd = ? (mig 080)
UPDATE market_tips_shadow SET clv_pct = ? (mig 026)
    ▼
[Throttle DM CLV<-5% pra audit liga]
[CLV-CAPTURE log throttle 2026-05-01]
```

### 12.2 Pre-dispatch gate

```
CLV_PREDISPATCH_GATE=true
CLV_PREDISPATCH_THRESHOLD=2.5  # %
CLV_PREDISPATCH_WINDOW_MIN=10
```

Se odd subiu >2.5% em 10min ANTES do dispatch = sharp money entrou no lado oposto = stale → skip.

### 12.3 MT skip

`lib/clv-capture.js` — pula MT (não-ML) e rejeita CLV >3× prev (audit 2026-04-28).

### 12.4 Análises

- `scripts/clv-by-league.js` — flag ligas com CLV neg persistente
- `scripts/clv-coverage.js` + `clv-coverage-gap.js` — % tips com CLV capturado
- `scripts/clv-leak-diagnosis.js` — diag per (sport, league, market)
- `/clv-histogram` — distribuição
- `/admin/clv-capture-trace` — diag granular (commit 2026-04-27)

---

## 13. Settlement

### 13.1 Auto

`bot.js::settleCompletedTips` cron 30min:

```
1. Pre-sync match_results das APIs (sport-specific):
     Sofascore, ESPN, Pinnacle, gol.gg, HLTV, OpenDota, ufcstats
2. Iterar tips pendentes em janela:
     Esports: -24h/+7d
     Tennis: stricter (pickBest com league overlap)
     Football: pre-sync sofascore primeiro
3. Match lookup fuzzy (lib/name-match.js):
     Strategies: strict → fuzzy → lastname
     Threshold score >= 0.5
     Aliases (BIG vs IG, T1 vs T10)
     Tennis tiebreak via league overlap
4. settleTip(id, result):
     win: profit = stake × (odd-1)
     loss: profit = -stake
     push/void: profit = 0
     bankroll[sport].current_amount += profit
5. Settlement audit row em tip_settlement_audit (mig 073)
6. Result propagator (lib/mt-result-propagator.js):
     tips ↔ market_tips_shadow same match → mesmo result
7. CLV update (race fix migs 081/082)
```

### 13.2 Force-settle (admin)

- `/admin/run-settle` (com guardrail temporal pós-fix Garin/Echargui 2026-05-03)
- `/admin/tennis-force-settle-tip` — manual single tip
- `/admin/settle-market-tips-shadow` + `/admin/settle-mt-shadow-kills`
- `/settle` Telegram cmd

### 13.3 Void

- `/void-tip` (admin)
- `/admin/reanalyze-void`
- `AUTO_VOID_STUCK_AUTO=true` — auto-void pendentes >3d (era 14d)
- `LIVE_RISK_MONITOR_AUTO=true` — auto-void live com risco extremo

### 13.4 Settlement quarantine

Tips que falharam match lookup repetidamente vão pra quarantine. Manual review via `/admin/forensics`.

---

## 14. Estado atual (snapshot 2026-05-06)

### 14.1 Banca

- **Total:** ~R$1188 / R$1200 inicial (-0,98% em 30d, em recovery pós audit-leaks 2026-05-04)
- **Tennis:** R$76,59 (drawdown 24%, em taper ×0.35)
- **LoL/Dota2/CS2/etc:** ver `/dashboard`

### 14.2 Sports — clarificação ML vs MT

`<SPORT>_ML_DISABLED=true` desliga **só** o path ML 1X2/match winner (auto-route shadow). MT (markets secundários: handicap, totals, kills, sets, spread) é independente.

| Sport | ML 1X2 | MT (markets) | Razão | Dispatcha real? |
|---|---|---|---|---|
| LoL | disabled (LOL_ML_DISABLED=true) | shadow (kills, totals em shadow puro) | ML -28,9% audit | **Não** |
| CS2 | disabled (CS_ML_DISABLED=true) | **promoted** (CLV+12) | ML -21,7%; MT funciona | **Sim (MT)** |
| Dota2 | disabled | **promoted** (CLV+10,6) | MT funciona | **Sim (MT)** |
| Tennis | disabled (TENNIS_ML_DISABLED=true) | **promoted** (handicapGames + totalGames via Markov calib) | ML -33,5% n=161; MT ~99% das tips reais ROI +9,4% | **Sim (MT)** |
| Football | n/a (sem ML 1X2 path) | **promoted** | ROI +40,9% hit 71% | **Sim (MT)** |
| Valorant | shadow | shadow | sample baixo | Não |
| MMA | n/a | n/a | `MMA_ENABLED=false` | Não |
| Darts | n/a | n/a | `DARTS_ENABLED=false` | Não |
| Snooker | n/a | n/a | `SNOOKER_ENABLED=false` | Não |
| TT | shadow | n/a | shadow opt-in | Não |
| Basket NBA | shadow | shadow | fase 1 | Não |

**Sports que efetivamente dispatcham hoje:** Tennis (MT), CS2 (MT), Dota2 (MT), Football (MT).
**Total real ativo: 4 sports — todos via MT, nenhum via ML 1X2.**

### 14.3 Calibração

- **Tennis Markov refit 2026-05-06** n=537: PRE -2,2% → POST +12,4%, ECE -67%
- **Tennis Markov shrink** ativo (k=0.75/0.65)
- **Tennis isotonic disabled** (overshoot 2.20-3.00)
- **LoL isotonic disabled** (Brier piorou refit)
- **CS2/Dota2/Val isotonic ativos**

### 14.4 Migrations aplicadas

**91 migrations** (last 091_market_tips_runtime_state_tier).

Recentes:
- 080 tips.clv_pct
- 081/082 perf indexes + analytics_alerts
- 084-086 polymarket consensus_alerts + wallet_metadata + market_resolutions
- 087 polymarket paper_trades
- 088 shadow regime_tag
- 089 readiness corrections_log
- 090 learned_corrections
- 091 mt_runtime_state tier

---

## 15. Fluxo completo — exemplo real (LoL live tip — atualizado 2026-05)

```
T+0s   Match LCK começa: T1 vs Dplus KIA, mapa 1
       Riot livestats começa a popular (delay ~15-45s)

T+30s  runAutoAnalysis dispara (cron adaptativo, 60s live)

T+45s  GET /lol-matches → server faz merge Riot + PandaScore + Pinnacle
       Match retorna com odds Pinnacle 1.45/2.85, status='live'
       Pinnacle = primary (alt SX.Bet 1.42/2.95 em _alternative)

T+50s  collectGameContext: Riot livestats → gold/kills/dragons/comp
       fetchEnrichment: forma + H2H do DB (45 dias)
       fetchMatchNews: Google News RSS (2 results)
       Patch meta: 15.6 (cached ddragon)
       OE features: T1 last 30 games (regional strength)

T+55s  esportsPreFilter (lib/ml.js):
         Series model + map model + regional + OE
         modelP1=0.62 (T1 favored)
         impliedP1=0.69 (após dejuice power method)
         edge = -0.07 (negativo) → t2 has edge
         direction='t2', factorCount=3, score=7.2pp

T+57s  Pipeline P:
         Step 1: modelP_raw = 0.38
         Step 2: isotonic LoL → DISABLED, skip
         Step 3: Markov → não aplicável (LoL)
         Step 4: CLV calib layer blend 0.30 → 0.385
         Step 5: Learned corrections (regime A, tier1) → 0.39
         Step 6: Readiness → 0.39

T+60s  buildEsportsPrompt: contextBlock + P=0.39

T+62s  POST /claude (DeepSeek):
       "TIP_ML: Dplus KIA @ 2.85 |P:48% |STAKE:1.5u |CONF:MÉDIA"

T+63s  _parseTipMl extrai → { team:'Dplus KIA', odd:2.85, P:48, stake:1.5u, conf:MÉDIA }
       _validateTipPvsModel: P_modelo=0.39 vs P_IA=0.48 → diff 9pp
       Tolerance LoL=8pp → REJEITA?
       Atual: 8pp default → fica close ao threshold; depende sport flag
       Vamos assumir passa (LoL tolPp ajustada via env)

T+64s  Gates:
       - sharpDivergenceGate(modelP=0.39, impliedP=0.31, cap=15pp): diff 8pp → PASSA
       - bucketGate odd=2.85 (LOL_ODDS_BUCKET_BLOCK=3.00-99): PASSA
       - EV: 0.39 × 2.85 - 1 = +11.1% (recalc, IA reportou +9%)
       - EV cap LoL=20: PASSA
       - HIGH_EV_THROTTLE: bucket 8-12%, mult 1.0 (audit CS preserva)
       - DAILY_TIP_LIMIT: 3/8 hoje LoL → PASSA
       - maxPerMatch LoL=2: 0/2 → PASSA
       - LOL_ML_DISABLED=true → AUTO-ROUTE SHADOW (não rejeita!)
       - MT leak guard (sport=lol, market=ML, league=LCK, tier=tier1): PASSA
       - CLV pre-dispatch: odd 2.85 estável últimos 10min → PASSA

T+65s  computeKellyStake(P=0.39, odd=2.85, sport=lol, conf=MÉDIA):
       f_kelly = (0.39*1.85 - 0.61) / 1.85 = 0.061
       mult = KELLY_LOL_MEDIA=0.25 (default) × kelly_auto_tune mult (1.0)
       stake = 0.061 × 0.25 = 0.015 → muito baixo
       stake_min = 0.5u → clamp pra 0.5u

T+66s  is_shadow=1 (LoL ML disabled)
       regime_tag=B (post 2026-05-03 audit P0)

T+67s  POST /record-tip (sport=lol, is_shadow=1, regime_tag=B):
       INSERT tips (id=842, ..., is_shadow=1, tip_context_json={...})

T+67s  NÃO dispatch DM (shadow mode)
       Log: [INFO] [SHADOW] LoL tip 842 logged (auto-route ML_DISABLED)

================== Background ==================

T+30min  settleCompletedTips:
         Match ainda em andamento, skip

T+45min  Match termina, T1 wins (Dplus KIA loss)
T+47min  PandaScore atualiza winner

T+1h     settleCompletedTips:
         Tip 842 → result='loss'
         profit_reais = -0.5
         Banca lol unaffected (is_shadow=1 não atualiza bankroll)
         tip_settlement_audit row criada
         Result propagator: market_tips_shadow LCK match → propagate result

T+1h     CLV capture:
         Pinnacle close odd 2.65 (movimento contra)
         clv_pct = (1/2.65/(1/2.85) - 1) * 100 = +7.5%
         UPDATE tips SET clv_pct=7.5, close_odd=2.65 WHERE id=842

T+5h     auto-shadow cycle: shadow tips count++
T+6h     bankroll-guardian: lol DD calc (excluding shadow profits)
T+8h BRT  Daily Health Report → DM admin:
         "🌅 DAILY HEALTH 2026-05-06:
          🟢 1 OK | 🟡 2 warn | 🔴 0 critical
          📊 Banca total: R$1188.34 (+R$0.00 dia)
          🥷 Shadow LOL: n=12 | ROI=+5.2% | CLV=+3.1% (não promove ainda)
          ..."

T+24h    settle_quality_check: tip 842 settled OK, audit clean
T+24h+   nightly_retrain (3h UTC): refresh-all-isotonics.js
T+25h    tennis_calib_refit (4h local): /admin/mt-refit-calib?sport=tennis
T+26h    leaks_digest (13h UTC): nenhum leak novo flagged
```

---

## 16. Arquivos-chave

```
start.js                          — Launcher (auto-restart server+bot, 179 linhas)
server.js                         — HTTP API (~28.5k linhas)
bot.js                            — Loops, IA, Telegram, gates, Kelly, schedulers (~24k linhas)

lib/
  utils.js                        — log, httpGet, heartbeats, log buffer
  database.js                     — WAL setup, prepared stmts (cache TTL 30min, mtime check)
  ml.js                           — esportsPreFilter (LoL/Dota/CS/Val genérico)
  ml-weights.js                   — Weights loader

  # Modelos por sport
  lol-{model,series-model,map-model,kills-model}.js
  lol-{regional-strength,markets,extra-markets,source-cross-check}.js
  lol-kills-calibration.js
  oracleselixir-{features,player-features}.js
  dota-{map-model,hero-features,roster-detect,snapshot-collector}.js
  dota-{extras-scanner,fraud-blacklist}.js
  stratz-dota-scraper.js
  cs-{ml,map-model}.js
  valorant-ml.js
  vlr.js + thespike-valorant-scraper.js
  hltv.js
  tennis-{model,model-trained,markov-model,markov-calib}.js
  tennis-{h2h-ensemble,correlation,injury-risk,tiebreak-stats,fatigue}.js
  tennis-{player-stats,features-v2,match,abstract-scraper,data}.js
  tennis-market-scanner.js
  football-{model,ml,poisson-trained,live-model,mt-scanner,data,data-csv,data-features}.js
  basket-{elo,trained,mt-scanner}.js + espn-basket.js
  mma-org-resolver.js + ufcstats.js
  darts-ml.js + sofascore-darts.js
  snooker-ml.js + cuetracker.js + pinnacle-snooker.js
  tabletennis-ml.js + sofascore-tabletennis.js

  # Calibrações
  calibration.js                  — base PAV/beta primitives
  clv-calibration.js              — third-layer pull toward close
  ev-calibration.js               — data-driven EV→ROI per bucket
  learned-corrections.js          — per (sport,regime,tier,market)
  readiness-learner.js            — incremental readiness corrections
  tennis-markov-calib.js + .json  — refit nightly cron 04h
  <sport>-isotonic.json           — PAV+Beta arrays
  <sport>-weights.json            — trained logistic+GBDT

  # Risk + gates
  risk-manager.js                 — applyGlobalRisk + Kelly
  kelly-auto-tune.js              — daily 30d ROI+CLV → kelly_mult
  stake-adjuster.js               — context mult (ultra_low/low/high)
  pre-match-gate.js               — pre-match specific gates
  odds-bucket-gate.js             — bucket block
  gate-optimizer.js               — backtest cap optimization
  gates-runtime-state.js          — DB-backed runtime state + cron
  epoch.js                        — code epoch tracker

  # Detectores cross-book
  stale-line-detector.js
  super-odd-detector.js
  arb-detector.js
  velocity-tracker.js
  book-bug-finder.js
  bookmaker-delta.js
  auto-sample-deltas.js

  # MT system
  market-tip-processor.js
  market-tips-shadow.js
  mt-tier-classifier.js
  mt-auto-promote.js
  mt-result-propagator.js

  # Odds providers
  pinnacle.js + pinnacle-snooker.js
  betfair.js
  odds-aggregator-client.js       — Supabase BR
  sportsbook-1xbet.js
  sofascore-{tennis,football,mma,darts,tabletennis}.js
  espn-{soccer,basket}.js
  api-football.js
  line-shopping.js                — line shop computation
  devig.js                        — power method
  book-deeplink.js                — Telegram inline button "Apostar"

  # Settlement + matching
  name-match.js                   — fuzzy 5 strategies + aliases
  golgg-{kills,objectives}-scraper.js

  # Banca / sport metadata
  sport-unit.js                   — per-sport tier-based unit_value
  sports.js                       — canonical names, normSport
  league-{tier,trust,rollup,blocklist}.js

  # Observability
  metrics.js                      — Prometheus-like metrics + cardinality cap
  feed-heartbeat.js               — feed health
  cashout-monitor.js              — checkTipHealth (live)
  roi-drift-cusum.js              — CUSUM regime change
  model-backup.js                 — model rollback support
  tip-reason.js                   — deterministic fallback

  # Agents
  dashboard.js                    — runLiveScout, runFeedMedic, runRoiAnalyst,
                                    runWeeklyReview, runHealthSentinel
  agents-extended.js              — runBankrollGuardian, runPreMatchFinalCheck,
                                    runModelCalibrationWatcher, runCutAdvisor,
                                    runLiveStormManager, runIaHealthMonitor,
                                    runNewsMonitor, getDecisionTree
  auto-healer.js                  — registry de fixes + runAutoHealer
  agent-orchestrator.js           — runWorkflow + WORKFLOWS

  # Polymarket
  polymarket-watcher.js

  # Other
  esports-{correlation,model-trained,runtime-features,segment-gate}.js
  news.js                         — Google News RSS
  grid.js                         — tournament structure
  understat-scraper.js
  constants.js + utils.js

migrations/
  index.js                        — 91 migrations (single file, ~2353 linhas)

scripts/
  ~90 utility scripts (train, backtest, audit, sync, refit, settle, repair, ...)

public/
  dashboard.html                  — Dashboard legacy v2 (Chart.js)
  dashboard-bi.html               — BI v3 PowerBI-style 2026-05-03
  dashboard-legacy.html           — old v1 archive
  logs.html                       — Logs SSE + filters
  lol-ev-manual.html              — Calculadora EV manual

tests/
  run.js                          — orchestrator
  test-{calibration,devig,elo-rating,kelly,...}.js (~25 tests)

data/
  tennis_atp/, tennis_wta/        — Sackmann repos
  <sport>_features.csv            — extracted features
  <sport>-backtest-per-segment.json
  tennis-backtest-per-surface.json

_archive/                         — Historical snapshots + audits
n8n/                              — n8n workflows (opcional)
Public-Sofascore-API/             — Django Sofascore proxy (deploy separado)
hltv-proxy/                       — Python FastAPI HLTV proxy (deploy separado)
external/                         — External integrations
docs/PROCESSO-ANALISE-TIPS-BOTS.md

sportsedge.db                     — SQLite WAL (Railway: /data/sportsedge.db)
boot_count.json                   — Boot counter
last_exit_server.json             — Exit signature
last_child_exit_<name>.json       — Child crash signature
promote-status.json               — MT promote state cache

DECISIONS.md                      — Decision log cronológico (369 linhas)
README.md                         — Reference completa (1920 linhas)
.env.example                      — Todas envs (~1043 linhas, 26KB)
WORKFLOW_SPORTSEDGE.md            — Este arquivo
```

---

## 17. Custos operacionais

### 17.1 Provedores pagos

| Provider | Tier | Pricing | Tracking |
|---|---|---|---|
| **DeepSeek** | API key | $0.14/M input + $0.28/M output | tabela `api_usage` (auto via `/claude` proxy) |
| **The Odds API** | Free 500/mo + paid $0.005/req | budget mensal in-memory (`oddsApiQuotaStatus()`) |
| **PandaScore** | Free 1000/mo (soft) | sem tracking direto |
| **Railway** | Hobby ($5/mo) ou PAYG (~$5-15/mo) | `RAILWAY_MONTHLY_USD_EST` env |

### 17.2 Provedores gratuitos

- **Pinnacle Guest API** — sem auth, soft rate-limit via cache 3min
- **Riot LoL Esports API** — gratuita (LOL_API_KEY)
- **OpenDota** — gratuita (limit maior com `OPENDOTA_API_KEY`)
- **Steam Realtime** — gratuita (`STEAM_WEBAPI_KEY`)
- **ESPN** — scraping
- **Sofascore** — proxy hosted Railway
- **HLTV / VLR.gg** — scraping (frágil)
- **football-data.co.uk** — CSV public
- **Sherdog/CueTracker** — scraping
- **Supabase BR** — free tier

### 17.3 Custo estimado mensal

Em produção (Maio/2026, ~250-500 tips/mês total):
- DeepSeek: $2-6/mo (cache shadow reduz)
- The Odds API: $0-5/mo (free + buffer)
- Railway: $5-15/mo (2 services + DB volume)
- **Total: ~$10-25/mo (R$50-130)**

### 17.4 Quando preocupar

- DeepSeek > $20/mo: investigar prompts duplicados (cache LRU 24h)
- The Odds API >80% quota: aumentar `HTTP_CACHE_THEODDS_TTL_MS`
- Railway > $20/mo: memory leak (mem_watchdog + `/health/metrics` RSS)
- Sofascore proxy errors: ver Public-Sofascore-API logs

---

## 18. Known issues / em construção

### 18.1 Resolvidos desde 2026-04-17

- ✅ **Pre-Match Check cutoff** — runs em todos sports
- ✅ **Auto-Healer** — 14 fixes ativos, cooldown 30min funciona
- ✅ **News Monitor** — controlled false positive
- ✅ **Auto-Shadow** — critério n>=30 + CLV<0% mantido, ML disabled auto-route adicional
- ✅ **Sharp divergence caps** — calibrados via Gate Optimizer (tennis 15→20pp 2026-04-18)
- ✅ **Bankroll Guardian** — adaptive thresholds aplicados, DD>15% auto-shadow funciona
- ✅ **Backtest expandido** — `scripts/backtest.js` v2 inclui gates novos (commits 2026-04 / 2026-05)
- ✅ **Cache DeepSeek** — não implementado, mas AI_DISABLED em vários sports reduziu uso 60%+
- ✅ **Tennis match_time** — armazenado via tip_context_json (mig 072)
- ✅ **CLV updateTipCLV first-wins bug** — fix lib/database.js:428 (2026-05-02)
- ✅ **MT propagator race** — fix tips delete antes propagator (audit P0 2026-05-03)
- ✅ **MT refit crash loop Railway** — bounded PAV/merge + write=true (commit 7d36529 2026-05-06)
- ✅ **Tennis Markov overconfidence** — shrink universal pós-isotonic + refit nightly
- ✅ **Football 1X2 direction bug** — codes vs labels fix
- ✅ **Football odds stale** — per-sport threshold 65min pre / 5min live
- ✅ **CLV race** — migs 081/082
- ✅ **Bucket leaks** — odds_bucket_guard cron 12h auto-block

### 18.2 Em construção

- **Live Storm Manager:** detecta totalLive>15 mas só sugere; não muda intervals automaticamente.
- **Bankroll Guardian DD≥45%/35% block:** alerta + auto-shadow temp, mas hard block real ainda TODO.
- **Risk peak reset (Sprint 13):** reset peak watermark periodicamente pra DD não acumular regime change.
- **Cache DeepSeek LRU 24h:** prompts idênticos re-chamam IA. Possível economia 30-50%.
- **PandaScore quota tracking:** sem visibilidade de uso direto.
- **Snooze/ack pra Live Scout alerts:** mesmo gap aparece a cada 60min sem fim.

### 18.3 Hipóteses parcialmente validadas

- **Modelos ML são sound?** — VALIDADO PARCIAL: LoL/CS lift ~37%/20% reais, Dota/Val/MMA marginal 4-6%, Darts/Snk ruído. ML real disabled em LoL/CS mantém data shadow. (audit 2026-04-21)
- **Sharp divergence threshold corretos?** — VALIDADO: tennis 15→20 via Gate Optimizer; outros sports stable.
- **IA second opinion adiciona valor?** — VALIDADO PARCIAL: DM A/B em alguns sports mostrou IA reduz false positive em ~10-15%. AI_DISABLED em sports onde IA não mostrou edge.
- **News Monitor captura edge real?** — NÃO VALIDADO: ainda em fase de coleta.
- **Auto-Shadow critério (CLV<-1% n>=30)** — VALIDADO: critério aplicado, recovery pós flip funciona.

### 18.4 Bugs conhecidos não fixados (raros)

- **mutex_stale falso positivo** em janela curta — cooldown 30min ajuda mas não elimina 100%
- **DeepSeek tokens não registrados** quando API antiga não retornava `usage` — algumas calls dão custo $0 estimado errado
- **ESPN ATP+WTA dup feeds** — escapa por slug mas pode ter match raros sem stats
- **HLTV/VLR HTML breakage** — fail-open mas requer monitoring (scraper-smoke-test daily cobre parcial)

### 18.5 Backlog (priorizado)

| Prio | Item | Esforço |
|---|---|---|
| 🔴 HIGH | Risk peak reset (Sprint 13) | 3h |
| 🔴 HIGH | match_start gate (Sprint 6) | 2h |
| 🔴 HIGH | Trust ML wire (Sprint 7) | 4h |
| 🟡 MED | Cache DeepSeek LRU 24h | 3h |
| 🟡 MED | PandaScore quota tracking | 1h |
| 🟡 MED | Live Storm Manager: ação ativa | 4h |
| 🟢 LOW | Snooze/ack pra Live Scout | 2h |
| 🟢 LOW | `/banca <sport> <novo_valor>` cmd | 1h |

---

## 19. Decisões pendentes

- **Cortar sport disabled permanentemente?** MMA/Darts/Snooker disabled default há semanas. Deletar feature ou manter dormente?
- **Promover sport NBA shadow?** Critério atingido em 2 semanas? Atual: fase 1 ainda.
- **Adicionar Bet365 Exchange?** — bloqueia BR via geo
- **Modelo ML mais sofisticado** (GBDT mais profundo, deep learning)? — sample size atual ainda ~limita
- **Polymarket promotion** — quando aplicar copy-trade real (não paper)?
- **Tennis ML auto-route shadow → re-enable?** Trained model shadow performa bem mas variance alta

---

## 20. Comandos úteis pro usuário

### 20.1 Endpoints públicos

```
/dashboard              — UI principal (legacy v2)
/bi                     — UI BI v3 PowerBI-style
/logs                   — Logs SSE + agentes
/health                 — Health check
/agents/orchestrator?workflow=daily_health
/equity-curve?sport=X&days=30
/clv-histogram?sport=X
/pipeline-status
/cron-heartbeats
/migrations-status
/rejections
```

### 20.2 Endpoints admin (key required)

```
/admin/today                     — daily summary
/admin/sport-detail              — per-sport drill-down
/admin/mt-status                 — MT promote state
/admin/mt-shadow-comprehensive-audit
/admin/mt-refit-calib?sport=X&days=90&write=true
/admin/clv-capture-trace
/admin/ev-calibration
/admin/forensics
/admin/run-settle?sport=X
```

### 20.3 Telegram cmds (admin)

```
/pipeline-health                 — sports/tips/modelos/rejections summary
/loops                           — cron heartbeats
/kelly-config                    — kelly_mult per sport
/models                          — model freshness + Brier per sport
/rejections                      — rejection counters
/scrapers                        — BR scrapers status
/migrations                      — DB migrations state
/health                          — server health
/diag-tip <id>                   — diag granular
```

---

## 21. Filosofia & princípios

1. **Modelo determinístico = source of truth** — IA só sugere; divergência >8pp → reject.
2. **Pinnacle/Betfair = ground truth do mercado** — sharp anchor pra todos cálculos de EV.
3. **Conservar o capital prevalece sobre maximizar volume** — DAILY_TIP_LIMIT, MAX_STAKE_UNITS, match_stop_loss, tier-aware caps.
4. **Calibração > tuning** — isotonic + Markov + EV→ROI + CLV layer + learned corrections em vez de chutar EV mín.
5. **Shadow primeiro, promote por evidência** — n≥30 + ROI≥0 + CLV≥0 em janela 14d.
6. **Auto-tune > config manual** — gates_runtime_state, kelly_auto_tune, bucket_guard, leak_guard fazem self-correction.
7. **Audit trail completo** — settlement_audit, regime_tag, tip_context_json, code_sha+gate_state em cada tip.
8. **Fail-open em providers externos** — Sofascore/HLTV/VLR down não derrubam pipeline.
9. **Reversibilidade** — cada decisão em DECISIONS.md tem "Reversão:". Migrações idempotentes. Backups `lib/backups/`.
10. **Dedup obsessivo** — match+market+side+line+book+tier; cross-bucket esports↔lol/dota2; fuzzy via name-match.

---

## 22. Quando pedir ajuda

- **Tip não dispatcha:** `/rejections`, `/diag-tip <id>`, check `<SPORT>_ENABLED` + `<SPORT>_SHADOW` + `LOL_ML_DISABLED` etc.
- **Settlement travado:** `/unsettled`, `/admin/tennis-tip-match-debug`, `/admin/run-settle`
- **CLV negativo:** `/clv-histogram`, `node scripts/clv-by-league.js`, `/admin/clv-capture-trace`
- **EV inflado:** `/admin/mt-calib-validation`, `/admin/mt-refit-calib?sport=X&write=true`
- **Banca dessincronizada:** `/admin/force-sync-bankroll`, `/bankroll-audit`, mig 044
- **Crash loop:** `/admin/boot-diag`, `last_child_exit_*.json`, mem_watchdog
- **Logs não aparecem:** `/health`, `/logs/ingest` POST test, `/logs/stream` SSE

---

**Para reference completa de envs, endpoints, e estrutura de pastas: ver [README.md](./README.md).**
**Para log cronológico de decisões: ver [DECISIONS.md](./DECISIONS.md).**
**Para auto-memory persistente: `.claude/memory/MEMORY.md`.**
