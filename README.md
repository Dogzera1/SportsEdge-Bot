# SportsEdge Bot

Bot autônomo de Telegram para análise automática de apostas esportivas, baseado em Valor Esperado (EV) e Kelly Criterion, alimentado por IA (DeepSeek ou Claude).

> **Status (Abril 2026 — Patch 26.5):** Sistema multi-esporte — **LoL Esports**, **Dota 2**, **MMA (UFC only)**, **Tênis** e **Futebol** operacionais. Cada esporte roda em bot Telegram independente (token separado). Odds via **SX.Bet** (LoL/Dota 2 live + pré-jogo), **OddsPapi v4** (esports upcoming) e **The Odds API** (futebol/MMA/tênis). Futebol usa **API-Football** para dados de forma, H2H e standings. MMA e Tênis usam **ESPN API** (gratuita) para records de lutadores e rankings ATP/WTA, com **fallback Sofascore** (via proxy `Public-Sofascore-API`) quando ESPN/Sherdog/Tapology não retornam dados. Tênis usa modelo **Elo por superfície** com dados Sackmann. Todos os esportes passam por pré-filtro ML antes de chamar a IA. Settlement automático em todos os esportes.
>
> **Produção (Railway):** No boot, `start.js` imprime `[LAUNCHER] PORT=… | DB=…` e sobe **dois** processos (`server.js` depois `bot.js`). Logs típicos: sync OddsPapi em lotes, `Force-fetch live` para torneios ao vivo, partidas LoL com `odds: X/Y` e lista `sem match` quando o slug OddsPapi não casa com o par Riot/PandaScore. Resposta **HTTP 429** da OddsPapi ativa **backoff de 2 horas** (nenhum fetch/re-fetch até expirar — ver `/debug-odds`). OddsPapi free tier = **250 requests totais** — default refresh é **60 min** (configurável via `ODDSPAPI_REFRESH_MIN`). Sem `CLAUDE_API_KEY`, o sistema usa só **DeepSeek** (fallback Claude desligado).

---

## Arquitetura

```
┌──────────────────────────────────────────────┐
│                  start.js                    │
│       spawna server + bot com                │
│  auto-restart (backoff exp: 3s→6s→12s→60s)  │
└──────────┬───────────────────────────────────┘
           │
┌──────────▼───────────────────────────────────┐
│           bot.js — Telegram Bot              │
│                                              │
│  Esports (LoL):                              │
│  • Auto-análise ao vivo (ciclo de 6 min)     │
│  • Auto-análise pré-jogo (upcoming <=24h)    │
│  • Alertas de draft e line movement          │
│  • Patch meta auto-fetch (ddragon, 14d)      │
│                                              │
│  MMA (UFC only):                             │
│  • Loop independente a cada 6h               │
│  • Filtro: apenas lutas na carta ESPN UFC    │
│  • ESPN scoreboard + athlete search fallback │
│  • ML pré-filtro (record ESPN → win rate)    │
│  • Análise DeepSeek com P modelo no prompt   │
│                                              │
│  Tênis:                                      │
│  • Loop independente a cada 20 min           │
│  • ESPN rankings ATP/WTA + form do torneio   │
│  • ML pré-filtro (ranking → probabilidade)   │
│  • Análise DeepSeek com P modelo no prompt   │
│                                              │
│  Futebol:                                    │
│  • Loop independente a cada 6h               │
│  • Fixtures pré-carregadas em batch (1 call) │
│  • Dados reais: forma, H2H, standings        │
│    via API-Football (lib/football-api.js)    │
│  • ML com dados reais (lib/football-ml.js)   │
│  • Settlement via fixture ID API-Football    │
│                                              │
│  Todos os esportes:                          │
│  • Fair Odds calculadas pelo modelo ML       │
│  • Settlement automático a cada 30 min       │
│  • Bots Telegram independentes por esporte   │
└──────────┬───────────────────────────────────┘
           │ HTTP localhost:PORT
┌──────────▼───────────────────────────────────┐
│         server.js — API Aggregator           │
│                                              │
│  Fontes de partidas:                         │
│    Riot / LoL Esports API + PandaScore       │
│    The Odds API (MMA / Tênis / Futebol)      │
│                                              │
│  Live LPL:                                   │
│    3 camadas: getLive zh-CN + PS running +   │
│    promoção por tempo (startTime past > 2min)│
│                                              │
│  Odds:                                       │
│    OddsPapi v4 — 1xBet (esports round-robin) │
│    The Odds API — EU (MMA/Tênis/Futebol)     │
│                                              │
│  Análise IA:                                 │
│    DeepSeek (deepseek-chat) — padrão         │
│    Anthropic Claude — fallback               │
│    Pré-filtro ML local (lib/ml.js)           │
│    Pré-filtro ML futebol (lib/football-ml.js)│
│    Contexto de notícias (lib/news.js)        │
│    Risk Manager cross-sport (lib/risk-mgr)   │
│                                              │
│  Dados gratuitos externos:                   │
│    ESPN API — MMA records + rankings tênis   │
│    Google News RSS — lesões/suspensões       │
│                                              │
│  sportsedge.db (SQLite via volume Railway)   │
│  users | events | matches | tips             │
│  odds_history | match_results | api_usage    │
│  pro_champ_stats | pro_player_champ_stats    │
│  synced_matches | settings                   │
└──────────────────────────────────────────────┘
```

---

## Pré-requisitos

