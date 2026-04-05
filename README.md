# LoL Betting Bot

Bot autônomo de Telegram para análise automática de apostas em **League of Legends**, baseado em Valor Esperado (EV) e Kelly Criterion, alimentado por IA (DeepSeek ou Claude).

> **Status (Abril 2026):** Sistema operando exclusivamente para LoL. Odds via **OddsPapi v4** (1xBet, plano free 250 req/mês) com sistema **round-robin** que busca um lote de torneios por ciclo. ML usa composição + WR de campeões em pro play + WR de jogadores com campeões específicos. Fair odds removidas de upcoming — tips pré-jogo só com odds reais disponíveis. Sistema de três níveis de confiança ativo: **ALTA**, **MÉDIA** e **BAIXA**.

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
│  • Auto-análise pré-jogo (upcoming <=24h)    │
│  • Alertas de draft e line movement          │
│  • Settlement automático de tips             │
│  • Patch meta auto-fetch (ddragon, 14d)      │
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
│    Re-fetch forçado se partida em < 2h       │
│                                              │
│  Análise IA:                                 │
│    DeepSeek (deepseek-chat) — padrão         │
│    Anthropic Claude — fallback               │
│    Pré-filtro ML local (lib/ml.js)           │
│                                              │
│  sportsedge.db (SQLite via volume Railway)   │
│  users | events | matches | tips             │
│  odds_history | match_results | api_usage    │
│  pro_champ_stats | pro_player_champ_stats    │
│  synced_matches                              │
└──────────────────────────────────────────────┘
```

---

## Pré-requisitos

- Node.js 18+
- Bot Telegram criado via [@BotFather](https://t.me/BotFather)
- Chave **DeepSeek API** (recomendado) ou **Anthropic Claude API**
- Chave da LoL Esports API (Riot Games)
- Token PandaScore — torneios fora da Riot (schedules + stats + sync de resultados pro)
- Chave OddsPapi — odds esports LoL via 1xBet ([oddspapi.io](https://oddspapi.io), plano free: 250 req/mês)

---

## Configuração (`.env`)

```env
# ── Telegram ──
TELEGRAM_TOKEN_ESPORTS=seu_token_bot

# ── APIs de IA (pelo menos uma obrigatória) ──
DEEPSEEK_API_KEY=sk-...                 # DeepSeek (recomendado — mais barato)
CLAUDE_API_KEY=sk-ant-api03-...         # Anthropic Claude (fallback)

# ── APIs de dados ──
LOL_API_KEY=sua_chave_lol               # LoL Esports API (Riot Games)
ODDS_API_KEY=sua_chave_oddspapi         # OddsPapi v4 (aceita: ODDSPAPI_KEY, ODDS_PAPI_KEY, ESPORTS_ODDS_KEY)
PANDASCORE_TOKEN=seu_token              # PandaScore (obrigatório para sync de stats pro)

# ── Servidor ──
SERVER_PORT=8080
DB_PATH=/data/sportsedge.db            # Railway: volume montado em /data
                                        # Local: use sportsedge.db

# ── Admin ──
ADMIN_USER_IDS=123456789,987654321      # IDs numéricos Telegram (obtenha via @userinfobot)
                                        # Admin é inscrito automaticamente a cada boot

# ── Feature flags ──
ESPORTS_ENABLED=true

# ── OddsPapi — ajuste fino (opcional) ──
ODDSPAPI_BATCH_SIZE=3                   # Torneios por requisição (padrão: 3)
ESPORTS_ODDS_TTL_H=3                    # Horas entre ciclos round-robin (padrão: 3h)

# ── LoL — ligas extras além da whitelist interna ──
LOL_EXTRA_LEAGUES=slug1,slug2           # opcional, separado por vírgula

# ── Meta LoL (atualizado automaticamente a cada 14 dias via ddragon) ──
LOL_PATCH_META=Patch 25.X — descrição do meta atual
PATCH_META_DATE=YYYY-MM-DD

# ── Análise pré-jogo — controle de rigidez (opcional) ──
LOL_PREGAME_BLOCK_BO3=true             # true = só analisa Bo3/Bo5 após Game 1 (draft conhecido)
                                        # false = analisa upcoming sem restrição de draft

