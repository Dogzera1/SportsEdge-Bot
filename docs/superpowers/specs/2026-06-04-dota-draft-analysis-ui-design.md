# Dota Lab — botão "Analisar draft" (Fase 2: UI)

**Data:** 2026-06-04
**Tipo:** feature display-only (UI + endpoints) — consome o pipeline da Fase 1
**Fase:** 2 de 2. Fase 1 (ingestão) já em `main` (`73a3dc0`).

---

## Objetivo

Adicionar ao Dota Lab um botão **"Analisar draft"** (separado do "Analisar partida") que mostra uma leitura de draft baseada nos dados reais ingeridos na Fase 1: **counters do confronto**, **WR de cada jogador no herói que pegou**, **força de draft (meta)** e **composição** — mais uma **leitura da IA ancorada nesses números**. É o que o user pediu ("matchups, WR de jogador×herói, tudo que ajude a analisar").

**Honestidade (decisão travada):** o Dota **não** produz um win% de draft (sem draft histórico para treinar/validar — ao contrário do `computeDraftWinProb` do LoL). "Analisar draft" mostra **leituras**, não uma probabilidade. O counter edge é rotulado "vantagem de matchup (pp)", nunca "probabilidade".

**Conexão com o pedido original:** os campos de jogador (`.dota-player`), que eram só conferência na feature de print-parse, **agora viram funcionais** — resolvem o pro (`dota_pro_players`) e puxam o WR jogador×herói (`dota_player_hero_stats`, on-demand).

---

## Componentes

### 1. `getDraftComposition(db, heroes)` — novo helper em `lib/dota-hero-features.js`
Função pura: recebe nomes de heróis, lê `dota_hero_stats` (`roles` CSV + `primary_attr`), retorna `{ roles: {Carry:n, Support:n, …}, attrs: {str:n, agi:n, int:n, all:n}, known: n }`. Leitura simples (contagem), sem modelo. Cache in-memory do map nome→{roles,attr} (~30min). Heróis desconhecidos são ignorados (contam em `known` só os resolvidos).

### 2. `POST /api/dota-draft-analyze` — endpoint (display-only)
Recebe `{ team1?, team2?, blue:[heróis], red:[heróis], players?:{blue:[nicks], red:[nicks]} }` (heróis e nicks **alinhados por slot**, índice i = mesmo jogador/herói). Orquestra os libs (todos já existentes exceto composição):
- **`draftStrength`** = `getDraftMatchupFactor(db, blue, red)` → `{factor, blueWR, redWR, detail}` ou `null` (amostra <3). Mais o WR/pickban individual por herói (de `dota_hero_stats`).
- **`matchupEdge`** = `getMatchupEdge(db, blue, red)` → `{blueAdvantagePp, sampled, pairs:[{blue,red,advPp,games}]}`, com nome de herói resolvido para exibição.
- **`playerHeroes`** = por lado, por slot: `resolveProPlayer(nick)` → `getPlayerHeroStats(account_id)` → `{nick, player, team, hero, onHero:{wr,games}|null, top:[3]}`. `onHero` = WR do jogador no herói **daquele slot** (casa hero do slot via `resolveHeroId`). Jogador sem match → `{nick, resolved:false}` (graceful). Slot sem nick → omitido.
- **`composition`** = `{blue: getDraftComposition(db, blue), red: getDraftComposition(db, red)}`.

Retorna `{ ok:true, draftStrength, matchupEdge, playerHeroes:{blue,red}, composition }`. É `async` (o `getPlayerHeroStats` pode fazer fetch on-demand; cacheado 7d, então a 2ª análise do mesmo jogador é instantânea). Sem cap próprio (fetch OpenDota é grátis + cacheado, e só resolve pros conhecidos — não é arbitrário).

`resolveHeroId(db, nameOrId)` → exportado de `lib/dota-hero-matchups.js` (hoje `_resolveId` é interno; promover a público e reusar nos dois lugares — P3, sem duplicar a resolução nome→hero_id).

