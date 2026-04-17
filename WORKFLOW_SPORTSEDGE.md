# WORKFLOW SPORTSEDGE BOT

Documentação completa do fluxo end-to-end: do momento que uma partida aparece nas APIs até a tip chegar no Telegram do usuário, e como o sistema se monitora/cura/reporta sozinho.

Última atualização: 2026-04-17

---

## 0. ARQUITETURA GERAL

```
┌─────────────────────────────────────────────────────────────────┐
│                      RAILWAY (1 deploy)                         │
│                                                                 │
│  start.js (launcher) — spawna 2 processos com auto-restart      │
│      │                                                          │
│      ├──► server.js (HTTP API, port 8080)                       │
│      │      • Endpoints /lol-matches, /odds, /record-tip etc   │
│      │      • Agentes /agents/* (orchestrator, sentinel...)    │
│      │      • Dashboard /dashboard, /logs                       │
│      │      • SQLite via volume Railway (/data/sportsedge.db)  │
│      │                                                          │
│      └──► bot.js (Telegram + análise)                           │
│             • Polls de cada sport (loops independentes)         │
│             • runAutoAnalysis (LoL/Dota/MMA/Tennis/Football)    │
│             • Schedulers diretos (Darts/Snooker/CS/Valorant)    │
│             • IA (DeepSeek) via /claude proxy do server        │
│             • Crons: auto-shadow, auto-healer, bankroll...      │
│             • Telegram bots (1 por esporte)                     │
│             • SQLite (mesmo arquivo, WAL mode)                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 1. PIPELINE DE TIP (do mercado → DM)

Para cada sport, o ciclo é o mesmo conceitual com variações:

### 1.1 Descoberta de partida

```
1. Bot loop dispara (cron por sport)
2. serverGet('/sport-matches') → server consulta APIs:
     • Pinnacle Guest API (LoL, Dota, CS, Valorant, Tennis, Snooker, TT, MMA)
     • SX.Bet (LoL/Dota live per-map)
     • PandaScore (LoL/Dota live status)
     • Sofascore (Darts, Tennis live)
     • The Odds API (MMA, Tennis, Football)
     • Riot API (LoL live stats)
     • OpenDota + Steam Realtime (Dota live)
     • VLR.gg (Valorant live)
     • HLTV scorebot (CS live)
3. Server faz merge/dedup, retorna lista normalizada:
     [{ id, team1, team2, league, status, time, odds, ... }]
4. Bot filtra: relevant (live + upcoming <6h)
```

### 1.2 Pré-filtro ML (antes de chamar IA, economiza tokens)

```
5. Para cada match relevant:
     • esportsPreFilter (lib/ml.js) — calcula:
       - modelP1, modelP2 (probabilidade do modelo)
       - impliedP1, impliedP2 (dejuiced do mercado)
       - score (edge em pp), direction, factorCount
     • Se factorCount=0 OU edge<3pp → skip (não chama IA)
     • Modelos específicos: lib/lol-model.js, dota-map-model.js,
       tennis-model.js, football-ml.js, valorant-ml.js,
       cs-ml.js, darts-ml.js, snooker-ml.js, tabletennis-ml.js
```

### 1.3 Enrichment de contexto

```
6. Coleta paralela:
     • collectGameContext (live stats: gold, kills, dragons, comp)
     • fetchEnrichment (forma, H2H, ESPN records, Sofascore stats)
     • fetchMatchNews (Google News RSS, 48h)
     • Patch meta (LoL ddragon)
     • Surface detection (tennis: clay/grass/hard)
     • Tournament tier (CS Major vs CCT, etc)
```

### 1.4 IA (DeepSeek via /claude proxy)

```
7. buildXxxPrompt monta o prompt com:
     • Times + odds + dejuiced %
     • Modelo P + edge + factorCount
     • Forma/H2H/comp/news
     • Live stats se houver
     • Decisão esperada: TIP_ML:[time]@[odd]|P:[%]|STAKE:[1-3]u|CONF:[ALTA/MÉDIA/BAIXA] OU SEM_EDGE

8. serverPost('/claude', { messages, max_tokens: 600 })
9. _parseTipMl(text) → extrai {team, odd, P, stake, conf}
   IA fornece APENAS P; sistema calcula EV via P × odd − 1
```

### 1.5 Gates pós-IA (camadas de proteção)

```
10. _validateTipPvsModel(text, modelP, tolPp=8)
    • Se P da IA divergir >8pp do modelo → REJEITA
    • Modelo é source of truth; IA é "segunda opinião"

11. _sharpDivergenceGate({ oddsObj, modelP, impliedP, maxPp })
    • Só dispara em odds Pinnacle/Betfair
    • Se modelP diverge >cap pp → REJEITA
    • Cap por sport:
      MMA/Football: 10pp | CS/Tennis/Valorant: 12pp
      LoL/Dota/Darts/Snooker: 15pp | TT: 20pp

12. EV sanity gate
    • EV > 50% → REJEITA (provável erro de cálculo)

13. Tier-aware caps
    • LoL tier 2-3 (não-premier): EV>25% → rejeita
    • CS tier 2+ (CCT/regional/academy): conf max MÉDIA, stake max 1u, EV min 8%
    • MMA bookmaker non-sharp (BetOnline/FanDuel/etc):
        EV min 12%, conf rebaixada ALTA→MÉDIA, stake max 1u

14. Confidence-based gates (sport-specific)
    • LoL BAIXA + ML edge<10pp → REJEITA
    • LoL BAIXA + EV<8% → REJEITA
    • MMA BAIXA → REJEITA (variância alta)
    • Tennis BAIXA + ML score<6pp → REJEITA