# ── Thresholds de tip (opcional — valores padrão se omitidos) ──
LOL_EV_THRESHOLD=5                      # EV mínimo % para emitir tip (padrão: 5)
LOL_PINNACLE_MARGIN=8                   # Margem 1xBet esperada % para de-juice (padrão: 8)
LOL_NO_ODDS_CONVICTION=70              # Confiança mínima % para tip sem odds de mercado (padrão: 70)
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

> **Nota DB_PATH no Railway:** se a variável aparecer com artefatos (`=/data/...` ou tab no prefixo), o sistema sanitiza automaticamente antes de abrir o banco.

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
| Re-análise sem edge | 2× cooldown | Partidas sem edge têm cooldown dobrado para economizar tokens |
| Notificação ao vivo | 1 min | Avisa sobre draft iniciado e partida ao vivo |
| Line movement | 30 min | Alerta se odds mudaram >= 10% desde o último snapshot |
| Settlement | 30 min | Resolve tips pendentes via Riot API e PandaScore |
| Sync pro stats | 12h (+ boot) | Busca até 400 partidas pro (últimos 45 dias) via PandaScore → popula WR de campeões, jogadores, forma e H2H |
| Patch meta auto-fetch | 14 dias | Busca versão atual no ddragon e atualiza `LOL_PATCH_META` automaticamente |
| Patch meta stale alert | 24h | Avisa admins se patch meta não foi atualizado há mais de 14 dias |
| Fetch de odds | 3h (configurável) | Round-robin: busca 1 lote de 3 torneios por ciclo |
| Re-fetch urgente | Sob demanda | Se partida começa em < 2h e odds têm > 2h, força re-fetch imediato |

---

## Sistema de ML — Sinais

O pré-filtro ML (`lib/ml.js`) calcula um edge score baseado em até 4 fatores. Qualquer fator disponível incrementa o `factorCount` — se nenhum dado estiver disponível, a partida passa diretamente para a IA.

| Fator | Fonte | Peso | Disponível quando |
|-------|-------|------|-------------------|
| Forma recente (win rate diferencial) | `match_results` (últimos 45 dias) | 0.25 | Após sync pro stats |
| H2H (histórico direto) | `match_results` (últimos 45 dias) | 0.30 | Após sync pro stats |
| Comp/meta score (WR médio dos campeões em pro play) | `pro_champ_stats` | 0.35 | Draft disponível + sync feito |
| Live stats | Riot/PandaScore ao vivo | extra `factorCount` | Partida ao vivo |

O comp score considera o WR médio dos campeões escolhidos em pro play (não solo queue). Positivo = blue/t1 favorecido. Mínimo de 4 entradas em `/champ-winrates` para ativar.

### Sync de Dados Pro (PandaScore)

No boot e a cada 12h, o sistema busca até **400 partidas finalizadas** dos últimos 45 dias via PandaScore e extrai:
- **`match_results`** — resultados para forma recente e H2H (filtrado a 45 dias)
- **`pro_champ_stats`** — WR de cada campeão por role em pro play
- **`pro_player_champ_stats`** — WR de cada jogador com campeões específicos

Partidas já sincronizadas são rastreadas em `synced_matches` para evitar double-counting.

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

### Re-fetch Urgente (< 2h)

Se uma partida está programada para começar em menos de 2 horas e as odds no cache têm mais de 2 horas, o sistema força um re-fetch imediato antes de passar as odds para análise, garantindo dados frescos no momento crítico.

### Matching de Times

A OddsPapi v4 não retorna nomes de times nos campos padrão — os nomes estão embutidos na URL de fixture do bookmaker (ex: `315638638-cloud9-lyon-gaming`). O sistema extrai o "combined slug" da URL, normaliza (minúsculo, sem caracteres especiais) e usa correspondência de substring. Um dicionário de aliases cobre variações de nome:

```
"BNK FEARX" → norm "bnkfearx" → alias key "fearx" → encontra "fearxhanjinbrion"
"Gen.G Esports" → norm "gengesports" → alias key "geng" → variante "gen" → encontra "gengktrolster"
```

---

## Sistema de Análise IA

### Provedor de IA

O bot usa **DeepSeek** (`deepseek-chat`) como provedor padrão por ser significativamente mais barato que Claude. Se `DEEPSEEK_API_KEY` não estiver configurado, cai automaticamente para **Anthropic Claude**. O endpoint `/claude` em `server.js` funciona como proxy unificado para ambos, normalizando o formato de resposta.