### 3. `POST /api/dota-draft-explain` — IA ancorada (display-only)
Novo `lib/dota-draft-explain.js`: `buildDotaDraftPrompt({ teams, draft, matchupEdge, playerHeroes, composition })` + `parseDotaDraftExplain(text)` (espelha `dota-match-explain.js`, 4 chaves: `overview`, `matchups`, `keyPlayers`, `verdict`). O prompt entrega os **números objetivos** (counter edge + pares decisivos, WR jogador×herói, composição) e pede ao Sonnet para interpretá-los + complementar com conhecimento de Dota; regras: não inventar probabilidade, não recomendar stake, marcar leitura de meta como "conhecimento geral / pode não refletir o patch". Endpoint reusa `aiPost` + cap `AI_ANALYSIS_DAILY_CAP` + `AI_ANALYSIS_MODEL` (mesma infra do `dota-match-explain`). Recomputa os dados objetivos via os mesmos libs (não confia no client).

### 4. Front-end (`public/lol-live-dashboard.html`)
- Botão **"Analisar draft"** (`dotaAnalyzeDraftBtn`) na `.dl-actions` do `#dotaLab`, ao lado de "Analisar partida".
- `dotaCollectDraft()` → coleta `{team1, team2, blue:[heróis], red:[heróis], players:{blue:[nicks], red:[nicks]}}` lendo cada `.dota-slot` (hero + player alinhados).
- `dotaAnalyzeDraft()` → POST `/api/dota-draft-analyze` → `dotaRenderDraft(root, d)`.
- `dotaRenderDraft()`: 4 blocos — força de draft (WR meta), counters (top pares ± pp), WR jogador×herói (linha por jogador com onHero destacado), composição (roles/atributos por lado) — + botão "🤖 Análise da IA" → `dotaExplainDraft()` → `/api/dota-draft-explain` (mesma UX do `dotaExplain` atual). Selo "⚠ leitura, não é probabilidade nem sinal de aposta".

---

## Garantias e princípios
- **Display-only / money-path airtight:** endpoints e libs só leem dados de análise; nada toca stake/EV/bet. Verificação por grep (`dota-draft-analyze`, `dota-draft-explain`, `getDraftComposition`, `resolveHeroId`) ausente de `bot.js`/`scanner`/`market-tip-processor`/`dota-map-model`.
- **Sem win% de draft** (sem dados); counter edge ≠ probabilidade (rótulo explícito).
- **Graceful:** sem jogadores → omite o bloco WR jogador×herói; `dota_*` tabelas vazias (pré-cron em prod, ou local) → blocos vazios, sem erro; `getPlayerHeroStats` fetch-fail → jogador sem dados.
- **P3:** reusa `getDraftMatchupFactor`/`getMatchupEdge`/`getPlayerHeroStats`/`resolveProPlayer` (Fase 1 + existentes); promove `resolveHeroId` a público em vez de duplicar; só `getDraftComposition` + `dota-draft-explain` são novos.
- **Sem dep npm, sem migration, sem env nova** (reusa `ANTHROPIC_API_KEY`/`AI_ANALYSIS_*`).

---

## Testes
- `getDraftComposition` (em `tests/test-dota-hero-matchups.js` ou novo): stub db com `dota_hero_stats` (roles/attr) → conta roles e atributos, ignora desconhecido.
- `resolveHeroId` (público): exato/loose/desconhecido (pode reusar o stub de matchups).
- `buildDotaDraftPrompt`/`parseDotaDraftExplain` (`tests/test-dota-draft-explain.js`): prompt contém os números objetivos + pede JSON 4-chaves; parse extrai as 4 chaves / null se inválido.
- Endpoints: smoke manual (CLI/seed como na Fase 1) — não unit (HTTP + IA).

---

## Fora de escopo (YAGNI)
- Win% de draft (sem dados).
- Sinergia de dupla aliada (Stratz dormante; OpenDota matchups não fornece).
- Alimentar o money-path (display-only; e draft é preditor fraco).
- Auto-prefill do draft de uma partida live (não há feed live de Dota).
