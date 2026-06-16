# Tennis Match Lab (rich) — Design

**Data:** 2026-06-16
**Status:** design aprovado em brainstorming (aguardando review do spec)
**Série:** LoL Draft Lab → LoL Match Lab → Dota Lab → CS Match Lab → **Tennis Lab**
**Análogo a:** `2026-06-01-dota-match-lab-design.md` e `2026-06-08-cs-match-lab-v1-design.md` (mesmo UX/overlay), **adaptado** a tennis.

---

## 1. Objetivo

Painel **"Tennis Lab"** no `/edge` (overlay próprio + botão na topbar, espelhando `#dotaLab`/`#csLab`). Dado **dois jogadores + superfície + Bo3/Bo5**, mostra:

- **P(vence)** calibrada (modelo ML de produção) + breakdown de fatores;
- **toda a superfície de mercados** que o bot precifica via Markov — **handicap de games, total de games, set betting, tiebreak, straight sets, aces, double faults** — com **odd justa + edge vs casa** por mercado;
- **análise da IA** (Sonnet) ancorada nos números.

**Display-only, money-path airtight.** Escopo escolhido pelo user: **tennis-rich completo** (toda a superfície Markov).

---

## 2. Princípio — REUSA o modelo de produção (≠ Dota/CS)

Divergência **consciente** do padrão Dota/CS. Lá, foi construído um Elo **paralelo** porque **não existia** modelo de match para aqueles sports. Tennis **já tem** um modelo completo, calibrado e mantido:

- `getTennisProbability` — ensemble ML (Surface Elo + Serve/Return + Fatigue + H2H + ranking + trained model), com calibração isotônica + CLV + segment gate embutidas.
- Motor Markov (`priceTennisMatch` e estimadores) que precifica os mercados.
- `applyMarkovCalib` — calibração **tier×format×side-aware** (schema v3) de `handicapGames`/`totalGames`, refit nightly contra outcomes reais.

Construir um modelo paralelo seria **violação de P3** (overfeaturing — já existem 148 libs). Então o lab **reusa as funções read-only de produção** e mostra exatamente o que o bot pensa.

**Airtightness por construção:** o lab só chama funções **read-only/puras**; o endpoint **nunca** toca `stake`/`EV-gate`/`Kelly`/`bankroll`/`tips`/`scanTennisMarkets`. Fair odd = `1/p` e edge = `p×oddCasa − 1` são aritmética **inline** (display), **não** o `scanTennisMarkets` (motor de EV = money-path). **Sem backtest novo** — o modelo já é validado/calibrado e o refit é mantido por crons existentes.

---

## 3. Não-objetivos

- **NÃO** alimenta EV/stake/Kelly/emissão de tip de tennis. Display-only.
- **NÃO** chama `scanTennisMarkets` (motor de EV gated). Odd justa/edge são aritmética inline.
- **NÃO** replica o blend 40/60 Markov↔ML que o `bot.js` faz inline (~8715–8900) — copiar isso acoplaria lógica money-path ao lab (risco de drift P5). O headline é "visão do modelo", não "prob exata da aposta" (explícito no disclaimer).
- **NÃO** cria backtest, migration, cron novo, nem dep npm.

---

## 4. Fontes & funções (todas existentes, read-only)

| Função (lib) | Uso no lab | Retorno relevante |
|---|---|---|
| `getTennisProbability(db, match, odds, enrich, surfaceOverride)` (`tennis-model`) | **Headline** P(vence) + fatores | `{ modelP1, modelP2, confidence, method, surface, tier, factors[], _elo, _serve, _fatigue, _h2h, _trained }` |
| `detectSurface(league)` / `tournamentTier(league)` (`tennis-model`) | auto superfície/tier do torneio | string |
| `getPlayerServeProfile(db, name, {surface})` (`tennis-player-stats`) | serve stats p/ `extractServeProbs` + enrich | `firstServePct`, `firstServePointsPct`, `secondServePointsPct`… |
| `getPlayerReturnPointsWon(db, name)` (`tennis-player-stats`) | `rpw1/rpw2` p/ KM full | rpw |
| `getPlayerRankInfo(db, name)` (`tennis-player-stats`) | enrich ranking + display | `{ latestRank, bestRank, recentRanks }` |
| `getPlayerAceRate(db, name)` (`tennis-player-stats`) | aces | `{ acePerMatchAvg, acePerSvptPct, matches }` |
| `getPlayerDfRate(db, name)` (`tennis-player-stats`) | double faults | `{ dfPerMatchAvg, dfPerSvptPct, matches }` |
| `extractServeProbs(ss1, ss2, {surface, rpw1, rpw2})` (`tennis-markov-model`) | serve probs (Klaassen-Magnus) | `{ p1Serve, p2Serve, method }` |
| `solvePointProbs(pMatchTarget, pServeAvg, bestOf)` (`tennis-markov-model`) | **fallback** serve probs back-solved do headline | `{ p1Serve, p2Serve }` |
| `priceTennisMatch({ p1Serve, p2Serve, bestOf, iters })` (`tennis-markov-model`) | **mercados** (uma passada) | `{ pMatch, setDist, totalGamesAvg, totalGamesPdf, gamesMarginPdf, pTiebreakMatch, pTiebreakFirstSet, pStraightSets, totalSetsAvg }` |
| `handicapGamesProb(gamesMarginPdf, line)` (`tennis-markov-model`) | handicap de games por linha | prob |
| `estimateTennisAces({ acesPerMatch1, acesPerMatch2, bestOf, surface })` (`tennis-markov-model`) | aces over | `{ totalAcesAvg, pOver:{line:p} }` |
| `estimateTennisDoubleFaults({ dfPerMatch1, dfPerMatch2, bestOf, surface })` (`tennis-markov-model`) | DF over | `{ totalDfAvg, pOver:{line:p} }` |
| `applyMarkovCalib(pRaw, market, { tier, format, side })` (`tennis-markov-calib`) | calib **só** `'handicapGames'`/`'totalGames'` | prob calibrada |
| `getEloMap(db)` (`tennis-ml`) | autocomplete de jogadores | Map nome→ratings (de `match_results game='tennis'`) |
| `aiPost` + cap `AI_ANALYSIS_DAILY_CAP` (AI-explain LoL/Dota) | IA explica | texto |