### Fluxo Completo

```
1. Ciclo detecta partida elegível (live ou upcoming <= 24h)
   |
2. Re-fetch urgente de odds (se partida começa em < 2h e odds > 2h antigas)
   |
3. Coleta em paralelo:
   |-- Odds do cache OddsPapi (via /odds?team1=X&team2=Y)
   |-- Contexto ao vivo: composições, gold, kills, dragões,
   |   barões, torres (Riot API ou PandaScore)
   |-- WR de campeões em pro play (pro_champ_stats)
   |-- WR de jogadores com campeões específicos (pro_player_champ_stats)
   |-- Forma recente dos times (últimas partidas — 45 dias)
   |-- Histórico H2H (últimos 45 dias)
   |-- Movimentação de linha (variação de odds)
   |
4. Pré-filtro ML local (lib/ml.js)
   -> Fatores: forma, H2H, comp/meta score, live stats
   -> Se sem edge matemático: pula a IA (economiza créditos)
   |
5. Prompt compacto para DeepSeek/Claude (max 600 tokens de resposta):
   |-- Estimativa de probabilidade (draft/forma/meta)
   |-- Comparação com odds 1xBet de-juiced -> cálculo de EV
   |-- WR de campeões e jogadores visível no contexto
   |
6. IA retorna:
   |-- TIP_ML:[time]@[odd]|EV:[%]|STAKE:[u]|CONF:[ALTA/MÉDIA/BAIXA]
   |-- FAIR_ODDS:[time1]=[X.XX]|[time2]=[X.XX]  (apenas partidas ao vivo/draft)
   |
7. Gates pós-IA:
   |-- Gate 0: rejeita se não há odds reais disponíveis
   |-- Gate 2: rejeita odds fora de [1.50, 3.00]
   |-- Gate 3 (consenso ML×IA): ML diverge da IA com score > 5pp → rebaixa ALTA→MÉDIA→BAIXA
   |-- Gate 4 (EV adaptativo): rejeita se EV < threshold por confiança (ver tabela abaixo)
   |
8. Se TIP_ML aprovada em todos os gates: envia DM a todos os inscritos
   |
9. Registra no banco SQLite + marca tipSent=true (evita duplicatas após redeploy)
   Partidas sem edge têm cooldown dobrado no próximo ciclo
```

### Níveis de Confiança e Thresholds de EV

O sistema opera com **três níveis de confiança**. O threshold de EV mínimo é **adaptativo** — quanto mais sinais disponíveis, menor o threshold exigido (mais dados = mais confiança na estimativa).

| Confiança | Sinais exigidos | EV mínimo (6 sinais → ≤1 sinal) | Kelly | Stake máx | Emoji |
|-----------|----------------|----------------------------------|-------|-----------|-------|
| 🟢 ALTA   | ≥ 2 sinais     | 2% → 7%                          | ¼ Kelly | 4u | 🟢 |
| 🟡 MÉDIA  | ≥ 1 sinal      | 1% → 5.5%                        | ⅙ Kelly | 3u | 🟡 |
| 🔵 BAIXA  | Nenhum         | 0.5% → 4%                        | 1/10 Kelly | 1.5u | 🔵 |

**Threshold adaptativo por quantidade de sinais** (`LOL_EV_THRESHOLD=5` padrão):

| Sinais disponíveis | ALTA | MÉDIA | BAIXA |
|--------------------|------|-------|-------|
| 6 sinais | 2% | 1% | 0.5% |
| 5 sinais | 3% | 1.5% | 0.5% |
| 4 sinais | 4% | 2.5% | 1% |
| 3 sinais | 5% | 3.5% | 2% |
| 2 sinais | 6% | 4.5% | 3% |
| ≤1 sinal | 7% | 5.5% | 4% |

Tips BAIXA sempre exibem aviso: _"Tip de confiança BAIXA — stake reduzido. Aposte com cautela."_

### Tipos de Tips

| Tipo | Dispara quando | Dados usados | Label na mensagem |
|------|---------------|--------------|-------------------|
| Ao vivo | `status = live` | Composições + Gold + KDA + Objetivos + WR champs/players (~90s delay) | `TIP ML AUTOMÁTICA` |
| Pré-jogo | `upcoming` com odds reais | Draft (se disponível) + Forma + H2H + WR champs/players + odds | `TIP PRÉ-JOGO ESPORTS` |