15. Live odds re-validation (Tennis live)
    • Re-fetch odds atual antes do DM
    • Se odd da pick caiu >12% desde análise → ABORTA
```

### 1.6 Risk Manager

```
16. calcKellyWithP(modelP, odd, fraction)
    • Fração: ALTA=¼, MÉDIA=⅙, BAIXA=1/10 Kelly
    • Cap por confiança: ALTA=4u, MÉDIA=3u, BAIXA=1.5u
    • Kelly negativo → aborta tip

17. applyGlobalRisk(sport, units, league)
    • GLOBAL_RISK_PCT (default 10%): exposição cross-sport vs banca total
    • SPORT_RISK_PCT (default 20%): exposição por sport vs banca do sport
    • Ajusta units pra caber no cap, ou rejeita

18. Pinnacle priority no /odds (LoL/Dota)
    • Pinnacle = primary (sharp anchor)
    • SX.Bet/TheOddsAPI vão como _alternative
    • DM mostra ambos pra usuário escolher
```

### 1.7 Persistência + DM

```
19. POST /record-tip
    • Insert na tabela tips com result=NULL
    • Dedup window: 24h por (match_id + tip_participant + market_type)
    • Salva: stake, stake_reais, odds, EV, confidence, modelP1/P2/Ppick

20. Build mensagem Telegram (sport-specific template)

21. Para cada user com prefs.has(sport):
    • sendDM(token, userId, msg)
    • 403 → marca user.subscribed=false (bloqueado)

22. Log: [INFO] [AUTO-X] Tip enviada: ...
```

### 1.8 Settlement automático

```
23. setInterval 30min:
    • settleCompletedTips()
    • Por sport, query tips WHERE result IS NULL
    • Consulta API de resultado:
      LoL: Riot API + PandaScore
      Dota: PandaScore
      MMA: ESPN UFC scoreboard
      Tennis: ESPN ATP/WTA + Sofascore
      Football: API-Football
      CS/Valorant: PandaScore + HLTV/VLR
      Darts/Snooker/TT: Sofascore
    • nameMatches() (lib/name-match.js): exact > alias > substring (score>=0.5)
    • Quarantine se match incerto (>0.4 mas <0.7) — requer /settle-manual

24. UPDATE tips SET result = win|loss|push|void, settled_at = NOW,
    profit_reais = stake * (odds-1) se win, else -stake (push=0)