---

## 5. Pipeline de dados (uma passada)

```
inputs: player1, player2, surface, bestOf, league?(torneio), bookOdds?
 │
 ├─▶ HEADLINE  getTennisProbability(db, {team1,team2,league,time:now}, odds=null, enrich, surface)
 │      ⚠ odds NÃO passada de propósito → impliedP1=0.5 (prior neutro). Passar a odd da casa
 │        ancoraria o modelo ao book e tornaria o "edge ML" circular. Headline = visão
 │        market-independent; edge ML = modelP1 × oddCasaML − 1 (inline, se o user der a odd).
 │      enrich = { ranking1/2 (getPlayerRankInfo→{rank…}), serveStats1/2 (getPlayerServeProfile) }
 │        (mapeamento de campos getPlayerServeProfile→serveSubModel/extractServeProbs e
 │         getPlayerRankInfo.latestRank→ranking.rank verificado no plano)
 │      → modelP1 (ML calibrado) + factors[Surface Elo, Serve/Return, Fatigue, H2H]
 │
 ├─▶ SERVE PROBS
 │      primário:  extractServeProbs(serveProfile1, serveProfile2, {surface, rpw1, rpw2})
 │      fallback (perfil ralo/null): solvePointProbs(modelP1, spwAvgSurface, bestOf)  ← ancora ao headline
 │
 ├─▶ MARKOV  priceTennisMatch({ p1Serve, p2Serve, bestOf, iters })
 │      → pMatch(saque), setDist, totalGamesPdf, gamesMarginPdf, pTiebreak*, pStraightSets…
 │      • handicapGames[]:  por linha → handicapGamesProb(gamesMarginPdf, L) → applyMarkovCalib(p,'handicapGames',{tier,format,side})
 │      • totalGames[]:     por linha → pOver(L) do totalGamesPdf      → applyMarkovCalib(p,'totalGames',{tier,format,side})
 │      • setBetting:       setDist (cru — sem calib específica; rotulado)
 │      • tiebreak / straightSets: pTiebreakMatch/pTiebreakFirstSet/pStraightSets (cru; rotulado)
 │
 ├─▶ ACES   getPlayerAceRate(p1/p2) → estimateTennisAces({acesPerMatch1/2: acePerMatchAvg, bestOf, surface}) (cru)
 ├─▶ DFs    getPlayerDfRate(p1/p2)  → estimateTennisDoubleFaults({dfPerMatch1/2: dfPerMatchAvg, bestOf, surface}) (cru)
 │
 └─▶ por mercado/linha: fairOdd = 1/p ; edge = p × oddCasa − 1  (inline, se bookOdds fornecida)
```

**opts da calib (derivados):** `tier = tournamentTier(league)`; `format = bestOf===5 ? 'bo5' : 'bo3'`; `side` = lado da linha (`team1`/`team2` p/ handicap, `over`/`under` p/ total). Strings exatas confirmadas no plano contra `tennis-markov-calib`.

---

## 6. Headline + divergência (decisão do user: ML primary + Markov cross-check)

