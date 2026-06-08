# CS Match Lab v1 (Elo-only) — Design

**Data:** 2026-06-08
**Status:** aprovado o escopo, pendente review do spec
**Origem:** o pedido era destravar stats da HLTV via Webshare pro analisador de CS. A Fase 0 (commit `b5c67ee`) provou que o Webshare funciona, mas as `/stats/*` da HLTV estão atrás de um **CF JS-challenge** ("Just a moment") que o `curl_cffi` não resolve (não roda JS) e que IP residencial não contorna. Decisão do user: construir o **lab v1 só com Elo** agora (não depende de vencer a CF); map-winrate/player-stats ficam pro "caminho B" (navegador-solver) no futuro.

## Objetivo

Painel "CS Match Lab" no `/edge` que, dado dois times de CS, mostra **P(team1 vence)** calibrada por Elo, **odd justa + edge** (vs odd do book, opcional) e uma **explicação por IA** ancorada nos números. **Display-only, money-path airtight** — espelha o Dota Match Lab.

## Escopo

**No v1:**
- Predição por Elo próprio cs2 (instância display-only), calibrada (isotônica), validada por backtest OOS.
- Odd justa (1/p) + edge vs odd do book opcional.
- IA (Sonnet) explica o confronto em PT-BR (honesty contract, display-only).
- UI: overlay `#csLab` no dashboard, espelhando `#dotaLab`.
- Listar partidas HLTV ao vivo/próximas (`/api/matches`, que passa pelo proxy) pra pré-preencher os times — opcional, tarefa separável.

**Fora do v1** (dependem das `/stats` bloqueadas pela CF):
- Winrate por mapa (map pool / map-gating na prob).
- Player stats HLTV 2.0.
- → viram "caminho B" (Playwright/FlareSolverr + Webshare) se o user quiser depois.

## Arquitetura / Componentes

Molde = Dota Match Lab. Arquivos **novos**, nada de edição no money-path.

### 1. `lib/cs-match-predict.js` (novo)
- `module.exports = { predictMatch }`
- `predictMatch(db, { team1, team2 })` → `{ prob, probTeam1, components: { elo }, confidence, label }`
  - `prob`/`probTeam1` = P(team1 vence o **match**, série Bo1/Bo3/Bo5), [0,1]. O Elo é treinado no `winner` de `match_results` (série-level), então a prob é da série inteira — **sem decomposição por mapa** (não temos dados de mapa no v1).
  - `components.elo` = `{ pTeam1, confidence, ratingTeam1, ratingTeam2, gamesTeam1, gamesTeam2, foundTeam1, foundTeam2 }`.
  - `label` ∈ `'forte' | 'lean' | 'lean fraco'` (derivado de |prob−0.5| + confidence), igual Dota.
- Elo via `createEloSystem(CS_ELO_CONFIG).bootstrap(db, 'cs2')` (instância própria, cache ~1h via closure `_csElo()`), depois `elo.getP(team1, team2)`.
- Calibração isotônica: `_applyIsotonicBlocks(CALIB.blocks, pRaw)` com artefato JSON gerado pelo backtest (mesmo padrão do Dota). Sem artefato → usa `pRaw` (sem calib).
- **Sem componente de draft/map** (CS v1 não tem dados de comp/mapa) — `components` só tem `elo`.

### 2. `lib/cs-match-explain.js` (novo)
- `module.exports = { buildCsExplainPrompt, parseCsExplain }`
- `buildCsExplainPrompt({ pred, teams, fairOdds, edge })` → string de prompt PT-BR. Instrui: "o `prob` vem do Elo — NÃO altere; explique o confronto, contexto dos times, e o que o edge significa". Honesty contract (não inventar stats que não temos: sem map pool, sem player form).
- `parseCsExplain(text)` → `{ overview, matchupRead, verdict }` (extrai JSON do response).
- A chamada à IA (`aiPost` Sonnet, cap diário compartilhado) acontece no endpoint, igual Dota.

### 3. `scripts/backtest-cs-match.js` (novo)
- Walk-forward sobre `match_results` game='cs2' ordenado por `resolved_at`: para cada match, `elo.getP()` ANTES de `elo.rate()` (sem leakage).
- Split 70/30 por data, fit isotônico PAV (12 bins) no treino, avalia teste com Brier (raw vs calib) + ECE, compara vs base-rate/coinflip.
- **Gate de exibição:** se o Elo cs2 NÃO bater coinflip OOS (Brier ≥ 0.25), o lab não apresenta a prob como sinal forte (label rebaixado / aviso). Esperado: Elo robusto (28k jogos, memória registra P(Alliance vs 9INE)=0.648) — mas o backtest decide, não a suposição.
- Salva o artefato de calibração isotônica (blocos JSON) consumido pelo predict.