Uma tip por partida — o flag `tipSent` é salvo no banco e recarregado no boot, evitando duplicatas após redeploy.

> **Upcoming sem odds:** partidas pré-jogo sem odds reais disponíveis não recebem análise de fair odds nem tips estimadas. A análise só roda quando há mercado real disponível.

### Proteções Anti-Viés

| Proteção | Mecanismo |
|---|---|
| "Sem edge" é resposta válida | Instrução explícita no prompt para não forçar recomendação |
| Gate 0: sem odds reais | Odds estimadas → rejeição automática |
| Gate 2: odds fora da zona | Odds < 1.50 ou > 3.00 → rejeição (zona de baixo valor real) |
| Gate 3: consenso ML×IA | ML diverge da IA com score > 5pp → rebaixa confiança (ALTA→MÉDIA→BAIXA) |
| Gate 4: EV mínimo adaptativo | EV abaixo do threshold por nível de confiança e quantidade de sinais → rejeição |
| Comparação contra 1xBet | De-juice da margem 1xBet (padrão 8%) para obter probabilidade justa real |
| Line movement | Instrução para ajustar probabilidade 2-3pp na direção do mercado quando linha se mover |
| Alto fluxo | Jogos com <15 min ou objetivo maior recente (Baron, Elder) → confiança máxima BAIXA |
| Form/H2H limitados a 45 dias | Resultados antigos (outro meta/patch) não contam para cálculo de edge |

### Kelly Criterion

```
f* = EV / (odds - 1)

ALTA:  stake = clamp(f* × 0.25,  0.5u, 4u)   ¼ Kelly
MÉDIA: stake = clamp(f* × 0.167, 0.5u, 3u)   ⅙ Kelly
BAIXA: stake = clamp(f* × 0.10,  0.5u, 1.5u) 1/10 Kelly

Arredondado a 0.5u
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

### Deduplicação Riot + PandaScore

Quando o mesmo confronto aparece em ambas as fontes, o sistema prioriza os dados da Riot API (stats ao vivo mais completos) e descarta a entrada duplicada do PandaScore, evitando análises duplicadas.

### Stats ao Vivo (LoL)

- Gold total por time com trajetória por minuto
- Torres, dragões (com tipos), barões, inibidores, kills
- KDA, gold e função (TOP/JGL/MID/ADC/SUP) por jogador
- WR do jogador com o campeão atual em pro play
- ~90s de delay na API oficial da Riot
- PandaScore como fonte alternativa para torneios não transmitidos pela Riot

---

## Settlement Automático

| Fonte | Frequência |
|-------|-----------|
| LoL Esports API (`/getSchedule`) | 30 min |
| PandaScore (`/ps-result`) | 30 min |

O settlement itera pelas tips não resolvidas, consulta o resultado via endpoint correspondente (Riot para `matchId` numérico, PandaScore para IDs com prefixo `ps_`) e marca WIN/LOSS no banco.

---

## Rotas do Servidor

### Partidas e Odds

| Rota | Descrição |
|------|-----------|
| `GET /lol-matches` | Combina Riot API + PandaScore; inclui odds quando disponíveis no cache |
| `GET /odds?team1=X&team2=Y[&force=1]` | Busca odds do cache; `force=1` ignora TTL e força re-fetch |
| `GET /live-gameids?matchId=X` | IDs dos games em andamento numa série Riot |
| `GET /live-game?gameId=X` | Stats ao vivo: gold, torres, dragões, kills, players |
| `GET /ps-compositions?matchId=ps_X` | Composições e stats via PandaScore (prefix `ps_`) |
| `GET /match-result?matchId=X&game=X` | Resultado final de uma partida (Riot) |
| `GET /ps-result?matchId=X` | Resultado final de uma partida (PandaScore) |

### Tips e Banco

| Rota | Descrição |
|------|-----------|
| `POST /record-tip` | Registrar tip no banco |
| `POST /settle` | Liquidar tip por match_id, sport e winner |
| `GET /unsettled-tips` | Tips aguardando resultado |
| `GET /tips-history` | Histórico de tips com filtros |
| `GET /roi` | ROI total, calibração por confiança, split ao vivo/pré-jogo |
| `GET /team-form?team=X&game=X` | Forma recente do time (últimos 45 dias) |
| `GET /h2h?team1=X&team2=Y&game=X` | Histórico H2H (últimos 45 dias) |
| `GET /odds-movement` | Variação de odds nas últimas 24h |
| `GET /db-status` | Contagem de registros por tabela |
| `GET /users` | Listar usuários |
| `POST /save-user` | Criar/atualizar usuário |
| `POST /claude` | Proxy unificado para DeepSeek ou Claude (auto-detecta pela key disponível) |

### Pro Stats (ML)

| Rota | Descrição |
|------|-----------|
| `GET /champ-winrates?champs=Corki,Azir&roles=mid,mid` | WR de campeões em pro play (mínimo 5 jogos) |
| `GET /player-champ-stats?players=Faker,Chovy&champs=Azir,Orianna` | WR de jogadores com campeões específicos (mínimo 3 jogos) |
| `POST /sync-pro-stats` | Força sync manual de stats pro via PandaScore |

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
| `tips` | Tips: odds, EV, stake, confidence, resultado, isLive, clv_odds, open_odds |
| `odds_history` | Snapshots de odds (14 dias) para detecção de line movement |
| `match_results` | Resultados pro (últimos 45 dias) para forma recente e H2H |
| `pro_champ_stats` | WR de campeões por role em pro play (acumulado via sync PandaScore) |
| `pro_player_champ_stats` | WR de jogadores com campeões específicos em pro play |
| `synced_matches` | IDs de partidas já sincronizadas (evita double-count no sync) |
| `api_usage` | Contador de uso por provedor de IA e mês |

---

## Estrutura de Arquivos

```
lol betting/
├── server.js           # Servidor HTTP: odds, partidas, banco, endpoints, proxy IA, sync pro stats
├── bot.js              # Bot Telegram: polling, análise automática, tips, patch meta
├── start.js            # Launcher: spawna server + bot com auto-restart
├── sync-form.js        # Script avulso: sync histórico de partidas (forma/H2H) sem o servidor rodando
├── railway.toml        # Deploy Railway (healthcheck TCP, restart on_failure)
├── package.json
├── .env                # Credenciais (nunca commitar)
├── sportsedge.db       # SQLite (criado automaticamente; path via DB_PATH)
└── lib/
    ├── database.js     # Schema SQLite, statements, path resolution (absoluto/relativo)
    ├── ml.js           # Pré-filtro ML local (forma, H2H, comp/meta score, live)
    ├── sports.js       # Registry de esportes (tokens, feature flags)
    └── utils.js        # log, calcKelly, calcKellyFraction, norm, fmtDate, httpGet, safeParse