25. UPDATE bankroll SET current_banca += profit_reais WHERE sport = X
```

---

## 2. SCHEDULERS (loops do bot.js)

### 2.1 Loops de polling (descobrem partidas + emitem tips)

| Loop | Cron | Mode live | Mode idle | Comentário |
|---|---|---|---|---|
| `runAutoAnalysis` | 6min (mutex) | — | — | Roda LoL+Dota+MMA+Tennis+Football+TT em paralelo. Mutex anti-concorrência. |
| `pollDota` | dentro do mutex (livre) | 60s (com Steam RT) / 2min sem | 15min | Steam RT delay ~15s; OpenDota 3min anti-cheat |
| `pollValorant` | scheduler próprio (fora mutex) | 90s | 5min | Reage rápido a VCT/Major |
| `pollCs` | scheduler próprio (fora mutex) | 90s | 5min | Idem |
| `runAutoDarts` | scheduler próprio | 2min | 15min | Sofascore Sport |
| `runAutoSnooker` | scheduler próprio | 2min | 15min | Pinnacle/Betfair |

### 2.2 Crons de manutenção/automação

| Cron | Intervalo | Função |
|---|---|---|
| `settleCompletedTips` | 30min | Liquida tips pendentes |
| `checkPendingTipsAlerts` | 30min | Loga tips expiradas |
| `sendDailySummary` | 30min check / 1x/dia | Resumo às 23-00h BRT |
| `recalcWeights` (ML weights) | 1x/sem (segunda 06h UTC) | Auto-tune pesos LoL ML |
| `checkPatchMetaStale` | 1x/14 dias | Auto-fetch patch meta ddragon |
| `checkCriticalAlerts` | 10min | Polling /alerts → DM admin (cooldown 1h/alert_id) |
| `checkLiveScoutGaps` | 3min | Live Scout → DM se gap >5min persistente (cooldown 60min) |
| `checkAutoShadow` | 6h | Avalia CLV 14d, flippa shadow se CLV<-1% em n>=30 |
| `runAutoHealerCycle` | 5min | Health Sentinel → Auto-Healer → DM aplicações |
| `runBankrollGuardianCycle` | 1h | DD>10% alerta, >15% auto-shadow temp, >25% block |
| `runPreMatchFinalCheckCycle` | 5min | Re-valida tips <30min match (odds drift, cancel) |
| `runNewsMonitorCycle` | 15min | RSS scan, alerta tips afetadas (cooldown 30min) |
| `runIaHealthCycle` | 1h | Parse failure rate, IA errors, backoff status |
| `runModelCalibrationCycle` | 24h | Brier drift detection (cooldown 24h DM) |
| `runDailyHealthIfTime` | 30min check / 1x/dia 8h BRT | Workflow consolidado + DM |

---

## 3. AGENTS (lib/dashboard.js + lib/agents-extended.js)

13 agents totais. 2 categorias: **observação** (passivos) e **ação** (ativos).

### 3.1 Agents de observação

| Agent | O que retorna | Endpoint |
|---|---|---|
| **live-scout** | Partidas live + gaps (no_gameids, stats_disabled, coverage_missing, delay_alto, duplicata_invertida) | `/agents/live-scout` |
| **feed-medic** | Health check Riot, VLR, ESPN, Pinnacle, server local — HTTP/latency/bytes | `/agents/feed-medic` |
| **roi-analyst** | ROI/Brier/calibração por sport+bucket+market+leaks | `/agents/roi-analyst?days=30` |
| **weekly-review** | Portfolio: verdes/amarelos/vermelhos/no_data + actions priorizadas + CLV trends | `/agents/weekly-review` |
| **health-sentinel** | Anomalies operacionais (mutex, poll silent via heartbeats, endpoint slow, DB locked, AI backoff, settlement stale) | `/agents/health-sentinel` |
| **bankroll-guardian** | DD/growth por sport + overall + alerts | `/agents/bankroll-guardian` |
| **cut-advisor** | Buckets vermelhos ranqueados por expected daily loss em R$ | `/agents/cut-advisor` |
| **live-storm** | Detecta totalLive>15, sugere priorização | `/agents/live-storm` |
| **ia-health** | Parse failure rate 24h, IA errors 1h, backoff active | `/agents/ia-health` |
| **model-calibration** | Brier 30d vs baseline 90d-30d, drift>0.03 alerta | `/agents/model-calibration` |
| **news-monitor** | RSS scan (HLTV, Sherdog, Google News etc), keyword classification, cruza com tips pendentes | `/agents/news-monitor` |
| **pre-match-check** | Tips pendentes <30min match: re-fetch odds, detecta drift/cancelamento | `/agents/pre-match-check?windowMin=30` |

### 3.2 Agent de ação

| Agent | O que faz | Endpoint |
|---|---|---|
| **auto-healer** | Recebe anomalies do sentinel e aplica fixes registrados (12 fixes em lib/auto-healer.js): mutex_stale, poll_silent_*, ai_backoff_long, auto_shadow_not_running, vlr_zero_unexpected | Não exposto via HTTP — roda via cron interno do bot |

### 3.3 Decision Tree

7 playbooks em `/agents/decision-tree`:
- Bucket virou CUT no Weekly Review
- Auto-healer mutex_stale repetido
- Bankroll Guardian DD>=15%
- Pre-Match Check odds adverse
- Model Calibration drift +0.03
- Live Storm
- IA parse failures

Cada playbook tem: `situation`, `steps[]`, `triggers[]`.

---

## 4. ORCHESTRATOR (workflows compostos)

`lib/agent-orchestrator.js` define chains de agents. Cada step pode ser:
- `{ agent: 'name' }` → invoca agent
- `{ custom: fn(ctx) }` → função arbitrária com short-circuit
- `{ compare: (post, pre) => ... }` → compara antes/depois

### 4.1 Workflows registrados

| Workflow | Steps | Quando usar |
|---|---|---|
| **full_diagnostic** | sentinel → check_actionable → auto_healer → sentinel_post (compare resolved/persistent/new) | Diagnóstico geral |
| **coverage_investigation** | live-scout → check_gaps → feed-medic | Investigar gaps cobertura |
| **weekly_full** | weekly_review + roi_analyst + health_sentinel | Review semanal |
| **tip_emergency** | pre-match-check + news-monitor → check_alerts (short-circuit se nada) → feed-medic | Tips em risco |
| **daily_health** | weekly_review + bankroll_guardian + health_sentinel + ia_health + cut_advisor | Cron 8h BRT |
| **incident_response** | sentinel → scout + medic + healer → sentinel_post | Resposta a critical |
| **model_check** | model_calibration + ia_health + bankroll_guardian | Saúde dos modelos |

### 4.2 Endpoint
```
GET /agents/orchestrator?workflow=daily_health
GET /agents/orchestrator (sem workflow → lista disponíveis)
```

---

## 5. AUTO-HEALER (registry de fixes)

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

### 5.1 Fixes registrados

| anomaly_id | Severity | Action |
|---|---|---|
| **mutex_stale** | critical | `autoAnalysisMutex.locked = false` (libera mutex stuck) |
| **poll_silent_lol** | warning | Re-invoca `runAutoAnalysis()` |
| **poll_silent_dota** | warning | Re-invoca `pollDota(true)` |
| **poll_silent_cs** | warning | Re-invoca `pollCs(true)` |
| **poll_silent_valorant** | warning | Re-invoca `pollValorant(true)` |
| **poll_silent_tennis** | warning | Re-invoca `pollTennis(true)` |
| **poll_silent_mma** | warning | Re-invoca `pollMma(true)` |
| **poll_silent_darts** | warning | Re-invoca `runAutoDarts()` |
| **poll_silent_snooker** | warning | Re-invoca `runAutoSnooker()` |
| **poll_silent_tt** | warning | Re-invoca `pollTableTennis(true)` |
| **ai_backoff_long** | warning | `global.__deepseekBackoffUntil = 0` (clear stuck flag) |
| **auto_shadow_not_running** | warning | Força `checkAutoShadow()` |
| **vlr_zero_unexpected** | warning | `vlrModule._clearCache()` |

### 5.2 Fluxo

```
[Cron 5min] runAutoHealerCycle()
   ↓
[1] runHealthSentinel(serverBase, db) → { anomalies, healthy, summary }
   ↓
[2] Se 0 anomalies → log debug, return (silencioso)
   ↓
[3] Build ctx com refs do bot (mutex, pollFns, vlrModule, log)
   ↓
[4] runAutoHealer({ anomalies, ctx }) → { applied, skipped, errors }
   ↓
