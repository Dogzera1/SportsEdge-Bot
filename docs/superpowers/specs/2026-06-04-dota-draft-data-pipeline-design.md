# Dota Lab — pipeline de dados de draft (Fase 1: ingestão)

**Data:** 2026-06-04
**Tipo:** ingestão de dados (backend) — pré-requisito da análise de draft do Dota Lab
**Fase:** 1 de 2. Fase 2 (UI "Analisar draft") = spec próprio, próximo ciclo.

---

## Objetivo

Popular o banco com os **dados reais** que faltam para uma análise de draft de Dota útil:
- **WR jogador×herói** (quão bem cada jogador vai com cada herói).
- **Counters herói×herói** (vantagem de um herói contra outro).

Hoje o Dota Lab só tem WR meta agregado por herói (`dota_hero_stats`) + Elo de times. As tabelas para jogador×herói e counters existem vazias ou nem existem. Esta fase entrega o **pipeline de ingestão + libs de leitura**, validável rodando scripts — **sem UI** (a UI é a Fase 2).

### Por que ingestão primeiro (decisão do user)
O user escolheu ter os dados reais antes da UI. A Fase 1 é testável de forma isolada (rodar os scripts, inspecionar as tabelas, rodar o CLI de prova). A Fase 2 só consome o que esta fase produz.

### Decisões travadas (não re-derivar)
- **Counters = OpenDota** (`/heroes/{id}/matchups`), sem token. A `stratz_hero_matchups` + `lib/stratz-dota-scraper.js` ficam **dormantes** (Stratz exige `STRATZ_API_TOKEN` — dá 403 sem; por isso a tabela está vazia hoje). Marco `@DORMANT 2026-06-04` no header do scraper.
- **WR jogador×herói = híbrido on-demand.** Cron leve diário popula só o mapa de pros; o WR por herói é buscado sob demanda (≤10 jogadores por análise) e cacheado 7 dias. Respeita o teto do free tier OpenDota (~2k req/dia).
- **Sem "win% só de draft"**: não há draft histórico (heróis por jogo) em `match_results` Dota → não é treinável/validável. A análise de draft (Fase 2) será leitura (matchup edge + WR jogador×herói + composição + IA), não uma probabilidade.

---

## Fontes (validadas em 2026-06-04, sem token)

| Endpoint OpenDota | Uso | Retorno usado |
|---|---|---|
| `GET /heroes/{hero_id}/matchups` | counters | linhas `{hero_id (oponente), games_played, wins}` (wins = vitórias do herói-alvo) |
| `GET /proPlayers` | mapa nick→account_id | `{account_id, name, team_name}` (~4417 pros) |
| `GET /players/{account_id}/heroes` | WR jogador×herói (on-demand) | `{hero_id, games, win, last_played}` (127 linhas) |

`OPENDOTA_API_KEY` opcional (anexa `?api_key=`), igual a `sync-opendota-heroes.js`.

---

## Componentes

### 1. Migration (nova, numerada em `migrations/index.js`)
Três tabelas (`CREATE TABLE IF NOT EXISTS`):

- **`dota_hero_matchups`** — `hero_id INTEGER, vs_hero_id INTEGER, games INTEGER, wins INTEGER, wr REAL, updated_at TEXT`, PK `(hero_id, vs_hero_id)`. Index em `hero_id`.
- **`dota_pro_players`** — `account_id INTEGER PRIMARY KEY, name TEXT, name_norm TEXT, team_name TEXT, updated_at TEXT`. Index em `name_norm`.
- **`dota_player_hero_stats`** — `account_id INTEGER, hero_id INTEGER, games INTEGER, wins INTEGER, wr REAL, last_played INTEGER, fetched_at TEXT`, PK `(account_id, hero_id)`. Index em `account_id`.

### 2. Scripts de sync + crons
Seguem o padrão de `scripts/sync-opendota-heroes.js` (https.get JSON, upsert em transação, `OPENDOTA_API_KEY` opcional) e são agendados em `bot.js` no molde de `runDotaHeroSync` (~bot.js:28143): `spawn('node', [script])`, `setInterval` + `setTimeout` escalonado pós-boot, `invalidate*Cache()` no close.

- **`scripts/sync-opendota-hero-matchups.js`** — itera os heróis de `dota_hero_stats` (hero_id), `GET /heroes/{id}/matchups`, calcula `wr = wins/games_played`, upsert em `dota_hero_matchups`. Delay ~1100ms entre req (respeita 60/min). ~138 req (~2,5 min). **Cron semanal** (boot+~120min). Invalida o cache do matchup reader no close.
- **`scripts/sync-opendota-pro-players.js`** — `GET /proPlayers` (1 req), upsert em `dota_pro_players` com `name_norm = normalizeProNick(name)`. **Cron diário** (boot+~115min). Invalida o cache do resolver no close.

### 3. Libs de leitura (puras, testáveis — o produto da Fase 1)

