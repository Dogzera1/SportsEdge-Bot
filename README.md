# SportsEdge Bot — Sistema Unificado

Bot de Telegram para análise de apostas com inteligência artificial. Suporta **MMA (UFC)**, **Esports (LoL e Dota 2)** e **Tênis (ATP/WTA/Challenger)** — cada esporte com seu próprio bot Telegram, compartilhando uma única infraestrutura: servidor HTTP, banco SQLite e processo Node.js.

O bot opera em **modo totalmente automático**: analisa partidas em ciclos regulares, identifica valor (+EV) e envia tips diretamente por DM aos inscritos, sem nenhuma interação manual necessária.

---

## Visão Geral da Arquitetura

```
┌──────────────────────────────────────────────────┐
│                  bot.js (launcher)               │
│  ┌──────────┐  ┌────────────┐  ┌─────────────┐  │
│  │ MMA Bot  │  │ Esports Bot│  │  Tennis Bot │  │
│  │ 🥊 Token │  │ 🎮 Token   │  │  🎾 Token   │  │
│  └────┬─────┘  └─────┬──────┘  └──────┬──────┘  │
│       └───────────────┴────────────────┘         │
│              Polling simultâneo                  │
└──────────────────────┬───────────────────────────┘
                       │ HTTP localhost:3000
┌──────────────────────▼───────────────────────────┐
│           server.js (API Aggregator)             │
│                                                  │
│  /events  /matches  /odds  /athlete  /form       │
│  /h2h  /record-tip  /settle-tip  /claude         │
│  /lol-matches  /ps-compositions  /live-game      │
│  /tennis-tournaments  /tennis-matches            │
│  /tennis-player  /tennis-surface-form            │
│  /roi  /tips-history  /lol-slugs  /lol-raw       │
│                                                  │
│  📦 sportsedge.db (SQLite)                       │
│  users | athletes | events | matches             │
│  tips | odds_history | card_snapshots            │
│  match_results                                   │
└──────────────────────────────────────────────────┘
```

Um único processo Node.js executa todos os bots em paralelo, cada um em seu próprio loop de polling com backoff exponencial.

---

## Pré-requisitos