[5] Filtra newApplied (cooldown 30min/anomaly_id anti-spam)
[6] Filtra criticalUnresolved (exclui self-resolved por precondition false)
   ↓
[7] Se há fixes novos OU criticals pendentes → DM admin
```

---

## 6. AUTOMAÇÕES DE NEGÓCIO (não operacional)

### 6.1 Auto-Shadow (proteção de edge negativo)

`bot.js:checkAutoShadow` — cron 6h, env `AUTO_SHADOW_NEGATIVE_CLV=true`:

```
1. Pra cada sport enabled:
2. GET /clv-decay?sport=X&days=14
3. Calcula CLV médio ponderado por n
4. Se CLV < -1% E n >= 30:
     SPORTS[sport].shadowMode = true
     DM admin: "🛑 AUTO-SHADOW ATIVADO — X"
5. Se CLV >= 0% E sport está em auto-shadow E originalmente não era shadow:
     Restore: SPORTS[sport].shadowMode = false
     DM admin: "✅ AUTO-SHADOW RESTAURADO — X"
```

### 6.2 Bankroll Guardian (proteção de drawdown)

`bot.js:runBankrollGuardianCycle` — cron 1h:

```
1. GET /equity-curve?sport=X&days=30 pra cada sport
2. Calcula DD = (peak - current) / peak
3. Severity:
     DD < 10%: ok
     DD 10-15%: info → DM "revisar perdas recentes"
     DD 15-25%: warning → DM + auto-shadow temp (1h)
     DD >= 25%: critical → DM + considera block (não implementado yet)
4. Restore se DD recuperar < 10%
5. Cooldown 1h/sport
```

### 6.3 Pre-Match Final Check

`bot.js:runPreMatchFinalCheckCycle` — cron 5min:

```
1. Tips pendentes (sent_at < 48h, is_live=0)
2. Pra cada tip cuja match começa em <30min:
3. Re-fetch via /sport-matches
4. Compara odd da pick atual vs odd da tip
5. Se drift > 10% adverso → DM warning
6. Se drift > 20% → DM critical
7. Se match não encontrado E sent_at <6h → DM warning "possível cancelamento"
8. Se match.status='cancelled'|'postponed' → DM critical
```

### 6.4 News Monitor

`bot.js:runNewsMonitorCycle` — cron 15min:

```
1. Fetch 7 RSS sources (HLTV, Sherdog, Tennis.com, Google News esports/dota/vct)
2. Filter: items últimos 24h
3. Classify por keywords:
     critical: cancel/postpon/withdraw/forfeit/DQ/VAC ban/suspend
     warning: injury/sick/stand-in/sub/out/lineup change
4. Cruza com tips pendentes (DB query)
5. Match por nome de team como palavra completa
6. Sort: critical > matched_tips > recente
7. DM cooldown 30min global, só envia worth (matched OR critical)
```

### 6.5 Model Calibration Watcher

`bot.js:runModelCalibrationCycle` — cron 24h:

```
1. Pra cada sport com tips settled:
2. Calcula Brier 30d (recent) e Brier 90d-30d (baseline)
3. Drift = recent - baseline
4. Se drift > 0.03 (Brier piorou) → alert + sugestões:
     - Para esports: "rodar /recalcWeights"
     - Para outros: "investigar lib/<sport>-ml.js, considerar shadow"
5. DM cooldown 24h
```

### 6.6 IA Health Monitor

`bot.js:runIaHealthCycle` — cron 1h:

```
1. Parse failure rate 24h: % responses sem TIP_ML parseável
2. IA errors 1h: count de logs "IA erro"
3. Backoff active: DeepSeek 429 ainda ativo?
4. Alertas:
     - Failure rate > 15% → "IA degradada"
     - >5 errors em 1h → "verificar API key/quota"
5. DM cooldown 4h
```

### 6.7 Daily Health Workflow

`bot.js:runDailyHealthIfTime` — cron 30min check, dispara 1x/dia 8h BRT:

```
1. POST /agents/orchestrator?workflow=daily_health
2. Roda: weekly_review + bankroll_guardian + health_sentinel + ia_health + cut_advisor
3. Constrói summary com:
     📊 Portfolio: 🟢X 🟡Y 🔴Z
     💰 Banca: R$inicial → R$atual (+lucro | growth%)
     🩻 Saúde: X crit | Y warn | Z healthy
     ✂️ Cuts: X prontos pra cortar (R$/dia em risco)