**`lib/dota-player-heroes.js`**
- `normalizeProNick(s)` → chave de match densa: `toLowerCase` + remove tudo que não é `[a-z0-9]`. (Ex.: `"Insania "`→`insania`, `"Ace ♠"`→`ace`, `"Tundra.Nine"`→`tundranine`.) Pura. É o que vai em `dota_pro_players.name_norm`.
- `resolveProPlayer(db, nick)` → `{account_id, name, team_name} | null`: casa a chave densa inteira contra `name_norm` e, como fallback, cada token do nick separado por `.`/espaço com ≥3 chars (assim `"Tundra.Nine"` casa com o pro `Nine`, `"OG ATF"` com `ATF`). Cache in-memory ~30min. Sem match → `null` (graceful: jogador fica sem dados, não quebra).
- `getPlayerHeroStats(db, accountId, { ttlDays = 7, fetcher } = {})` → lê `dota_player_hero_stats`; se ausente ou `fetched_at` mais velho que `ttlDays`, chama `fetcher(accountId)` (default = OpenDota `/players/{id}/heroes`), faz upsert e retorna `[{hero_id, games, wins, wr, last_played}]` ordenado. `fetcher` injetável → testável sem rede.

**`lib/dota-hero-matchups.js`**
- `getMatchupEdge(db, blueHeroes, redHeroes)` — aceita **nomes** (resolve nome→hero_id via `dota_hero_stats.localized_name`, reusando `normalizeHeroName` de `lib/dota-draft-parse.js`) **ou** hero_ids. Lê `dota_hero_matchups`, calcula por par azul×vermelho a vantagem `adv = wr - 0.5` (com guard de amostra mínima de `games`), retorna `{ blueAdvantagePp, pairs: [{ blue, red, adv, games }], sampled }`. Cache in-memory da tabela (~30min). Pura sobre o DB.

### 4. Validação
- **Testes unitários** (`tests/test-dota-player-heroes.js`, `tests/test-dota-hero-matchups.js`) — puros, sem rede: `normalizeProNick` (tags/símbolos/espaços), `getPlayerHeroStats` com `fetcher` mockado (cache hit / miss / stale → refetch), `getMatchupEdge` (resolução de nome, agregação, guard de amostra mínima, herói desconhecido). Stub db igual ao `test-dota-draft-parse.js`. Roda no pre-commit.
- **Script CLI** `scripts/dota-draft-probe.js` — recebe nicks + heróis dos dois lados, exercita `resolveProPlayer` + `getPlayerHeroStats` (fetch real) + `getMatchupEdge`, imprime o resultado. Valida o pipeline end-to-end com dados reais, sem UI. Não roda no cron (ferramenta manual).

---

## Garantias e princípios

- **Display-only / fora do money-path:** dados e libs são para análise. Verificação por grep: as tabelas/libs novas não são referenciadas por `bot.js` (exceto o agendamento dos syncs), `lib/scanner*`, `lib/market-tip-processor`, `lib/dota-map-model`. Os syncs são ingestão de meta (igual aos OpenDota existentes), não tocam stake/EV.
- **Rate-limit (P externos):** counters batch leve semanal (~138 req, delay 1100ms); proPlayers 1 req/dia; player×hero on-demand (≤10/análise, cache 7d). Tudo dentro do free tier. `OPENDOTA_API_KEY` opcional eleva o teto.
- **P3 (anti-overfeaturing):** verifiquei que não existe ingestão de player×hero nem de counters OpenDota (grep). `dota_hero_matchups` é a fonte ativa; `stratz_hero_matchups`/`stratz-dota-scraper` ficam `@DORMANT` (não deletar sem autorização — só marcar). Crons novos seguem o padrão existente, sem duplicar intent.
- **P5 (cross-sport):** ingestão Dota-específica; o pipeline OpenDota é o mesmo padrão dos syncs Dota já existentes (heroes/matches/team-stats). Sem sibling em outros sports.
- **Sem dep npm, sem env nova obrigatória** (reusa `OPENDOTA_API_KEY` opcional já existente).

---

## Fora de escopo (Fase 2 ou descartado)
- **UI "Analisar draft"** + endpoint `/api/dota-draft-analyze` + leitura da IA de draft → **Fase 2** (spec próprio).
- **Win% só de draft** → descartado (sem draft histórico; seria inventar confiança).
- **Stratz** (counter+sinergia) → dormante; reativável depois com `STRATZ_API_TOKEN` (scraper pronto).
- **Sinergia de dupla aliada** → OpenDota matchups não fornece; só counter. (Stratz traria.)
- **Mapear por roster do time** (em vez de nick) → Fase 2 pode usar `team_name` de `dota_pro_players` como fallback; não nesta fase.

---

## Testes (resumo)
`tests/test-dota-player-heroes.js` + `tests/test-dota-hero-matchups.js`, puros, fetcher/db stub, no pre-commit. Não testar wrappers triviais. O CLI é validação manual, não teste automatizado.
