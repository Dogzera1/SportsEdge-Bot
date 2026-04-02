# LoL Betting Bot

Bot autônomo de Telegram para análise automática de apostas em **League of Legends**, baseado em Valor Esperado (EV) e Kelly Criterion, alimentado pela IA Claude da Anthropic.

> **Status (Abril 2026):** Sistema operando exclusivamente para LoL. Odds via **OddsPapi v4** (1xBet, plano free 250 req/mês) com sistema **round-robin** que busca um lote de torneios por ciclo, evitando rate-limit. Análise automática ao vivo e pré-jogo funcional. Ligas europeias secundárias (Prime League, HLL, Road of Legends, LIT) cobertas a partir do 2° ciclo (~3h após startup).

---

## Arquitetura

```
┌──────────────────────────────────────────────┐
│                  start.js                    │
│       spawna server + bot com                │
│       auto-restart em falha                  │
└──────────┬───────────────────────────────────┘
           │
┌──────────▼───────────────────────────────────┐
│           bot.js — Telegram Bot              │
│                                              │
│  • Polling contínuo + backoff exponencial    │
│  • Auto-análise ao vivo (ciclo de 6 min)     │
│  • Auto-análise pré-jogo (próximas 24h)      │
│  • Alertas de draft e line movement          │
│  • Settlement automático de tips             │
└──────────┬───────────────────────────────────┘
           │ HTTP localhost:PORT
┌──────────▼───────────────────────────────────┐
│         server.js — API Aggregator           │
│                                              │
│  Fontes de partidas:                         │
│    Riot / LoL Esports API                    │
│    PandaScore API                            │
│                                              │
│  Odds:                                       │
│    OddsPapi v4 — 1xBet (round-robin)         │
│                                              │
│  Análise IA:                                 │
│    Anthropic Claude (claude-sonnet-4-6)      │
│    Pré-filtro ML local (lib/ml.js)           │
│                                              │
│  sportsedge.db (SQLite)                      │
│  users | events | matches | tips             │
│  odds_history | match_results                │
└──────────────────────────────────────────────┘
```

---

## Pré-requisitos