4. DM admin com summary + steps + duração
```

---

## 7. DASHBOARDS (UIs)

### 7.1 `/dashboard` (público, sem auth pra HTML)

`public/dashboard.html` + Chart.js. Endpoints chamados via `apiFetch` (com x-admin-key):

| Card | Endpoint | Função |
|---|---|---|
| Sport tabs (LoL/Dota/CS/Val/MMA/Boxe/Tennis/Football/Darts/Snooker/TT) | — | Seletor |
| Cards principais | `/roi?sport=X` | KPIs (ROI, win rate, Brier, banca, calibração, CLV) |
| Live Snapshot | `/live-snapshot` | Partidas live por sport com odds + stats |
| Upcoming | `/upcoming-snapshot?hours=24` | Próximas 24h |
| ROI por Liga | `/league-roi?sport=X` | Tabela com mult badge, pre/live, conf split |
| Equity Curve | `/equity-curve?sport=X&days=N` | Linha banca + drawdown (Chart.js dual-axis) |
| Heatmap horários | `/hourly-roi?sport=X&days=N` | Grid 12×2 colorido por ROI hora BRT |
| Shadow vs Ativo | `/shadow-vs-active?sport=X&days=N` | Cards lado-a-lado |
| ROI Matrix | `/roi-matrix?days=N` | Tabela cross-sport×phase×tier com Veredito |
| CLV Decay | `/clv-decay?sport=X&days=N` | Chart dual-line (CLV diário + rolling 7d) |
| ML Charts (LoL) | `/ml-weights`, `/ml-dashboard` | Pesos ML, accuracy walk-forward, predictions |
| Tips Table | `/tips-history?status=...` | Filtros: q, status, live, conf, sort, limit |

### 7.2 `/logs` (público pra HTML, agentes exigem auth)

`public/logs.html` — 5 tabs:

| Tab | Conteúdo |
|---|---|
| Tips | 2 colunas: enviadas + negadas (real-time via SSE) |
| Cobertura ao Vivo | Tabela 20min de partidas live |
| Erros | Buffer com últimas 50 linhas error/warn |
| Status dos Bots | Cards por sport (ok/warn/error) com métricas |
| **Agentes** | Cards de cada agent com botão refresh |

Cards na aba Agentes:
- 🩻 Health Sentinel + 🔧 Auto-Healer
- 🎼 Orchestrator (workflows, com seletor)
- 🗓️ Weekly Review
- 🔭 Live Scout
- 📈 ROI Analyst
- 🩺 Feed Medic

---

## 8. ENV VARS PRINCIPAIS

### 8.1 Core
```env
DEEPSEEK_API_KEY=sk-...
PANDASCORE_TOKEN=...
LOL_API_KEY=...
THE_ODDS_API_KEY=...
API_SPORTS_KEY=...
SOFASCORE_PROXY_BASE=https://...
STEAM_WEBAPI_KEY=...                    # acelera Dota live ~5x
ADMIN_USER_IDS=12345,67890
ADMIN_KEY=...
DB_PATH=/data/sportsedge.db
PORT=8080
```

### 8.2 Telegram tokens (1 por sport)
```env
TELEGRAM_TOKEN_ESPORTS=...
TELEGRAM_TOKEN_MMA=...
TELEGRAM_TOKEN_TENNIS=...
TELEGRAM_TOKEN_FOOTBALL=...
TELEGRAM_TOKEN_DARTS=...
TELEGRAM_TOKEN_SNOOKER=...
TELEGRAM_TOKEN_CS=...
TELEGRAM_TOKEN_VALORANT=...             # pode compartilhar com CS
TELEGRAM_TOKEN_TT=...
```

### 8.3 Risk
```env
GLOBAL_RISK_PCT=0.10
SPORT_RISK_PCT=0.20
```

### 8.4 Sharp divergence caps (anti-edge-fictício)
```env
LOL_MAX_DIVERGENCE_PP=15
DOTA_MAX_DIVERGENCE_PP=15
CS_MAX_DIVERGENCE_PP=12
VAL_MAX_DIVERGENCE_PP=12
TENNIS_MAX_DIVERGENCE_PP=12
MMA_MAX_DIVERGENCE_PP=10
FOOTBALL_MAX_DIVERGENCE_PP=10
DARTS_MAX_DIVERGENCE_PP=15
SNOOKER_MAX_DIVERGENCE_PP=15
TT_MAX_DIVERGENCE_PP=20
```

### 8.5 IA second opinion toggles (default true)
```env
CS_USE_AI=true
VAL_USE_AI=true
DARTS_USE_AI=true
SNOOKER_USE_AI=true
TT_USE_AI=true
```

### 8.6 Tier 2+ caps
```env
CS_TIER2_MIN_EV=8.0
CS_TIER2_MAX_STAKE=1.0
MMA_MIN_EV_NONSHARP=12.0
MMA_MAX_STAKE_NONSHARP=1.0
```

### 8.7 Schedulers de agentes
```env
AUTO_HEALER_ENABLED=true
AUTO_HEALER_INTERVAL_MIN=5
AUTO_HEALER_DM_COOLDOWN_MIN=30
AUTO_SHADOW_NEGATIVE_CLV=true
AUTO_SHADOW_CHECK_INTERVAL_HOURS=6
AUTO_SHADOW_MIN_N=30
AUTO_SHADOW_CLV_CUTOFF=-1.0
AUTO_SHADOW_RECOVERY_CLV=0.0
LIVE_SCOUT_ALERTS=true
LIVE_SCOUT_CHECK_INTERVAL_MIN=3
LIVE_SCOUT_ALERT_THRESHOLD_MIN=5
LIVE_SCOUT_ALERT_COOLDOWN_MIN=60
```

### 8.8 Outros
```env
LIVE_STORM_THRESHOLD=15
LOG_BUFFER_MAX=5000
AUTO_ANALYSIS_MUTEX_STALE_MIN=15
```

---

## 9. FLUXO COMPLETO — EXEMPLO REAL (LoL live tip)

```
T+0s   Match LCK começa: T1 vs Dplus KIA, mapa 1
       Riot livestats começa a popular (delay ~15-45s)

T+30s  pollDota não, mas runAutoAnalysis dispara (cron 6min, sorte de hit)
       OU scheduleValorant/Cs disparam (90s live)

T+45s  GET /lol-matches → server faz merge Riot + PandaScore + Pinnacle
       → match retorna com odds Pinnacle 1.45/2.85, status='live'

T+50s  collectGameContext: Riot livestats retorna gold/kills/dragons
       fetchEnrichment: forma + H2H do DB (45 dias)
       fetchMatchNews: Google News RSS

T+55s  esportsPreFilter:
         modelP1=0.62 (T1 favored)
         impliedP1=0.69 (após dejuice)
         edge = 0.62 - 0.69 = -0.07 negativo
         direction='t2', factorCount=3