- Node.js 18+
- Bots Telegram criados via [@BotFather](https://t.me/BotFather) — um por esporte
- Chave Claude API (Anthropic)
- The Odds API key (MMA + Tênis)
- LoL Esports API key + OddsAPI key (Esports)
- PandaScore token (Esports — torneios não-Riot como qualificatórias EWC)

---

## Configuração

```env
# ── Telegram (um token por esporte) ──
TELEGRAM_TOKEN_MMA=seu_token_mma
TELEGRAM_TOKEN_ESPORTS=seu_token_esports
TELEGRAM_TOKEN_TENNIS=seu_token_tennis      # deixe em branco para desativar

# ── APIs ──
CLAUDE_API_KEY=sk-ant-api03-...            # Anthropic Claude (claude-sonnet-4-6)
THE_ODDS_API_KEY=sua_chave_the_odds        # MMA + Tênis
LOL_API_KEY=sua_chave_lol                  # LoL Esports (Riot)
ODDS_API_KEY=sua_chave_oddspapi            # Odds Esports (oddspapi.io)
PANDASCORE_TOKEN=seu_token                 # PandaScore — torneios não-Riot

# ── Servidor ──
SERVER_PORT=3000
DB_PATH=sportsedge.db                      # Railway: use /data/sportsedge.db com volume montado

# ── Admin ──
# Obrigatório: ID numérico do Telegram do admin (obtenha via @userinfobot)
# O admin é inscrito automaticamente em todos os esportes a cada restart
ADMIN_USER_IDS=123456789,987654321

# ── Feature flags ──
MMA_ENABLED=true
ESPORTS_ENABLED=true
TENNIS_ENABLED=true                         # false para desativar

# ── LoL — ligas extras (slugs adicionais além da whitelist interna) ──
LOL_EXTRA_LEAGUES=cd,north_regional_league,south_regional_league  # opcional; separado por vírgula

# ── Meta LoL (atualizar a cada patch — afeta qualidade da análise) ──
LOL_PATCH_META=Patch 26.X — descrição do meta atual
PATCH_META_DATE=YYYY-MM-DD
```

---

## Iniciando

```bash
npm install
npm start           # inicia servidor + todos os bots via start.js

# Ou separadamente (servidor DEVE iniciar primeiro)
npm run server      # node server.js  →  porta configurada em SERVER_PORT/PORT
npm run bot         # node bot.js     →  polling de todos os bots ativos
```

### Deploy no Railway

1. Faça push para o repositório GitHub vinculado ao projeto Railway
2. Configure as variáveis de ambiente no painel **Variables** do Railway (todas as do `.env` acima)
3. Para persistência do banco entre redeploys, crie um volume no Railway e defina `DB_PATH=/data/sportsedge.db`
4. O `start.js` gerencia os dois processos (server + bot) com auto-restart em caso de falha
5. **Importante:** configure `ADMIN_USER_IDS` com seu ID do Telegram — o admin é inscrito automaticamente a cada boot, garantindo recebimento de tips mesmo após redeploys

> O `railway.toml` já está configurado com healthcheck TCP na porta 3000 e restart policy `on_failure`.

---

## Seed de Dados Históricos (Tênis)

O sistema usa os CSVs públicos do [Jeff Sackmann](https://github.com/JeffSackmann) para alimentar o histórico de forma por superfície antes do primeiro deploy.

```bash
# 1. Baixar dados ATP e WTA
git clone https://github.com/JeffSackmann/tennis_atp  data/tennis_atp
git clone https://github.com/JeffSackmann/tennis_wta  data/tennis_wta

# 2. Importar partidas principais + Challenger + Futures
node scripts/seed-tennis.js --dir=./data/tennis_atp --years=2022,2023,2024
node scripts/seed-tennis.js --dir=./data/tennis_wta --years=2022,2023,2024

# 3. Atualizar quando novos anos ficarem disponíveis
node scripts/seed-tennis.js --dir=./data/tennis_atp --years=2025
```

---

## Interface dos Bots

O bot opera em **modo automático**. Não há navegação manual de eventos ou lutas. O usuário interage apenas com três botões:

| Botão / Comando | Função |
|---|---|
| `🔔 Notificações` | Ativa/desativa recebimento de tips automáticas por DM |
| `📊 Tracking` | Exibe acertos, ROI, profit, calibração, split pré-jogo vs ao vivo (esports) e últimas tips |
| `📅 Próximas` | Lista partidas ao vivo e próximas 24–48h para o esporte do bot |
| `❓ Ajuda` | Explica como o bot funciona |
| `/tracking` | Mesmo que o botão Tracking |
| `/meustats` | Resumo rápido de performance (win rate, ROI) |

### Comandos Admin

| Comando | Função |
|---|---|
| `/stats [sport]` | ROI total, calibração por confiança, histórico de tips |
| `/users` | Status do banco de dados |
| `/pending` | Tips pendentes de settlement |
| `/settle` | Força settlement imediato |
| `/rescrape <nome>` | Atualiza stats de um lutador (MMA) |
| `/force-analyze [id]` | Força re-análise de uma partida |
| `/slugs` | Lista slugs LoL reconhecidos e slugs desconhecidos vistos |
| `/lolraw` | Dump completo da API de schedule LoL por liga (diagnóstico) |

---

## Ciclos Automáticos

### 🥊 MMA

- **Auto-análise** a cada 6h: processa lutas nos **próximos 5 dias** em duas fases:
  - `early` (>24h até 5 dias antes): análise antecipada com stats e forma disponíveis
  - `final` (≤24h, pós-pesagem): re-análise com informações de peso e camp confirmados
- **Notificação dia do evento** (a cada 1h): avisa inscritos com card completo quando o UFC é hoje ou amanhã
- **Late replacements** (a cada 2h): compara card atual com snapshot anterior, alerta admins + inscritos em caso de troca
- **Line movement** (a cada 30 min): alerta quando odds mudam ≥ 10%
- **Settlement** (a cada 30 min): via scraping UFCStats

### 🎮 Esports (LoL + Dota 2)

- **Auto-análise ao vivo** a cada 3 min: analisa partidas `live` com dados de gold, composições, KDA e objetivos em tempo real
- **Auto-análise pré-jogo** a cada 3 min: analisa partidas `upcoming` nas **próximas 24h** — re-análise a cada 2h por partida, sem repetir se tip já enviada
- **Notificação ao vivo** (a cada 1 min): avisa inscritos quando draft começa (🟡) e quando a partida vai ao vivo (🔴)
- **Patch meta stale** (a cada 24h): alerta admins se `LOL_PATCH_META` não foi atualizado há >14 dias
- **Settlement** via LoL Esports API e OpenDota API

### 🎾 Tênis

- **Auto-análise** a cada 4h: cobre partidas nas **próximas 48h**, prioriza por tier (Grand Slam > Masters 1000 > ATP/WTA 500 > ATP/WTA 250 > Challenger > ITF), máx. 8 torneios/ciclo, 3 partidas por torneio
- **Notificação pré-partida** (a cada 5 min): avisa inscritos ~30 min antes do início com superfície e horário de Brasília
- **Withdrawals/lucky losers** (a cada 2h): compara draw com snapshot anterior
- **Settlement** (a cada 24h): via The Odds API scores endpoint
- **Line movement** (a cada 30 min)

---

## Sistema de Análise IA

### Janelas de Análise por Esporte

| Esporte | Partidas elegíveis | Re-análise |
|---|---|---|
| Esports (ao vivo) | `status=live` — sem limite de tempo | A cada 10 min por partida |
| Esports (pré-jogo) | `status=upcoming` nas próximas 24h | A cada 2h por partida |
| MMA | Próximos 5 dias (120h) — fases `early` e `final` | Uma vez por fase |
| Tênis | Próximas 48h — prioridade por tier de torneio | Uma vez por partida por ciclo de 4h |

### Fluxo Automático

1. Ciclo detecta partida elegível dentro da janela do esporte
2. Coleta em paralelo: stats ao vivo (se disponíveis), odds de mercado, forma recente, H2H, line movement
3. **Pré-filtro quantitativo** (MMA e Tênis): modelo estatístico compara probabilidade estimada com odds de mercado. Se a divergência for menor que o limiar (5pp MMA / 6pp Tênis), a análise é pulada silenciosamente — sem chamar o Claude. Partidas sem odds de mercado sempre chegam ao Claude (comportamento Option A preservado).
4. Para LoL: busca composições e stats ao vivo (Riot API ou PandaScore para torneios não-Riot) + patch meta
5. Monta prompt com **raciocínio em duas etapas**: estimativa cega de probabilidade → comparação com odds
6. Claude declara probabilidade antes de ver odds, depois verifica se há edge real (gate de 3pp)
7. **Com odds de mercado:** tip emitida se EV ≥ 2%
8. **Sem odds de mercado:** Claude estima fair odds (juice 6%) e emite tip se confiança ALTA/MÉDIA — mensagem marcada com `⚠️ Odds estimadas`
9. Tip registrada no banco + enviada por DM a todos os inscritos no esporte (¼ Kelly)

#### Pré-filtro MMA — Score de Vantagem

Calcula um score composto a partir de diferenciais reais entre os lutadores: strike accuracy (`str_acc`), striking defense (`str_def`), takedown defense (`td_def`) e win rate recente. Os diferenciais são convertidos via função logística para uma probabilidade de modelo (P1), limitada ao intervalo 35–65% para respeitar a variância do MMA. Se `|modelP1 - impliedP1| < 5pp`, a luta é pulada.

#### Pré-filtro Tênis — Mini-Elo por Superfície

Calcula probabilidade baseline via fórmula logarítmica de ranking (`P1 = ln(r2) / (ln(r1) + ln(r2))`). Quando o jogador tem ≥3 partidas na superfície, o baseline é ajustado 40% pelo win rate na superfície e 60% pelo ranking. Se `|modelP1 - impliedP1| < 6pp`, a partida é pulada.

#### Esports Pré-Jogo — Nota sobre Draft

Tips emitidas para partidas `upcoming` são baseadas exclusivamente em **forma histórica e H2H** — sem acesso ao draft/composições, que só ficam disponíveis quando a partida começa. As mensagens de tip pré-jogo incluem o aviso:

> _Análise pré-draft: baseada em forma e histórico (sem acesso às comps)_

O tracking esports exibe os resultados separados por fase (**ao vivo vs pré-jogo**) para que você avalie empiricamente se as tips pré-draft têm ROI positivo ao longo do tempo.

### Proteções Anti-Viés nos Prompts

- **"Sem edge" é uma resposta válida** — instrução explícita em todos os prompts para não forçar recomendação
- **Gate de 3pp** — se a estimativa do Claude diferir das odds implícitas em menos de 3 pontos percentuais, a análise retorna "SEM EDGE"
- **Line movement como sinal contrário** — instrução para ajustar probabilidade 2-3pp na direção do movimento de mercado
- **MMA: teto de 65-70%** — mesmo com vantagem técnica clara, o Claude é instruído a respeitar a variância do esporte
- **Esports: desconto de alto fluxo** — jogos com menos de 15 min ou objetivo maior recente rebaixam confiança para BAIXA automaticamente
- **Tênis: baseline de ranking** — fórmula logarítmica gera probabilidade de referência; Claude justifica quando diverge >8pp
- **Pré-filtro quantitativo (MMA + Tênis)** — modelo estatístico simples roda antes do Claude; se o modelo concordar com o mercado dentro do limiar, o Claude não é chamado, reduzindo custo de API e aumentando taxa de acerto das análises que chegam ao prompt

### Prompts por Esporte

| Esporte | Foco principal |
|---|---|
| MMA | Striking (SLpM, Acc, Def), Grappling (TD Avg vs TD Def), cartel, forma recente |
| LoL | Composições, gold ao vivo, torres, dragões, patch meta, formato Bo |
| Dota 2 | Gold diff, Roshan/Aegis, barracks, itens-chave, tempo de jogo |
| Tênis | Superfície, forma por superfície (histórico 3 anos), ranking vs forma, H2H na superfície |

### Kelly Criterion (¼ Kelly)

```
f* = EV / (odds − 1)
stake = clamp(f* × 0.25, 0.5u, 4u) arredondado a 0.5u
```

---

## Cobertura LoL — Fontes de Partidas

O bot combina duas fontes para máxima cobertura:

**Riot / LoL Esports API** — ligas oficiais transmitidas pela Riot:
Worlds, MSI, LCS, LCK, LEC, LPL, CBLOL, LLA, PCS, LCO, VCS, LJL, EMEA Masters, LFL, NLC, LTA Norte/Sul, First Stand, e ligas regionais.

**PandaScore** — torneios não transmitidos pela Riot (ex: qualificatórias EWC, ligas regionais independentes). IDs PandaScore são prefixados com `ps_` internamente. Composições e stats desses jogos vêm do endpoint `/ps-compositions`.

Para adicionar ligas extras além da whitelist interna, use `LOL_EXTRA_LEAGUES` no `.env`.

**Stats ao vivo LoL:**
- Gold total por time com trajetória
- Torres, dragões (com tipos), barões, inibidores, kills
- KDA, gold e CS por jogador com nome do invocador
- ~90s de delay na API oficial da Riot

---

## Settlement Automático

| Esporte | Fonte de resultado | Frequência |
|---|---|---|
| MMA | Scraping UFCStats | 30 min |
| LoL | LoL Esports API (`/getSchedule`) | 30 min |
| Dota 2 | OpenDota API (`/api/matches/{id}`) | 30 min |
| Tênis | The Odds API (`/scores?daysFrom=2`) | 24h |

---

## Alertas Automáticos

| Alerta | Intervalo | Destinatários |
|---|---|---|
| Partida LoL ao vivo / draft | 1 min | Inscritos esports |
| Partida tênis começa em ~30 min | 5 min | Inscritos tênis |
| Evento UFC hoje / amanhã | 1h | Inscritos MMA |
| Line movement ≥ 10% | 30 min | Inscritos no esporte |
| Late replacement MMA | 2h | Inscritos + admins |
| Withdrawal/substituição tênis | 2h | Inscritos + admins |
| Patch meta desatualizado (>14d) | 24h | Admins |

---

## The Odds API — Gestão de Quota

O plano gratuito tem **500 requisições/mês**. O sistema gerencia o consumo automaticamente:

- **TTL MMA**: 4h por refresh (≈ 180 req/mês)
- **TTL Tênis**: 12h por refresh, máx. 8 torneios por ciclo (≈ 180 req/mês)
- **Hard cap**: 450 req/mês (50 de buffer). Ao atingir, usa cache existente e loga aviso
- Contador em memória (`oddsApiAllowed()`) — reinicia com restart do processo

> **Nota:** O contador de requisições é em memória. Reiniciar o bot zera o contador do mês atual. Isso é inofensivo na prática — o cache de dados ainda funciona e as requisições reais tendem a ser bem abaixo do limite.

---

## Banco de Dados (`sportsedge.db`)

| Tabela | Conteúdo |
|---|---|
| `users` | user_id, username, subscribed, sport_prefs (JSON array) |
| `athletes` | lutadores/jogadores por sport, stats JSON scrapeados |
| `events` | eventos por sport — UFC cards, torneios LoL, torneios de tênis |
| `matches` | confrontos por evento com resultado pós-evento |
| `tips` | tips registradas: odds, EV, stake, confidence, resultado |
| `odds_history` | snapshots de odds (14 dias) para detecção de line movement |
| `card_snapshots` | snapshot do card/draw para detecção de replacements/withdrawals |
| `match_results` | histórico de resultados — esports (forma/H2H) + tênis Sackmann (surface form) |

**Índices de performance:**
- `idx_matches_surface (sport, category)` — queries de forma por superfície
- `idx_matches_time (sport, match_time)` — detecção de início de partidas

Campo `sport TEXT` presente em todas as tabelas para separação por esporte. Para tênis, `category` armazena a superfície (clay/hard/grass). Em `match_results`, `game` armazena a superfície para dados históricos do Sackmann.

---

## Rotas do Servidor

### Unificadas (`?sport=X`)

| Rota | Método | Descrição |
|---|---|---|
| `/events?sport=X` | GET | Eventos do esporte X |
| `/matches?eventId=X&sport=X` | GET | Partidas de um evento com odds |
| `/athlete?name=X&sport=X` | GET | Stats de um atleta/jogador |
| `/form?name=X&sport=X` | GET | Forma recente (últimos 10) |
| `/h2h?p1=X&p2=Y&sport=X` | GET | Histórico H2H |
| `/odds?p1=X&p2=Y&sport=X` | GET | Odds ao vivo |
| `/odds-movement?p1=X&p2=Y&sport=X` | GET | Histórico de odds (line movement) |
| `/record-tip` | POST | Registrar tip no banco |
| `/settle-tip?sport=X` | POST | Liquidar tip por vencedor |
| `/unsettled-tips?sport=X` | GET | Tips aguardando resultado |
| `/roi?sport=X` | GET | ROI total, calibração por confiança e split pré-jogo/ao vivo (esports) |
| `/tips-history?sport=X&filter=X&limit=N` | GET | Histórico de tips (all/settled/pending) |
| `/db-status?sport=X` | GET | Contagem por tabela |
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
| `/lol-slugs` | Lista slugs LoL na whitelist + slugs desconhecidos vistos (diagnóstico) |
| `/lol-raw` | Dump completo do schedule Riot por liga com status de cobertura (diagnóstico) |

### MMA

| Rota | Descrição |
|---|---|
| `/upcoming-fights?days=X` | Lutas próximas com odds |
| `/mma-events` | Eventos UFC futuros |
| `/mma-fights?eventId=X` | Card de um evento com odds |
| `/fighter-stats?name=X` | Stats de um lutador (UFCStats) |
| `/card-snapshot?eventId=X` | Snapshot atual do card |
| `/save-card-snapshot` | Salvar snapshot para comparação |
| `/settle-fight` | Registrar resultado de uma luta |
| `/pending-past-fights` | Lutas passadas com tips abertas |

### Tênis

| Rota | Descrição |
|---|---|
| `/tennis-tournaments` | Torneios com partidas nos próximos 14 dias |
| `/tennis-matches?tournamentId=X` | Partidas de um torneio com odds |
| `/tennis-player?name=X` | Stats de um jogador (cache DB 12h) |
| `/tennis-surface-form?player=X&surface=Y` | Forma histórica por superfície |
| `/tennis-snapshot?tournamentId=X` | Snapshot do draw para detecção de withdrawals |
| `/tennis-save-snapshot` | Salvar snapshot do draw |
| `/tennis-settle` | Disparar settlement via The Odds API scores |

---

## Fontes de Dados

| Fonte | Esporte | Uso |
|---|---|---|
| UFCStats (`ufcstats.com`) | MMA | Eventos, lutas, stats dos lutadores |
| The Odds API | MMA + Tênis | Odds ao vivo e resultados finalizados |
| LoL Esports API (`esports-api.lolesports.com`) | LoL | Calendário, séries, placar |
| LoL Live Stats Feed (`feed.lolesports.com`) | LoL | Stats ao vivo com delay ~90s |
| PandaScore API | LoL | Torneios não-Riot (ex: EWC Qualifier, ligas regionais) |
| OpenDota API | Dota 2 | Partidas ao vivo, resultados, stats |
| OddsAPI (`oddspapi.io`) | Esports | Odds Pinnacle para LoL e Dota 2 |
| Sackmann CSV (`github.com/JeffSackmann`) | Tênis | Histórico ATP/WTA/Challenger 2022–2024 |
| Anthropic Claude (`claude-sonnet-4-6`) | Todos | Análise de matchup via proxy `/claude` |

---

## Estrutura de Arquivos

```
lol betting/
├── server.js           # Servidor HTTP unificado (porta configurada via PORT/SERVER_PORT)
├── bot.js              # Bot multi-esporte (polling simultâneo, modo automático)
├── start.js            # Launcher Railway: spawna server.js + bot.js com auto-restart
├── railway.toml        # Configuração Railway (builder nixpacks, healthcheck TCP, restart policy)
├── package.json
├── .env                # Credenciais (não commitar)
├── sportsedge.db       # SQLite unificado (criado automaticamente; path via DB_PATH)
├── lib/
│   ├── database.js     # Schema SQLite, prepared statements e índices
│   ├── sports.js       # Registry de esportes (tokens, flags, sport keys)
│   └── utils.js        # log, calcKelly, fmtDate, fuzzyName, httpGet, oddsApiAllowed
├── scrapers/
│   ├── mma.js          # Scraper UFCStats (eventos, lutas, stats de lutadores)
│   └── tennis.js       # Scraper tênis (The Odds API — fixtures, odds, settlement)
├── scripts/
│   └── seed-tennis.js  # Importador de CSVs Sackmann para histórico de surface form
└── data/               # CSVs do Sackmann (não commitar — gerado pelo git clone)
    ├── tennis_atp/
    └── tennis_wta/
```

---

## Segurança

- Credenciais exclusivamente via `.env` — nunca hardcoded
- `.env`, `*.db` e `data/` devem estar no `.gitignore`
- Comandos admin protegidos por whitelist `ADMIN_USER_IDS`
- Usuários que bloqueiam o bot removidos automaticamente (erro 403)
- Claude API key transmitida via header `x-claude-key`, nunca no body