- **P(vence) primária** = `getTennisProbability.modelP1` — ML ensemble calibrado, com breakdown de fatores (número auditável e explicável). Chamado **sem** a odd da casa (prior neutro 0.5) → visão **market-independent**, pra o edge vs book não ser circular (ver §5).
- **P(vence) por saque (Markov `pMatch`)** = exibida ao lado como **conferência**.
- Se `|modelP1 − pMatchSaque| > 0.05` → **flag** na UI: "modelo de ranking/Elo diverge do modelo de saque (favorece o sacador maior/menor)".
- **NÃO** se replica o blend 40/60 do bot (ver §3).
- `confidence` (com SHARP_CAP e divergence penalty já aplicados dentro de `getTennisProbability`) vira o **selo de qualidade** + `label` ∈ `'forte' | 'lean' | 'lean fraco'` (de `|modelP1−0.5|` + confidence + dados disponíveis).

---

## 7. Mercados exibidos (rich completo)

| Mercado | Fonte | Calibrado? | Linhas |
|---|---|---|---|
| **Moneyline (ML)** | `getTennisProbability.modelP1/P2` | sim (isotônica/CLV no modelo) | — |
| **Handicap de games** | `handicapGamesProb(gamesMarginPdf, L)` | **sim** (`applyMarkovCalib 'handicapGames'`) | ±1.5, ±2.5, ±3.5, ±4.5, ±5.5 |
| **Total de games** | `pOver(L)` do `totalGamesPdf` | **sim** (`applyMarkovCalib 'totalGames'`) | derivadas do PDF (ex.: 20.5–24.5) |
| **Set betting** | `setDist` | não (cru, rotulado) | 2-0/2-1/… (Bo3) ou 3-0/3-1/3-2/… (Bo5) |
| **Tiebreak** | `pTiebreakMatch`, `pTiebreakFirstSet` | não (cru) | sim/não |
| **Straight sets** | `pStraightSets` | não (cru) | sim/não |
| **Aces** | `estimateTennisAces.pOver` | não (Poisson) | 8.5–22.5 |
| **Double faults** | `estimateTennisDoubleFaults.pOver` | não (Poisson) | 3.5–10.5 |

Cada linha mostra: **prob do modelo**, **odd justa (1/p)**, e — se o user digitar a odd da casa — **edge** (calculado client-side ao vivo). Mercados crus levam selo "não calibrado especificamente — estimativa Markov/Poisson".

---

## 8. Arquitetura (arquivos)

**Novos:**
- `lib/tennis-match-lab.js` — orquestrador puro/read-only:
  - `analyzeTennisMatch(db, { player1, player2, surface, bestOf, league, bookOdds, iters })` →
    ```jsonc
    { ok, headline:{ probP1, probP2, label, confidence, method, surface, tier, bestOf,
                     markovProbP1, divergence, divergenceFlag },
      factors:[ {name,p1,p2,weight,detail,found1,found2} ],   // de getTennisProbability.factors
      serve:{ p1Serve, p2Serve, method, source:'profiles'|'solved' },
      markets:{ ml:{...}, handicapGames:[...], totalGames:[...], setBetting:{...},
                tiebreak:{...}, straightSets:{...}, aces:[...], doubleFaults:[...] },
      quality:{ eloFound1, eloFound2, hasServe1, hasServe2, hasAce1, hasAce2, hasRank1, hasRank2, notes:[] } }
    ```
  - `module.exports = { analyzeTennisMatch }`.
- `lib/tennis-match-explain.js` — `buildTennisExplainPrompt({ pred, players, surface, bestOf })` + `parseTennisExplain(text)`. `module.exports = { buildTennisExplainPrompt, parseTennisExplain }`.
- `tests/test-tennis-match-lab.js`, `tests/test-tennis-match-explain.js`.

**Modificados:**
- `server.js` — handlers novos perto dos `/api/dota-*`/`/api/cs-*`:
  - `GET /api/tennis-players` → `{ ok, players:[...] }` (keys de `getEloMap(db)`).
  - `POST /api/tennis-match-analyze` body `{ player1, player2, surface, bestOf, league?, bookOdds? }` → `analyzeTennisMatch(...)`.
  - `POST /api/tennis-match-explain` body `{ ...pred, players, surface, bestOf }` → `buildTennisExplainPrompt` → `aiPost(Sonnet)` → `parseTennisExplain`. Cap compartilhado.
  - *(separável, última task)* `GET /api/tennis-upcoming` → lista jogos próximos (ESPN `tennis-data.getScoreboard` ou feed Pinnacle existente) normalizada `{ player1, player2, tournament, surface, bestOf, startTime }` p/ prefill.
- `public/lol-live-dashboard.html` — overlay `#tennisLab` + botão `🎾 Tennis Lab` (molde `#dotaLab`/`#csLab`). Render: headline + divergência, fatores, tabela de mercados (com célula editável de odd da casa → edge ao vivo), selo de qualidade, seção IA, disclaimer fixo.

**Reuso:** ver tabela §4. **Sem dep npm, sem migration, sem cron.**

---