T+60s  Pré-filtro PASSED (mlScore.pass=true porque algum lado tem edge)
       buildEsportsPrompt: monta com tudo

T+62s  POST /claude (DeepSeek) → IA responde:
       "TIP_ML: Dplus KIA @ 2.85 |P:48% |STAKE:1.5u |CONF:MÉDIA"

T+63s  _parseTipMl extrai: { team:'Dplus KIA', odd:2.85, P:48, stake:1.5u, conf:MÉDIA }
       _validateTipPvsModel: P_modelo (1-0.62=0.38) vs P_IA (0.48) → diff 10pp
       Se tolPp=8: REJEITA. Se 10: passa.
       Vamos assumir passa (tolerância flex em alguns sports).

T+64s  _sharpDivergenceGate(odds Pinnacle, modelP=0.38, impliedP=0.31, cap=15pp):
       diff = 7pp < 15pp → PASSA

T+65s  EV recalc: 0.38 × 2.85 - 1 = +8.3% (não +9% que IA reportou)
       Sanity: < 50% → ok
       Confidence rebaixada se necessário

T+66s  calcKellyWithP(0.38, 2.85, 1/6) → 1.2u
       applyGlobalRisk('esports', 1.2, 'LCK') → ok, mantém 1.2u

T+67s  POST /record-tip → DB insert (id=400)

T+68s  Build msg Telegram:
       🎮 💰 TIP ML AUTOMÁTICA — MAPA 1
       T1 vs Dplus KIA (Bo3)
       🎯 Aposta: Dplus KIA ML @ 2.85
       🏦 Casa: Pinnacle (alt SX.Bet: 2.95/1.42)
       📈 EV: +8.3%
       💵 Stake: 1.2u (⅙ Kelly)
       🟡 Confiança: MÉDIA | ML: 7.0pp
       📋 LCK
       _Análise (forma+H2H+meta)_

T+69s  for each user inscrito em esports:
         sendDM(token, userId, msg)
         403 → marca subscribed=false

T+70s  log: [INFO] [AUTO] Tip enviada: Dplus KIA @ 2.85

================== Background ==================

T+5min  Pre-Match Final Check (cron) varre tips pendentes
        Tip 400 não está em pendente <30min (já está live), skip

T+15min  News Monitor cron, 0 news flagrantes pra T1/Dplus

T+30min  settleCompletedTips (cron) — match ainda em andamento, skip

T+45min  Match termina, Dplus KIA wins
T+47min  PandaScore atualiza winner

T+1h     settleCompletedTips:
         tip 400 → result='win'
         profit_reais = 1.2 × (2.85-1) = 2.22
         current_banca += 2.22 (esports)

T+1h     CLV: Pinnacle closing odd era 2.65 (movimento contra)
         clv = (2.85/2.65 - 1) × 100 = +7.5% positivo
         Salva em tips.clv_odds = 2.65

T+5h     auto-shadow (6h cron): CLV +7.5% em 1 tip nova, n total ainda baixo, skip
T+6h     bankroll-guardian (1h cron): banca esports +2.22, OK
T+8h BRT (next day) Daily Health Report dispara:
         DM admin: "🌅 DAILY HEALTH: 🟢1 🟡1 🔴3 | Banca R$900→R$918.28 (+R$18.28 | +2.03%)"
```

---

## 10. RESUMO PRO USUÁRIO

### O que o sistema faz **sozinho**

✅ Descobre partidas em 9 sports
✅ Coleta odds + stats live + form/H2H
✅ Filtra com modelos ML calibrados por sport
✅ Chama IA pra segunda opinião
✅ Aplica 6 camadas de gates (P-vs-modelo, sharp divergence, EV sanity, tier-aware, conf-based, odds re-validation)
✅ Calcula stake via Kelly fracionado
✅ Aplica risk manager cross-sport
✅ Envia DM Telegram pra inscritos
✅ Liquida resultados a cada 30min
✅ Atualiza banca em R$
✅ Detecta gaps de cobertura live
✅ Re-valida tips antes do match
✅ Monitora news pra times com tip pendente
✅ Detecta drift do modelo
✅ Auto-shadow sports com CLV ruim
✅ Auto-shadow sports com DD alto
✅ Detecta anomalies operacionais (mutex/poll/cache/AI)
✅ Aplica fixes automáticos
✅ Reporta diariamente via DM

### O que o usuário **precisa fazer**

📅 Diário (1 min): ler DM "Daily Health Report"
📅 Reagir a alerts críticos (~1-2/semana)
📅 Decisão final em ações que mudam comportamento (cut sport, mudar gate)

### Endpoints úteis

```
/dashboard           — UI principal
/logs                — Logs + agentes
/agents/orchestrator?workflow=daily_health
/agents/weekly-review
/agents/health-sentinel
/agents/bankroll-guardian
/agents/cut-advisor
/agents/decision-tree
/roi-matrix?days=30
/equity-curve?sport=esports&days=30
/clv-decay?sport=esports&days=30
```

---

## 11. ARQUIVOS-CHAVE

```
bot.js                          — Loops, IA, Telegram, gates, Kelly, schedulers
server.js                       — HTTP API, endpoints, agentes, dashboard, settlement
start.js                        — Launcher (auto-restart server+bot)

