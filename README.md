# SportsEdge Bot — Esports Edition

Bot de Telegram para análise de apostas com inteligência artificial, especializado em **Esports (LoL e Dota 2)**. Opera em **modo totalmente automático**: analisa partidas em ciclos regulares, identifica valor (+EV) e envia tips diretamente por DM aos inscritos, sem nenhuma interação manual necessária.

---

## Visão Geral da Arquitetura

```
┌──────────────────────────────────────────────────┐
│                  bot.js (launcher)               │
│            ┌────────────────────┐                │
│            │   Esports Bot 🎮   │                │
│            │   (LoL + Dota 2)   │                │
│            └─────────┬──────────┘                │
│              Polling loop + backoff              │
└─────────────────────┬────────────────────────────┘
                      │ HTTP localhost:3000
┌─────────────────────▼────────────────────────────┐
│           server.js (API Aggregator)             │
│                                                  │
│  /lol-matches  /dota-matches  /live-game         │
│  /ps-compositions  /dota-live  /match-result     │
│  /record-tip  /settle-tip  /claude               │
│  /roi  /tips-history  /db-status  /users         │
│                                                  │
│  📦 sportsedge.db (SQLite)                       │
│  users | events | matches | tips                 │
│  odds_history | match_results                    │
└──────────────────────────────────────────────────┘
```

Um único processo Node.js executa o bot com polling contínuo e backoff exponencial.

---

## Pré-requisitos

