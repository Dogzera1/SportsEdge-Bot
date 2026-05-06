# SportsEdge Bot

Sistema autônomo multi-esporte de detecção e dispatch de apostas de valor (Value Betting) via Telegram, com ML próprio, calibração isotônica, IA opcional como segunda opinião e dezenas de gates anti-edge-fictício.

> **Última atualização:** 2026-05-06 (Maio/2026 release)
>
> **Filosofia central:** modelo determinístico = source of truth. Pinnacle/Betfair = ground truth do mercado. IA (DeepSeek) só sugere — se P da IA diverge >8pp do modelo, tip é rejeitada. Se modelo diverge >cap pp do Pinnacle dejuiced, tip é rejeitada (edge provavelmente fictício).

---

## Índice

1. [Visão geral](#visão-geral)
2. [Arquitetura](#arquitetura)
3. [Esportes suportados](#esportes-suportados)
4. [Quick start](#quick-start)
5. [Pipeline de tip (end-to-end)](#pipeline-de-tip-end-to-end)
6. [Modelos](#modelos)
7. [Camadas de calibração](#camadas-de-calibração)
8. [Gates anti-edge-fictício](#gates-anti-edge-fictício)
9. [Risk management & banca](#risk-management--banca)
10. [Market Tips (MT)](#market-tips-mt)
11. [Shadow mode](#shadow-mode)
12. [CLV tracking](#clv-tracking)
13. [Settlement](#settlement)
14. [Crons / loops autônomos](#crons--loops-autônomos)
15. [Detectores cross-book](#detectores-cross-book)
16. [Polymarket integration](#polymarket-integration)
17. [Auto-healer & health sentinel](#auto-healer--health-sentinel)
18. [Banco de dados](#banco-de-dados)
19. [HTTP endpoints (server.js)](#http-endpoints-serverjs)
20. [Comandos Telegram](#comandos-telegram)
21. [Dashboards](#dashboards)
22. [Estrutura de pastas](#estrutura-de-pastas)
23. [Variáveis de ambiente](#variáveis-de-ambiente)
24. [Deployment (Railway)](#deployment-railway)
25. [Desenvolvimento local](#desenvolvimento-local)
26. [Testes](#testes)
27. [Subprojetos](#subprojetos)
28. [Memory & decisions log](#memory--decisions-log)
29. [Troubleshooting](#troubleshooting)

---

## Visão geral

SportsEdge é um bot de Telegram autônomo que:

- **Descobre partidas** em múltiplas APIs (Pinnacle, SX.Bet, PandaScore, Sofascore, ESPN, HLTV, VLR, OpenDota, Steam, Riot, OddsAPI, etc.).
- **Calcula P (probabilidade real)** com ML treinado por sport (logistic + isotônico, alguns com GBDT, Markov para tennis, Poisson+CSV para futebol).
- **Compara com odds dejuiced de Pinnacle** (sharp anchor) para detectar edge.
- **Filtra com 12+ camadas de gates** (sharp divergence, bucket gate, EV cap data-driven, learned corrections, MT leak guard, etc.).
- **Decide stake via Kelly fracionado** com auto-tune diário per-sport e cap por confidence.
- **Dispara DM no Telegram** (1 bot por sport).
- **Settla automaticamente** via match_results + propagation entre `tips` ↔ `market_tips_shadow`.
- **Registra CLV** (closing line value) pra avaliar quality do edge a posteriori.
- **Auto-cura** loops travados, isotonic stale, drawdown alto, regime change (CUSUM).
- **Reporta** tudo em dashboards web (`/dashboard`, `/bi`, `/admin`, `/logs`).

**Status atual (Maio 2026):**
- Banca total: ~R$1188 / R$1200 inicial (-0,98% em 30d, em recovery pós-leak audit 2026-05-04)
- 9 sports ativos: LoL, CS2, Dota2, Valorant, Tennis, Football, MMA, Darts, Snooker, TableTennis, Basket (NBA shadow)
- ML real ML disabled em LoL/CS (ROI negativo) — auto-rota pra shadow ao invés de rejeitar
- MT promovido em CS2/Dota2 + Football
- 91 migrations aplicadas
- Tennis Markov calib refit nightly (cron 04h)

---

## Arquitetura

```
┌───────────────────────────────────────────────────────────────────┐
│                       RAILWAY (1 deploy)                          │
│                                                                   │
│   start.js (launcher) — spawna 2 processos com auto-restart       │
│      │   exponential backoff 3s → 6s → 12s → 24s → 60s            │
│      │   port retry on EADDRINUSE                                 │
│      │   captura stdout/stderr → /logs/ingest do server (batched) │
│      │   persiste exit signature em last_child_exit_*.json        │
│      │                                                            │
│      ├──► server.js (HTTP API + dashboards, port $PORT)           │
│      │      • /lol-matches, /odds, /record-tip, /claude proxy ... │
│      │      • /admin/* (login, today, sport-detail, env-audit ...)│
│      │      • Endpoints de calibração (/admin/mt-refit-calib)     │
│      │      • SSE /logs/stream                                    │
│      │      • SQLite via volume Railway (/data/sportsedge.db)     │
│      │      • WAL mode, checkpoint TRUNCATE, journal_size_limit   │
│      │      • signal handlers SIGTERM/SIGINT (graceful shutdown)  │
│      │                                                            │
│      └──► bot.js (Telegram + análise + crons)                     │
│             • Polls de cada sport (cron por sport)                │
│             • runAutoAnalysis (LoL/Dota) + pollSport (CS/Val/...)  │
│             • IA (DeepSeek) via /claude proxy do server           │
│             • Cron handlers (auto-shadow, healer, guardian, ...)  │
│             • Telegram bots (1 token por sport, 6 bots total)     │
│             • Mesma DB (WAL mode mode garante leitura concorrente)│
└───────────────────────────────────────────────────────────────────┘
```

### Por que dois processos?

- **Isolamento de falhas:** crash do bot.js (Telegram polling, scrapers) não derruba HTTP API que outros sistemas (dashboard, agentes externos) dependem.
- **Restart independente:** isotonic refresh ou OOM em scrapers reinicia só bot.js (servidor mantém uptime).
- **DB compartilhada via WAL:** ambos abrem `sportsedge.db` em modo WAL — leituras paralelas, writes serializados.

### Comunicação

- **bot.js → server.js:** HTTP localhost (`http://localhost:$PORT/...`). Padrão usado para `/odds`, `/record-tip`, `/claude`, agents/*, e self-call em /admin/*.
- **server.js → bot.js:** não direta — bot polla DB pra detectar mudanças (ex: tips voided manualmente).
- **start.js → server.js:** batched POST `/logs/ingest` com stdout dos children.

---

## Esportes suportados

| Sport | Bot Telegram | Odds primária | Stats live | Modelo P | IA | Status |
|---|---|---|---|---|---|---|
| **LoL Esports** | `@Lolbetting_bot` | Pinnacle (per-map via `period=N`) → SX.Bet alt | Riot API + PandaScore + gol.gg | Logistic+GBDT+isotonic (lol-weights.json) | DeepSeek | ML real disabled → MT shadow puro |
| **Dota 2** | (compartilha bot LoL) | Pinnacle per-map → SX.Bet alt | OpenDota + Steam Realtime API (~15s vs 3min) | Logistic+isotonic+momentum (dota2-weights.json) | DeepSeek | ML disabled → MT promoted |
| **CS2** | `@Csbettor_bot` | Pinnacle (tier-1 detection) | HLTV scorebot + cs-map-model | Elo + HLTV form + isotonic (cs2-weights.json) | DeepSeek | ML disabled → MT promoted |
| **Valorant** | (compartilha bot CS) | Pinnacle | VLR.gg (mapa/round/side/score) | Logistic + Bayesian map→série + isotonic (valorant-weights.json) | DeepSeek | ML shadow only |
| **MMA/Boxe** | `@Ufcbettor_bot` | The Odds API (prefere Pinnacle/Betfair) | ESPN + Sofascore fallback | Record + ufcstats (mma-weights.json) | DeepSeek | Disabled (default 2026-05-04) |
| **Tennis** | `@Tennisbet1_bot` | Pinnacle → The Odds API | Sofascore live | Sackmann Elo + trained logistic + Markov (tennis-weights.json) | DeepSeek | Trained model + Markov ativo; calib refit nightly |
| **Football** | `@Betfut1_bot` | The Odds API + Pinnacle | API-Football + Sofascore + ESPN soccer | Poisson trained + DC + home boost + xG/SoT + fd_features | DeepSeek | MT promoted |
| **Darts** | `@Dartsbet_bot` | Sofascore | Sofascore (sets/legs) | 3DA + WR sample-weighted (darts-weights.json) | DeepSeek | Disabled (default 2026-05-04) |
| **Snooker** | `@Snookerbet_bot` | Pinnacle / Betfair | CueTracker WR (cache 6h) | ranking-log + WR (snooker-weights.json) | DeepSeek | Disabled (default 2026-05-04) |
| **Table Tennis** | `@TTbettor_bot` | Pinnacle | Sofascore | Elo + form (sample-weighted) | DeepSeek | Marginal |
| **Basket NBA** | (admin DM) | Pinnacle + ESPN | ESPN + Pinnacle | logistic + isotonic + Elo blend (basket-trained.js) | — | Shadow fase 1 (promote critério ≥30 + CLV≥0 em 2sem) |

**Focus funnel (2026-04-24):**
- **Primary** (full dispatch): LoL, CS2, Tennis
- **Shadow** (`<SPORT>_SHADOW=true`): Dota2, Valorant, MMA, Darts, Snooker, Football, TT
- **Disabled hard:** MMA, Darts, Snooker (default 2026-05-04 via `<SPORT>_ENABLED=false`)

---

## Quick start

### Pré-requisitos

- Node.js >= 18
- 6 tokens de bot do Telegram (@BotFather)
- Chaves de API: DEEPSEEK_API_KEY, THE_ODDS_API_KEY, PANDASCORE_TOKEN, LOL_API_KEY (Riot), API_FOOTBALL_KEY, STEAM_WEBAPI_KEY
- Volume persistente para `sportsedge.db` (Railway: `/data/`)

### Instalação

```bash
git clone https://github.com/Dogzera1/SportsEdge-Bot.git
cd SportsEdge-Bot
npm install
cp .env.example .env
# Editar .env com tokens
node start.js
```

### .env mínimo

```env
PORT=3000
DB_PATH=sportsedge.db

# Telegram
TELEGRAM_TOKEN_ESPORTS=<token>     # cobre LoL + Dota 2
TELEGRAM_TOKEN_CS=<token>          # cobre CS2 + Valorant
TELEGRAM_TOKEN_MMA=<token>
TELEGRAM_TOKEN_TENNIS=<token>
TELEGRAM_TOKEN_FOOTBALL=<token>
TELEGRAM_TOKEN_DARTS=<token>
TELEGRAM_TOKEN_SNOOKER=<token>

# IA
DEEPSEEK_API_KEY=sk-...

# Odds
THE_ODDS_API_KEY=<key>
PINNACLE_LOL=true
PINNACLE_DOTA=true
PINNACLE_TENNIS=true
SXBET_ENABLED=true

# Stats
LOL_API_KEY=<riot_key>
PANDASCORE_TOKEN=<token>
API_SPORTS_KEY=<api_football_key>
STEAM_WEBAPI_KEY=<steam_key>
SOFASCORE_PROXY_BASE=https://your-sofascore-proxy.up.railway.app

# Admin
ADMIN_KEY=<chave_aleatoria_longa>
ADMIN_USER_IDS=<seu_telegram_id>

# Sports
ESPORTS_ENABLED=true
TENNIS_ENABLED=true
FOOTBALL_ENABLED=true
CS_ENABLED=true
VAL_ENABLED=true
TT_ENABLED=true
MMA_ENABLED=false
DARTS_ENABLED=false
SNOOKER_ENABLED=false
```

Lista completa: ver [.env.example](./.env.example) (1043 linhas, ~26KB) e seção [Variáveis de ambiente](#variáveis-de-ambiente).

---

## Pipeline de tip (end-to-end)

Para cada sport, o ciclo conceitual é o mesmo:

### 1. Descoberta de partida

```
[Bot loop por sport — cron adaptativo 6-24min]
    │
    ▼
serverGet('/<sport>-matches')
    │
    ▼
[Server agrega APIs paralelas]
    │
    ├── Pinnacle Guest (LoL, Dota, CS, Val, Tennis, Snk, TT, MMA)
    ├── SX.Bet (LoL/Dota live per-map)
    ├── PandaScore (LoL/Dota live status, compositions)
    ├── Sofascore (Darts, Tennis live, Football)
    ├── The Odds API (MMA, Tennis, Football, NBA)
    ├── Riot API (LoL live stats)
    ├── OpenDota + Steam RT (Dota live snapshots)
    ├── VLR.gg (Valorant live HTML)
    ├── HLTV scorebot (CS live scoreboard)
    ├── ESPN (Football, NBA, MMA, Tennis)
    ├── API-Football (Soccer fixtures, H2H, standings)
    ├── football-data.co.uk (CSV histórico — fd_features)
    ├── gol.gg (LoL kills/objectives scraping)
    ├── OracleElixir (LoL feature mining)
    └── Stratz (Dota draft matchups)
    │
    ▼
[Merge/dedup + normalize]
    │
    ▼
[{ id, team1, team2, league, status, time, odds, _allOdds, ... }]
    │
    ▼
[Bot filtra: live + upcoming <6h + relevant league]
```

### 2. Pré-filtro ML (antes de IA — economiza tokens)

```js
// lib/ml.js → esportsPreFilter (genérico)
// lib/<sport>-ml.js → modelo específico

const { modelP1, modelP2, edge, factorCount } = preFilter(match, ctx);
if (factorCount === 0 || Math.abs(edge) < 3) return; // skip
```

Modelos chamados:
- `lib/lol-model.js` + `lib/lol-series-model.js` + `lib/lol-map-model.js`
- `lib/dota-map-model.js` + `lib/dota-hero-features.js`
- `lib/cs-ml.js` + `lib/cs-map-model.js`
- `lib/valorant-ml.js`
- `lib/tennis-model.js` + `lib/tennis-model-trained.js` + `lib/tennis-markov-model.js`
- `lib/football-ml.js` + `lib/football-model.js` + `lib/football-poisson-trained.js` + `lib/football-data-features.js`
- `lib/darts-ml.js` / `lib/snooker-ml.js` / `lib/tabletennis-ml.js`

### 3. Enrichment de contexto (paralelo)

```
- collectGameContext (live stats: gold, kills, dragons, comp, score, momentum)
- fetchEnrichment (forma, H2H, ESPN records, Sofascore stats)
- fetchMatchNews (Google News RSS, 48h)
- Patch meta (LoL ddragon, 14d cache)
- Tournament tier classification (lib/league-tier.js, mt-tier-classifier.js)
- League trust score (lib/league-trust.js)
- Player-level features (oracleselixir-player-features, tennis-player-stats)
- Roster sub detection (lol-roster-sub, dota-roster-detect)
- Tennis Markov (Barnett-Clarke + sets + tiebreak)
- Tennis fatigue decay (até -70 pts Elo)
- Tennis injury risk (RET/W/O/bagels)
- Dota draft matchup (lib/stratz-dota-scraper)
- CS HLTV form + Elo
- Football fd_features (CSV-driven xG/SoT/cards/etc.)
```

### 4. Cálculo de P final + odds

```
1. preFilter → modelP_raw
2. Calibração isotonic (lib/<sport>-isotonic.json) → modelP_calib
3. Calibração Markov (tennis only) → modelP_calib2
4. CLV calibration layer (puxa em direção close line) → modelP_final
5. Learned corrections (per regime/tier) → modelP_corrected

Odds:
1. Pinnacle (sharp anchor)
2. Devig (lib/devig.js — power method)
3. impliedP_dejuiced
4. Edge = modelP_final - impliedP_dejuiced
5. EV = modelP_final * odd - 1
```

### 5. IA (DeepSeek) — segunda opinião opcional

```
- Bot envia contextBlock (Elo, form, H2H, live stats, news) + P do modelo
- IA retorna {pick, P_ia, conf, reason}
- _validateTipPvsModel: se |P_ia - P_modelo| > 8pp → rejeita
- IA NÃO decide P; só sugere; AI_DISABLED=true desativa cross-sport
```

### 6. Gates (rejeição)

Em ordem:

1. **Dedup** (mesmo match+market+side+line já analisado <TTL)
2. **Sharp divergence gate** (|modelP - impliedP_pinnacle_dejuiced| > cap) → reject
3. **Bucket gate** (`ODDS_BUCKET_BLOCK`, `<SPORT>_ODDS_BUCKET_BLOCK`) → reject
4. **EV gate** (EV < `<SPORT>_MIN_EV` + `PRE_MATCH_EV_BONUS` se pre)
5. **EV cap** (`TIP_EV_MAX_PER_SPORT` — cap ROI tóxico em EV>30%)
6. **Brier auto-cap** (`BRIER_AUTO_EV_CAP` reduz cap quando Brier degrada)
7. **HIGH_EV_THROTTLE** (multiplier 0.6 default ON em buckets EV>12%)
8. **Conf gate** (BAIXA bloqueada por default em alguns sports)
9. **Tier gate** (CS tier 2+ exige EV >8%, conf MÉDIA, stake 1u)
10. **MT leak guard** (auto-disable (sport, market, league) com CLV leak)
11. **Match stop-loss** (`MATCH_STOP_LOSS_UNITS=2` — máx 2u perda por match)
12. **Daily tip limit** (`DAILY_TIP_LIMIT` per sport)
13. **Per-match cap** (`maxPerMatch` LoL/Dota/CS/Val/Tennis)
14. **Per-tournament cap** (`MAX_TIPS_PER_TOURNAMENT_PER_DAY=8`)
15. **CLV pre-dispatch gate** (odd subiu >threshold em N min = stale)
16. **Stale line gate** (Pinnacle moveu mas casa não — possível stale)
17. **Min/max odds** (`<SPORT>_MIN_ODDS`, `<SPORT>_MAX_ODDS`)
18. **League blocklist** (manual + auto via league-bleed)
19. **Path-guard** (rejeita pipeline path com regressão Brier)
20. **AI validation** (IA reverter divergência grande)

### 7. Risk / staking (Kelly)

```
Kelly fraction f = (P*(odd-1) - (1-P)) / (odd-1)
stakeUnits = f * KELLY_MULT_<SPORT>_<CONF>
            * pre_match_multiplier (default 1.0; reduced em pre-match risk)
            * stake_context_mult (ultra_low 0.70 / low 0.90 / high 1.05 — cs/dota)
clamp(MIN_STAKE, MAX_STAKE_UNITS)
```

Auto-tune diário (cron 8h local) ajusta `kelly_mult` per-sport baseado em ROI+CLV últimos 30d.

### 8. Dispatch DM

```
- format msg: pick + P + odd + EV + stake + reason
- inline button "Apostar" (deeplink livro via lib/book-deeplink.js)
- sendDM via TELEGRAM_TOKEN_<SPORT>
- markAdminDmSent (dedup 24h)
- /record-tip persiste em DB (sport, match, market, side, line, P, odd, stake, ev, clv_pct, tip_context, regime_tag, ...)
```

### 9. Settlement

```
[Cron 30min — settleCompletedTips]
    │
    ▼
[Pre-sync match_results das APIs (Sofascore, ESPN, Pinnacle, gol.gg, HLTV, ...)]
    │
    ▼
[Para cada pending tip: lookup match_results via fuzzy (lib/name-match.js)]
    │
    ▼
[Settle: result=win/loss/push/void; profit, banca update]
    │
    ▼
[Propagator: tips ↔ market_tips_shadow same match → mesmo result]
    │
    ▼
[Audit: settlement_audit row p/ rastreabilidade]
```

### 10. CLV capture

```
[Cron close-line — captura odd Pinnacle no kickoff]
    │
    ▼
[Calcula clv_pct = (1/close_odd - 1/tip_odd) / (1/tip_odd) * 100]
    │
    ▼
[Persiste em tips.clv_pct + market_tips_shadow.clv_pct]
    │
    ▼
[Throttled DMs CLV<-5% pra audit liga]
```

---

## Modelos

### Esports

| Model | Path | Algoritmo | Features principais |
|---|---|---|---|
| LoL series | `lib/lol-series-model.js` | Logistic+isotonic | Bo3/Bo5 series prob via map prob |
| LoL map | `lib/lol-map-model.js` | Logistic+isotonic + GBDT | Patch meta, comp, regional strength, OE features |
| LoL kills | `lib/lol-kills-model.js` + `lib/lol-kills-calibration.js` | Poisson player-level | Kills médios + std + opponent allow |
| Dota map | `lib/dota-map-model.js` | Logistic+isotonic + momentum | Hero matchup (Stratz), draft, side, momentum (streak/wr_trend) |
| CS map | `lib/cs-map-model.js` | Elo + HLTV form | Per-map CT advantage (Anubis 5%, Dust2 1%), team1IsCT shift |
| Valorant | `lib/valorant-ml.js` | Logistic + Bayesian map→série | Map prob, side, momentum |

**Trained models:** `lib/{lol,dota2,cs2,valorant,tennis,football}-weights.json` + `lib/<sport>-isotonic.json`. Refit nightly via `scripts/refresh-all-isotonics.js` (cron `NIGHTLY_RETRAIN_AUTO=true`).

### Tennis

- **Sackmann Elo** (per-surface) → P_elo
- **Trained logistic** (`lib/tennis-model-trained.js`, weights.json) → P_trained, **active default**
- **Markov motor** (`lib/tennis-markov-model.js`) — Barnett-Clarke ML + sets + totals + tiebreak
- **Markov calib** (`lib/tennis-markov-calib.js` + `tennis-markov-calib.json`) — PAV + Beta smoothing per market (handicapGames, totalGames). **Refit nightly cron 04h** via `/admin/mt-refit-calib?sport=tennis&days=90&write=true`
- **Markov shrink universal pós-calib** — `0.5 + k * (pCalib - 0.5)` p/ corrigir overconfidence residual (k=0.75 handicap, 0.65 total)
- **Edge tiered:** Slam/Masters 2.5pp; demais 4.0pp
- **Injury risk:** RET/W/O/bagels → downgrade conf + shrink P
- **Tiebreak rolling:** TB W/L per jogador 12m
- **Fatigue decay:** até -70 pts Elo
- **Round/segment stack:** Slam×1.15 + F×1.06 = ×1.22

### Football

- **Poisson trained** (`lib/football-poisson-trained.js`) — μ_home, μ_away, ρ (Dixon-Coles)
- **fd_features** (`lib/football-data-features.js`) — CSV-driven xG/SoT/cards/corners (football-data.co.uk)
- **football-ml** (`lib/football-ml.js`) — feature wrapper + ensemble
- **football-model** (`lib/football-model.js`) — pré-Poisson legacy
- **xG_per_SoT=0.32** (lit avg 0.30-0.34)
- **Direction codes** (não labels): H/D/A; **Home boost** controlled

### Outros

- **MMA:** record + ufcstats scraper
- **Darts:** 3DA + WR sample-weighted (jogadores <10 jogos atenuados)
- **Snooker:** ranking-log + CueTracker WR
- **TT:** Elo + form
- **Basket NBA:** logistic+isotonic 2798 games (2 seasons), Brier 0.188 / lift +24%; blend trained+Elo (w=0.65)

---

## Camadas de calibração

Em ordem de aplicação:

### 1. Isotonic per-sport

`lib/<sport>-isotonic.json` — função monotônica P_raw → P_calib via PAV (Pool Adjacent Violators). Treinado contra outcome real settled.

- **LoL isotonic disabled** (`LOL_ISOTONIC_DISABLED=true`) — refit Brier 0.25→0.27 piorou em 2026-04-24
- **Tennis isotonic disabled** (`TENNIS_ISOTONIC_DISABLED=true`) — overshoot bucket 2.20-3.00, ROI -64%
- **CS2/Dota2/Valorant** ativos (Brier ECE -35-70%)

### 2. Markov calib (tennis only)

`lib/tennis-markov-calib.js` — PAV + Beta smoothing per market sobre P do Markov pre-jogo. Resolve overconfidence sistemática (P_med 0.78 em handicapGames com hit real <70%).

- **Refit nightly** cron 04h local (commit `fe16e55` 2026-05-06)
- **Cache TTL 30min** sem restart
- **Shrink universal pós-calib** k=0.75/0.65

### 3. EV → ROI calibration

`lib/ev-calibration.js` — data-driven per (sport, ev_bucket). Sobrescreve `HIGH_EV_THROTTLE` quando n≥10. Cron 6h.

- Endpoint: `/admin/ev-calibration`
- Preserva CS 8-12% bucket (ROI +29.9%)
- Aplica throttle severo em EV>30% (gap+50pp em 5 sports)

### 4. CLV calibration layer

`lib/clv-calibration.js` — terceira camada pós-isotonic puxa P em direção da closing line.

- Lit: arxiv 2410.21484
- Default blend 0.30
- Wired em LoL/Tennis/Dota2/CS2 trained
- Opt-out: `CLV_CALIB_DISABLED=true`

### 5. Learned corrections

`lib/learned-corrections.js` (mig 090) — per (sport, regime, tier, market) corrections aprendidas via readiness-learner. Cron noturno.

### 6. Readiness learner

`lib/readiness-learner.js` (mig 089) — observa decisões de readiness (block alert vs OK) e aprende corrections incrementais.

---

## Gates anti-edge-fictício

### Sharp divergence gate

`bot.js::_sharpDivergenceGate` — bloqueia tip se `|modelP - impliedP_pinnacle_dejuiced| > cap_sport`. Tier-aware.

| Sport | Default cap | Env override |
|---|---|---|
| MMA | 10pp | `MMA_MAX_DIVERGENCE_PP` |
| Football | 10pp | `FOOTBALL_MAX_DIVERGENCE_PP` |
| CS | 12pp | `CS_MAX_DIVERGENCE_PP` |
| Tennis | 20pp | `TENNIS_MAX_DIVERGENCE_PP` (era 15, relaxado 2026-04-18) |
| Valorant | 12pp | `VAL_MAX_DIVERGENCE_PP` |
| LoL/Dota | 15pp | `LOL_MAX_DIVERGENCE_PP` / `DOTA_MAX_DIVERGENCE_PP` |
| Darts/Snooker | 15pp | `<SPORT>_MAX_DIVERGENCE_PP` |
| TT | 20pp | `TT_MAX_DIVERGENCE_PP` |

### Bucket gate

`lib/odds-bucket-gate.js` — bloqueia odds em faixa com leak comprovado.

```
ODDS_BUCKET_BLOCK=2.20-3.00            # cross-sport
LOL_ODDS_BUCKET_BLOCK=3.00-99
VALORANT_ODDS_BUCKET_BLOCK=2.20-99
```

**Auto-guard cron 12h** (`ODDS_BUCKET_GUARD_AUTO=true`) — auto-block (sport, bucket) quando n≥30 + ROI≤-10% + CLV≤-2%; auto-restore se ROI recupera.

### EV cap per-sport

`TIP_EV_MAX_PER_SPORT` — cap final no EV alvo (defaults 25-35 dependendo do sport, audit 2026-05-04 mostrou EV>30% sangra catastrófico em todos sports).

```
LOL_MT_EV_MAX=20, CS2_MT_EV_MAX=20, DOTA_MT_EV_MAX=20
TENNIS_MT_EV_MAX=25, FOOTBALL_MT_EV_MAX=20
```

### Pre-match EV bonus

`PRE_MATCH_EV_BONUS` — adiciona EV mínimo em tips PRE (pré-match tem ROI muito pior que LIVE em vários sports — odds estáticas viram fantasma quando mercado move).

```
CS_PRE_MATCH_EV_BONUS=5      # CS PRE -53% vs LIVE +19% (gap 72pp)
VAL_PRE_MATCH_EV_BONUS=4
LOL_PRE_MATCH_EV_BONUS=4
```

### Gates auto-tune

`lib/gates-runtime-state.js` — DB-backed runtime state com cron 12h. Auto-ajusta `PRE_MATCH_EV_BONUS` e `MAX_STAKE_UNITS` por sport. Env override sempre vence auto-tune.

### Path-guard

`runDriftGuardCycle` — observa pipeline path (combinação de calibrações/gates). Persiste regressão Brier per-path em DB. Bloqueia path com regressão sustentada.

---

## Risk management & banca

### Banca per-sport (tier-based)

`lib/sport-unit.js` — cada sport tem `unit_value` independente baseado em tier:

```
0.5u → low-tier (darts, snk legacy)
0.6u
0.8u
1.0u → default
1.2u → cs2/dota2 promoted
1.5u
2.0u
3.0u → tennis premium
```

**Banca rebalance** via `scripts/rebalance-bankroll-1000.js` (10 sports × R$100 inicial) e `scripts/reset-equity.js` com `--dry-run`/`--confirm`.

Tabela `bankroll` per-sport: `current_amount`, `initial_amount`, `unit_value`, `last_updated`. Migrações 033-038 split → bump → revert → rebuild → align.

### Kelly

`lib/risk-manager.js::computeKellyStake(P, odd, opts)` — Kelly fracionado:

```
f_kelly = (P*(odd-1) - (1-P)) / (odd-1)
stake = f_kelly * KELLY_MULT_<SPORT>_<CONF> * stake_context_mult
clamp(MIN_STAKE, MAX_STAKE_UNITS)
```

**Defaults conservadores:**
- ALTA: 0.40
- MÉDIA: 0.25
- BAIXA: 0.10
- Dota2 cut: 0.20 (CLV -45% leak 2026-04-23)

**Override per-sport:** `KELLY_<SPORT>_<CONF>` → `KELLY_<CONF>` → default

**Auto-tune diário** (`runKellyAutoTune`): rolling 30d ROI+CLV → ajusta `kelly_mult` em `gates_runtime_state`. Step up +0.05 / down -0.10. Bounds [0.20, 1.20]. Cron 8h local. Opt-out `KELLY_AUTO_TUNE=false`.

### Bankroll Guardian

`runBankrollGuardian` — adaptive thresholds por banca:
- Small (<R$100): DD 45/28/18%
- Big (≥R$100): DD 35/20/12%

Cron 1h. Auto-skip esports legacy bucket. Pause sport quando DD breach.

### Stake adjuster

`lib/stake-adjuster.js` — `detectStakesContext` → multiplier:
- ultra_low ×0.70
- low ×0.90
- high ×1.05

Wired em Dota/CS.

### Risk peak reset

Sprint 13 pendente — reset peak watermark periodicamente pra DD não acumular regime change.

---

## Market Tips (MT)

Sistema paralelo de detecção de tips em **markets secundários** (handicap, totals, kills, sets, etc.) — separado de ML core (1X2/match winner).

### Pipeline

```
[Scanner per sport]
    │ lib/<sport>-mt-scanner.js (tennis, football, basket, lol-extra-markets, dota-extras-scanner, odds-markets-scanner)
    ▼
[lib/market-tip-processor.js — gate EV>=8% + pModel>=55% + Kelly 0.10 + tier classifier]
    │
    ▼
[Shadow log primeiro — lib/market-tips-shadow.js]
    │ Migs 024/025/026: market_tips_shadow + admin_dm + clv
    │ Mig 054: is_live col
    │ Mig 055: model_version
    │ Mig 088: regime_tag
    │ Mig 091: tier
    ▼
[Backtest periódico — scripts/backtest-market-tips.js]
    │
    ▼
[Auto-promote — lib/mt-auto-promote.js]
    │ Critérios: n≥30 + CLV≥0 + ROI≥0 em 14d
    │ Mig 077: mt_auto_promote table
    │ Cron 12h
    ▼
[Promote: dispatch real (DM admin → DM users)]
    │ Mig 050/051/063/091: mt_runtime_state side+league+tier
    ▼
[Leak guard — auto-disable (sport,market,league,tier) com CLV leak]
    │ MT_LEAK_GUARD_AUTO=true (default)
    ▼
[Result propagator — lib/mt-result-propagator.js]
    │ tips ↔ market_tips_shadow same match → mesmo result
```

### Tier classifier

`lib/mt-tier-classifier.js`:
- **tennis:** tier1_slam, tier2_atp_500, tier2_masters, tier3_atp_250, tier3_wta125, tier4_challenger, tier_quali_or_early (Q1/Q2/R1/R2)
- **lol:** tier1_la_liga (footbol Spain), tier2_regional (LCK CL), tier1_brazil_b
- **cs2:** tier1_premier, tier2_secondary (ESL Challenger SA, CCT SA)

**Stake mults aplicados:**
- cs2 tier2_secondary 1.3× (+63% ROI CLV+14%)
- lol tier2_regional 1.2× (+26% ROI)
- tennis tier4_challenger 0.6× (-10%)
- football tier1_la_liga totals 0.7×
- football brasileirão B 1.15× (+42%)
- tennis Q1/R1/R2 0.5×

### Markets cobertos

- **Tennis:** handicapGames, totalGames, sets handicap, sets total, aces total
- **Football:** OVER/UNDER 2.5, BTTS, AH, totals, halves
- **LoL:** total kills (player+map), total dragons, total towers, handicap maps
- **Dota:** total kills, handicap maps
- **CS2:** total maps, handicap maps
- **NBA:** spread + totals (Normal CDF μ=rolling pace/def σ=18/13)

### Promoted (2026-05)

- **Football MT** (2026-05-03) — ROI +40,9%, hit 71%, CLV 0
- **CS2 MT** (2026-04-25 pending → 2026-05-04 promoted) — CLV+12
- **Dota2 MT** (2026-05-04) — CLV+10,6

### Audit endpoints (`/admin/...`)

- `mt-status` — promote state per (sport, market, tier)
- `mt-shadow-audit` — shadow stats
- `mt-shadow-comprehensive-audit`
- `mt-shadow-by-league` + `mt-shadow-by-ev`
- `mt-historical-learnings` (6 análises)
- `mt-promote-status`
- `mt-disable-list` (runtime disabled)
- `mt-calib-validation` (drift detection)
- `mt-brier-history` (Brier semana)
- `mt-refit-calib` (refit isotônico)

---

## Shadow mode

Toggle global por sport via `<SPORT>_SHADOW=true`. Quando shadow:

1. Tip passa por todos os gates igual modo real
2. **Não dispatcha DM**
3. Persiste em `tips` com `is_shadow=1` (mig 015) e `tip_context.shadow_reason`
4. Settlement normal pra cálculo retroativo de ROI/CLV/Brier
5. Cards dashboard "🥷 ML Shadow" mostram performance per sport
6. **PROMOVER** badge quando n≥30 + ROI≥0 + CLV≥0

**Use cases:**
- Sport novo (Basket NBA fase 1)
- ML real disabled (LoL ML, CS ML, Tennis ML — bleeding ROI mas mantém data)
- A/B test gates (sprint experimental)
- Pre-deploy validation

**Regime tag** (mig 088): separação entre regimes A/B/C pra audits cruzando datas com mudanças significativas (2026-04-22 bucket gate, 2026-05-03 audit P0).

**ML disabled auto-route** (2026-05-05): em vez de rejeitar tip, rota pra shadow. Hard reject opt-in via `ML_DISABLED_HARD_REJECT=true`.

---

## CLV tracking

CLV = Closing Line Value = % a favor da odd da tip vs odd Pinnacle no kickoff dejuiced. Métrica gold-standard pra detectar edge real.

```
clv_pct = (1/close_odd_dejuiced - 1/tip_odd) / (1/tip_odd) * 100
```

### Capture

- **Cron close-line capture** — captura odd Pinnacle no momento do kickoff
- Persiste em `tips.clv_pct` (mig 080) e `market_tips_shadow.clv_pct` (mig 026)
- **Throttle DM** quando CLV<-5% (audit liga)
- **CLV pre-dispatch gate** (`CLV_PREDISPATCH_GATE=true`) — odd subiu >2.5% em 10min = sharp money entrou no lado oposto = stale
- **CLV race fix** (mig 081/082) — evitava update first-wins corrompendo CLV

### Análises

- `scripts/clv-by-league.js` — flag ligas com CLV neg persistente
- `scripts/clv-coverage.js` + `clv-coverage-gap.js` — qual % das tips tem CLV capturado
- `scripts/clv-leak-diagnosis.js` — diagnóstico per (sport, league, market)
- `/clv-histogram` — distribuição CLV
- `/admin/clv-capture-trace` — diag granular

### MT skip

`lib/clv-capture.js` — **pula MT (não-ML)** e rejeita CLV >3× prev (mig 080+).

---

## Settlement

### Auto

`bot.js::settleCompletedTips` — cron 30min:

1. **Pre-sync match_results** das APIs (Sofascore, ESPN, Pinnacle, gol.gg, HLTV, OpenDota, ufcstats)
2. **Iterar tips pendentes** em janela esports -24h/+7d
3. **Match lookup fuzzy** via `lib/name-match.js` (strict → fuzzy → lastname; threshold ≥0.5 + aliases). Tennis: tiebreak via league overlap.
4. **Pickbest tennis** quando ambíguo
5. **Settle** result=win/loss/push/void, profit, banca update
6. **Propagator** — tips ↔ market_tips_shadow same match → mesmo result
7. **Audit row** em `tip_settlement_audit` (mig 073)

### Force-settle (admin)

- `/admin/run-settle` — force-settle window (com guardrail temporal — fix Garin/Echargui 2026-05-03)
- `/admin/tennis-force-settle-tip` — manual single tip
- `/admin/settle-market-tips-shadow` + `/admin/settle-mt-shadow-kills`
- `/settle` Telegram cmd (admin only)

### Void

- `/void-tip` (admin) + `/admin/reanalyze-void`
- `AUTO_VOID_STUCK_AUTO=true` — auto-void tips pendentes >3d (era 14d, reduced 2026-05-01)
- `LIVE_RISK_MONITOR_AUTO=true` — auto-void tips live com risco extremo (queue collapse)
- Pattern detection via `/void-audit`

### Settlement quarantine

Tips que falharam match lookup repetidamente vão pra quarantine (counter `settle_quarantine`). Manual review via `/admin/forensics`.

---

## Crons / loops autônomos

| Cron | Cadência | Função |
|---|---|---|
| `lol/dota/cs/val/tennis/...` polls | 6-30min adaptativo | Discover + analyze |
| `auto_shadow` | 6h | Shadow stats summary |
| `auto_healer` | 5min | Detecta + cura anomalias (mutex stale, polls silentes, ai backoff stuck) |
| `bankroll_guardian` | 1h | Adaptive DD thresholds per sport |
| `weekly_recalc` | 7d | Recalc weights/baselines |
| `autonomy_digest` | 24h | DM admin daily digest |
| `db_backup` | 24h (4h UTC) | VACUUM INTO snapshot |
| `leaks_digest` | 24h (13h UTC) | DM top leaks (n≥20, ROI≤-15%) |
| `mt_restore` | 24h (14h UTC) | Sugere remover bloqueados que recuperaram |
| `scraper_smoke` | 24h | Daily scraper health check |
| `weekly_digest` | 7d (Mon 14h UTC) | Weekly summary |
| `nightly_retrain` | 24h (3h UTC) | refresh-all-isotonics.js |
| `tennis_calib_refit` | 24h (4h local) | /admin/mt-refit-calib?sport=tennis (commit fe16e55) |
| `path_guard` | 6h | Pipeline path regression detect |
| `league_bleed` | 6h | Detect liga sangrando |
| `pipeline_digest` | 6h | Pipeline summary |
| `mt_bucket_guard` | 12h | MT scanner odd floor/cap auto-tune |
| `gates_autotune` | 12h | EV bonus + stake cap auto-tune |
| `league_guard` | 12h | League-level kelly_mult tune |
| `odds_bucket_guard` | 12h | (sport, bucket) auto-block leaks |
| `mt_auto_promote` | 12h | Promote/revert (sport, market, tier) |
| `model_calibration` | 24h | Calibration drift check |
| `backtest_validator` | 24h | Validate model via gates retroativos |
| `post_fix_monitor` | 24h | Alert se sport sangra pós gate-fix |
| `live_storm` | 10min | Flip into/out-of storm mode |
| `kelly_auto_tune` | 24h (8h local) | Per-sport kelly_mult tune |
| `roi_drift_cusum` | 24h (9h local) | CUSUM regime change |
| `clv_capture` | per match | Captura close line |
| `mem_watchdog` | continuous | RSS monitoring (P95×1.3 baseline) |
| `polymarket_watcher` | 5min | Cross-validation copy-trading |
| `stale_line_detector` | 5min | Pinnacle moveu vs casa não |
| `super_odd_detector` | 5min | Book>20% acima Pinnacle |
| `arb_detector` | 5min | Arb 2-way esports + 3-way football |
| `velocity_tracker` | 5min | Pinnacle >3%/5min = sharp money |
| `book_bug_finder` | 5min | Anomalias de odds |

Heartbeats em `/cron-heartbeats` ou `/admin/cron-status`.

---

## Detectores cross-book

Loops que comparam odds entre books pra detectar oportunidades sem depender de modelo.

### Stale Line Detector

`lib/stale-line-detector.js` (mig 057) — Pinnacle moveu >5% em 15min mas casa soft permanece na odd antiga = stale → DM admin (cooldown 1h por match). Cobertura: football, LoL silent.

### Super-Odd Detector

`lib/super-odd-detector.js` (mig 058) — book>20% acima Pinnacle (promo/erro de pricing). DM football. Devig aplicado.

### Arb Detector

`lib/arb-detector.js` (mig 059) — arb 2-way esports + 3-way football. DM stake split com payout garantido.

### Velocity Tracker

`lib/velocity-tracker.js` (mig 060) — Pinnacle >3% em 5min = sharp money entrou. Reusa ring buffer compartilhado.

### Book Bug Finder

`lib/book-bug-finder.js` (mig 061) — anomalias de pricing (odd duplicada com line diferente, totals invertidos, etc.).

### Cross-book sem Pinnacle

Quando Pinnacle ausente (rare), detectores funcionam com **mediana** das casas como reference.

### Bookmaker Delta BR

`lib/bookmaker-delta.js` (mig 056) — calibra book BR vs Pinnacle. `/odd-sample` + `/admin/bookmaker-deltas`.

---

## Polymarket integration

Mini-Predex cross-validation copy-trading (2026-05-04, migs 084-086):

- **Notify $1000+ DCA agg** — wallets com DCA agressivo
- **Multi-wallet consensus** (≥3 sharps) — DM com tip context
- **Auto-discovery sport sharps** — wallets recorrentes em sports
- **Realized PnL via outcome resolution** (mig 086)
- **BI dashboard `/pm`**

`lib/polymarket-watcher.js` cron 5min.

---

## Auto-healer & health sentinel

### Health Sentinel

Detecta anomalias:

- **mutex_stale** (autoAnalysisMutex.locked travado)
- **poll_silent_<sport>** (poll não roda há >2x cadência esperada)
- **ai_backoff_long** (DeepSeek backoff travado)
- **auto_shadow_not_running**
- **vlr_zero_unexpected** (VLR retorna 0 matches inesperado)

### Auto-healer

`lib/auto-healer.js` — registry de fixes:

```js
{
  severity: 'critical' | 'warning',
  precondition: ({ ctx, anomaly }) => { ok: bool },
  action: ({ ctx, anomaly, pre }) => { applied: string },
  validate: ({ ctx, anomaly }) => { ok: bool }
}
```

Fluxo cron 5min:
1. Run sentinel → anomalies
2. Build ctx com refs do bot (mutex, pollFns, vlrModule, log)
3. Run healer → applied/skipped/errors
4. Filter newApplied (cooldown 30min/anomaly_id anti-spam)
5. Filter criticalUnresolved (exclui self-resolved)
6. DM admin

### Agent orchestrator

`lib/agent-orchestrator.js` — workflows compostos:

| Workflow | Steps |
|---|---|
| `full_diagnostic` | sentinel → check_actionable → auto_healer → sentinel_post |
| `coverage_investigation` | live-scout → check_gaps → feed-medic |
| `weekly_full` | weekly_review + roi_analyst + health_sentinel |
| `tip_emergency` | pre-match-check + news-monitor → check_alerts → feed-medic |
| `daily_health` | weekly_review + bankroll_guardian + health_sentinel + ia_health + cut_advisor |
| `incident_response` | sentinel → scout + medic + healer → sentinel_post |
| `model_check` | model_calibration + ia_health + bankroll_guardian |

Endpoint: `GET /agents/orchestrator?workflow=daily_health`

---

## Banco de dados

**SQLite WAL mode** com `journal_size_limit` + checkpoint TRUNCATE. DB unitário (`sportsedge.db`) compartilhado entre `server.js` e `bot.js`.

### Tabelas principais

| Tabela | Propósito |
|---|---|
| `bankroll` | Banca per-sport (mig 001 split lol/dota; tier-aware unit_value) |
| `tips` | Tips reais (40+ cols: P, odd, stake, ev, clv_pct, regime_tag, tip_context_json, settlement_audit) |
| `market_tips_shadow` | MT shadow log (mig 024+) |
| `match_results` | Resultados settled (sport-agnostic) |
| `tip_settlement_audit` | Audit row per settlement (mig 073) |
| `gates_runtime_state` | DB-backed runtime gates state (mig 053) |
| `mt_runtime_state` | MT promote/disable state (migs 050/051/063/091) |
| `league_blocklist` | Manual + auto blocklists (mig 045) |
| `odds_bucket_blocklist` | Auto-bucket blocks (mig 052) |
| `bookmaker_delta_samples` | BR vs Pinnacle delta calib (mig 056) |
| `stale_line_events` / `super_odd_events` / `arb_events` / `velocity_events` / `book_bug_events` | Cross-book detector logs |
| `mt_auto_promote` | Auto-promote state (mig 077) |
| `polymarket_consensus_alerts` / `wallet_metadata` / `paper_trades` / `market_resolutions` | Polymarket integration |
| `oracleselixir_games` / `oracleselixir_players` | LoL feature mining (26k+ rows) |
| `dota_team_rosters` / `dota_hero_stats` / `dota_team_stats` | Dota enrichment |
| `cs_team_stats` / `valorant_team_stats` | Esports stats |
| `tennis_match_stats` / `tennis_player_serve_stats` | Tennis enrichment (5765 rows 2024 ATP+WTA) |
| `understat_matches` | Football xG/SoT |
| `football_data_csv` (+ shots) | football-data.co.uk integration (3317 rows) |
| `lol_game_objectives` | LoL gol.gg objectives |
| `stratz_hero_matchups` | Dota draft |
| `basket_match_history` / `basket_elo` | NBA shadow |
| `learned_corrections` | Per (sport, regime, tier, market) corrections (mig 090) |
| `readiness_corrections_log` | Readiness learner log (mig 089) |
| `error_log` | Centralized errors (mig 075) |
| `tips_shadow_regime_tag` | Regime separation A/B/C (mig 088) |

### Migrations

91 migrations em `migrations/index.js` (single file, ~2300 linhas). Cada migration tem `id`, `up(db)` idempotente. Whitelist guard pra DDL (validar ident regex). Aplicadas no boot do server.

```
GET /migrations-status   # check applied vs available
```

---

## HTTP endpoints (server.js)

~28k linhas. Endpoints categorizados:

### Discovery / odds

- `/lol-matches`, `/dota-matches`, `/cs-matches`, `/valorant-matches`, `/mma-odds`, `/basket-matches`
- `/lol-slugs`, `/lol-raw`, `/live-gameids`, `/ps-compositions`, `/debug-livestats`
- `/opendota-live`, `/ps-dota-live`, `/live-game`
- `/odds`, `/odds-markets`, `/handicap-odds`, `/player-props-debug`, `/sx-status`, `/debug-odds`
- `/dota-map-result`, `/live-snapshot`, `/upcoming-snapshot`, `/debug-vlr`, `/debug-teams`, `/debug-match-odds`, `/debug-map-odds`

### Records

- `/record-tip` (POST) — registra tip (com `lineShopOdds`, `pickSide` opcional)
- `/record-analysis` (POST)
- `/match-result`, `/ps-result`, `/dota-result`, `/cs-result`, `/valorant-result`, `/darts-result`, `/snooker-result`, `/football-result`, `/basket-result`

### Tips queries

- `/tips-history?limit=N&sport=X&filter=settled|open`
- `/shadow-tips`, `/unsettled-tips`, `/cashout-alerts`
- `/market-tips-recent`, `/market-tips-by-sport`, `/market-tips-breakdown`, `/market-tips-by-league`
- `/equity-curve?sport=X&days=N`, `/hourly-roi`, `/shadow-vs-active`
- `/clv-histogram`, `/roi`, `/sports-risk-status`, `/pipeline-status`, `/tips-produced-rate`

### Settle / void

- `/reopen-tip` (POST), `/settle-manual` (POST), `/void-tip`
- `/admin/run-settle`, `/admin/tennis-force-settle-tip`
- `/admin/settle-market-tips-shadow`, `/admin/settle-mt-shadow-kills`, `/admin/settle-mt-shadow-kills-manual`

### Admin (key-protected)

- `/admin/login`, `/admin/logout`, `/admin/me` — cookie-based session
- `/admin/today`, `/admin/sport-detail`, `/admin/cron-status`, `/admin/env-audit`, `/admin/tg-commands`
- `/admin/mt-status`, `/admin/mt-shadow-audit`, `/admin/mt-shadow-comprehensive-audit`, `/admin/mt-shadow-by-league`, `/admin/mt-shadow-by-ev`, `/admin/mt-historical-learnings`, `/admin/mt-promote-status`, `/admin/mt-disable-list`, `/admin/mt-calib-validation`, `/admin/mt-brier-history`, `/admin/mt-refit-calib`
- `/admin/blocklist-stats`, `/admin/cs-live-debug`, `/admin/repair`, `/admin/force-sync-bankroll`, `/admin/move-football-mt-to-shadow`
- `/admin/repair-market-tips-dedup`, `/admin/purge-voided-market-tips`
- `/admin/boot-diag`, `/admin/forensics`, `/admin/quick-stats`
- `/admin/tennis-sources-diag`, `/admin/tennis-tip-match-debug`
- `/admin/basket-seed`, `/admin/basket-train`, `/admin/basket-train-status`, `/sync-basket-espn`
- `/admin/clv-capture-trace`
- `/admin/ev-calibration`
- `/admin/bookmaker-deltas`
- `/admin/oe-status`, `/sync-oe`, `/sync-tennis-espn-range`

### Agentes

- `/agents/orchestrator?workflow=X`
- `/agents/post-fix-monitor`, `/agents/gate-optimizer`, `/agents/sentinel`, `/agents/scout`, `/agents/medic`, `/agents/healer`, `/agents/cut-advisor`, `/agents/ia-health`

### Health / metrics

- `/health`, `/alerts` (cached 10s)
- `/metrics-lite`, `/metrics`, `/health/metrics`
- `/metrics/ingest` (POST — bot heartbeat bridge)
- `/health/metrics.html`, `/metrics.html`

### Logs

- `/logs/ingest` (POST batched from start.js)
- `/logs` (HTML), `/logs/stream` (SSE)
- `/rejections`

### Dashboards

- `/dashboard` (legacy), `/bi` (PowerBI-style v3), `/admin/index.html`, `/admin/today.html`, `/admin/sport-detail.html`, `/admin/cron-status.html`, `/admin/forensics.html`, `/admin/quick-stats.html`
- `/lol-ev-manual` (manual EV calc UI)

### Misc

- `/tennis-elo`, `/football-elo`, `/basket-elo`, `/basket-trained`, `/basket-trained-markets`
- `/users`, `/save-user` (POST)
- `/debug-sport-tips`, `/migrations-status`, `/cron-heartbeats`
- `/odd-sample` (POST — bookmaker delta sample)
- `/ai-stats?month=YYYY-MM` (per-sport AI tracking)
- `/claude` (DeepSeek proxy with rate-limit + retry + per-sport tracking)

---

## Comandos Telegram

### Públicos (todos os bots)

- `/start` — welcome + disclaimer
- `/help` — lista de comandos
- `/stats [sport]` — ROI público + calibração
- `/roi` — alias
- `/stop` — unsubscribe
- `/resub` / `/resubscribe` — re-subscribe

### Admin (ADMIN_USER_IDS only)

- `/users` — count subscribers
- `/resync` — force re-sync
- `/settle` — force settle now
- `/pending` — list pending tips
- `/slugs` — LoL slugs available
- `/lolraw` — Pinnacle LoL raw response
- `/reanalise` — re-analyze last
- `/shadow` — shadow stats summary
- `/tip` — manual tip dispatch
- `/alerts` — current alerts
- `/pipeline-health` / `/pipeline` — sports/tips/modelos/rejections summary
- `/unsettled` / `/settle-debug` — pending tips diag
- `/rejections` — rejection counters by reason
- `/diag` / `/diag-tip` — diag specific tip
- `/loops` — cron heartbeats
- `/path-guard` / `/paths` — pipeline paths state
- `/kelly-config` / `/kelly` — kelly_mult per sport
- `/explore` / `/exploits` / `/explorar` — opportunities scanner
- `/scraper-health` / `/scrapers` / `/scrapers-br` — BR scrapers status
- `/br-edges` / `/edges` / `/edges-now` — BR edges live
- `/casa-stats` / `/casas` / `/scorecard` — bookmakers scorecard
- `/book-bugs` / `/bookbugs` / `/bugs` — book bug events
- `/odd-sample` — sample BR odds
- `/hybrid-stats` / `/hybrid` — hybrid model performance
- `/models` — model freshness + Brier per sport
- `/pause-sport` / `/pause` / `/unpause-sport` / `/unpause` — pause/unpause sport
- `/run-guardian` / `/guardian` — force bankroll guardian
- `/migrations` / `/migrations-status` — DB migrations state
- `/pipeline-status` / `/pipeline` / `/health` — pipeline health
- `/ai-stats` / `/ai` — AI usage per sport
- `/health` — server health
- `/debug` — debug current state
- `/dedup-tips` / `/archive-dupes` — dedup runner
- `/shadow-summary` — cross-sport shadow summary

---

## Dashboards

### Public

- **`/dashboard.html`** (legacy v2) — clean UX, equity curve, hourly heatmap, shadow vs active, leaks card, blocklist card, live tips card, ML shadow per sport
- **`/bi`** (v3 PowerBI-style 2026-05-03) — Chart.js + OKLCH light theme, standalone

### Admin

- **`/admin/index.html`** — admin home with tg-commands list
- **`/admin/today.html`** — daily summary
- **`/admin/sport-detail.html`** — per-sport drill-down
- **`/admin/cron-status.html`** — cron heartbeats grid
- **`/admin/forensics.html`** — settlement forensics
- **`/admin/quick-stats.html`** — quick metrics

### Logs

- **`/logs.html`** — live log tail (SSE) + filters

### Manual tools

- **`/lol-ev-manual.html`** — manual EV calc UI

---

## Estrutura de pastas

```
.
├── start.js              # Launcher (spawns server.js + bot.js)
├── server.js             # HTTP API (~28.5k lines)
├── bot.js                # Telegram + análise + crons (~24k lines)
├── package.json          # only better-sqlite3 + dotenv (zero framework)
├── README.md             # este arquivo
├── WORKFLOW_SPORTSEDGE.md  # Diagrama detalhado pipeline
├── DECISIONS.md          # Decision log cronológico
├── .env.example          # ~26KB, ~1043 linhas — todas vars
├── nixpacks.toml         # Railway build config
├── railway.toml          # Railway deploy config
├── docker-compose.n8n.yml  # n8n local dev
├── sportsedge.db         # SQLite WAL (Railway: /data/sportsedge.db)
├── boot_count.json       # Boot counter
├── last_exit_server.json # Exit signature
├── promote-status.json   # MT promote state cache
│
├── lib/                  # 146 módulos
│   ├── ml.js             # Pre-filter genérico
│   ├── <sport>-ml.js     # Pre-filter per sport
│   ├── <sport>-model.js  # Modelo determinístico
│   ├── <sport>-model-trained.js  # Trained logistic
│   ├── <sport>-weights.json      # Trained weights
│   ├── <sport>-isotonic.json     # Isotonic calib
│   ├── lol-{series,map,kills}-model.js  # LoL hierarchy
│   ├── dota-{map,hero,roster}-*.js
│   ├── cs-{ml,map}-model.js
│   ├── tennis-{markov-model,markov-calib,model-trained,h2h-ensemble,...}.js
│   ├── football-{ml,model,poisson-trained,data-features,live-model,mt-scanner}.js
│   ├── basket-{elo,trained,mt-scanner}.js
│   ├── pinnacle.js       # Pinnacle Guest API client
│   ├── pinnacle-snooker.js
│   ├── betfair.js
│   ├── odds-aggregator-client.js  # Supabase BR
│   ├── sportsbook-1xbet.js
│   ├── line-shopping.js  # Line shop computation
│   ├── devig.js          # Power method devig
│   ├── name-match.js     # Fuzzy match (lib threshold≥0.5 + aliases)
│   ├── elo-rating.js
│   ├── league-tier.js
│   ├── league-trust.js
│   ├── league-rollup.js
│   ├── mt-{auto-promote,result-propagator,tier-classifier}.js
│   ├── market-tip-processor.js
│   ├── market-tips-shadow.js
│   ├── clv-{calibration,capture}.js
│   ├── ev-calibration.js
│   ├── learned-corrections.js
│   ├── readiness-learner.js
│   ├── kelly-auto-tune.js
│   ├── stake-adjuster.js
│   ├── risk-manager.js
│   ├── gate-optimizer.js
│   ├── gates-runtime-state.js
│   ├── pre-match-gate.js
│   ├── odds-bucket-gate.js
│   ├── stale-line-detector.js
│   ├── super-odd-detector.js
│   ├── arb-detector.js
│   ├── velocity-tracker.js
│   ├── book-bug-finder.js
│   ├── bookmaker-delta.js
│   ├── auto-healer.js
│   ├── auto-sample-deltas.js
│   ├── agent-orchestrator.js
│   ├── agents-extended.js
│   ├── feed-heartbeat.js
│   ├── metrics.js
│   ├── dashboard.js
│   ├── database.js       # WAL setup, prepared stmts
│   ├── model-backup.js
│   ├── roi-drift-cusum.js
│   ├── tip-reason.js     # Deterministic tipReason fallback
│   ├── news.js           # Google News RSS
│   ├── league-blocklist.js
│   ├── espn-{soccer,basket}.js
│   ├── sofascore-{tennis,football,mma,darts,tabletennis}.js
│   ├── api-football.js
│   ├── football-data-csv.js
│   ├── football-data.js
│   ├── ufcstats.js       # MMA scraper
│   ├── mma-org-resolver.js
│   ├── hltv.js           # CS scoreboard
│   ├── vlr.js            # Valorant
│   ├── cuetracker.js     # Snooker WR
│   ├── stratz-dota-scraper.js
│   ├── thespike-valorant-scraper.js
│   ├── tennis-abstract-scraper.js
│   ├── understat-scraper.js
│   ├── golgg-{kills,objectives}-scraper.js
│   ├── oracleselixir-{features,player-features}.js
│   ├── dota-{snapshot-collector,extras-scanner,fraud-blacklist}.js
│   ├── lol-{extra-markets,markets,regional-strength,source-cross-check}.js
│   ├── tennis-{correlation,injury-risk,tiebreak-stats,fatigue,player-stats,features-v2}.js
│   ├── esports-{correlation,model-trained,runtime-features,segment-gate}.js
│   ├── grid.js           # Tournament structure
│   ├── epoch.js          # Code epoch tracker (gates_runtime_state)
│   ├── cashout-monitor.js
│   ├── polymarket-watcher.js
│   ├── book-deeplink.js  # Telegram inline button "Apostar"
│   ├── sport-unit.js     # Per-sport tier-based unit_value
│   ├── sports.js         # Sport metadata (canonical names, normSport)
│   ├── ml-weights.js     # Weights loader
│   ├── constants.js
│   ├── utils.js
│   └── backups/          # Model backups
│
├── migrations/
│   └── index.js          # 91 migrations (single file, ~2353 linhas)
│
├── scripts/              # 90 scripts utility
│   ├── train.js          # Generic train
│   ├── train-{esports,tennis,basket}-model.js
│   ├── backtest{,-v2,-railway-tips}.js
│   ├── backtest-{lol,tennis,football,esports,market-tips,new-models,railway-tips}-*.js
│   ├── backtest-tennis-per-surface.js
│   ├── backtest-esports-per-segment.js
│   ├── audit-{all,leaks,leaks-deep,mma,recent-7d,stakes-granular,gates,pending,match-results,market-tips-by-tier,mt-settled-suspects}.js
│   ├── refit-{mt-calib-all,tennis-markov-calib-inline}.js
│   ├── refresh-all-isotonics.js
│   ├── fit-{lol,tennis,esports}-{model,markov}-{isotonic,calibration}.js
│   ├── extract-{1v1,esports,mma,tennis}-features.js
│   ├── sync-{golgg-*,opendota-*,oracleselixir,sackmann-tennis,sofascore-history,ufcstats-history,tennis-stats,darts-stats,hltv-results,hltv-cs-teams,pandascore-history}.js
│   ├── seed-basket-history.js
│   ├── settle-{mt-shadow-esports,tennis-now}.js
│   ├── shadow-compare.js
│   ├── repair-empty-final-scores.js
│   ├── rerun-{pending-tips,railway-pending}.js
│   ├── reset-equity.js   # snapshot DB + archive + rebaseline (--dry-run/--confirm)
│   ├── rebalance-bankroll-1000.js
│   ├── rollback-model.js
│   ├── debug-mt-shadow-settle.js
│   ├── diag-{isotonic-zones,lpl}.js
│   ├── diagnose-mt-tennis.js
│   ├── ai-impact-report.js
│   ├── check-model-freshness.js
│   ├── clv-{by-league,coverage,coverage-gap,leak-diagnosis}.js
│   ├── calibrate{,-lol-momentum}.js
│   ├── backfill-{clv,mma-sherdog}.js
│   ├── backup-db.js
│   ├── book-bugs-{find,replay}.js
│   ├── book-deeplink-test.js
│   ├── mma-coverage-report.js
│   ├── predict.js
│   ├── probe-pinnacle{,-tennis}.js
│   ├── roi-by-odds-bucket.js
│   ├── root-cause-{atp-madrid-r3,tennis-clv}.js
│   ├── scraper-smoke-test.js
│   ├── tennis-v2-smoke.js
│   ├── test-tennis-trained.js
│   ├── tune-oe-weight-temperature.js
│   ├── void-bad-tennis-tips.js
│   └── ...
│
├── public/               # HTML dashboards
│   ├── dashboard.html
│   ├── dashboard-bi.html
│   ├── dashboard-legacy.html
│   ├── logs.html
│   └── lol-ev-manual.html
│
├── tests/                # ~25 unit tests (run.js orchestrator)
│   ├── run.js
│   ├── test-{calibration,devig,elo-rating,kelly,kelly-cap-confkey,name-match,metrics,constants}.js
│   ├── test-{darts,football}-ml.js
│   ├── test-football-data-features.js
│   ├── test-football-mt-scanner.js
│   ├── test-tennis-{h2h-ensemble,market-scanner,score-parser}.js
│   ├── test-{admin-cookie-auth,banca-delta,espn-pen-aet,log-ring-buffer,tip-context-shape}.js
│   └── ...
│
├── data/                 # Datasets + features
│   ├── tennis_atp/       # Sackmann tennis ATP repo
│   ├── tennis_wta/       # Sackmann tennis WTA repo
│   ├── {lol,cs2,dota2,valorant,tennis,football,mma,darts,snooker}_features.csv
│   ├── {cs2,dota2,valorant,football}-backtest-per-segment.json
│   ├── tennis-backtest-per-surface.json
│   └── tipsbot.db (legacy)
│
├── docs/
│   └── PROCESSO-ANALISE-TIPS-BOTS.md
│
├── _archive/             # Historical snapshots + audits
│   ├── _audit_20260504_0749/
│   ├── debug-snapshots/
│   ├── sportsedge_snapshot_2026-04-24.db
│   └── ...
│
├── n8n/                  # n8n workflows
│   ├── README.md
│   └── workflows/
│
├── Public-Sofascore-API/ # Subprojeto Django/Flask Sofascore proxy
│   ├── README.md
│   ├── sofascore_service/
│   ├── docs/
│   └── venv/
│
├── hltv-proxy/           # Subprojeto Python HLTV proxy
│   ├── main.py
│   ├── Dockerfile
│   ├── requirements.txt
│   └── railway.toml
│
└── external/             # External integrations
```

---

## Variáveis de ambiente

Categoria geral. Lista completa: [.env.example](./.env.example).

### Core

```env
PORT=3000
DB_PATH=/data/sportsedge.db
SERVER_PORT=3000             # alias usado por bot.js → server
ADMIN_KEY=<chave_aleatoria>  # Header x-admin-key OU Authorization: Bearer
ADMIN_USER_IDS=<id1,id2>     # @userinfobot
ADMIN_SESSION_TTL_MS=86400000  # 24h cookie session
```

### Telegram

```env
TELEGRAM_TOKEN_ESPORTS=<token>     # cobre LoL + Dota
TELEGRAM_TOKEN_CS=<token>
TELEGRAM_TOKEN_MMA=<token>
TELEGRAM_TOKEN_TENNIS=<token>
TELEGRAM_TOKEN_FOOTBALL=<token>
TELEGRAM_TOKEN_DARTS=<token>
TELEGRAM_TOKEN_SNOOKER=<token>
TIPS_UNIFIED_TOKEN=<token>         # consolidado dispatch
SYSTEM_ALERTS_TOKEN=<token>        # alertas roteados
```

### IA / odds / stats APIs

```env
DEEPSEEK_API_KEY=sk-...
CLAUDE_API_KEY=                    # opcional, fallback
THE_ODDS_API_KEY=<key>
ODDS_API_KEY=<key>                 # OddsPapi (legacy)
PINNACLE_LOL=true
PINNACLE_DOTA=true
PINNACLE_TENNIS=true
SXBET_ENABLED=true
LOL_BLOCK_SX_TIPS=true             # SX não dispatch (LEC liquidez baixa)
LOL_BLOCK_SX_LIVE=true
LOL_API_KEY=<riot_key>
PANDASCORE_TOKEN=<token>
API_SPORTS_KEY=<api_football_key>
API_FOOTBALL_KEY=<key>             # alias
API_FOOTBALL_DAILY_BUDGET=80
STEAM_WEBAPI_KEY=<steam_key>
SOFASCORE_PROXY_BASE=<url>
SUPABASE_URL=<url>                 # BR aggregator
SUPABASE_ANON_KEY=<key>
```

### Sports flags

```env
ESPORTS_ENABLED=true
TENNIS_ENABLED=true
FOOTBALL_ENABLED=true
CS_ENABLED=true
VAL_ENABLED=true
TT_ENABLED=true
MMA_ENABLED=false                  # 2026-05-04 disabled default
DARTS_ENABLED=false
SNOOKER_ENABLED=false
BASKET_ENABLED=true                # NBA shadow

# Shadow mode per sport
DOTA2_SHADOW=true
VALORANT_SHADOW=true
FOOTBALL_SHADOW=false              # promoted 2026-05-03
MMA_SHADOW=true
DARTS_SHADOW=true
SNOOKER_SHADOW=true
TT_SHADOW=true

# ML disabled (auto-route shadow)
LOL_ML_DISABLED=true
CS_ML_DISABLED=true
TENNIS_ML_DISABLED=true
ML_DISABLED_HARD_REJECT=false      # opt-in hard reject
```

### Risk / banca

```env
GLOBAL_RISK_PCT=0.10
SPORT_RISK_PCT=0.20
DAILY_TIP_LIMIT=8                  # per sport
MATCH_STOP_LOSS_UNITS=2
MAX_TIPS_PER_TOURNAMENT_PER_DAY=8
TZ_OFFSET=-3                       # BRT
TIP_EV_MAX_PER_SPORT={"esports":25,"tennis":25,"cs":30,"valorant":30}

# Per-sport
LOL_MT_EV_MAX=20
CS2_MT_EV_MAX=20
DOTA_MT_EV_MAX=20
TENNIS_MT_EV_MAX=25
FOOTBALL_MT_EV_MAX=20
PRE_MATCH_EV_BONUS=0
CS_PRE_MATCH_EV_BONUS=5
LOL_PRE_MATCH_EV_BONUS=4
VAL_PRE_MATCH_EV_BONUS=4
MAX_STAKE_UNITS=2.0
CS_MAX_STAKE_UNITS=2.0
LOL_MAX_STAKE_UNITS=2.0
TENNIS_MAX_STAKE_UNITS=2.0

# Stake mults per market
CS2_TOTAL_STAKE_MULT=1.3
DOTA2_TOTAL_STAKE_MULT=1.2
LOL_HANDICAP_STAKE_MULT=1.2
```

### Kelly

```env
KELLY_AUTO_TUNE=true               # cron 8h local
KELLY_<SPORT>_<CONF>=<float>       # override (ex: KELLY_LOL_ALTA=0.40)
KELLY_<CONF>=<float>               # cross-sport fallback
```

### Gates

```env
ODDS_BUCKET_BLOCK=                 # cross-sport (vazio default)
LOL_ODDS_BUCKET_BLOCK=3.00-99
VALORANT_ODDS_BUCKET_BLOCK=2.20-99
ODDS_BUCKET_GUARD_AUTO=true
ODDS_BUCKET_GUARD_MIN_N=30
ODDS_BUCKET_GUARD_ROI_CUTOFF=-10
ODDS_BUCKET_GUARD_CLV_CUTOFF=-2
ODDS_BUCKET_GUARD_ROI_RESTORE=-2
ODDS_BUCKET_GUARD_DAYS=30

GATES_AUTOTUNE_AUTO=true
GATES_AUTOTUNE_MIN_N=20
GATES_AUTOTUNE_DAYS=30

LOL_MAX_DIVERGENCE_PP=15
DOTA_MAX_DIVERGENCE_PP=15
CS_MAX_DIVERGENCE_PP=12
TENNIS_MAX_DIVERGENCE_PP=20
VAL_MAX_DIVERGENCE_PP=12
FOOTBALL_MAX_DIVERGENCE_PP=10
MMA_MAX_DIVERGENCE_PP=10
DARTS_MAX_DIVERGENCE_PP=15
SNOOKER_MAX_DIVERGENCE_PP=15
TT_MAX_DIVERGENCE_PP=20

CLV_PREDISPATCH_GATE=true
CLV_PREDISPATCH_THRESHOLD=2.5
CLV_PREDISPATCH_WINDOW_MIN=10
HIGH_EV_THROTTLE=true              # default ON
```

### Tennis

```env
TENNIS_MIN_EDGE_TOP=2.5            # Slam/Masters
TENNIS_MIN_EDGE=4.0                # demais
TENNIS_NON_SLAM_DISABLED=true
TENNIS_HANDICAP_GAMES_ENABLED=true
TENNIS_HANDICAP_SETS_LEGACY=false
TENNIS_MARKOV_CALIB_DISABLED=false
TENNIS_MARKOV_SHRINK_HANDICAPGAMES=0.75
TENNIS_MARKOV_SHRINK_TOTALGAMES=0.65
TENNIS_MARKOV_SHRINK_DISABLED=false
TENNIS_CALIB_REFIT_DISABLED=false  # cron nightly 04h
TENNIS_CORRELATION_ADJ=true
TENNIS_MT_TIER2_PROMOTE=true
TENNIS_MIN_ODDS=1.40
TENNIS_MAX_ODDS=5.00
TENNIS_MARKET_SCAN_MIN_ODD=1.50
TENNIS_MARKET_SCAN_MIN_EV=5
TENNIS_MARKET_SCAN_MAX_EV=40
TENNIS_MARKET_SCAN_MAX_EV_HANDICAPGAMES=55
TENNIS_MARKET_SCAN_MAX_EV_TOTALGAMES=40
TENNIS_MARKET_MAX_PER_MATCH=3
TENNIS_ISOTONIC_DISABLED=true
TENNIS_ML_DISABLED=true
VAL_MIN_ELO_GAMES=3
```

### LoL/Dota

```env
LOL_PATCH_META=                    # auto-fetched ddragon
LOL_PREGAME_BLOCK_BO3=false
LOL_EV_THRESHOLD=1.5
LOL_PINNACLE_MARGIN=2.5
LOL_NO_ODDS_CONVICTION=60
LOL_UPCOMING_INTERVAL_MIN=120
LOL_ISOTONIC_DISABLED=true
LOL_KILLS_PROMOTE=false
LOL_KILLS_SCAN_MIN_EV=5
DOTA_MAX_DIVERGENCE_PP=15
```

### Football

```env
FB_USE_FD_CSV=true
FB_DIVERGENCE_GATE=true
FB_DIVERGENCE_MAX_PP=12
XG_PER_SOT=0.32
```

### MT

```env
MT_LEAK_GUARD_AUTO=true
MT_PERMANENT_DISABLE_LIST=tennis|totalGames|over,lol|total
MT_RESTORE_AUTO=true
MT_RESTORE_HOUR_UTC=14
MT_RESTORE_MIN_N=30
MT_RESTORE_DAYS=14
MT_RESTORE_MIN_ROI=0
MT_RESTORE_MIN_CLV=0
```

### Autonomy / loops

```env
AUTONOMY_DIGEST_AUTO=true
AUTONOMY_DIGEST_HOUR_UTC=12
NIGHTLY_RETRAIN_AUTO=true
NIGHTLY_RETRAIN_HOUR_UTC=3
AUTO_ROLLBACK_ON_REGRESSION=true
BRIER_AUTO_EV_CAP=true
LIVE_RISK_MONITOR_AUTO=true
AUTO_VOID_STUCK_AUTO=true
DB_BACKUP_AUTO=true
DB_BACKUP_HOUR_UTC=4
DB_BACKUP_KEEP_DAYS=7
DAILY_LEAKS_DIGEST_AUTO=true
DAILY_LEAKS_DIGEST_HOUR_UTC=13
DAILY_LEAKS_MIN_N=20
DAILY_LEAKS_ROI_CUTOFF=-15
DAILY_LEAKS_DAYS=7
WEEKLY_DIGEST_AUTO=true
WEEKLY_DIGEST_DAY_UTC=1
WEEKLY_DIGEST_HOUR_UTC=14
WEEKLY_DIGEST_DAYS=7
LEAGUE_BLEED_AUTO=true
ROI_CUSUM_DISABLED=false
ROI_CUSUM_K=0.5
ROI_CUSUM_H=4
TIME_OF_DAY_AUTO=true
POLYMARKET_DISCOVERY_AUTO_APPLY=true
```

### HTTP / cache / DB

```env
HTTP_CACHE_DEFAULT_TTL_MS=0
HTTP_CACHE_MAX_ENTRIES=500
HTTP_CACHE_THEODDS_TTL_MS=14400000  # 4h
HTTP_CACHE_ODDSPAPI_TOURNAMENTS_TTL_MS=86400000
HTTP_CACHE_ODDSPAPI_ODDS_TTL_MS=0
HTTP_CACHE_ODDSPAPI_FIXTURE_TTL_MS=0
ANALYZED_TTL_MS=259200000          # 72h
MARKET_TIP_SENT_TTL_MS=172800000   # 48h
DB_SYNCHRONOUS=NORMAL              # NORMAL|FULL
DB_SLOW_QUERY_MS=100
HEALTH_CACHE_MS=10000
MEM_WATCHDOG_DISABLED=false
MEM_WATCHDOG_AUTO=true
MEM_WATCHDOG_AUTO_MARGIN=1.3
```

### Detectores cross-book

```env
STALE_LINE_DISABLED=false
VELOCITY_WINDOW_MIN=10
```

---

## Deployment (Railway)

### Setup

1. Fork/clone para seu GitHub
2. Conectar repo no Railway dashboard
3. Add volume montado em `/data` (SQLite persistente)
4. Configurar env vars (todas as do .env.example essenciais)
5. Deploy auto via push

### Configs

- **`nixpacks.toml`** — buildpack Node 18+
- **`railway.toml`** — health check em `/health`, restart policy
- **`start.js`** — entrypoint (spawna server.js + bot.js)

### Subprojetos paralelos

- **Sofascore proxy** (Public-Sofascore-API) — Django app, deploy separado, retorna `SOFASCORE_PROXY_BASE`
- **HLTV proxy** (hltv-proxy) — Python FastAPI, deploy separado, retorna URL via env
- **n8n** (opcional) — workflows automation, docker-compose ou Railway

### Health check

Railway pinga `/health` (cached 10s). Se 3 falhas seguidas → restart container.

```
GET /health → { status: 'ok'|'degraded', db, lastAnalysis, pendingTips, sources, alerts, botGauges, build, metricsCardinality, metricsLite }
```

### Crash loop diag

`last_child_exit_<name>.json` persiste {code, signal, uptime_ms} mesmo em SIGKILL. Boot subsequente lê e correlaciona. `boot_count.json` rastreia rapid boots.

`/admin/boot-diag` mostra padrão de crashes recentes.

---

## Desenvolvimento local

```bash
# Setup
cp .env.example .env
# editar .env com tokens
npm install

# Rodar tudo
node start.js

# Ou separado
node server.js     # terminal 1
node bot.js        # terminal 2

# Dev mode (nodemon)
npm run dev

# Backtest
npm run backtest
node scripts/backtest-tennis-per-surface.js
node scripts/backtest-railway-tips.js

# Train
npm run train
node scripts/train-tennis-model.js
node scripts/train-esports-model.js
node scripts/train-basket-model.js

# Refit calibrations
node scripts/refresh-all-isotonics.js
node scripts/refit-mt-calib-all.js
node scripts/refit-tennis-markov-calib-inline.js

# Audits
node scripts/audit-leaks-deep.js
node scripts/audit-recent-7d.js
node scripts/clv-by-league.js
node scripts/roi-by-odds-bucket.js

# Utils
node scripts/reset-equity.js --dry-run
node scripts/reset-equity.js --confirm
node scripts/rebalance-bankroll-1000.js
node scripts/dedup-tips.js
```

### Hot tips

- **DB locked errors:** WAL mode + busy_timeout default 5s já mitiga, mas evite múltiplos `node bot.js` paralelos
- **Pinnacle 403:** rotaciona User-Agent. `lib/pinnacle.js` já tem pool
- **DeepSeek rate limit:** backoff exponencial built-in. `AI_DISABLED=true` desativa cross-sport
- **Sofascore proxy down:** scrapers fail-open, retornam null silenciosamente

---

## Testes

```bash
npm test                            # tests/run.js
node tests/test-calibration.js      # individual
```

~25 unit tests cobrindo:

- Calibration (PAV, beta smoothing)
- Devig (power method)
- Elo rating
- Kelly cap (confkey)
- Name match (fuzzy threshold)
- Metrics (Brier, ECE, ROI)
- Constants
- Darts/Football ML
- Football data features + MT scanner
- Tennis H2H ensemble + market scanner + score parser
- Admin cookie auth
- Banca delta
- ESPN PEN/AET
- Log ring buffer
- Tip context shape

**CI:** sem GHA configurado. Roda local antes de push.

---

## Subprojetos

### Public-Sofascore-API (`Public-Sofascore-API/`)

Django/Flask proxy para Sofascore (desbloqueia Cloudflare via headers + venv Python). Deploy separado no Railway. Routes:

- `/tennis/{event_id}` — score live + stats
- `/football/{event_id}` — score + xG/SoT
- `/darts/{event_id}` — sets + legs + 3-dart avg
- `/snooker/{event_id}` — frames + breaks
- `/tt/{event_id}` — sets + games

Bot consome via `SOFASCORE_PROXY_BASE`. Cache headers respected.

### HLTV proxy (`hltv-proxy/`)

FastAPI Python para HLTV scoreboard (Cloudflare). Endpoints:

- `/match/{id}` — score live + map state
- `/team/{id}` — recent results

`lib/hltv.js` cliente.

### n8n (`n8n/`)

Workflows opcionais (notification orchestration, sentinel scheduling).

```bash
docker-compose -f docker-compose.n8n.yml up -d
```

### data/tennis_atp + data/tennis_wta

Sackmann tennis history repos (cloned). Usados por `lib/tennis-data.js` + `scripts/sync-sackmann-tennis.js`.

### data/oraclesElixir (via DB table)

LoL match data sourced via `lib/oracleselixir-features.js`. Bucket S3: `oracles-elixir.s3.amazonaws.com`.

---

## Memory & decisions log

### `DECISIONS.md`

Log cronológico de decisões significativas (toggle gate, cap change, kill switch). Format:

```
## YYYY-MM-DD — Título
**Motivo:** ...
**Antes:** ...
**Agora:** ...
**Reversão:** ...
**Status:** ✅ aplicado | 🧪 experimental | ⚠️ provisório
```

### `WORKFLOW_SPORTSEDGE.md`

Documento detalhado do pipeline end-to-end com diagramas, agentes, orchestrator, auto-healer.

### `.claude/memory/MEMORY.md` (auto-memory Claude Code)

Indice de ~80 memory files cobrindo:

- Estado atual (gates / regimes / sessões)
- MT system (overview + sprints)
- Per-sport pipelines (tennis, LoL, esports, football)
- Calibration / detection
- Banca / settlement
- Tips / dispatch / dedup
- Dashboards / observabilidade

Útil para Claude Code agents recuperarem contexto entre sessões.

---

## Troubleshooting

### Bot não dispatcha

1. Check `/health` — sources OK?
2. Check `/rejections` — gate está rejeitando? (sharp_divergence, bucket, ev_cap, daily_limit, etc.)
3. Check `/loops` — poll do sport rodou recente?
4. Check `<SPORT>_ENABLED=true` e `<SPORT>_SHADOW=false`
5. Check `LOL_ML_DISABLED` / `CS_ML_DISABLED` etc — se true, ML route shadow
6. `/diag-tip <match_id>` — diag granular

### Settlement travado

1. `/unsettled` — list pending
2. `/admin/tennis-tip-match-debug` (tennis) — fuzzy match diag
3. `/admin/run-settle?sport=X` — force-settle window
4. Verifica match_results pre-sync errors em `/logs`
5. `AUTO_VOID_STUCK_AUTO=true` faz auto-void após 3d

### Crash loop Railway

1. `/admin/boot-diag` — exit signature pattern
2. `last_child_exit_*.json` — last crash details
3. Check `boot_count.json` — rapid boots?
4. `/health` retorna 200? Se timeout, healthcheck mata container
5. Mem watchdog: `MEM_WATCHDOG_RSS_MB` override hard se P95 baseline ruim

### CLV negativo persistente

1. `/clv-histogram?sport=X` — distribuição
2. `node scripts/clv-by-league.js` — qual liga
3. `/admin/clv-capture-trace?sport=X&days=7`
4. Check `CLV_PREDISPATCH_GATE=true` ativo
5. League blocklist via `/admin/blocklist-stats`

### EV inflado / model overconfident

1. Check isotonic ativo: `lib/<sport>-isotonic.json` mtime
2. `/admin/mt-calib-validation` — drift
3. `/admin/mt-refit-calib?sport=X&days=90&write=true` — refit on-demand
4. `BRIER_AUTO_EV_CAP=true` reduz cap automaticamente quando Brier degrada

### Banca dessincronizada

1. `/admin/force-sync-bankroll` — POST recalcula
2. `node scripts/clv-coverage.js` — coverage gaps
3. `/bankroll-audit` — diff stored vs recomputed
4. Mig 044 sincroniza key 'baseline' JSON ↔ keys separadas

### MT scanner não detectando

1. `/admin/mt-status` — promote state per (sport, market, tier)
2. `/admin/mt-disable-list` — runtime disabled?
3. `MT_PERMANENT_DISABLE_LIST` — leak permanente
4. Check `<SPORT>_MT_EV_MAX` cap

### Logs não aparecem

1. `/health` retorna 200?
2. `/logs/ingest` POST funciona? (check via curl)
3. `start.js` está propagando stdout? (pipeLineToServer)
4. `/logs/stream` SSE conecta?

---

## Filosofia & princípios

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

## Licença & autoria

Projeto privado. Autor: Victor (acgdj12@gmail.com).

Stack: Node.js 18+, better-sqlite3, dotenv. **Zero framework HTTP** (http nativo). **Zero ORM** (raw SQL via prepared statements).

Co-development: Claude Code (Anthropic) com auto-memory persistente.

---

**Última atualização:** 2026-05-06
**Branch:** main
**Commits recentes relevantes:**
- `fe16e55` feat(tennis-calib): cron nightly refit 04h local
- `3630239` chore(tennis-calib): refit n=537 (era 115)
- `7d36529` fix(mt-refit-calib): bounded PAV/merge loops + write=true persist mode
- `f6d9da6` fix BRIER_AUTO_EV_CAP reader/writer inconsistency
- `ead685b` ML disabled auto-route → shadow + nightly retrain default-on
