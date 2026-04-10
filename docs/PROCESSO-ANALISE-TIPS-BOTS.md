# Processo completo de análise e tips (SportsEdge)

Documento referente ao fluxo implementado em **`bot.js`** (Telegram + orquestração) e **`server.js`** (API, odds, DB, liquidação). Dois processos Node costumam rodar (API na porta configurada + bot local ou segundo serviço no Railway).

---

## 1. Visão geral

| Componente | Função |
|-------------|--------|
| **server.js** | `/lol-matches`, `/mma-matches`, `/tennis-matches`, `/football-matches`, odds (OddsPapi / caches), `/record-tip`, `/settle`, ESPN/sync tênis, etc. |
| **bot.js** | Telegram (`poll` por esporte), **`runAutoAnalysis()`** unificado, envio de DMs, **`settleCompletedTips()`**, CLV, alertas de linha e “ao vivo”. |
| **SQLite** | Tips, banca, `match_results`, usuários/inscrições. |

Cada **sport** (`esports`, `mma`, `tennis`, `football`) pode ter token Telegram próprio; tips só vão a usuários com esse sport em `sport_prefs`.

---

## 2. Arranque do bot (`bot.js`)

0. **`validateEnv()`** (IIFE no topo): verifica variáveis obrigatórias e opcionais; emite `WARN` no log se ausentes, sem lançar excepção. Cobre `DEEPSEEK_API_KEY`, `ODDS_API_KEY`, tokens Telegram por sport, `PANDASCORE_TOKEN`, `THE_ODDS_API_KEY`, `API_SPORTS_KEY`. (`ADMIN_KEY` só no **server**, um aviso `[SEC]` no boot da API.)
1. Carrega **`SPORTS`** (`lib/sports.js`) conforme `.env` (enabled + token).
2. **`loadSubscribedUsers()`** → `GET /users?subscribed=1`; admins em **`ADMIN_USER_IDS`** são auto-inscritos nos sports ativos.
3. **`loadExistingTips()`** → histórico para maps `analyzedMatches` / `analyzedMma` / `analyzedTennis` / `analyzedFootball` (evita re-tip imediata).
4. Para cada sport com token válido (`getMe`): inicia **`poll(token, sport)`** (comandos Telegram: `/start`, tracking, etc.).
5. **Primeira análise automática** após **15 s**: `runAutoAnalysis()`.
6. **A cada 6 minutos**: `runAutoAnalysis()` de novo.
7. **A cada 30 minutos**: `settleCompletedTips()`.
8. **A cada 30 minutos**: `checkLineMovement()` (só esports).
9. **A cada 1 minuto** (se esports ativo): `checkLiveNotifications()`.
10. **A cada 2 minutos** (esports): refresh forçado de odds para partidas **live** LoL.

> **`server.js`** também executa `validateServerEnv()` antes do `server.listen()` (mesmas variáveis críticas do lado API).

---

## 3. Ciclo unificado: `runAutoAnalysis()`

- Usa **mutex** (`withAutoAnalysisMutex`): se um ciclo ainda rodar, o próximo é pulado (ou lock “stale” após ~15 min — `AUTO_ANALYSIS_MUTEX_STALE_MIN`).
- **Ordem fixa:**
  1. **Esports (LoL)** — draft/live filtrado + upcoming 24h  
  2. Pausa **5 s** → **`pollMma(true)`** (uma passagem; o loop interno do MMA agenda a próxima em 30 min)  
  3. Pausa **5 s** → **`pollFootball(true)`** (se futebol ativo)  
  4. Pausa **5 s** → **`pollTennis(true)`** (se tênis ativo)  
  5. Pausa **2 s** → **`checkCLV(sharedCaches)`**  
  6. **`refreshOpenTips(sharedCaches)`**

---

## 4. Esports (LoL) — análise automática

Fonte de partidas: **`GET /lol-matches`** (Riot + PandaScore mesclados no server).

### 4.1 Loop principal LoL (pré-jogo com draft)