- Node.js 18+
- Bot Telegram criado via [@BotFather](https://t.me/BotFather)
- Chave Claude API (Anthropic)
- OddsPapi key — odds esports LoL + Dota 2/Pinnacle ([oddspapi.io](https://oddspapi.io), 250 req/mês free)
- LoL Esports API key (Riot)
- PandaScore token — torneios não-Riot, schedules e stats

---

## Configuração

```env
# ── Telegram ──
TELEGRAM_TOKEN_ESPORTS=seu_token_esports

# ── APIs ──
CLAUDE_API_KEY=sk-ant-api03-...            # Anthropic Claude (claude-sonnet-4-6)
LOL_API_KEY=sua_chave_lol                  # LoL Esports (Riot)
ODDS_API_KEY=sua_chave_oddspapi            # Esports odds — LoL + Dota 2 (oddspapi.io, 250 req/mês free)
PANDASCORE_TOKEN=seu_token                 # PandaScore — torneios não-Riot (schedules + stats)

# ── Servidor ──
SERVER_PORT=3000
DB_PATH=sportsedge.db                      # Railway: use /data/sportsedge.db com volume montado

# ── Admin ──
# Obrigatório: ID numérico do Telegram (obtenha via @userinfobot)
# O admin é inscrito automaticamente em esports a cada restart
ADMIN_USER_IDS=123456789,987654321

# ── Feature flags ──
ESPORTS_ENABLED=true

# ── LoL — ligas extras (slugs adicionais além da whitelist interna) ──
LOL_EXTRA_LEAGUES=cd,north_regional_league  # opcional; separado por vírgula

# ── Meta LoL (atualizar a cada patch — afeta qualidade da análise) ──
LOL_PATCH_META=Patch 26.X — descrição do meta atual
PATCH_META_DATE=YYYY-MM-DD
```

---

## Iniciando

```bash
npm install
npm start           # inicia servidor + bot via start.js

# Ou separadamente (servidor DEVE iniciar primeiro)
npm run server      # node server.js  →  porta configurada em SERVER_PORT
npm run bot         # node bot.js     →  polling do bot esports
```

### Deploy no Railway

1. Faça push para o repositório GitHub vinculado ao projeto Railway
2. Configure as variáveis de ambiente no painel **Variables** do Railway
3. Para persistência do banco entre redeploys, crie um volume e defina `DB_PATH=/data/sportsedge.db`
4. O `start.js` gerencia os dois processos (server + bot) com auto-restart em caso de falha
5. Configure `ADMIN_USER_IDS` com seu ID do Telegram — o admin é inscrito automaticamente em esports a cada boot

> O `railway.toml` já está configurado com healthcheck TCP na porta 3000 e restart policy `on_failure`.

---

## Interface do Bot

O bot opera em **modo automático**. O usuário interage apenas com os botões do menu:

| Botão / Comando | Função |
|---|---|
| `🔔 Notificações` | Ativa/desativa recebimento de tips automáticas por DM |
| `📊 Tracking` | Exibe acertos, ROI, profit, calibração, split pré-jogo vs ao vivo |
| `📅 Próximas` | Lista partidas ao vivo e próximas 48h |
| `❓ Ajuda` | Explica como o bot funciona |
| `/tracking` | Mesmo que o botão Tracking |
| `/meustats` | Resumo rápido de performance (win rate, ROI) |

### Comandos Admin

| Comando | Função |
|---|---|
| `/stats` | ROI total, calibração por confiança, histórico de tips |
| `/users` | Status do banco de dados |
| `/pending` | Tips pendentes de settlement |
| `/settle` | Força settlement imediato |
| `/force-analyze [id]` | Força re-análise de uma partida |
| `/slugs` | Lista slugs LoL reconhecidos e desconhecidos (diagnóstico) |
| `/lolraw` | Dump completo do schedule LoL por liga (diagnóstico) |

---

## Ciclos Automáticos — Esports (LoL + Dota 2)

- **Auto-análise ao vivo** a cada 6 min: analisa partidas `live` com dados de gold, composições, KDA e objetivos em tempo real; re-análise a cada 10 min por partida
- **Auto-análise pré-jogo** a cada 6 min: analisa partidas `upcoming` nas **próximas 24h** — exige odds de mercado reais; se ainda não houver odds, aguarda 30 min e tenta novamente
- **Notificação ao vivo** (a cada 1 min): avisa inscritos quando draft começa (🟡) e quando a partida vai ao vivo (🔴)
- **Line movement** (a cada 30 min): alerta quando odds mudam ≥ 10%
- **Patch meta stale** (a cada 24h): alerta admins se `LOL_PATCH_META` não foi atualizado há >14 dias
- **Settlement** (a cada 30 min): via LoL Esports API e OpenDota API

---

## Sistema de Análise IA

### Fluxo Automático

1. Ciclo detecta partida elegível (`live` ou `upcoming` ≤24h)
2. Coleta em paralelo: stats ao vivo (se disponíveis), odds de mercado (OddsPapi/Pinnacle), forma recente, H2H, line movement
3. **Gate de odds pré-jogo**: se não houver odds reais, a partida é marcada como `waitingOdds` e re-verificada em 30 min — o Claude **nunca** é chamado sem odds (análise sem mercado tem divergência esperada de 15–20pp, tornando-a estruturalmente pouco fiável)
4. Para LoL: busca composições e stats ao vivo (Riot API ou PandaScore para torneios não-Riot) + patch meta atual
5. Monta prompt com **raciocínio em duas etapas**: estimativa cega de probabilidade → comparação com odds de mercado
6. Claude declara probabilidade antes de ver as odds, depois verifica se há edge real (gate de 3pp)
7. **Fair odds = `1/probabilidade`** (sem juice) — tip emitida se EV ≥ 2%
8. Tip registrada no banco + enviada por DM a todos os inscritos (¼ Kelly)
9. **Uma tip por partida**: flag `tipSent` pré-populada de `/unsettled-tips` ao boot impede duplicados após redeploy

### Prompts LoL vs Dota 2

| Jogo | Foco principal |
|---|---|
| LoL | Composições, gold ao vivo, torres, dragões, patch meta, formato Bo |
| Dota 2 | Gold diff, Roshan/Aegis, barracks, itens-chave, tempo de jogo |

### Proteções Anti-Viés

- **"Sem edge" é uma resposta válida** — instrução explícita para não forçar recomendação
- **Gate de 3pp** — se a estimativa do Claude diferir das odds implícitas em <3pp, retorna "SEM EDGE"
- **Line movement como sinal contrário** — instrução para ajustar probabilidade 2-3pp na direção do mercado
- **Desconto de alto fluxo** — jogos com <15 min ou objetivo maior recente rebaixam confiança para BAIXA automaticamente

### Tips Pré-Jogo — Nota sobre Draft

Tips `upcoming` são baseadas exclusivamente em **forma histórica e H2H** — sem acesso ao draft, que só fica disponível quando a partida começa. As mensagens incluem o aviso:

> _Análise pré-draft: baseada em forma e histórico (sem acesso às comps)_

O tracking exibe resultados separados por fase (**ao vivo vs pré-jogo**) para avaliação empírica de ROI ao longo do tempo.

### Kelly Criterion (¼ Kelly)

```
f* = EV / (odds − 1)
stake = clamp(f* × 0.25, 0.5u, 4u)  arredondado a 0.5u
```

---

## Cobertura — Fontes de Partidas

### LoL

**Riot / LoL Esports API** — ligas oficiais:
Worlds, MSI, LCS, LCK, LEC, LPL, CBLOL, LLA, PCS, LCO, VCS, LJL, EMEA Masters, LFL, NLC, LTA Norte/Sul, First Stand e ligas regionais.

**PandaScore** — torneios não transmitidos pela Riot (ex: qualificatórias EWC, ligas regionais independentes). IDs prefixados com `ps_` internamente.

**Stats ao vivo:**
- Gold total por time com trajetória
- Torres, dragões (com tipos), barões, inibidores, kills
- KDA, gold e CS por jogador com nome do invocador
- ~90s de delay na API oficial da Riot

### Dota 2

Partidas tier 1 via OpenDota API — gold diff, Roshan/Aegis, barracks, itens-chave, estado ao vivo.

### Odds

**OddsPapi** — fonte única de odds para esports. Fornece Pinnacle + 350 bookmakers para LoL (sportId=18) e Dota 2 (sportId=16). O sistema usa apenas Pinnacle (sharp book) como referência de EV.

Tournament IDs cacheados 24h; odds atualizadas a cada 6h numa única chamada combinada. Soft cap em 200 req/mês (50 de buffer).

Para adicionar ligas extras além da whitelist interna, use `LOL_EXTRA_LEAGUES` no `.env`.

---

## Settlement Automático

| Jogo | Fonte de resultado | Frequência |
|---|---|---|
| LoL | LoL Esports API (`/getSchedule`) | 30 min |
| Dota 2 | OpenDota API (`/api/matches/{id}`) | 30 min |

---

## Alertas Automáticos

| Alerta | Intervalo | Destinatários |
|---|---|---|
| Partida LoL ao vivo / draft iniciado | 1 min | Inscritos esports |
| Line movement ≥ 10% | 30 min | Inscritos esports |
| Patch meta desatualizado (>14d) | 24h | Admins |

---

## Banco de Dados (`sportsedge.db`)

| Tabela | Conteúdo |
|---|---|
| `users` | user_id, username, subscribed, sport_prefs (JSON array) |
| `events` | eventos/torneios com `sport = 'esports'` |
| `matches` | confrontos com resultado pós-jogo |
| `tips` | tips registradas: odds, EV, stake, confidence, resultado |
| `odds_history` | snapshots de odds (14 dias) para detecção de line movement |
| `match_results` | histórico de resultados para forma/H2H |

---

## Rotas do Servidor

### Gerais

| Rota | Método | Descrição |
|---|---|---|
| `/record-tip` | POST | Registrar tip no banco |
| `/settle-tip?sport=esports` | POST | Liquidar tip por vencedor |
| `/unsettled-tips?sport=esports` | GET | Tips aguardando resultado |
| `/roi?sport=esports` | GET | ROI total, calibração e split pré-jogo/ao vivo |
| `/tips-history?sport=esports` | GET | Histórico de tips |
| `/db-status?sport=esports` | GET | Contagem por tabela |
| `/save-user` | POST | Criar/atualizar usuário |
| `/users?subscribed=1` | GET | Listar usuários |
| `/claude` | POST | Proxy para Anthropic API (`claude-sonnet-4-6`) |

### Esports

| Rota | Descrição |
|---|---|
| `/lol-matches` | Partidas LoL — combina Riot API + PandaScore (ao vivo, draft, próximas) |
| `/dota-matches` | Partidas Dota 2 tier 1 |
| `/live-gameids?matchId=X` | IDs de games em andamento numa série Riot |
| `/live-game?gameId=X` | Stats ao vivo de um game LoL (gold, torres, players) |
| `/ps-compositions?matchId=ps_X` | Composições e stats de partida PandaScore (`ps_` prefix) |
| `/dota-live?matchId=X` | Estado ao vivo Dota (gold diff, kills, heroes) |
| `/dota-match-detail?matchId=X` | Detalhes avançados Dota (Roshan, barracks, itens) |
| `/match-result?matchId=X&game=X` | Resultado final de uma partida |
| `/lol-slugs` | Slugs LoL na whitelist + desconhecidos vistos (diagnóstico) |
| `/lol-raw` | Dump completo do schedule Riot por liga (diagnóstico) |

---

## Fontes de Dados

| Fonte | Uso |
|---|---|
| LoL Esports API (`esports-api.lolesports.com`) | Calendário, séries, placar LoL |
| LoL Live Stats Feed (`feed.lolesports.com`) | Stats ao vivo com delay ~90s |
| PandaScore API | Torneios não-Riot (ex: EWC Qualifier, ligas regionais), schedules e stats |
| OddsPapi (`oddspapi.io`) | Odds Pinnacle para LoL (sportId=18) e Dota 2 (sportId=16) |
| OpenDota API | Partidas ao vivo, resultados e stats Dota 2 |
| Anthropic Claude (`claude-sonnet-4-6`) | Análise de matchup via proxy `/claude` |

---

## Estrutura de Arquivos

```
lol betting/
├── server.js           # Servidor HTTP (porta configurada via PORT/SERVER_PORT)
├── bot.js              # Bot esports (polling, modo automático)
├── start.js            # Launcher Railway: spawna server.js + bot.js com auto-restart
├── railway.toml        # Configuração Railway (healthcheck TCP, restart policy)
├── package.json
├── .env                # Credenciais (não commitar)
├── sportsedge.db       # SQLite (criado automaticamente; path via DB_PATH)
└── lib/
    ├── database.js     # Schema SQLite, prepared statements e índices
    ├── sports.js       # Registry de esportes (tokens, flags)
    └── utils.js        # log, calcKelly, norm, fmtDate, fuzzyName, httpGet
```

---

## Segurança

- Credenciais exclusivamente via `.env` — nunca hardcoded
- `.env` e `*.db` devem estar no `.gitignore`
- Comandos admin protegidos por whitelist `ADMIN_USER_IDS`
- Usuários que bloqueiam o bot removidos automaticamente (erro 403)
- Claude API key transmitida via header `x-claude-key`, nunca no body