lib/
  utils.js                      — log, Kelly, httpGet, heartbeats, log buffer
  database.js                   — Schema SQLite + statements + migrations
  ml.js                         — esportsPreFilter (LoL/Dota/CS/Val genérico)
  lol-model.js                  — Modelo LoL específico (Elo+draft+form)
  dota-map-model.js             — Modelo Dota mapa-a-mapa
  tennis-model.js               — Elo por superfície
  football-ml.js                — Poisson + home boost
  cs-ml.js                      — Elo CS
  valorant-ml.js                — Elo + Bayesian map→série
  darts-ml.js                   — 3DA + WR sample-weighted
  snooker-ml.js                 — Ranking-log + WR
  tabletennis-ml.js             — Elo
  risk-manager.js               — applyGlobalRisk
  ml-weights.js                 — Pesos dinâmicos (recalcWeights semanal)
  name-match.js                 — Matching de settlement (5 estratégias)
  tennis-match.js               — Matching tennis específico
  news.js                       — Google News RSS pra prompts
  cashout-monitor.js            — checkTipHealth (live)

  pinnacle.js                   — Pinnacle Guest API (LoL/Dota/Tennis/CS/Val)
  pinnacle-snooker.js           — Pinnacle snooker
  vlr.js                        — VLR.gg scraper Valorant
  hltv.js                       — HLTV scraper CS
  cuetracker.js                 — CueTracker scraper snooker
  sofascore-darts.js            — Sofascore darts
  sofascore-tennis.js           — Sofascore tennis live
  sofascore-tabletennis.js      — Sofascore TT

  dashboard.js                  — runLiveScout, runFeedMedic, runRoiAnalyst,
                                  runWeeklyReview, runHealthSentinel
  agents-extended.js            — runBankrollGuardian, runPreMatchFinalCheck,
                                  runModelCalibrationWatcher, runCutAdvisor,
                                  runLiveStormManager, runIaHealthMonitor,
                                  runNewsMonitor, getDecisionTree
  auto-healer.js                — Registry de fixes + runAutoHealer
  agent-orchestrator.js         — runWorkflow + WORKFLOWS (7 chains)

public/
  dashboard.html                — Dashboard principal (Chart.js)
  logs.html                     — Logs + agentes (SSE)
  lol-ev-manual.html            — Calculadora EV manual

