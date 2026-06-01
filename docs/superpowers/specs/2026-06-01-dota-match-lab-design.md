# Dota Match Lab (leve) — Design

**Data:** 2026-06-01
**Análogo a:** `2026-06-01-lol-match-lab-design.md` (LoL Match Lab) — versão enxuta pra Dota.
**Status:** design aprovado em brainstorming (aguardando review do spec)

---

## 1. Objetivo

Um painel **"Dota Lab"** separado no `/edge` que prevê **P(time vence)** pré-jogo e dá uma leitura da partida — **display-only**, escopo leve: preditor por **Elo** (calibrado), **força de draft** (leitura) e **Análise da IA** (Sonnet). Sem perfil de fase medido (dado não existe pra Dota).

## 2. Princípio — Elo validado, draft como leitura

- O **prob** vem do **Elo** (calibrado e validado por backtest em `match_results` dota2). É o sinal forte e auditável.
- O **draft** entra como **leitura separada** (força de draft blue vs red via winrate dos heróis), **NÃO** embutido no prob. Motivo: `match_results` de Dota não tem o draft histórico (heróis por jogo), então não dá pra validar um ajuste de draft num backtest — embuti-lo seria fabricar confiança. (Embutir = v2, exigiria ingerir draft histórico.)
- A IA explica Elo + draft + heróis, instruída a ser medida e a não recomendar stake.

## 3. Não-objetivos

- **NÃO** alimenta EV/stake/Kelly/emissão de tip de Dota. Display-only.
- **NÃO** faz perfil de fase (early/mid/late) — sem timing por herói no banco.
- **NÃO** usa matchup/synergy individual de heróis — `stratz_hero_matchups` está vazia (n=0); só a **força agregada** de draft (winrate).
- **NÃO** adiciona dep npm nem migration. Reusa `createEloSystem`, `dota-hero-features`, `aiPost` + cap, o padrão do Match Lab/AI-explain.

## 4. Fontes de dados (confirmadas)

| Fonte | Uso | Estado (01/06) |
|---|---|---|
| `match_results` game='dota2' | Elo (bootstrap + replay) | **42.530 jogos / 2.328 times**; `createEloSystem` testado (getP OK) |
| `dota_hero_stats` | força de draft (`pro_winrate`/`pickban`) | **127 heróis** populados |
| `lib/dota-hero-features.js` | `getTeamDraftStrength` / `getDraftMatchupFactor` | já existe e funciona |

## 5. Arquitetura

### Arquivos novos
- `scripts/backtest-dota-match.js` — replay point-in-time do Elo em `match_results` dota2 (game-level), mede **Brier/ECE vs base-rate**, fita isotônica **se** o Elo cru estiver mal calibrado (senão calib = identidade). Escreve `lib/dota-match-meta.json` (Elo config + métricas do backtest) e `lib/dota-match-calib.json` (blocos isotônicos ou vazio).
- `lib/dota-match-predict.js` — `predictMatch(db, { team1, team2, side, draft })` → P(team1) via Elo + calib; anexa a leitura de draft. Display-only.
- `lib/dota-match-explain.js` — `buildDotaExplainPrompt` + `parseExplainResponse` (reusa o parser de `lol-match-explain` se idêntico; senão próprio).
- `tests/test-dota-match-predict.js`, `tests/test-dota-match-explain.js`.

### Arquivos modificados
- `server.js` — `POST /api/dota-match-analyze`, `GET /api/dota-heroes`, `GET /api/dota-teams`, `POST /api/dota-match-explain` (perto dos handlers LoL ~5334).
- `public/lol-live-dashboard.html` — painel "Dota Lab" (overlay próprio, botão na topbar) + render.

### Reuso
`createEloSystem` (`lib/elo-rating`), `getDraftMatchupFactor`/`getTeamDraftStrength` (`lib/dota-hero-features`), `aiPost` + cap `AI_ANALYSIS_DAILY_CAP` (do AI-explain LoL), `_applyIsotonicBlocks` (`lib/brier-holdout-eval`, usado pelo LoL), o helper `el()` e o estilo do Match Lab.

## 6. O preditor (`predictMatch`)

```
P(blue) = calib( elo.getP(blueTeam, redTeam).pA )      # Elo calibrado
P(team1) = side==='blue' ? P(blue) : 1 - P(blue)
```
- **Elo:** `createEloSystem(meta.eloConfig)` com `halfLifeDays:0` (all-history, igual ao display Elo do LoL — evita o decay que quebra o replay point-in-time). Bootstrap de dota2.
- **Calib:** `_applyIsotonicBlocks(CALIB.blocks, pBlue)` se `CALIB.blocks` não-vazio; senão identidade.
- **Draft (leitura, fora do prob):** se `draft` (5+5 heróis) → `getDraftMatchupFactor(db, draft.blue, draft.red)` → `components.draft = { blueWR, redWR, factor, highPriorityBlue, highPriorityRed }`.
- **Confidence/label:** da confiança do Elo (`e.confidence`); `label` = 'forte' se conf>0.6 senão 'lean'; sem times → 'lean fraco', prob 0.5.

Retorno:
```jsonc
{ "prob":0.59, "probBlue":0.59,
  "components": { "elo": {"pBlue":0.59,"confidence":1,"ratingBlue":1535,"ratingRed":1470},
                  "draft": {"blueWR":0.53,"redWR":0.51,"factor":1.3,"highPriorityBlue":2,"highPriorityRed":1} | null },
  "confidence":1, "label":"lean" }
```