- Node.js 18+
- Bot Telegram criado via [@BotFather](https://t.me/BotFather) — um por esporte ativo
- Chave **DeepSeek API** (recomendado) ou **Anthropic Claude API**
- Chave da LoL Esports API (Riot Games) — esports
- Token PandaScore — torneios fora da Riot (schedules + stats + sync de resultados pro + live LPL) — esports
- Chave OddsPapi — odds esports LoL via 1xBet ([oddspapi.io](https://oddspapi.io), plano free: **250 requests totais**) — esports
- **SX.Bet** — odds LoL/Dota 2 ao vivo (API pública, sem chave); ativar via `SXBET_ENABLED=true`
- Chave **The Odds API** — odds para futebol, MMA e tênis
- Chave **API-Football** (`api-sports.io`) — dados de forma, H2H e standings para futebol (free tier: 100 req/dia)
- Chave **football-data.org** (`FOOTBALL_DATA_TOKEN`) — enriquecimento alternativo para futebol (opcional; free tier disponível)
- **ESPN API** — gratuita, sem chave; usada automaticamente para MMA e Tênis
- **Sofascore** (via proxy `Public-Sofascore-API`) — fallback quando ESPN/Sherdog/Tapology vazios (tênis e MMA)

---

## Configuração (`.env`)

```env
# ── Telegram — um token por esporte ──
TELEGRAM_TOKEN_ESPORTS=seu_token_bot
TELEGRAM_TOKEN_MMA=seu_token_mma        # opcional
TELEGRAM_TOKEN_TENNIS=seu_token_tennis  # opcional
TELEGRAM_TOKEN_FOOTBALL=seu_token_fb    # opcional
TELEGRAM_TOKEN_DARTS=seu_token_darts    # opcional (shadow mode por default)
TELEGRAM_TOKEN_SNOOKER=seu_token_snk    # opcional (requer Betfair Exchange)

# ── APIs de IA (pelo menos uma obrigatória) ──
DEEPSEEK_API_KEY=sk-...                 # DeepSeek (recomendado — mais barato)
CLAUDE_API_KEY=sk-ant-api03-...         # Anthropic Claude (fallback)

# ── APIs de dados — esports ──
LOL_API_KEY=sua_chave_lol               # LoL Esports API (Riot Games)
ODDS_API_KEY=sua_chave_oddspapi         # OddsPapi v4 (aceita: ODDSPAPI_KEY, ODDS_PAPI_KEY, ESPORTS_ODDS_KEY)
PANDASCORE_TOKEN=seu_token              # PandaScore (obrigatório para sync de stats pro + live LPL)

# ── APIs de dados — futebol/MMA/tênis ──
THE_ODDS_API_KEY=sua_chave              # The Odds API (odds para futebol, MMA, tênis)
API_SPORTS_KEY=sua_chave               # API-Football / api-sports.io (forma, H2H, standings, settlement)
                                        # Alias aceito: APIFOOTBALL_KEY
FOOTBALL_DATA_TOKEN=sua_chave          # football-data.org v4 (enriquecimento alternativo — opcional)
# Nota: ESPN API é gratuita e sem chave — MMA e Tênis usam automaticamente

# ── Servidor ──
SERVER_PORT=8080
DB_PATH=/data/sportsedge.db            # Railway: volume montado em /data
                                        # Local: use sportsedge.db

# ── Admin ──
ADMIN_USER_IDS=123456789,987654321      # IDs numéricos Telegram (obtenha via @userinfobot)
                                        # Admin é inscrito automaticamente a cada boot
ADMIN_KEY=sua_chave_admin               # Recomendado: protege rotas admin do server.js (header x-admin-key)
                                        # Sem esta chave, rotas admin ficam abertas — WARNING no boot

# ── Risk Manager global (cross-sport) ──
GLOBAL_RISK_PCT=0.10                    # Exposição máxima global (tips pendentes) vs banca total (padrão 10%)
SPORT_RISK_PCT=0.20                     # Exposição máxima por esporte vs banca do esporte (padrão 20%)

# ── Feature flags ──
ESPORTS_ENABLED=true
MMA_ENABLED=true                        # false por padrão se token ausente
TENNIS_ENABLED=true
FOOTBALL_ENABLED=true
DARTS_ENABLED=true                      # requer TELEGRAM_TOKEN_DARTS + SOFASCORE_PROXY_BASE
SNOOKER_ENABLED=true                    # requer TELEGRAM_TOKEN_SNOOKER + Betfair (BF_APP_KEY etc.)

# ── Shadow mode (modo auditoria — tip gerada mas NÃO envia DM) ──
# Darts + Snooker: ambos GRADUADOS (default não-shadow).
# Darts: 3-dart avg + WR via Sofascore (proxy Public-Sofascore-API).
# Snooker: WR temporada via scraper CueTracker (lib/cuetracker.js) + implied Pinnacle.
# DARTS_SHADOW=true                     # voltar darts pra shadow
# SNOOKER_SHADOW=true                   # voltar snooker pra shadow

# ── Darts — Sofascore ──
# Fonte única (odds + 3-dart avg + 180s + checkouts) via Sofascore
SOFASCORE_PROXY_BASE=https://xxx.ngrok-free.app/api/v1/sofascore  # Public-Sofascore-API no projeto
# SOFASCORE_DIRECT=true                 # alternativa: chamar api.sofascore.com direto
DARTS_TOURNAMENT_WHITELIST=pdc,premier-league-darts,world-matchplay,world-grand-prix,uk-open,players-championship,european-tour,grand-slam,world-series-finals

# ── Snooker — Pinnacle guest API ──
# Usa endpoint público guest.api.arcadia.pinnacle.com (funciona do BR, sem auth).
# Betfair foi removido porque bloqueia IPs brasileiros.
# PINNACLE_API_KEY=...                   # opcional: override da X-API-Key pública
#                                        # (a chave atual está hardcoded em lib/pinnacle-snooker.js)

# ── LoL Pre-match — Pinnacle (substitui OddsPapi travada) ──
# Pinnacle cobre LCK, LCS, LFL, CBLOL, LPL, EMEA Masters, NACL, Rift Legends, etc.
# Sem quota mensal — só rate limit soft (cache 3min interno).
PINNACLE_LOL=true                       # ativa fetcher Pinnacle para LoL (pre-match + live)
PINNACLE_LOL_REFRESH_MIN=10             # refresh completo (pre + live), default 10min, mínimo 5
PINNACLE_LOL_LIVE_REFRESH_MIN=2         # refresh rápido quando há matches LIVE cacheados (default 2min)

# ── Futebol — configuração ──
FOOTBALL_LEAGUES=soccer_brazil_serie_b,soccer_brazil_serie_c  # ligas a monitorar (The Odds API keys)
FOOTBALL_EV_THRESHOLD=5.0              # EV mínimo % para emitir tip (padrão: 5.0)
FOOTBALL_DRAW_MIN_ODDS=2.80            # Odds mínimas para tip de empate (padrão: 2.80)

# Ligas disponíveis para FOOTBALL_LEAGUES:
#   soccer_brazil_campeonato     — Brasileirão Série A
#   soccer_brazil_serie_b        — Série B
#   soccer_brazil_serie_c        — Série C
#   soccer_argentina_primera     — Primera División
#   soccer_spain_segunda_division
#   soccer_germany_3liga
#   soccer_england_league1
#   soccer_england_league2
#   soccer_usa_mls
#   soccer_chile_primera_division
#   soccer_colombia_primera_a
#   soccer_uruguay_primera_division

# ── OddsPapi — ajuste fino (opcional) ──
ODDSPAPI_BATCH_SIZE=3                   # Torneios por requisição (padrão: 3)
ODDSPAPI_REFRESH_MIN=60                 # Intervalo entre ciclos de fetch em MINUTOS (padrão: 60; mín: 15)
ESPORTS_ODDS_TTL_H=3                    # Horas entre ciclos round-robin (padrão: 3h)
ODDSPAPI_BOOTSTRAP=false                # Após deploy: busca vários lotes seguidos p/ encher cache
                                        # ⚠️ free tier (250 req) — deixe false para economizar quota
ODDSPAPI_BOOTSTRAP_MS=5000              # Intervalo mínimo entre lotes no bootstrap (ms, padrão 5000)
ODDSPAPI_ESPORTS_SPORT_ID=18            # sportId LoL na OddsPapi (padrão 18)
ODDSPAPI_FORCE_COOLDOWN_S=300           # Cooldown do force=1 por par de times (s) — reduz risco de 429
ODDSPAPI_LIVE_POLL=0                    # ⚠️ NÃO ative em free tier — 6 fixtures × 3 maps a cada 6s esgota quota em segundos

# ── SX.Bet (LoL / Dota 2 ao vivo) ──
SXBET_ENABLED=true                      # Obrigatório para odds de LoL live (e Dota 2 live)
SXBET_BASE_URL=https://api.sx.bet       # Padrão — não precisa alterar

# ── PandaScore — cache ──
PANDA_CACHE_TTL_MS=60000               # TTL do cache PandaScore em ms (padrão 60s — evita rate limit)

# ── LoL — ligas extras além da whitelist interna ──
LOL_EXTRA_LEAGUES=slug1,slug2           # opcional, separado por vírgula

# ── Meta LoL (atualizado automaticamente a cada 14 dias via ddragon) ──
LOL_PATCH_META=Patch 26.X — descrição do meta atual
PATCH_META_DATE=YYYY-MM-DD

# ── Análise pré-jogo — controle de rigidez (opcional) ──
LOL_PREGAME_BLOCK_BO3=true             # true = só analisa Bo3/Bo5 após Game 1 (draft conhecido)
                                        # false = analisa upcoming sem restrição de draft

# ── Thresholds de tip LoL (opcional — valores padrão se omitidos) ──
LOL_EV_THRESHOLD=5                      # EV mínimo % para emitir tip (padrão: 5)
LOL_PINNACLE_MARGIN=8                   # Mínimo de edge em pp necessário para considerar uma aposta (padrão: 8)
LOL_NO_ODDS_CONVICTION=70              # Confiança mínima % para tip sem odds de mercado (padrão: 70)
LOL_MIN_ODDS=1.50                       # Gate pós-IA: odd mínima (padrão 1.50)
LOL_MAX_ODDS=4.00                       # Gate pós-IA: odd máxima (padrão 4.00)
LOL_HIGH_ODDS=3.00                      # Acima disso exige EV extra (LOL_HIGH_ODDS_EV_BONUS, padrão +3pp)
```

---

## Iniciando

```bash
npm install
npm start           # inicia servidor + bot via start.js

# Ou separadamente (servidor DEVE iniciar antes)
npm run server      # node server.js
npm run bot         # node bot.js

# Testes unitários (sem dependência de framework)
npm test            # executa tests/run.js — Kelly, parser de TIP_ML, name-match
```

### Testes (`tests/`)

Suíte mínima sem framework externo (Node runner puro):

| Arquivo | Cobertura |
|---|---|
| `tests/test-kelly.js` | `calcKellyWithP`, `calcKellyFraction` — casos negativos, frações, edge cases |
| `tests/test-tip-parser.js` | Regex `TIP_ML:...\|EV:...\|STAKE:...\|CONF:...` de LoL e MMA |
| `tests/test-name-match.js` | Matching de settlement: exact, alias, substring com guard, short-alias traps |

Execute `npm test` antes de qualquer deploy que toque parser da IA, Kelly ou settlement.

### Deploy no Railway

1. Push para o repositório GitHub vinculado ao Railway
2. Configure as variáveis de ambiente no painel **Variables**
3. Para persistência do banco entre redeploys: crie um Volume e defina `DB_PATH=/data/sportsedge.db`
4. O `start.js` gerencia os dois processos com **auto-restart exponencial** em falha (3s→6s→12s→24s→60s máx); primeira linha útil nos logs: `[LAUNCHER] PORT=… | DB=…`
5. Configure `ADMIN_USER_IDS` com seu ID do Telegram — o admin é inscrito automaticamente a cada boot
6. Configure `ADMIN_KEY` para proteger rotas admin; sem ele, um `WARN [SEC]` é emitido uma vez no boot
7. O `railway.toml` já está configurado com healthcheck TCP e restart policy `on_failure`
8. **OddsPapi:** `ODDSPAPI_BOOTSTRAP=true` acelera o cache no primeiro minuto após deploy, mas soma muitas chamadas — em 429 o servidor entra em **backoff 2h**

> **Nota DB_PATH no Railway:** se a variável aparecer com artefatos (`=/data/...`), o sistema sanitiza automaticamente antes de abrir o banco.

#### Decodificação rápida dos logs (produção)

| Log | Significado |
|-----|-------------|
| `[BOOT] ENV: CLAUDE_API_KEY=❌ AUSENTE` | Só **DeepSeek** entra no `/claude`; Claude desligado até configurar a chave. |
| `[BOOT] … tips existentes carregadas` | Histórico de tips por esporte reidratado do SQLite. |
| `[BOOT] Sports carregados: […]` | Esportes habilitados e se cada um tem token Telegram. |
| `[WARN] [SEC] ADMIN_KEY não configurada` | Emitido **uma vez** no boot; rotas admin abertas sem auth. Configure `ADMIN_KEY`. |
| `[PANDASCORE] N partidas LoL (M live)` | Cache PandaScore renovado (TTL 60s); M partidas ao vivo — usadas para promover LPL live. |
| `[LOL] … riot=N ps=M psBackoff=0` | N partidas Riot + M PandaScore; `psBackoff=1` quando riot < 10 partidas. |
| `[AUTO] LoL: N partidas (X live, Y draft)` | X = ao vivo (inclui LPL promovidas por PandaScore ou tempo). |
| `[AUTO-MMA] Pulando não-UFC: Nome vs Nome` | Luta fora do UFC filtrada (só UFC via ESPN scoreboard é analisado). |
| `[ODDS] Torneios ativos via sportId=18: N` | OddsPapi retornou lista dinâmica de torneios com fixtures futuras/upcoming/live. |
| `[ODDS] Buscando odds: lote N/M` | Ciclo OddsPapi (round-robin); no deploy, bootstrap pode enfileirar vários lotes. |
| `[ODDS] Bootstrap concluído — ~N entradas` | Cache esports aquecido após sequência de lotes. |
| `[LOL] … odds: A/B \| sem match: slugs` | **A** partidas com par no cache OddsPapi; slugs listados = nomes que não casaram. |
| `[AUTO] Analisando: X vs Y \| sinais=N/6 \| evThreshold=X%` | Pré-jogo/live LoL: sinais ML disponíveis, threshold adaptativo de EV. |
| `[AUTO] Sem tip: X vs Y → IA sem edge` | IA ou gates não aprovaram tip; inclui probabilidades e EV estimados. |
| `[AUTO] Gate odds … [min, max]` | Odd sugerida fora de `LOL_MIN_ODDS` / `LOL_MAX_ODDS` (padrão 1.50–4.00). |
| `[AUTO-MMA] Gate semana … luta futura` | Confiança não-alta em luta distante → descartada. |
| `[AUTO-FOOTBALL] … [sem dados]` | Fixture/API-Football não deu forma/H2H/standings (odds-only). |
| `429 — backoff 2h ativado` | OddsPapi rate limit → 2h sem fetch. |

---

## Interface do Bot

O bot opera em **modo totalmente automático**. O usuário interage pelos botões do menu:

| Botão / Comando | Função |
|---|---|
| `Notificações` | Ativa/desativa recebimento de tips automáticas por DM |
| `Tracking` | Exibe ROI, win rate, profit, calibração, split ao vivo vs pré-jogo |
| `Próximas` | Lista partidas ao vivo e próximas com odds quando disponíveis |
| `⚖️ Fair Odds` | Exibe odds calculadas pelo modelo ML do sistema |
| `Ajuda` | Explica como o bot funciona |

### Comandos Admin

| Comando | Função |
|---|---|
| `/stats` | ROI total, calibração por confiança (ALTA/MÉDIA/BAIXA), histórico de tips |
| `/users` | Status do banco de dados |
| `/pending` | Tips pendentes de settlement |
| `/settle` | Força settlement imediato |
| `/refresh-open` | Reanalisa tips pendentes e atualiza `current_odds/current_ev` |
| `/slugs` | Slugs de liga reconhecidos + desconhecidos vistos (diagnóstico) |
| `/lolraw` | Dump do schedule Riot por liga (diagnóstico) |

---

## Detecção de Partidas ao Vivo (LoL)

A LPL tem comportamento especial na Lolesports API — frequentemente aparece como `unstarted` no schedule mesmo quando ao vivo. O sistema usa **3 camadas** em cascata:

| Camada | Fonte | Descrição |
|--------|-------|-----------|
| 1 | `getLive?hl=zh-CN` | Lolesports API com locale chinês — captura LPL direto |
| 2 | PandaScore `/running` | Sempre consultado (cache 60s); promove `upcoming→live` quando PS confirma |
| 3 | Tempo decorrido | Se `startTime` passou há 2–300 min e sem `winner` → promove para live (LPL, LDL, LCK) |

> **PandaScore obrigatório para LPL live:** sem `PANDASCORE_TOKEN`, a camada 2 não funciona; a camada 3 ainda detecta por tempo.

---

## Sistema de Fair Odds

Cada esporte exibe fair odds calculadas pelo **próprio modelo de análise do sistema** — não apenas o de-juice (remoção da margem da bookie). A diferença entre a fair odd do modelo e a odd da bookie é o **edge em pp**.

| Esporte | Fonte dos dados | Método |
|---------|----------------|--------|
| LoL Esports | Forma recente + H2H (banco local, 45 dias) | Prior bayesiano logístico |
| MMA | ESPN scoreboard (carta atual UFC) + ESPN athlete search + Sofascore fallback | Win rate do record histórico |
| Tênis | Sackmann (Elo superfície) + ESPN rankings ATP/WTA + Sofascore fallback | Modelo Elo-log por superfície |
| Futebol | API-Football (forma, H2H, standings) + Sofascore home/away split | `calcFootballScore` com Poisson + home boost |
| Darts | Sofascore (3-dart avg + win rate últimos 10 jogos) | `dartsPreFilter` — 3-dart avg diff é o sinal primário |
| Snooker | Pinnacle guest API (odds) + ranking fallback | `snookerPreFilter` — log-diff de ranking ± win rate recente |

---

## Ciclos Automáticos

| Ciclo | Intervalo | Descrição |
|---|---|---|
| Auto-análise | 6 min | Analisa partidas `live` e `upcoming` nas próximas 24h |
| Re-análise ao vivo | 10 min | Re-analisa a mesma partida ao vivo enquanto sem tip enviada |
| Re-análise pré-jogo | 30 min | Re-tenta partidas upcoming que ainda não têm odds |
| Re-análise sem edge | 2× cooldown | Partidas sem edge têm cooldown dobrado para economizar tokens |
| Notificação ao vivo | 1 min | Avisa sobre draft iniciado e partida ao vivo |
| Line movement | 30 min | Alerta se odds mudaram >= 10% desde o último snapshot |
| Settlement | 30 min | Resolve tips pendentes (LoL via Riot/PandaScore, Futebol via API-Football, MMA/Tênis via ESPN) |
| Sync pro stats | 12h (+ boot) | Busca até 400 partidas pro (últimos 45 dias) via PandaScore |
| Patch meta auto-fetch | 14 dias | Busca versão atual no ddragon |
| Fetch de odds (OddsPapi) | 60 min (configurável via `ODDSPAPI_REFRESH_MIN`) | Round-robin: busca 1 lote de 3 torneios por ciclo |
| Re-fetch urgente | Sob demanda | Partida começa em < 2h → força re-fetch imediato |
| Cache PandaScore | 60s (configurável) | `PANDA_CACHE_TTL_MS` — evita chamadas excessivas ao PS |
| Cache fixtures futebol | 6h | Pré-carrega todas as fixtures da semana em batch |
| Cache ESPN MMA | 1h | Scoreboard de lutas da carta atual do UFC |
| Cache ESPN atletas | 6h | Records individuais buscados via athlete search |
| Cache ESPN tênis | 3h | Rankings ATP/WTA (150 por tour) |

---

## Sistema de ML — Sinais

O pré-filtro ML (`lib/ml.js`) calcula um edge score baseado em até 4 fatores.

| Fator | Fonte | Peso | Disponível quando |
|-------|-------|------|-------------------|
| Forma recente (win rate diferencial) | `match_results` (últimos 45 dias) | dinâmico (padrão 0.25) | Após sync pro stats |
| H2H (histórico direto) | `match_results` (últimos 45 dias) | dinâmico (padrão 0.30) | Após sync pro stats |
| Comp/meta score (WR médio dos campeões em pro play) | `pro_champ_stats` | dinâmico (padrão 0.35) | Draft disponível + sync feito |
| Live stats | Riot/PandaScore ao vivo | extra `factorCount` | Partida ao vivo |

Os pesos dinâmicos ficam em `ml_factor_weights` e são recalculados semanalmente. Veja `GET /ml-weights` no dashboard.

### Saída do Modelo (`esportsPreFilter`)

```javascript
{
  pass: true,           // se deve chamar a IA
  direction: 't1',      // direção com maior edge
  score: 9.3,           // edge máximo em pp
  modelP1: 0.621,       // probabilidade estimada pelo modelo (0-1)
  modelP2: 0.379,
  impliedP1: 0.528,     // probabilidade de-juiced do mercado
  impliedP2: 0.472,
  factorCount: 2        // quantos fatores foram usados
}
```

### Sync de Dados Pro (PandaScore)

No boot e a cada 12h, o sistema busca até **400 partidas finalizadas** dos últimos 45 dias via PandaScore e extrai:
- **`match_results`** — resultados para forma recente e H2H
- **`pro_champ_stats`** — WR de cada campeão por role em pro play
- **`pro_player_champ_stats`** — WR de cada jogador com campeões específicos

---

## Sistema de Odds

### LoL / Dota 2 ao vivo — SX.Bet + Pinnacle

Cascata de fontes para odds ao vivo:

1. **SX.Bet** (primário, per-map) — API descentralizada, ativar `SXBET_ENABLED=true`
2. **Pinnacle** (fallback, série) — guest API, cai quando SX.Bet não tem mercado aberto
3. **Série via SX.Bet** quando Riot API não fornece `currentMap` (entre mapas ou partida PandaScore `ps_`)

O endpoint `/odds?game=lol&map=N` tenta SX.Bet primeiro; se falhar, busca no `oddsCache` populado por `fetchLoLOddsFromPinnacle()` (que traz live + upcoming no mesmo endpoint `listSportMatchups`). Entradas com `isLive=true` são priorizadas via sort em `findOdds()`.

**Refresh Pinnacle live**: quando há matches LIVE cacheados, um segundo `setInterval` de `PINNACLE_LOL_LIVE_REFRESH_MIN` (default 2min) atualiza só aqueles, capturando mudanças de odds em tempo real sem sobrecarregar a API.

**Dota 2 live**: mesma cascata — SX.Bet → Pinnacle → The Odds API cache.

### LoL pré-match — Pinnacle Guest API

Pinnacle (sportId=12 E-Sports) é a fonte primária recomendada para odds pré-match de LoL desde que OddsPapi free tier (250 req) provou ser inviável. Ativar com `PINNACLE_LOL=true`.

**Cobertura confirmada (Abr/2026):** LCK, LCS, LFL, CBLOL, LPL, EMEA Masters, NACL, TCL, LCP, Prime League, Rift Legends, ROL, LES — ~33 match-winners ativos por dia.

**Lacunas:** ligas tier-3/4 fora do circuito principal (Hellenic Legends, Road of Legends pequenas, etc.) podem não estar.

**Implementação** (`lib/pinnacle.js` + `fetchLoLOddsFromPinnacle` em `server.js`):
- Filtro: `league.name` contém "League of Legends" + descarta participantes com `(Kills)` no nome (mercado kills, não match winner)
- Cache key: `esports_pin_<matchupId>` no mesmo `oddsCache` que OddsPapi → `findOdds` encontra automaticamente
- Refresh: `PINNACLE_LOL_REFRESH_MIN` (default 10 min)
- American odds → decimal via `americanToDecimal()`

### Esports pré-jogo — OddsPapi Round-Robin

Com **250 requests totais** no plano free, as odds são buscadas em ciclos round-robin. Default: 1 lote a cada **60 minutos** (configurável via `ODDSPAPI_REFRESH_MIN`).

### Ordem dos Lotes

| Lote | Ligas cobertas |
|------|----------------|
| 1 | LCS, LEC, LCK |
| 2 | Prime League (DE), Hellenic Legends League (GR), Road of Legends (PT) |
| 3 | LIT/LES (IT/ES), Finnish Pro League, EMEA Masters |
| 4 | CBLOL (BR), NACL, LPL 2026 (CN) |
| 5 | LCK CL, LCP (APAC), LRN |
| 6 | LRS, Esports World Cup |
| 7 | LPL 2026 alternativo (39997, 40019) |

> **LPL:** TID ativo confirmado: `46121`. Candidatos alternos: `39997`, `40019` (diferentes splits/stages). O sistema usa a lista dinâmica retornada pela OddsPapi API — se o TID da LPL atual não constar, as odds ficam sem match para aquele confronto.

### Re-fetch Urgente (< 2h)

Se uma partida está programada para começar em menos de 2 horas e as odds no cache têm mais de 2 horas, o sistema força um re-fetch imediato.

### Rate limit (HTTP 429)

Se a OddsPapi retornar **429**, o servidor define backoff de **2 horas**, loga `429 — backoff 2h ativado` e para todos os fetches até expirar. Use `GET /debug-odds` para ver `backoffRemainingSeconds`.

---

## Sistema de Análise IA

### Provedor de IA

O bot usa **DeepSeek** (`deepseek-chat`) como provedor padrão. Se `DEEPSEEK_API_KEY` não estiver configurado, cai automaticamente para **Anthropic Claude**. O endpoint `/claude` em `server.js` funciona como proxy unificado para ambos.

### Fluxo Completo

```
1. Ciclo detecta partida elegível (live ou upcoming <= 24h)
   |
2. Re-fetch urgente de odds (se partida começa em < 2h e odds > 2h antigas)
   |
3. Coleta em paralelo:
   |-- Odds do cache OddsPapi (via /odds?team1=X&team2=Y)
   |-- Contexto ao vivo: composições, gold, kills, dragões, barões, torres
   |-- WR de campeões em pro play (pro_champ_stats)
   |-- WR de jogadores com campeões específicos (pro_player_champ_stats)
   |-- Forma recente dos times (últimas partidas — 45 dias)
   |-- Histórico H2H (últimos 45 dias)
   |-- Movimentação de linha (variação de odds)
   |
4. Pré-filtro ML local (lib/ml.js)
   -> Retorna: modelP1, modelP2, t1Edge, t2Edge, factorCount
   -> Se sem edge matemático com compScore disponível: pula a IA
   |
5. Prompt compacto para DeepSeek/Claude (max 600 tokens de resposta)
   |
6. IA retorna:
   |-- TIP_ML:[time]@[odd]|EV:[%]|STAKE:[u]|CONF:[ALTA/MÉDIA/BAIXA]
   |
7. Gates pós-IA:
   |-- Gate 0: rejeita se não há odds reais disponíveis
   |-- Gate 0.5 (EV-modelo, assimétrico): IA reporta EV > modeloEV + 10pp → rebaixa conf
   |-- Gate 0.6 (P-magnitude, simétrico): |P_ml − P_ai_implied| > 10pp → rebaixa conf
   |-- Gate 2: rejeita odds fora de [LOL_MIN_ODDS, LOL_MAX_ODDS]
   |-- Gate 3 (direção ML×IA): direção diverge com factorCount≥2, score≥3pp → rebaixa conf
   |-- Gate 3.5 (sem-dados): factorCount=0 → bloqueia BAIXA, exige EV≥8% para MÉDIA
   |-- Gate 4 (EV adaptativo): rejeita se EV < threshold por confiança
   |-- Gate 4b: rejeita EV absurdo (> 50%) — erro de cálculo da IA
   |
8. Se TIP_ML aprovada: envia DM a todos os inscritos + registra no DB
   Usuários que bloquearam o bot (403) são removidos e persistidos no DB
```

### Unidade de stake (`u`) — base do Kelly

**Definição explícita**: `1u = 1% da banca do esporte específico` (não cross-sport).

- Cada esporte tem sua própria banca na tabela `bankroll` (`esports`, `mma`, `tennis`, `football`), com `initial_banca` e `current_banca` próprias.
- Kelly (`_applyKelly` em `lib/utils.js`) retorna stake em % da banca → multiplica por 100 para converter em `u`.
- Os caps `4u / 3u / 1.5u` correspondem a `4% / 3% / 1.5%` da banca do esporte — são o **teto hardcoded do Kelly** (não "u fixo"). Abaixo do cap, o stake escala dinamicamente com edge.
- Valor em reais do settlement: `stake_reais = stake_units × (current_banca_do_sport / 100)`.

**Caps de exposição (independentes do Kelly individual)** em `lib/risk-manager.js`:
- `GLOBAL_RISK_PCT=0.10` — soma de tips pendentes **cross-sport** não pode exceder 10% da banca total.
- `SPORT_RISK_PCT=0.20` — soma de tips pendentes de um esporte não pode exceder 20% da banca desse esporte.

Kelly calcula a stake individual, risk-manager reduz ou rejeita se os caps de exposição já estariam violados.

### Política de Kelly/Stake (ML vs IA)

O stake é calculado com **Kelly fracionado** (fração por nível de confiança). A probabilidade `P` usada no Kelly segue esta política explícita:

| Condição | P usada no Kelly | Razão |
|---|---|---|
| `factorCount > 0` (ML tem dados) | `modelP` do ML | Calibrado por histórico (Elo/forma/H2H); evita circularidade `p ← EV ← IA` |
| `factorCount = 0` (sem dados ML) | `calcKellyFraction(tipEV, odd, k)` | Fallback via EV da IA; Gate 3.5 já restringe para ALTA/MÉDIA com EV alto |

**Nunca** é feito blend entre `P_ml` e `P_ai_implied` no stake — divergência ML×IA apenas rebaixa **confiança** (que reduz a fração Kelly e o teto de stake), nunca mistura as probabilidades. Isso evita que alucinações da IA inflem apostas.

**Derivação de `P_ai_implied`** (usada nos gates de consenso):
```
P_ai_implied = (1 + EV_ia / 100) / odd
```

**Gates de consenso (LoL, `autoAnalyzeMatch`):**
- **Gate 0.5 — EV-modelo (assimétrico)**: se `EV_ia − EV_modelo > 10pp`, IA está otimista demais → rebaixa conf. Assimétrico por design: IA pessimista pode ter razão (sinal qualitativo que ML não captura).
- **Gate 0.6 — P-magnitude (simétrico)**: se `|P_ml − P_ai_implied| > 10pp` → rebaixa conf (ALTA→MÉDIA, >15pp MÉDIA→BAIXA). Captura o caso em que direção concorda mas magnitude de P diverge muito.
- **Gate 3 — direção**: se `ml.direction ≠ ia.direction` com `factorCount≥2` e `score≥3pp` → rebaixa; score>8pp rejeita BAIXA.

### Níveis de Confiança e Thresholds de EV

| Confiança | Sinais exigidos | EV mínimo (6 sinais → ≤1 sinal) | Kelly | Stake máx |
|-----------|----------------|----------------------------------|-------|-----------|
| 🟢 ALTA   | ≥ 2 sinais     | 2% → 7%                          | ¼ Kelly | 4u |
| 🟡 MÉDIA  | ≥ 1 sinal      | 1% → 5.5%                        | ⅙ Kelly | 3u |
| 🔵 BAIXA  | Nenhum         | 0.5% → 4%                        | 1/10 Kelly | 1.5u |

---

## MMA — Filtro UFC

O sistema analisa **apenas lutas do UFC**. A cada ciclo:
1. Busca todas as lutas MMA com odds (`The Odds API — mma_mixed_martial_arts`)
2. Carrega a carta atual do UFC via ESPN (`/apis/site/v2/sports/mma/ufc/scoreboard`)
3. Para cada luta com odds: verifica se os lutadores estão na carta ESPN UFC
4. Lutas não encontradas no ESPN são puladas (`[DEBUG] Pulando não-UFC: X vs Y`)

> **Nota:** lutas UFC muito futuras podem não estar ainda no ESPN scoreboard e seriam temporariamente puladas até serem adicionadas ao scoreboard.

---

## Settlement Automático

| Esporte | Fonte | Frequência |
|---------|-------|-----------|
| LoL (Riot) | LoL Esports API | 30 min |
| LoL (PandaScore) | PandaScore (prefixo `ps_`) | 30 min |
| Futebol | API-Football (prefixo `fb_`) | 30 min |
| MMA | ESPN UFC scoreboard | 30 min |
| Tênis | ESPN ATP/WTA scoreboard | 30 min |

### Matching de nomes no settlement (`lib/name-match.js`)

Settlement unifica o matching de nomes numa função auditável (`nameMatches`) com 5 estratégias em ordem:

| Método | Quando | Score |
|---|---|---|
| `exact` | strings normalizadas iguais | 1.0 |
| `alias` | `LOL_ALIASES` mapeia A↔B (ex: `FNC ↔ Fnatic`) | 0.95 |
| `substring` | `A.includes(B)` + ambos ≥ 4 chars + `score ≥ 0.5` | `shorter/longer` |
| `substring_weak` | casaria por substring mas score < 0.5 → **NÃO é match** (registrado como WARN para auditoria) | `shorter/longer` |
| `none` | nenhum dos acima | 0 |

**Threshold de score mínimo (0.5 default)** evita falsos positivos silenciosos:
- `"Real"` (4) em `"UnrealTournament"` (16) → score 0.25 → `substring_weak` (rejeitado)
- `"Bayern"` em `"BayernLeverkusen"` → score 0.375 → `substring_weak` (rejeitado — são times diferentes)
- `"Liquid"` em `"Team Liquid"` → score 0.55 → `substring` (match legítimo)

Configurável via `opts.minSubstrScore` para casos específicos.

**Tênis** usa matcher dedicado (`lib/tennis-match.js`) com suporte a `"Last, First"` e inicial abreviada (`"J. Last"`).

Cada settlement emite log: `[SETTLE] esports matchId=X tip="Fnatic" vs winner="FNC" → win [method=alias score=0.95]`. Casos `substring_weak` são logados como **WARN** destacando potenciais disputas.

---

## Rotas do Servidor

### Partidas e Odds

| Rota | Descrição |
|------|-----------|
| `GET /lol-matches` | Combina Riot API + PandaScore; inclui odds quando disponíveis no cache |
| `GET /mma-matches` | Lutas MMA próximas com odds (The Odds API) |
| `GET /tennis-matches` | Partidas de tênis próximas com odds (The Odds API) |
| `GET /football-matches` | Partidas de futebol próximas 7 dias com odds H2H + Over/Under |
| `GET /odds?team1=X&team2=Y[&force=1]` | Busca odds do cache; `force=1` ignora TTL e força re-fetch |
| `GET /live-gameids?matchId=X` | IDs dos games em andamento numa série Riot |
| `GET /live-game?gameId=X` | Stats ao vivo: gold, torres, dragões, kills, players |

### Tips e Banco

| Rota | Descrição |
|------|-----------|
| `POST /record-tip` | Registrar tip no banco |
| `POST /settle` | Liquidar tip por match_id, sport e winner |
| `GET /unsettled-tips` | Tips aguardando resultado |
| `GET /tips-history` | Histórico de tips com filtros |
| `GET /roi` | ROI total, calibração por confiança, split ao vivo/pré-jogo |
| `GET /team-form?team=X&game=X` | Forma recente do time (exato → fuzzy LIKE, últimos 45 dias) |
| `GET /h2h?team1=X&team2=Y&game=X` | Histórico H2H (exato → fuzzy LIKE, últimos 45 dias) |

### Diagnóstico

| Rota | O que retorna |
|------|--------------|
| `GET /health` | Saúde do serviço + métricas-lite |
| `GET /debug-odds` | Cache completo de odds: slugs, TTL, backoff restante, estado do round-robin |
| `GET /debug-teams` | Todos os times do schedule com `hasOdds` e `league` — identifica mismatches |
| `GET /debug-match-odds?team1=X&team2=Y` | Testa matching de odds para um par específico |
| `GET /lol-slugs` | Slugs de liga reconhecidos na whitelist + slugs desconhecidos |
| `GET /lol-raw` | Dump bruto do schedule Riot por liga |

---

## Banco de Dados (`sportsedge.db`)

| Tabela | Conteúdo |
|--------|---------|
| `users` | user_id, username, subscribed, sport_prefs (JSON array) |
| `tips` | odds, EV, stake, confidence, resultado, isLive, clv_odds, open_odds |
| `odds_history` | Snapshots de odds (14 dias) para detecção de line movement |
| `match_results` | Resultados pro (últimos 45 dias) para forma recente e H2H |
| `pro_champ_stats` | WR de campeões por role em pro play |
| `pro_player_champ_stats` | WR de jogadores com campeões específicos em pro play |
| `synced_matches` | IDs de partidas já sincronizadas |
| `api_usage` | Contador de uso por provedor de IA e mês |
| `bankroll` | Banca atual por esporte |
| `ml_factor_weights` | Pesos dinâmicos do pré-filtro ML (recalculados semanalmente) |
| `tip_factor_log` | Log de fatores ML por tip (para recalibração de pesos) |
| `settings` | Flags de controle interno (ex: one-time cleanups) |
| `voided_tips` | Blacklist de tips com odds erradas |

---

## Estrutura de Arquivos

```
lol betting/
├── server.js           # Servidor HTTP: odds, partidas, banco, endpoints, proxy IA, sync pro stats
├── bot.js              # Bot Telegram: polling, análise automática, tips, patch meta, fair odds
├── start.js            # Launcher: spawna server + bot com auto-restart (backoff exponencial)
├── sync-form.js        # Script avulso: sync histórico de partidas (forma/H2H) sem o servidor rodando
├── railway.toml        # Deploy Railway (healthcheck TCP, restart on_failure)
├── nixpacks.toml       # Build config Nixpacks (Railway)
├── package.json
├── .env                # Credenciais (nunca commitar)
├── sportsedge.db       # SQLite (criado automaticamente; path via DB_PATH)
├── migrations/         # Scripts de migração SQLite
├── public/             # Dashboard HTML + calculadora EV manual (lol-ev-manual.html)
└── lib/
    ├── database.js     # Schema SQLite, statements (exato + fuzzy LIKE), índices de performance
    ├── ml.js           # Pré-filtro ML esports (forma, H2H, comp score) — retorna modelP1/P2
    ├── ml-weights.js   # Pesos dinâmicos do ML — recalculados semanalmente por acurácia por fator
    ├── risk-manager.js # Risk Manager global: ajusta stake por exposição cross-sport (GLOBAL_RISK_PCT/SPORT_RISK_PCT)
    ├── news.js         # Google News RSS — contexto de lesões/suspensões/escalações no prompt (sem API key)
    ├── football-data.js# Wrapper football-data.org v4: enriquecimento alternativo para futebol
    ├── football-ml.js  # Pré-filtro ML futebol: 1X2 + Over/Under via Poisson simplificado
    ├── tennis-data.js  # Dados ESPN de tênis: rankings ATP/WTA, scoreboard de torneios
    ├── radar-sport.js  # Wrapper Radar Sport API com cache em memória + throttle
    ├── sports.js       # Registry de esportes (tokens, feature flags)
    └── utils.js        # log, calcKelly, calcKellyFraction, norm, fmtDate, httpGet, safeParse
```

---

## Troubleshooting e Erros Comuns

### Banco de Dados
- **`no such table: settings`**: Reinicie o servidor — a tabela é criada automaticamente no boot pelo schema.
- **`syntax error` ao criar tabelas**: Verifique se o SQLite está acessível e o `DB_PATH` está correto.
- **Perda de conexão com DB**: Railway pode reatribuir volume. O sistema fallback para `sportsedge.db` local.

### Odds
- **`sem match` nos logs**: Nomes de times não casam entre Riot/PandaScore e OddsPapi. Use `/debug-match-odds` para investigar.
- **HTTP 429 da OddsPapi (`Request limit exceeded — 250 requests`)**: Backoff de 2 horas ativado automaticamente. Verifique `/debug-odds` para tempo restante. Se recorrente: aumente `ODDSPAPI_REFRESH_MIN` (ex: `120` ou `180`) e desative `ODDSPAPI_BOOTSTRAP` e `ODDSPAPI_LIVE_POLL`.
- **`/debug-odds` mostra `count: 0, lastSync: nunca`**: OddsPapi nunca conseguiu sincronizar — chave ausente/inválida ou backoff ativo. Veja `lastApiResponse` para detalhes.
- **LPL sem odds**: OddsPapi pode não ter cobertura para esse confronto específico. Verifique se o TID 46121 está na lista dinâmica via `/debug-odds`.
- **Sem notificação de partida LoL ao vivo com odds**: confira `SXBET_ENABLED=true`. Odds de LoL live vêm exclusivamente do SX.Bet, independente do OddsPapi. O sistema já faz fallback para odds de série quando Riot API não retorna `currentMap` (entre mapas ou partidas PandaScore `ps_`).

### LPL Live
- **LPL não aparece como live**: Verifique se `PANDASCORE_TOKEN` está configurado. Sem ele, a detecção por PandaScore (camada 2) não funciona; a detecção por tempo (camada 3) ainda atua após 2min do startTime.
- **LPL aparece como live mas não deveria**: A promoção por tempo usa a janela 2–300min; se o jogo terminou sem atualizar `winner` na API, pode persistir como live por até 5h.

### MMA
- **Lutas UFC sendo filtradas**: O ESPN scoreboard pode não ter lutas muito futuras. Elas serão adicionadas assim que aparecerem no ESPN.
- **Lutas não-UFC aparecendo**: Verifique se o filtro `findEspnFight` está funcionando nos logs (`[DEBUG] Pulando não-UFC`).

### IA
- **`Failed to parse AI response`**: A IA não seguiu o formato esperado. Verifique o prompt e contexto enviado.
- **Timeout da API**: DeepSeek/Claude pode demorar. Timeout configurado para 45 segundos.

### Settlement
- **Tips não settled**: Verifique se a API de resultados está funcionando (ESPN para MMA/Tênis, API-Football para futebol).
- **Winner não detectado**: Nomes podem não casar. O sistema usa fuzzy matching.

---

## Darts (shadow mode)

Novo esporte adicionado em modo **shadow** (tip é gerada e registrada no DB, mas **não envia DM**). Objetivo: auditar CLV e win rate dos primeiros 30 tips antes de promover para produção.

### Arquitetura

- **Fonte única**: Sofascore (via proxy `Public-Sofascore-API` no projeto).
- **`lib/sofascore-darts.js`**: listagem de eventos PDC, odds H2H, stats do match (`Average3Darts`, `Thrown180`, `CheckoutsOver100`, etc.) e rolling average dos últimos N jogos por jogador.
- **`lib/darts-ml.js`**: pré-filtro com **3-dart avg differential como sinal primário** (equivalente ao xG em futebol) + win rate recente como sinal secundário.
- **Sem IA**: modelo puramente estatístico (3DA é forte o suficiente; economia de tokens).
- **Kelly conservador**: 1/8 Kelly + gates de edge ≥4pp (com 2 fatores) ou 5pp (com 1 fator).
- **Whitelist PDC** via `DARTS_TOURNAMENT_WHITELIST` (default cobre PDC World, Premier League, Matchplay, Grand Prix, UK Open, Players Championship, European Tour, Grand Slam, World Series Finals).

### Shadow Mode

| Flag env | Efeito |
|---|---|
| `DARTS_SHADOW=true` (default) | Tips registradas com `is_shadow=1` no DB; sem DM |
| `DARTS_SHADOW=false` | Tips enviam DM normalmente (após graduação) |
| `<SPORT>_SHADOW=true` | Qualquer outro esporte também pode rodar em shadow |

### Comando admin `/shadow [sport]`

Relatório de auditoria via Telegram:
```
🕶️ SHADOW TIPS — DARTS
Total: 17
✅ W: 9 | ❌ L: 6 | ⚪ Void: 0 | ⏳ Pend: 2
Win rate: 60.0%
CLV médio: +2.15% (n=13)
```

**Critério de graduação sugerido**: ≥30 tips, CLV médio positivo, win rate calibrado com confiança predita. Ao graduar: setar `DARTS_SHADOW=false` e restart.

### Endpoint `/shadow-tips?sport=X&limit=100`

Retorna JSON com summary + últimas N tips para análise externa (Excel, Python notebook).

---

## Snooker (Pinnacle guest API)

Novo esporte em shadow mode, alimentado pela **Pinnacle Guest API** — endpoint público usado pelo próprio frontend pinnacle.com, sem auth real.

### Por que Pinnacle (e não Betfair)

A primeira tentativa foi usar Betfair Exchange API (delayed key gratuita), mas **Betfair bloqueia IPs brasileiros** (Region: BR → Restricted). Pinnacle aceita acesso de BR e tem endpoint guest público.

### Setup

Zero setup — a `X-API-Key` pública é hardcoded em `lib/pinnacle-snooker.js`. Se Pinnacle rotacionar essa chave, use `PINNACLE_API_KEY` no env para override.

```env
SNOOKER_ENABLED=true
TELEGRAM_TOKEN_SNOOKER=<token>
SNOOKER_SHADOW=true  (default)
```

### Limitações

- Sem auth oficial — a key é pública mas pode ser rotacionada sem aviso (risco médio)
- Rate limit soft: cache de 3 min no endpoint `/snooker-matches`
- Schema pode mudar (mudou uma vez em 2023) — se quebrar, ajustar parser em `lib/pinnacle-snooker.js`
- Odds em formato **American odds** (+305, -499) → convertidas para decimal via `americanToDecimal()`

### Fluxo (`lib/pinnacle-snooker.js`)

- `GET /0.1/sports/28/matchups?brandId=0` → lista de matchups ativos (sportId 28 = snooker)
- Para cada matchup: `GET /0.1/matchups/{id}/markets/related/straight` → moneyline + totals
- Extrai `prices.home` / `prices.away` (American), converte para decimal
- Cobertura: todos os majors (World, UK, Masters, Tour Championship, German Masters, etc.)

### Código legado

`lib/betfair.js` ficou no repo como referência para deploys fora do BR — se um dia o bot rodar em servidor US/EU, pode ser reativado trocando o import em `server.js`.

### Modelo ML

`lib/snooker-ml.js` com 2 sinais possíveis:
- **Log-diff de ranking** (placeholder — snooker.org pendente de aprovação do header `X-Requested-By`)
- **Win rate da temporada atual** (ATIVO) — via scraper `lib/cuetracker.js` de `cuetracker.net/players/<slug>`

### Enrichment CueTracker (`lib/cuetracker.js`)

CueTracker não tem API oficial — scraping HTML puro do padrão `Won:</span> N (XX.XX%)`.

- **Cache 6h** (stats mudam lentamente — temporadas snooker são longas)
- **Slug**: nome convertido para lowercase com hífens (ex: `Judd Trump` → `judd-trump`)
- **Validação**: testado com Trump, Selby, Bingham, Vafaei, Zhou Yuelong, Jackson Page — todos retornaram stats corretas
- **Risco**: CueTracker pode mudar HTML. Se quebrar, ajustar o regex em `_fetchHtml` + fallback para shadow automático.

### Whitelist

Por default sem whitelist explícita; Betfair já foca em majors (World Championship, UK, Masters, Tour Championship, German Masters, Shanghai, etc.). Filtro adicional por competição pode ser adicionado se necessário.

---

## Monitoramento e Alertas

### `/health` — status agregado do sistema

Retorna JSON com status por fonte de dados (não apenas esports):

```json
{
  "status": "ok|degraded|error",
  "db": "connected",
  "lastAnalysis": "...",
  "pendingTips": { "esports": 3, "mma": 1, "tennis": 0 },
  "sources": {
    "oddspapi": { "keyConfigured": true, "lastSyncMinAgo": 12, "cacheSize": 18, "backoffActive": false },
    "theOddsApi": { "keyConfigured": true, "quota": { "used": 410, "cap": 450, "pct": 91.1 } },
    "sxbet": { "enabled": true },
    "apiFootball": { "keyConfigured": true }
  },
  "alerts": [...],
  "metricsLite": {...}
}
```

### `/alerts` — alertas críticos ativos

Endpoint dedicado para monitoramento externo. Retorna apenas o array de alertas ativos no momento:

| ID do alerta | Severidade | Dispara quando |
|---|---|---|
| `db_error` | critical | SQLite falhou |
| `oddspapi_key_missing` | critical | `ODDS_API_KEY`/`ODDSPAPI_KEY` ausente |
| `oddspapi_never_synced` | critical | OddsPapi nunca sincronizou (>30 min pós-boot) |
| `oddspapi_backoff_long` | warning | backoff 429 ativo há >1h |
| `theodds_quota_high` | warning / critical | The Odds API ≥80% / ≥95% da quota |
| `analysis_stale` | warning | nenhuma análise há >2h |

### Notificações Telegram para admin

O bot faz **polling do `/alerts` a cada 10 min** (`checkCriticalAlerts` em `bot.js`) e envia DM para todos os `ADMIN_USER_IDS` quando um alerta novo aparece. Throttle: 1h por `alert.id` (se persistir, re-notifica a cada hora, não a cada ciclo).

Exemplo da mensagem recebida:
```
🚨 ALERTA SISTEMA (critical)

`oddspapi_never_synced`
OddsPapi nunca sincronizou desde o boot (>30min) — verifique chave/quota
```

**Observação de escopo**: não integramos Sentry/Prometheus — overkill para um único deploy Railway. O modelo de polling do `/alerts` via bot é suficiente e mantém dependências zero.

---

## Concorrência SQLite

Tanto `server.js` quanto `bot.js` abrem o mesmo arquivo via `lib/database.js`. Concorrência é segura porque:

- `journal_mode = WAL` — leitores concorrentes não bloqueiam escritores
- `busy_timeout = 5000` — queries esperam até 5s antes de disparar `SQLITE_BUSY`
- Transações críticas (settlement, record-tip) são wrapped em `db.transaction()` — atômicas

Em cargas muito maiores (>100 req/s de escrita), considerar migrar para PostgreSQL — Railway oferece free tier. Hoje o volume de escritas é baixo (tips individuais + settlements a cada 30 min) e WAL + busy_timeout cobrem o caso com folga.

---

## Segurança

- Todas as credenciais via `.env` — nunca hardcoded
- `.env` e `*.db` no `.gitignore`
- Comandos admin protegidos por whitelist `ADMIN_USER_IDS`
- `ADMIN_KEY` protege rotas admin do servidor via header `x-admin-key` — **configure em produção**; sem ela, WARNING emitido uma vez no boot
- Usuários que bloqueiam o bot (403) removidos da memória e persistidos no DB (`subscribed: false`)
- API key da IA transmitida via header, nunca no body
- OddsPapi key aceita múltiplas variáveis: `ODDS_API_KEY`, `ODDSPAPI_KEY`, `ODDS_PAPI_KEY`, `ESPORTS_ODDS_KEY`
- `DB_PATH` sanitizado automaticamente (trim + remoção de artefatos `=` do Railway)
- Índices SQLite otimizados: `odds_history(recorded_at)`, `match_results(lower(team1))`, `tips(sport, result)`, `tips(match_id)`