migrations/                     — SQLite migrations versionadas
sportsedge.db                   — DB local (Railway: /data/sportsedge.db)
```

---

## 12. CUSTOS OPERACIONAIS

Sistema tem 12 dias em produção (deploy inicial Abril/2026). Tracking real via endpoint **`GET /cost-summary?month=YYYY-MM`** + card no dashboard.

### Provedores pagos (com custo recorrente)

| Provider | Tier | Pricing | Tracking |
|---|---|---|---|
| **DeepSeek** | API key | $0.14/M input + $0.28/M output (deepseek-chat sem cache) | tabela `api_usage` (auto: count + tokens registrados a cada `/claude` proxy) |
| **The Odds API** | Free 500/mo + paid $0.005/req | budget mensal trackeado in-memory (`oddsApiQuotaStatus()`) | endpoint retorna `used/cap/pct` |
| **Railway** | Hobby ($5/mo flat) ou Pay As You Go (~$5-10/mo pra 2 services) | Não expõe API de cost — estimativa via env `RAILWAY_MONTHLY_USD_EST` (default 7) | manual |

### Provedores gratuitos

- **Pinnacle Guest API** — sem auth, sem quota documentada (rate limit soft 3min cache local)
- **PandaScore** — free tier 1000 calls/mo (não trackeamos calls atualmente)
- **Riot LoL Esports API** — gratuita
- **OpenDota** — gratuita (limit maior com `OPENDOTA_API_KEY`)
- **Steam Realtime** — gratuita (precisa `STEAM_WEBAPI_KEY`)
- **ESPN MMA/Tennis** — scraping gratuito
- **Sofascore** — via proxy hosted no Railway (já contabilizado)
- **HLTV / VLR.gg / Sherdog / CueTracker** — scraping gratuito (frágil, sujeito a quebras de HTML)

### Custo total estimado / mês (snapshot abr/2026)

Em fase inicial (12 dias, ~5 tips/dia/sport, ~250 chamadas DeepSeek/dia):
- DeepSeek: ~$2-4/mo (~7500 calls × ~600+300 tokens)
- The Odds API: $0 (dentro free tier)
- Railway: $5-10/mo (estimativa)
- **Total estimado: ~$7-15/mo (R$35-75 com USD/BRL = 5)**

⚠️ Override no env:
```
RAILWAY_MONTHLY_USD_EST=10        # ajuste conforme billing real do Railway
USD_BRL_RATE=5.20                 # taxa atual
```

### Quando preocupar

- DeepSeek > $20/mo: high volume, considerar cache de respostas pra prompts repetidos
- The Odds API > 80% quota: enable shadow ou aumentar TTL cache
- Railway > $20/mo: investigar memory leak, reduzir poll intervals

---

## 13. KNOWN ISSUES / EM CONSTRUÇÃO

### 🔧 Decisões provisórias (em janela de validação)

| Item | Status | Janela | Risco se errar |
|---|---|---|---|
| Pre-Match Check cutoff 90min (match-missing) | ⚠️ provisório | revisar 2026-05-01 | False negative pra Bo3+ longos / tennis Slam |
| Auto-Healer 12 fixes | 🧪 experimental | 14d (até 2026-05-01) | Fix que nunca dispara = ruído; fix mal-aplicado = damage |
| News Monitor | 🧪 experimental | 30d (até 2026-05-15) | 70% expected false positive — vai virar spam? |
| Auto-Shadow CLV cutoff -1% / n>=30 | 🧪 experimental | 30d | Cutoff frouxo demais pode demorar a flippar; apertado demais flippa demais |
| Sharp divergence caps por sport | 🧪 calibração inicial | 30d | Caps frouxos = edge fictício passa; apertados = boas tips bloqueadas |
| LoL tier 2-3 EV cap >25% | ⚠️ provisório | 30d | Pode estar bloqueando tips legítimas em tier 2-3 |
| Bankroll Guardian thresholds 10/15/25% DD | 🧪 sem dados ainda | 60d | Sistema novo — precisa cenário real de drawdown |

### 🚧 Em construção (parcial)

- **Live Storm Manager** — só detecta totalLive>15 e sugere; **não age** (não muda intervals dos polls automaticamente). Implementação ativa pendente.
- **Bankroll Guardian DD≥25% block** — alerta sai mas não bloqueia bot. Só auto-shadow temp em DD≥15%. Block real ficou TODO.
- **Backtest expandido** — `scripts/backtest.js` existe mas não simula gates novos (`_sharpDivergenceGate`, tier-aware caps). Resultado pode super-estimar performance.
- **PandaScore call tracking** — table `api_usage` não registra. Sem visibilidade de quanto da quota é consumida.
- **Cache de respostas DeepSeek** — prompts idênticos (mesma partida re-analisada) re-chamam IA. Possível economia 30-50% de tokens.
- **Live Scout alerts via DM** — funciona mas não tem snooze/ack (mesmo gap aparece a cada 60min sem fim).
- **Tennis match_time** — tabela tips não armazena; agentes têm que estimar via sent_at + heurística.

### 🔬 Hipóteses não validadas (precisam backtest)

- **Modelos ML são fundamentalmente sound?** — Não validado. Sistema novo (12d). Plano original era esperar 60d coletando, mas se modelo é ruim, é desperdício.
  - **Ação:** rodar `scripts/backtest.js` em match_results históricos (45d) e checar Brier + ROI simulado por sport antes de esperar mais 30d.
- **Sharp divergence threshold corretos?** — Definidos por intuição, não data.
  - **Ação:** backtest com caps diferentes (5/10/15/20pp) e comparar.
- **IA second opinion adiciona valor?** — Não medido. Pode estar só rejeitando tips boas.
  - **Ação:** rodar 30d comparando bucket com IA on vs off (shadow mode A/B).
- **News Monitor captura edge real?** — Não validado.
  - **Ação:** classificar manualmente 30 alerts: % afetou outcome de tip.
- **Auto-Shadow critério (CLV<-1% n>=30)** — chutado.
  - **Ação:** ver historicamente quantos sports flippariam e se CLV é proxy bom de ROI.

### 🐛 Bugs conhecidos não fixados

- **mutex_stale "Críticas pendentes" em DM** — fixado mas falso positivo ainda pode aparecer em janela curta. Cooldown de 30min/anomaly_id ajuda mas não elimina.
- **Settlement_stale_<sport>** detecta tips >48h sem result, mas não distingue settlement realmente travado vs match com winner desconhecido vs name match falhou.
- **DeepSeek tokens não registrados quando API antiga não retornava `usage`** — algumas calls dão custo $0 estimado errado.

### 📚 Falta documentação

- **Como adicionar sport novo** — não há runbook
- **Como debugar tip não enviada** — checklist de gates falhados
- **Como interpretar buckets do `/roi-matrix`** — `tier1` significa o quê em cada sport
- **Como reverter migration de DB** — não temos script de rollback

### 🔮 Backlog (priorizado)

| Prio | Item | Esforço |
|---|---|---|
| 🔴 HIGH | `scripts/backtest.js` v2 — incluir gates novos + Brier por bucket | 4h |
| 🔴 HIGH | Cost tracking real Railway (via webhook ou estimativa por uso) | 2h |
| 🟡 MED | Cache de respostas DeepSeek (LRU 24h por hash do prompt) | 3h |
| 🟡 MED | PandaScore quota tracking | 1h |
| 🟡 MED | Bankroll Guardian DD≥25% block real | 2h |
| 🟡 MED | Live Storm Manager: ação ativa (mudar intervals) | 4h |
| 🟢 LOW | Snooze/ack pra Live Scout alerts | 2h |
| 🟢 LOW | Comando admin `/banca <sport> <novo_valor>` | 1h |

### 🔁 Decisões pendentes (debatidas, não decididas)

- **Cortar sport sem edge após 30d?** — não definido critério final
- **Promover sport com CLV positivo sustentado?** — não definido (aumentar Kelly fraction? expandir markets?)
- **Adicionar mais bookmakers** (Betfair Exchange, Bet365)? — Betfair bloqueia BR
- **Modelo ML mais sofisticado** (deep learning, gradient boosting)? — talvez overkill pra sample size atual

---

## 14. ESTADO ATUAL (snapshot 2026-04-17)

- **9 sports ativos:** LoL, Dota, MMA, Tennis, CS, Valorant, Darts, Snooker, TT (Football disabled)
- **Banca:** R$900 inicial → R$916 atual (+1.78%)
- **Buckets:** 0 verdes | 1 amarelo (tennis pregame tier2plus) | 3 vermelhos pequenos (esports/mma — n<30) | 10 no_data
- **Auto-Healer:** rodando, 0 anomalias detectadas
- **Auto-Shadow:** ativo (env true), 0 sports flippados
- **Live Scout:** rodando, alerts ocasionais (Riot delay alto, live sem frames)
- **Phase atual:** Coleta de dados (Fase 2 do plano de ataque). Decisões de cut/scale só em ~3-4 semanas com dataset maduro.