- Node.js 18+
- Bot Telegram criado via [@BotFather](https://t.me/BotFather)
- Chave da API Anthropic Claude
- Chave da LoL Esports API (Riot Games)
- Token PandaScore — torneios fora da Riot (schedules + stats)
- Chave OddsPapi — odds esports LoL via 1xBet ([oddspapi.io](https://oddspapi.io), plano free: 250 req/mês)

---

## Configuração (`.env`)

```env
# ── Telegram ──
TELEGRAM_TOKEN_ESPORTS=seu_token_bot

# ── APIs ──
CLAUDE_API_KEY=sk-ant-api03-...          # Anthropic Claude
LOL_API_KEY=sua_chave_lol                # LoL Esports API (Riot Games)
ODDS_API_KEY=sua_chave_oddspapi          # OddsPapi v4 (aceita também: ODDSPAPI_KEY)
PANDASCORE_TOKEN=seu_token               # PandaScore

# ── Servidor ──
SERVER_PORT=8080
DB_PATH=sportsedge.db                    # Railway: use /data/sportsedge.db com volume montado

# ── Admin ──
ADMIN_USER_IDS=123456789,987654321       # IDs numéricos Telegram (obtenha via @userinfobot)
                                         # O admin é inscrito automaticamente a cada boot

# ── Feature flags ──
ESPORTS_ENABLED=true

# ── OddsPapi — ajuste fino (opcional) ──
ODDSPAPI_BATCH_SIZE=3                    # Torneios por requisição (padrão: 3)
ESPORTS_ODDS_TTL_H=3                     # Horas entre ciclos round-robin (padrão: 3h)

# ── LoL — ligas extras além da whitelist interna ──
LOL_EXTRA_LEAGUES=slug1,slug2            # opcional, separado por vírgula

# ── Meta LoL (atualizar a cada patch para melhorar qualidade da análise) ──
LOL_PATCH_META=Patch 25.X — descrição do meta atual
PATCH_META_DATE=YYYY-MM-DD
```

---

## Iniciando

```bash
npm install
npm start           # inicia servidor + bot via start.js

# Ou separadamente (servidor DEVE iniciar antes)
npm run server      # node server.js
npm run bot         # node bot.js
```

### Deploy no Railway

1. Push para o repositório GitHub vinculado ao Railway
2. Configure as variáveis de ambiente no painel **Variables**
3. Para persistência do banco entre redeploys: crie um Volume e defina `DB_PATH=/data/sportsedge.db`
4. O `start.js` gerencia os dois processos com auto-restart em falha
5. Configure `ADMIN_USER_IDS` com seu ID do Telegram — o admin é inscrito automaticamente a cada boot
6. O `railway.toml` já está configurado com healthcheck TCP e restart policy `on_failure`

---

## Interface do Bot

O bot opera em **modo totalmente automático**. O usuário interage pelos botões do menu:

| Botão / Comando | Função |
|---|---|
| `Notificações` | Ativa/desativa recebimento de tips automáticas por DM |
| `Tracking` | Exibe ROI, win rate, profit, calibração, split ao vivo vs pré-jogo |
| `Próximas` | Lista partidas ao vivo e próximas com odds quando disponíveis |
| `Ajuda` | Explica como o bot funciona |

### Comandos Admin

| Comando | Função |
|---|---|
| `/stats` | ROI total, calibração por confiança (ALTA/MÉDIA/BAIXA), histórico de tips |
| `/users` | Status do banco de dados |
| `/pending` | Tips pendentes de settlement |
| `/settle` | Força settlement imediato |
| `/slugs` | Slugs de liga reconhecidos + desconhecidos vistos (diagnóstico) |
| `/lolraw` | Dump do schedule Riot por liga (diagnóstico) |

---

## Ciclos Automáticos

| Ciclo | Intervalo | Descrição |
|---|---|---|
| Auto-análise | 6 min | Analisa partidas `live` e `upcoming` nas próximas 24h |
| Re-análise ao vivo | 10 min | Re-analisa a mesma partida ao vivo enquanto sem tip enviada |
| Re-análise pré-jogo | 30 min | Re-tenta partidas upcoming que ainda não têm odds |
| Notificação ao vivo | 1 min | Avisa sobre draft iniciado e partida ao vivo |
| Line movement | 30 min | Alerta se odds mudaram >= 10% desde o último snapshot |
| Settlement | 30 min | Resolve tips pendentes via Riot API e PandaScore |
| Patch meta stale | 24h | Avisa admins se `LOL_PATCH_META` não foi atualizado há mais de 14 dias |
| Fetch de odds | 3h (configurável) | Round-robin: busca 1 lote de 3 torneios por ciclo |

---

## Sistema de Odds — OddsPapi Round-Robin

Com 250 req/mês no plano free (~8 req/dia), as odds são buscadas em ciclos de 3h. Cada ciclo cobre **um lote diferente** de torneios, ciclando pelos 6 lotes. Todos os torneios são cobertos em ~18h.

### Ordem dos Lotes

| Lote | Ligas cobertas | Quando busca |
|------|----------------|--------------|
| 1 | LCS, LEC, LCK | Startup |
| 2 | Prime League (DE), Hellenic Legends League (GR), Road of Legends (PT) | +3h |
| 3 | LIT/LES (IT/ES), Finnish Pro League, EMEA Masters | +6h |
| 4 | CBLOL (BR), NACL, LPL (CN) | +9h |
| 5 | LCK CL, LCP (APAC), LRN | +12h |
| 6 | LRS, Esports World Cup | +15h |

O cursor do round-robin é visível em `/debug-odds` no campo `roundRobin`.

### Matching de Times

A OddsPapi v4 não retorna nomes de times nos campos padrão — os nomes estão embutidos na URL de fixture do bookmaker (ex: `315638638-cloud9-lyon-gaming`). O sistema extrai o "combined slug" da URL, normaliza (minúsculo, sem caracteres especiais) e usa correspondência de substring. Um dicionário de aliases cobre variações de nome:

```
"BNK FEARX" → norm "bnkfearx" → alias key "fearx" → encontra "fearxhanjinbrion"
"Gen.G Esports" → norm "gengesports" → alias key "geng" → variante "gen" → encontra "gengktrolster"
```

---

## Sistema de Análise IA

### Fluxo Completo

```
1. Ciclo detecta partida elegível (live ou upcoming <= 24h)
   |
2. Coleta em paralelo:
   |-- Odds do cache OddsPapi (via /odds?team1=X&team2=Y)
   |-- Contexto ao vivo: composições, gold, kills, dragões,
   |   barões, torres (Riot API ou PandaScore)
   |-- Forma recente dos times (últimas partidas no banco)
   |-- Histórico H2H
   |-- Movimentação de linha (variação de odds)
   |
3. Pré-filtro ML local (lib/ml.js)
   -> Regressão logística heurística em JavaScript puro
   -> Se sem edge matemático: pula o Claude (economiza créditos)
   |
4. Prompt estruturado em 2 etapas para o Claude:
   |-- ETAPA 1: Estimativa cega de probabilidade (draft/forma)
   |-- ETAPA 2: Comparação com odds de mercado -> cálculo de EV
   |
5. Claude (claude-sonnet-4-6) retorna:
   |-- TIP_ML:[time]@[odd]|EV:[%]|STAKE:[u]|CONF:[ALTA/MÉDIA/BAIXA]
   |-- FAIR_ODDS:[time1]=[X.XX]|[time2]=[X.XX]  (quando sem odds reais)
   |
6. Se TIP_ML com EV >= +2%: envia DM a todos os inscritos
   Se só FAIR_ODDS: envia "odds de referência" sem tip formal
   |
7. Registra no banco SQLite + marca tipSent=true (evita duplicatas após redeploy)
```

### Tipos de Tips

| Tipo | Dispara quando | Dados usados | Label na mensagem |
|------|---------------|--------------|-------------------|
| Ao vivo | `status = live` | Composições + Gold + KDA + Objetivos (~90s delay) | `TIP ML AUTOMÁTICA` |
| Pré-jogo | `upcoming` nas próximas 24h | Forma histórica + H2H + odds de mercado | `TIP PRÉ-JOGO ESPORTS` |

Uma tip por partida — o flag `tipSent` é salvo no banco e recarregado no boot, evitando duplicatas após redeploy.

### Proteções Anti-Viés

| Proteção | Mecanismo |
|---|---|
| "Sem edge" é resposta válida | Instrução explícita no prompt para não forçar recomendação |
| Gate de 3pp | Se estimativa do Claude divergir das odds implícitas em <3pp: retorna "SEM EDGE" |
| Line movement | Instrução para ajustar probabilidade 2-3pp na direção do mercado quando linha se mover |
| Alto fluxo | Jogos com <15 min ou objetivo maior recente (Baron, Elder) rebaixam confiança para BAIXA automaticamente |
| Sem odds reais | Sem odds de mercado, tip só emitida com convicção >65% e múltiplos fatores favoráveis |

### Nota sobre Tips Pré-Jogo

Tips `upcoming` são baseadas em forma histórica e H2H — sem acesso ao draft, disponível apenas quando a série começa. As mensagens incluem o aviso:

> _Análise pré-draft: baseada em forma e histórico (sem acesso às comps)_

O tracking exibe resultados separados por fase (ao vivo vs pré-jogo) para avaliação empírica de ROI.

### Kelly Criterion (¼ Kelly)

```
f* = EV / (odds - 1)
stake = clamp(f* × 0.25, 0.5u, 4u)  arredondado a 0.5u
```

---

## Cobertura de Ligas

### Partidas (Riot API + PandaScore)

| Tier | Ligas |
|------|-------|
| T1 — Global | Worlds, MSI |
| T1 — Regionais | LCS, LCK, LEC, LPL, CBLOL, LLA, PCS, LCO, VCS, LJL, LCP |
| T2 — Europa | EMEA Masters, LFL, NLC, Prime League (DE), Hellenic Legends League (GR), LIT (IT), LES (ES), Road of Legends (PT), Finnish Pro League, EBL |
| T2 — Americas | LTA Norte, LTA Sul, NACL, Circuito Desafiante |
| T2 — Asia | LCK CL, LDL, LRN, LRS |
| EWC | Esports World Cup e qualificatórias |

Ligas adicionais podem ser habilitadas via `LOL_EXTRA_LEAGUES` no `.env`.

### Stats ao Vivo (LoL)

- Gold total por time com trajetória por minuto
- Torres, dragões (com tipos), barões, inibidores, kills
- KDA, gold e função (TOP/JGL/MID/ADC/SUP) por jogador
- ~90s de delay na API oficial da Riot
- PandaScore como fonte alternativa para torneios não transmitidos pela Riot

---

## Settlement Automático

| Fonte | Frequência |
|-------|-----------|
| LoL Esports API (`/getSchedule`) | 30 min |
| PandaScore | 30 min |

---

## Rotas do Servidor

### Partidas e Odds

| Rota | Descrição |
|------|-----------|
| `GET /lol-matches` | Combina Riot API + PandaScore; inclui odds quando disponíveis no cache |
| `GET /odds?team1=X&team2=Y` | Busca odds do cache para um par de times |
| `GET /live-gameids?matchId=X` | IDs dos games em andamento numa série Riot |
| `GET /live-game?gameId=X` | Stats ao vivo: gold, torres, dragões, kills, players |
| `GET /ps-compositions?matchId=ps_X` | Composições e stats via PandaScore (prefix `ps_`) |
| `GET /match-result?matchId=X&game=X` | Resultado final de uma partida |

### Tips e Banco

| Rota | Descrição |
|------|-----------|
| `POST /record-tip` | Registrar tip no banco |
| `POST /settle-tip` | Liquidar tip por vencedor |
| `GET /unsettled-tips` | Tips aguardando resultado |
| `GET /tips-history` | Histórico de tips com filtros |
| `GET /roi` | ROI total, calibração por confiança, split ao vivo/pré-jogo |
| `GET /team-form?team=X&game=X` | Forma recente do time |
| `GET /h2h?team1=X&team2=Y&game=X` | Histórico H2H |
| `GET /odds-movement` | Variação de odds nas últimas 24h |
| `GET /db-status` | Contagem de registros por tabela |
| `GET /users` | Listar usuários |
| `POST /save-user` | Criar/atualizar usuário |
| `POST /claude` | Proxy para Anthropic API |

### Diagnóstico

| Rota | O que retorna |
|------|--------------|
| `GET /debug-odds` | Cache completo de odds: slugs, TTL, backoff restante, estado do round-robin (`cursor`, `nextBatch`, `totalBatches`, `nextTids`, `cycleCompletesIn`) |
| `GET /debug-teams` | Todos os times do schedule (Riot + PandaScore) com `team1norm`, `team2norm`, `hasOdds` e `league` — permite identificar mismatches de nome |
| `GET /debug-match-odds?team1=X&team2=Y` | Testa matching de odds para um par específico, mostrando variantes e aliases verificados |
| `GET /lol-slugs` | Slugs de liga reconhecidos na whitelist + slugs desconhecidos vistos no schedule |
| `GET /lol-raw` | Dump bruto do schedule Riot por liga |

---

## Banco de Dados (`sportsedge.db`)

| Tabela | Conteúdo |
|--------|---------|
| `users` | user_id, username, subscribed, sport_prefs (JSON array) |
| `events` | Torneios/eventos com sport = 'esports' |
| `matches` | Confrontos com resultado pós-jogo |
| `tips` | Tips: odds, EV, stake, confidence, resultado, isLive |
| `odds_history` | Snapshots de odds (14 dias) para detecção de line movement |
| `match_results` | Histórico de resultados para forma recente e H2H |

---

## Estrutura de Arquivos

```
lol betting/
├── server.js           # Servidor HTTP: odds, partidas, banco, endpoints
├── bot.js              # Bot Telegram: polling, análise automática, tips
├── start.js            # Launcher: spawna server + bot com auto-restart
├── railway.toml        # Deploy Railway (healthcheck TCP, restart on_failure)
├── package.json
├── .env                # Credenciais (nunca commitar)
├── sportsedge.db       # SQLite (criado automaticamente; path via DB_PATH)
└── lib/
    ├── database.js     # Schema SQLite, prepared statements e índices
    ├── ml.js           # Pré-filtro ML local (regressão logística heurística)
    ├── sports.js       # Registry de esportes (tokens, feature flags)
    └── utils.js        # log, calcKelly, norm, fmtDate, httpGet, safeParse
```

---

## Fontes de Dados

| Fonte | Uso |
|-------|-----|
| `esports-api.lolesports.com` | Calendário oficial LoL, séries, placar |
| `feed.lolesports.com` | Stats ao vivo LoL (~90s de delay) |
| `esports.lolesports.com/persisted2` | Composições e detalhes do draft |
| PandaScore API | Torneios não-Riot: schedules, compositions, stats |
| OddsPapi v4 (`api.oddspapi.io/v4`) | Odds 1xBet para LoL (sportId=18), round-robin por lote |
| Anthropic Claude (`claude-sonnet-4-6`) | Análise de matchup via proxy `/claude` |

---

## Segurança

- Todas as credenciais via `.env` — nunca hardcoded
- `.env` e `*.db` no `.gitignore`
- Comandos admin protegidos por whitelist `ADMIN_USER_IDS`
- Usuários que bloqueiam o bot removidos automaticamente (erro 403)
- Claude API key transmitida via header `x-claude-key`, nunca no body
- OddsPapi key aceita múltiplas variáveis: `ODDS_API_KEY`, `ODDSPAPI_KEY`, `ODDS_PAPI_KEY`, `ESPORTS_ODDS_KEY`