- O array processado é **`status === 'draft'`** apenas: composições já conhecidas antes do jogo começar; **tips ML ao vivo nesse ramo estão desligadas** (comentário no código: “tips ao vivo desabilitadas”).
- Ainda há lógica de mapa ao vivo dentro de `autoAnalyzeMatch` / `collectGameContext` quando há stats de mapa — o fluxo “live” completo depende desse encadeamento; o filtro inicial não inclui `status === 'live'`.
- **Ligas principais** (LCK, LPL, LEC, etc.): **`isMainLeague()`** → **sem tip** automática.
- Deduplicação: prioriza **Riot** sobre **PandaScore** para o mesmo confronto.
- Chave **`analyzedMatches`**: `game_id` + opcional **`_MAPn`** quando contexto é de mapa específico.
- Cooldown: **`RE_ANALYZE_INTERVAL`** (10 min); se última análise foi “sem edge”, **dobra** o intervalo.

### 4.2 Pipeline por partida: `autoAnalyzeMatch()`

(Resumo; implementação longa no `bot.js`.)

- Monta contexto: odds (`/odds` ou estimadas), forma/H2H (`/team-form`, `/h2h`), **`/grid-enrich`** (LoL, opcional — `GRID_API_KEY` no server), composições (**`/ps-compositions`**, **`/live-gameids`**, stats ao vivo).
- **Pré-modelo:** `esportsPreFilter()` (`lib/ml.js`) → score em “pp”, `modelP1`/`modelP2`, fatores ativos.
- Chama **`POST /claude`** no server (modelo configurável, ex. DeepSeek) com prompt que exige formato **`TIP_ML:...`** ou **`SEM_EDGE`**.
- **Prompt LoL (`buildEsportsPrompt`):** bloco `LOL_PROMPT_RESEARCH_HINTS` — teses de edge da literatura quant (ritmo early/jungle, objetivos vs. só ouro, série Bo3/Bo5), alinhadas a ideias de projetos como [lol-betting-pipeline](https://github.com/chdoyle1/lol-betting-pipeline); **sem** Python/GRID no runtime. Checklist ampliado (8 itens) + contador separado **Conf pré-modelo** (0–6) dos sinais de enrichment.
- Se houver tip parseada: **Kelly** (`calcKellyWithP` / `calcKellyFraction`) por confiança (ALTA ¼, MÉDIA ⅙, BAIXA 1/10) → **`applyGlobalRisk('esports', ...)`** → **`POST /record-tip`** → DM inscritos → opcional **`/log-tip-factors`**.
- Opcional: segunda tip **HANDICAP** (mercado via `/handicap-odds`) se não for live no mapa — stake limitado, confiança BAIXA.

### 4.3 Upcoming (próximas 24h)

- Janela: **`UPCOMING_WINDOW_HOURS`** = 24h.
- Ignora **Bo3/Bo5** antes do draft se **`LOL_PREGAME_BLOCK_BO3`** ≠ `false`.
- Cooldown **`UPCOMING_ANALYZE_INTERVAL`** (30 min); **< 2h** para o jogo: bypass de cooldown + **`forceOddsRefreshQueued`**.
- Gate extra: confiança **BAIXA** só se **ML edge ≥ 8 pp** no pré-jogo.
- **`POST /record-tip`** sem `lol_` map suffix no id base (Bo1).

---

## 5. MMA + Boxe — `pollMma()`

Fonte: **`GET /mma-matches`** (The Odds API: MMA + `boxing_boxing`).

Paralelo: **`fetchEspnMmaFights()`** (scoreboard UFC na ESPN).

### 5.1 Filtros por luta

| Regra | MMA | Boxe |
|--------|-----|------|
| Deve existir na ESPN (UFC) | Sim — senão *Pulando não-UFC* | Não exige ESPN |
| Luta no passado | Ignora | Ignora |
| Data inválida ou > 60 dias | Ignora | Ignora |
| **Janela até o combate** | — | Só analisa boxe se a luta for em **≤ N dias** (default **10**, `BOXING_MAX_DAYS_BEFORE_FIGHT`; além disso pula) |
| Intervalo entre re-análises | **6 h** (`MMA_INTERVAL`) | Idem |

### 5.2 Dados e modelo

- **MMA:** records ESPN no card; fallback ESPN atleta → Wikipedia → Sherdog → Tapology; `mmaRecordToEnrich` → **`esportsPreFilter`**.
- **Boxe:** sem records externos (só de-juice / modelo mínimo).

### 5.3 IA e gates

- **`POST /claude`** com prompt MMA/boxe; parse **`TIP_ML:fighter@odd|EV:…|STAKE:…|CONF:…`**.
- Luta **fora da semana calendário** atual: só aceita se **CONF = ALTA**.
- Odds **1.40–5.00**; **EV ≥ 5%**.
- Risco: **`applyGlobalRisk('mma', ...)`** → **`POST /record-tip`** com `sport=mma` (boxe usa o mesmo fluxo/Telegram MMA bot).
- Loop standalone: a cada **30 min** se não `runOnce`.

---

## 6. Tênis — `pollTennis()`

Fonte: **`GET /tennis-matches`** (The Odds API, chaves ATP/WTA balanceadas no server).

- Enriquecimento: rankings ESPN ATP/WTA, evento/scoreboard, **`/team-form`**, **`/h2h`** com `game=tennis`, `rankingToEnrich` / DB.
- **`TENNIS_MIN_EDGE`** (default ~2.5 pp): ajuste do pré-filtro vs LoL.
- **`esportsPreFilter`** → IA (mesmo padrão `TIP_ML` com regras de tênis no prompt).
- Gates: odds **1.15–5.00**, **EV ≥ 4%**.
- **`POST /record-tip`**, `sport=tennis`, `matchId` canônico `tennis_<id_odds>`.
- Re-execução: intervalo **2 h** por confronto; sem partidas → retry em **30 min**.

---

## 7. Futebol — `pollFootball()`

Fonte: **`GET /football-matches`**.

- Odds 1X2 (e opcional O/U 2.5); pré-filtro rápido de EV trivial.
- Dados: **football-data.org** se token (`FOOTBALL_DATA_*`); senão **forma/H2H** via **`/team-form`**, **`/h2h`**, **`/football-elo`**.
- **`calcFootballScore`** (`lib/football-ml.js`): se há `fixtureInfo` e `!pass` → pula IA.
- IA decide mercado (1X2, dupla chance, O/U conforme prompt).
- Gates típicos: odds **1.30–6.00**, **`FOOTBALL_EV_THRESHOLD`** (default 5%), draw com odd mínima **`FOOTBALL_DRAW_MIN_ODDS`**.
- Loop: **1 h** entre ciclos completos.

---

## 8. Liquidação — `settleCompletedTips()`

Roda a cada **`SETTLEMENT_INTERVAL`** = **30 min** (fixo no código).

1. Para cada sport habilitado: **`GET /unsettled-tips?days=…`**
   - **Tênis:** default **120 dias** (`TENNIS_UNSETTLED_DAYS`); demais **30 dias**.
2. **`mma`:** cruzar tip com **ESPN UFC**; se `post` e vencedor → **`POST /settle`**.
3. **`tennis`:**  
   - `GET /sync-tennis-espn-results?force=1`  
   - `/tennis-scores` (Odds API, se útil)  
   - `fetchEspnTennisEvent` (resultados recentes)  
   - Ordem: **`/tennis-db-result`** (DB + sync ESPN por janela de datas) → scores → fallback ESPN par a par.
4. **`football`:** **`GET /football-result?matchId=…&team1=…&team2=…&sentAt=…`**  
   - Server consulta `match_results` (CSV 2024/25 importado no boot) primeiro por `match_id` exacto; se não encontrar, faz LIKE por nome dos times numa janela de ±4 dias em torno de `sentAt`.  
   - Após **`/settle`** o server actualiza o Elo dos times (`updateEloMatch`) — só para mercados 1X2 (não O/U); vencedor validado contra nome dos times ou "Draw".  
   - Body do settle inclui `home` e `away` para o Elo update.
5. **`esports`:** **`/match-result`** (Riot) ou **`/ps-result`** (PandaScore) → **`/settle`**.

O server em **`/settle`** compara vencedor com `tip_participant` (tênis usa matching de nomes **`tennisSinglePlayerNameMatch`**).

---

## 9. Outras tarefas em background

| Tarefa | Intervalo / gatilho |
|--------|----------------------|
| **`checkCLV`** | Fim de cada `runAutoAnalysis`; grava odds de fechamento perto do horário do jogo (esports, futebol, tênis). |
| **`refreshOpenTips`** | Atualiza odds/EV em tips abertas (usa caches do ciclo). |
| **`checkLineMovement`** | 30 min; alerta movimento forte de linha (esports). |
| **`checkLiveNotifications`** | 1 min; DM “partida ao vivo com mercado” (LoL). |

---

## 10. Variáveis de ambiente relevantes (não exaustivo)

| Variável | Efeito |
|----------|--------|
| `BOXING_MAX_DAYS_BEFORE_FIGHT` | Boxe: só analisa se faltam **≤ N dias** para a luta (default 10). |
| `MMA_MAX_IA_CALLS_PER_CYCLE` | MMA/boxe: máx. chamadas IA por ciclo do `pollMma` (default **18**; `0` = sem limite). |
| `ADMIN_KEY` | Só no **server**: um aviso `[SEC]` no boot se ausente (bot não duplica). |
| `GRID_API_KEY` | **Server**: acesso [GRID Central Data](https://api-op.grid.gg/central-data/graphql) + Series State; endpoint **`GET /grid-enrich?team1=&team2=&game=lol`**. Open Access pode **não** incluir LoL — depende do plano. |
| `LOL_GRID_ENRICH` | **Bot**: `false` desliga chamada a `/grid-enrich` (default ligado se API responder). |
| `GRID_DAYS_BACK`, `GRID_MAX_STATE_CALLS`, `GRID_ENRICH_CACHE_MS`, … | Ver `lib/grid.js` — janela temporal, paginação `allSeries`, limite de `seriesState`, cache por confronto. |
| `TENNIS_MIN_EDGE` | Limiar do pré-filtro ML (tênis). |
| `TENNIS_UNSETTLED_DAYS` | Janela de tips pendentes para liquidação tênis. |
| `FOOTBALL_EV_THRESHOLD`, `FOOTBALL_DRAW_MIN_ODDS` | Gates futebol. |
| `LOL_PREGAME_BLOCK_BO3` | Bloquear upcoming Bo3/Bo5 até draft. |
| `TELEGRAM_HTTP_TIMEOUT_MS`, `TELEGRAM_HTTP_ATTEMPTS` | Telegram lento (ex. Railway). |
| `ODDSPAPI_START_DELAY_MS`, `ODDSPAPI_BOOTSTRAP_GAP_AFTER_FIRST_MS` | Espaçar chamadas OddsPapi no boot (server). |

---

## 11. Onde mudar o comportamento

- **Intervalos globais de análise / settlement:** topo de `bot.js` (`RE_ANALYZE_INTERVAL`, `SETTLEMENT_INTERVAL`, etc.).
- **Prompts e parsing de tip:** funções `autoAnalyzeMatch`, `buildEsportsPrompt` (`LOL_PROMPT_RESEARCH_HINTS`), blocos `pollMma` / `pollTennis` / `pollFootball`.
- **Endpoints e caches de odds:** `server.js` (OddsPapi, 429/backoff, `/lol-matches`).
- **Matching de nomes (tênis):** `lib/tennis-match.js` + `/tennis-db-result` / `/settle` no server.  
  - `extractSurname()` trata formatos "Last, First", "J.Sinner" e "J. Sinner".  
  - `normalizeNameOrder()` converte "Last, First" → "First Last" antes de comparação substring.  
  - Pipeline: nome exacto → substring → ordem normalizada → sobrenome isolado → último token.
- **Elo futebol:** `lib/database.js` (`updateEloMatch`); disparo automático no `/settle` após liquidação de mercados 1X2.

---

*Gerado a partir do código do repositório; revisar após refactors grandes.*