## 9. IA explica (`tennis-match-explain.js`)

Prompt entrega os dados reais (P do modelo + fatores Elo/serve/fatigue/H2H, ranking, odds justas/edges por mercado, superfície, Bo) e pede JSON:
`{"overview","matchupRead","marketsRead","verdict"}` (4 seções).

**Honesty contract:** a IA **não inventa nem altera** as probs/edges (vêm do modelo); pode usar conhecimento próprio de tennis (estilo de jogo, ajuste por superfície, H2H qualitativo) pra a leitura — **rotulado como conhecimento geral**; **não recomenda stake**; PT-BR; responde **APENAS** o JSON. Parser com fallback `raw` se as chaves não casarem.

---

## 10. Inputs, autocomplete & prefill

- player1, player2: datalist via `GET /api/tennis-players`.
- superfície (clay/grass/hard/indoor) + Bo (3/5): manual; se torneio digitado → auto (`detectSurface` + Grand-Slam → Bo5 via regex já usada no modelo).
- bookOdds: **opcional por linha** — odd justa sempre visível; edge calculado client-side conforme o user digita a odd da casa.
- **Prefill (decisão do user: incluído, última task separável):** `/api/tennis-upcoming` → clicar num jogo preenche players+superfície+Bo. Se o plano inflar, vira v1.1 sem travar o core.

---

## 11. Degradação graciosa / edge cases

- Jogador fora do Elo (`found1/2=false`) → `confidence` baixa, `label='lean fraco'` + aviso "jogador com pouco/zero histórico". Sem 500.
- Sem perfil de saque → serve probs **back-solved** do headline (`solvePointProbs`) → games/totals/sets consistentes com o headline; `serve.source='solved'`.
- Sem ace/DF rate → seções aces/DFs mostram "dados insuficientes" (não quebram o resto).
- Sem ranking → trained model roda com rank undefined (já tolerado por `predictTrainedTennis`); fatores Elo/fadiga/H2H seguem do DB.
- IA sem key/cap/erro → "IA indisponível", resto do painel funciona.
- `iters` do Markov tunável (default ~15k; on-demand, não hot-path; ~dezenas de ms).

---

## 12. Money-path airtight (invariante + verificação)

- Grep nos arquivos **novos** por `scanTennisMarkets|kelly|stake|bankroll|recordMarketTip|emitTip|minEv|EV_CAP|is_shadow|INSERT INTO tips` → **0**.
- `getTennisProbability`/`priceTennisMatch`/estimadores/`applyMarkovCalib` são read-only (sem side-effects, sem escrita em `tips`) — reusá-los p/ display não afeta tips reais.
- Endpoints retornam **só** prob/odd-justa/edge/texto. `edge` é aritmética inline, **não** o scanner gated.
- Suite existente continua verde (puramente aditivo). `node -c` nos arquivos novos.

---

## 13. Testes (lógica real, poucos)

- **`tennis-match-lab`** (DB real readonly, como `test-lol-match-predict`):
  - `probP1 ∈ [0,1]`; sem-jogadores → `label='lean fraco'`;
  - `serve.source='solved'` quando perfil ausente (mock player sem stats);
  - mercados presentes com `fairOdd = 1/p` (EPSILON);
  - calib aplicada só em handicapGames/totalGames (markets crus ≠ calibrados);
  - edge = `p×odd−1` quando bookOdds dada.
- **`tennis-match-explain`**: prompt inclui P+fatores+mercados+"não recomende stake"/"APENAS JSON"; parse das 4 chaves + fallback.
- Grep airtight money-path (§12) como asserção.

---

## 14. P3/P4/P5 notes

- **P3:** reusa todo o stack tennis existente; zero modelo paralelo, zero cron/dep/migration. (Contraste explícito com Dota/CS, justificado em §2.)
- **P4:** ao tocar `server.js`, conferir se há helper de listagem de jogadores reaproveitável (Dota/CS têm `/api/*-teams` — padrão a seguir, não duplicar lógica de datalist no front).
- **P5:** o lab não introduz lógica cross-sport nova; usa libs tennis-only. Nada a propagar.

---

## 15. Plano de entrega (alto nível → vira plano detalhado)

1. `lib/tennis-match-lab.js` (orquestrador `analyzeTennisMatch`) + testes — **núcleo primeiro**.
2. `lib/tennis-match-explain.js` + testes.
3. Endpoints `GET /api/tennis-players`, `POST /api/tennis-match-analyze`, `POST /api/tennis-match-explain`.
4. UI overlay `#tennisLab` + botão + tabela de mercados + seção IA.
5. *(separável)* `GET /api/tennis-upcoming` + prefill na UI.
6. Smoke prod (`/edge`): confronto ATP real (ex.: Sinner vs Alcaraz, clay, Bo3) → headline + mercados + divergência + IA (4 seções).