```

### Sync manual de histórico

Para popular a tabela `match_results` com os últimos 45 dias sem precisar do servidor rodando:

```bash
node sync-form.js           # sync incremental (pula já sincronizados)
node sync-form.js --force   # re-sincroniza tudo
```

---

## Fontes de Dados

| Fonte | Uso |
|-------|-----|
| `esports-api.lolesports.com` | Calendário oficial LoL, séries, placar |
| `feed.lolesports.com` | Stats ao vivo LoL (~90s de delay) |
| `esports.lolesports.com/persisted2` | Composições e detalhes do draft |
| PandaScore API | Torneios não-Riot: schedules, compositions, stats, resultados, sync de champ/player WR |
| OddsPapi v4 (`api.oddspapi.io/v4`) | Odds 1xBet para LoL (sportId=18), round-robin por lote |
| DeepSeek API (`api.deepseek.com`) | Análise de matchup — padrão (mais barato) |
| Anthropic Claude (`api.anthropic.com`) | Análise de matchup — fallback |
| ddragon (`ddragon.leagueoflegends.com`) | Versão atual do patch para atualização automática do meta |

---

## Segurança

- Todas as credenciais via `.env` — nunca hardcoded
- `.env` e `*.db` no `.gitignore`
- Comandos admin protegidos por whitelist `ADMIN_USER_IDS`
- Usuários que bloqueiam o bot removidos automaticamente (erro 403)
- API key da IA transmitida via header, nunca no body
- OddsPapi key aceita múltiplas variáveis: `ODDS_API_KEY`, `ODDSPAPI_KEY`, `ODDS_PAPI_KEY`, `ESPORTS_ODDS_KEY`
- `DB_PATH` sanitizado automaticamente (trim + remoção de artefatos `=` do Railway)