### 4. Endpoints (`server.js`, novos, padrão dos `/api/dota-*`)
- `GET /api/cs-teams` → lista times únicos `match_results WHERE game='cs2'` (autocomplete).
- `POST /api/cs-match-analyze` `{ team1, team2, oddTeam1?, oddTeam2? }` → `predictMatch()` + `fairOdds` (1/p) + `edge` (se odd fornecida). Retorna `{ ok, pred, fairOdds, edge }`.
- `POST /api/cs-match-explain` `{ team1, team2, pred, fairOdds, edge }` → `buildCsExplainPrompt` → `aiPost(Sonnet)` → `parseCsExplain`. Retorna `{ ok, analysis }`.
- (opcional) `GET /api/cs-live-matches` → proxy `/api/matches` do `HLTV_PROXY_BASE`, normaliza `{ matchId, teams, event, live }` pra UI.

### 5. UI (`public/lol-live-dashboard.html`, espelha `#dotaLab`)
- Overlay `#csLab` (mesmo padrão fixed/overlay do `#dotaLab` ~linha 1058) + botão `#csLabBtn` no header.
- Inputs: team1, team2 (autocomplete via `/api/cs-teams`), odds opcionais. Botão "Analisar" → `/api/cs-match-analyze`; botão "IA explica" → `/api/cs-match-explain`.
- (opcional) lista de jogos ao vivo via `/api/cs-live-matches` → clicar pré-preenche os times.
- Render: prob + ratings + odd justa + edge + label; seção IA.

## Data flow

```
user (2 times [+odds]) ─▶ /api/cs-match-analyze ─▶ predictMatch(db) ─▶ createEloSystem('cs2').getP ─▶ calib isotônica
                                                          └─▶ fairOdds + edge ─▶ UI
user clica "IA explica"  ─▶ /api/cs-match-explain ─▶ buildCsExplainPrompt ─▶ aiPost(Sonnet) ─▶ parseCsExplain ─▶ UI
```

## Money-path airtight (invariante)

- **NÃO** importar `lib/cs-ml.js` / `getCsElo` (esse é o Elo das tips reais). O lab cria instância própria via `createEloSystem(...).bootstrap(db,'cs2')`.
- **NÃO** referenciar stake/EV/Kelly/bankroll/`tips`. Endpoints retornam só prob/odd/edge/texto.
- Verificação: `grep` nos arquivos novos por `cs-ml|getCsElo|kelly|stake|bankroll|getLolProbability` deve dar 0.
- Suite existente (1060 testes) continua passando — o lab é puramente aditivo.

## Error handling

- Time não encontrado no Elo (`foundTeam1/2=false`): `confidence` baixa → `label='lean fraco'` + aviso na UI ("time com poucos/zero jogos no histórico cs2"). Não erro 500.
- IA: cap diário compartilhado (mesmo do Dota/LoL); se estourar, UI mostra "IA indisponível", o resto do painel funciona.
- `/api/cs-live-matches`: se o proxy HLTV falhar, a lista fica vazia — input manual continua funcionando (degradação graciosa).

## Testing

- `scripts/backtest-cs-match.js` é o teste de validação do preditor (Brier OOS vs coinflip) e gera a calib.
- Testes de lógica (poucos, comportamento real): `fairOdds`=1/p, cálculo de `edge`, derivação de `label`, e o grep de airtight money-path.
- `node -c` nos arquivos JS + suite `npm test` (1060) verde.

## Fora de escopo / roadmap

- **Caminho B** (futuro, se user quiser): navegador-solver (Playwright+stealth ou FlareSolverr) + Webshare pra resolver o CF JS-challenge → destrava `/stats` → map winrate + player stats → enriquece o lab.
- **Bug lateral money-path (separado, NÃO neste trabalho):** `lib/cs-ml.js` faz `WHERE game='cs'` mas os dados são `game='cs2'` → o Elo das tips reais de CS pode estar vazio. É money-path → decisão à parte com pre-flight. O lab v1 não toca isso.

## Decisões (resolvidas)

- **`/api/cs-live-matches` (lista HLTV ao vivo):** incluído no v1, como **última task** do plano — separável (se o plano inflar, vira v1.1 sem bloquear o core Elo + IA).
- **Config do Elo cs2** (`kBase`, `halfLifeDays`, etc): default = mesma base do Dota; o backtest ajusta empiricamente só se melhorar o Brier OOS.