## 7. Backtest & calibração (`backtest-dota-match.js`)

- Itera `match_results` dota2 em ordem cronológica; pra cada jogo: pega Elo as-of (antes de processar), computa `pBlue`, registra outcome, processa o jogo no Elo.
- Métricas: Brier do Elo vs Brier do base-rate (blue win-rate global); ECE (10 bins).
- **Decisão data-driven:** se ECE ≤ 0.03 e Brier < base-rate → calib = identidade (Elo cru já honesto). Senão → fita isotônica (PAV) e revalida.
- Escreve `meta` (eloConfig + Brier/ECE/baseRate/n) e `calib` (blocks). **Se o Elo não bater o base-rate, o número fica no meta e eu reporto ao user — não exibimos um modelo que não supera o coinflip sem aviso.**

## 8. Contrato da API

- `GET /api/dota-teams` → `{ ok, teams:[...] }` (distinct de `match_results` dota2).
- `GET /api/dota-heroes` → `{ ok, heroes:[...] }` (`localized_name` de `dota_hero_stats`).
- `POST /api/dota-match-analyze` body `{ team1, team2, side, blue:[heroName…], red:[…], bookOdds }` → `{ ok, ...predictMatch, fairOdds:{team1,team2}, edge }` (odd justa = 1/prob; edge = prob×bookOdds−1 se bookOdds).
- `POST /api/dota-match-explain` body idem → Sonnet, 6 seções adaptadas (ver §10). Cap compartilhado.

## 9. UI (painel Dota Lab)

Overlay próprio (botão `⚗ Dota Lab` na topbar do `/edge`), estilo do Match Lab:
- 2 inputs de time (datalist `/api/dota-teams`) + lado.
- 5 inputs de herói por lado (datalist `/api/dota-heroes`, sem roles).
- input odd da casa.
- Botão "Analisar" → mostra **P(vitória)** + barra + **odd justa/edge** + **força de draft** (`blueWR x redWR`, heróis high-priority) + selo de qualidade (heróis conhecidos, conf Elo).
- Botão **"🤖 Análise da IA"** → seções.
- Disclaimer fixo: "display-only — não é sinal de aposta; draft é leitura agregada".

## 10. Análise da IA (`dota-match-explain.js`)

Prompt entrega os dados reais: P(blue) do Elo + ratings, odd justa/edge, força de draft (blueWR/redWR/high-priority), heróis dos dois lados. Pede JSON com seções adaptadas a Dota:
`{"overview","draftRead","keyHeroes","verdict"}` (4 seções — sem early/mid/late nem tempo de jogo, que não temos no banco). Mesmas regras: PT-BR, medido (Elo domina, draft é leitura agregada), **não recomende stake**, não invente. Parse com fallback `raw` (reusa `parseExplainResponse` se a forma casar; senão valida as 4 chaves).

## 11. Edge cases
- Sem times → prob 0.5, label 'lean fraco' (sem Elo).
- Time fora do Elo (`foundA/foundB` false) → confidence 0, aviso "time sem histórico".
- Draft incompleto (<3 heróis conhecidos por lado) → `getTeamDraftStrength` retorna null → `components.draft=null`, painel mostra "draft insuficiente".
- Herói desconhecido → contribui neutro (0.5) na força (já tratado em `dota-hero-features`).
- IA sem key / cap / erro → mensagens (igual ao AI-explain LoL).

## 12. Testes
- `dota-match-predict`: prob∈[0,1] pra times conhecidos; orientação side flip; sem-times→0.5/'lean fraco'; draft presente→`components.draft` populado, ausente→null. (Usa o DB real readonly, como `test-lol-match-predict`.)
- `dota-match-explain`: prompt inclui Elo+ratings+draft+heróis e a instrução "não recomende stake"/"APENAS um JSON"; parse das 4 chaves + fallback.
- backtest: rodar 1x, conferir `meta` (Brier/ECE/baseRate) — gate de honestidade antes de exibir.

## 13. Riscos & mitigação
| Risco | Mitigação |
|---|---|
| Elo mal calibrado exibido como verdade | Backtest mede Brier/ECE; calib isotônica se preciso; reporto se não bate base-rate |
| Usuário acha que o draft entra no prob | Draft é seção "leitura", separada do número; disclaimer |
| `dota_hero_stats` desatualizado | `getTeamDraftStrength` já usa neutro 0.5 pra heróis sem pickban credível |
| Custo IA | Cap compartilhado `AI_ANALYSIS_DAILY_CAP`, sob demanda |
| Overfeaturing (P3) | Reusa Elo/draft-features/aiPost/isotonic; painel próprio, sem cron/dep |

## 14. Plano de entrega (alto nível)
1. `scripts/backtest-dota-match.js` + artefatos (`dota-match-meta/calib.json`) — **gate de honestidade primeiro**.
2. `lib/dota-match-predict.js` + testes.
3. `lib/dota-match-explain.js` + testes.
4. Endpoints (`dota-match-analyze`, `dota-teams`, `dota-heroes`, `dota-match-explain`).
5. UI (painel Dota Lab + Análise da IA).
6. Smoke prod.
