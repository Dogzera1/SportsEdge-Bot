# Match Lab — Análise da IA (LLM explain) — Design

**Data:** 2026-06-01
**Evolui:** `2026-06-01-lol-match-lab-game-profile-design.md` (game-profile)
**Status:** design aprovado em brainstorming (aguardando review do spec)

---

## 1. Objetivo

Adicionar ao painel Match Lab um botão **"Análise da IA"** que gera, sob demanda, uma **leitura de partida em linguagem natural** (PT-BR, seções) escrita pelo Claude Sonnet. A IA **explica os números que o game-profile já computou** — não inventa análise nova.

## 2. Princípio inegociável — a IA explica, não adivinha

Num bot de aposta, um LLM solto escreve prosa confiante e fabricada. Para evitar isso:

- O prompt entrega **apenas os dados reais** já calculados (game-profile + draft + times). A IA **interpreta esses dados**, não gera sinal do zero.
- A IA é instruída a ser **medida** ("draft é sinal fraco; o Elo do time domina") e a **não recomendar stake**.
- A saída exibe rótulo fixo **"leitura da IA — não é sinal de aposta"**.

## 3. Não-objetivos

- **NÃO** alimenta EV/stake/Kelly/emissão de tip. Display-only, igual ao resto do Match Lab.
- **NÃO** roda automático — só quando o usuário clica (controle de custo).
- **NÃO** adiciona dependência npm nem migration. Reusa `aiPost` (`lib/utils.js:802`), `predictMatch`, `computeGameProfile`, `computeDraftWinProb`, o cap-pattern e o `incrApiUsage` do vision.

## 4. Arquitetura

### Arquivos novos
- `lib/lol-match-explain.js` — lógica pura testável:
  - `buildExplainPrompt({ gameProfile, draft, teams, probPct, label })` → string do prompt.
  - `parseExplainResponse(text)` → `{ early, mid, late, winCondition, keyMatchup, verdict }` ou `null` (parse falhou).
- `tests/test-lol-match-explain.js` — testa os dois.

### Arquivos modificados
- `server.js` — novo handler `POST /api/lol-match-explain` (perto do `/api/lol-match-analyze`, ~5334).
- `public/lol-live-dashboard.html` — botão + render da análise em `dlRenderGameProfile` (ou logo após).

### Fluxo
```
UI "Análise da IA" → POST /api/lol-match-explain {team1,team2,side,blue,red,bookOdds,league}
  → predictMatch(db, …)               (mesma orientação do analyze)
  → computeDraftWinProb(draft)         (breakdown: laneMatchups, knownChamps)
  → computeGameProfile(…)              (fases/odds/win-cond/estilo/quality)
  → buildExplainPrompt(…)              (lib)
  → aiPost('anthropic', …, sonnet)     (cap + tracking)
  → parseExplainResponse(text)         (lib)
  → { ok:true, analysis } | { ok:true, analysis:null, raw } | { ok:false, error }
UI renderiza as 6 seções (ou o raw como fallback) + rótulo fixo
```

## 5. Contrato da API

**Request** `POST /api/lol-match-explain` (mesmos campos do analyze):
```jsonc
{ "team1":"T1", "team2":"Gen.G", "side":"blue", "blue":[{champion,role}…], "red":[…],
  "bookOdds":1.55, "league":null }
```

**Response (sucesso):**
```jsonc
{ "ok": true, "analysis": {
    "early": "Vermelho leva levemente a rota — Gnar/Caitlyn ~+gold aos 15.",
    "mid":   "Fase de transição equilibrada; vantagem indefinida.",
    "late":  "Azul cresce: Jinx escala e a comp de teamfight valoriza lutas longas.",
    "winCondition": "Azul quer arrastar e lutar em torno de objetivos; vermelho quer fechar antes.",
    "keyMatchup": "A bot lane decide o late — Jinx vs Aphelios.",
    "verdict": "Lean azul pelo Elo + scaling; só há valor se a odd pagar acima da justa (~1.36)."
} }
```
**Fallback (parse falhou mas houve texto):** `{ "ok": true, "analysis": null, "raw": "<texto do modelo>" }`.
**Erros:** `vision_disabled` (sem `ANTHROPIC_API_KEY`, 503), `daily_cap_reached` (429), `empty_match` (sem times e sem draft, 400), `ai_failed` (500).

## 6. O prompt (`buildExplainPrompt`)

Monta um bloco de dados + instrução. Inclui só o que existe (omite campos null):

```
Dados da partida de LoL (modelo estatístico display-only — NÃO são apostas):
- Times: Azul=<team1|'(não informado)'>, Vermelho=<team2|'(não informado)'>
- P(favorito) ~ <probPct>% (<label>), via Elo do time
- Odd justa: Azul <fairOdds.team1> / Vermelho <fairOdds.team2>[; edge vs odd da casa: <edge%>]
- EARLY (medido): vence <winner> — Δ aos 15min <golddiff15>g, <xpdiff15>xp, <csdiff15>cs
- MID (estimado): <winner>
- LATE (estimado/scaling): <winner>
- Tempo esperado: <bucket> (~<min> min)
- Win condition (computada): <winCondition>
- Estilo de comp: Azul=<blue.style>, Vermelho=<red.style>
- Draft Azul: <role:champion …>  | Draft Vermelho: <…>
- Confrontos de rota (Δ azul, pp): <role +X.Xpp(n) …>   (quando houver)

Você é um analista de LoL. Com base SOMENTE nos dados acima, escreva a leitura em PT-BR.
Responda APENAS um JSON compacto, nada fora dele:
{"early":"…","mid":"…","late":"…","winCondition":"…","keyMatchup":"…","verdict":"…"}
Regras: cada campo 1-2 frases; seja MEDIDO — draft sozinho é sinal fraco, o Elo do time
domina o resultado; NÃO recomende stake nem diga "aposte"; no verdict, comente valor apenas
em relação à odd justa; não invente nada que não esteja nos dados acima.
```

`max_tokens` 700 (seções curtas). `temperature` padrão.

## 7. Parse + fallback (`parseExplainResponse`)

Extrai o primeiro bloco `{…}` do texto (`text.match(/\{[\s\S]*\}/)`), `JSON.parse`. Valida que tem as 6 chaves string. Se ok → retorna o objeto (campos faltantes viram `''`). Se falhar → `null` (endpoint devolve `raw`).

## 8. UI

- Botão **"🤖 Análise da IA"** dentro do bloco game-profile (renderizado por `dlRenderGameProfile` quando há `gameProfile`). Só aparece se a partida já foi analisada.
- Clique → texto "analisando…" + desabilita o botão → `POST /api/lol-match-explain` com os mesmos inputs da última análise (lê os campos atuais de time/draft/odd).
- Sucesso → renderiza as 6 seções rotuladas (EARLY/MID/LATE/WIN/CHAVE/VEREDITO). Fallback `raw` → mostra o texto cru. Erro → mensagem (`daily_cap_reached` → "limite diário de análises atingido").
- Rótulo fixo abaixo: **"leitura da IA — não é sinal de aposta"**.

## 9. Custo & cap

- Cap próprio `AI_ANALYSIS_DAILY_CAP` (default **30**) por `(IP, dia)`, via `global._aiAnalysisDayMap` (mesmo pattern do vision em `server.js:5416`). Reserva o slot **antes** da chamada paga (falhas contam, anti-abuso).
- Custo rastreado: `stmts.incrApiUsage.run('anthropic', month)` (agrega no contador anthropic existente).
- Modelo via `AI_ANALYSIS_MODEL` (default `claude-sonnet-4-5`). `ANTHROPIC_API_KEY` reusada (já setada).

## 10. Edge cases
- **Sem `ANTHROPIC_API_KEY`** → 503 `vision_disabled` (igual ao print-parse). Botão mostra "IA indisponível".
- **Sem times e sem draft** → 400 `empty_match` (nada pra explicar).
- **Cap atingido** → 429, mensagem clara.
- **aiPost falha/timeout/circuit-open** → 500 `ai_failed`, painel intacto.
- **JSON do modelo inválido** → fallback `raw` (mostra o texto, não quebra).
- **Draft parcial** (alguns campeões) → o prompt inclui só os conhecidos; a IA é instruída a não inventar.

## 11. Testes (`tests/test-lol-match-explain.js`)
- `buildExplainPrompt`: inclui prob, odd justa, fases com âncora, win-condition e draft; **omite** linhas de campos null (ex.: sem edge → sem a linha de edge); contém a instrução "APENAS um JSON" e "NÃO recomende stake".
- `parseExplainResponse`: JSON válido (com cerca de prosa em volta) → objeto com as 6 chaves; JSON inválido/sem chaves → `null`; chaves faltando → preenchidas com `''`.
- Endpoint: smoke prod (1 chamada real) + verificação de cap/erro graceful.

## 12. Riscos & mitigação
| Risco | Mitigação |
|---|---|
| IA soa confiante/fabrica sinal | Prompt ancorado nos dados + instrução "medido, não invente" + rótulo "não é sinal" |
| Usuário trata como ordem de aposta | Verdict fala valor só vs odd justa; disclaimer fixo; display-only |
| Custo descontrolado (Sonnet) | Cap diário por IP + sob demanda (não automático) + tracking api_usage |
| JSON malformado do LLM | `parseExplainResponse` com fallback pra `raw` |
| Overfeaturing (P3) | Reusa aiPost/predictMatch/computeGameProfile/cap-pattern; 1 endpoint, 1 lib, sem cron/dep |

## 13. Plano de entrega (alto nível)
1. `lib/lol-match-explain.js` (`buildExplainPrompt` + `parseExplainResponse`) + testes.
2. `POST /api/lol-match-explain` (server.js): orquestra + aiPost + cap + tracking.
3. UI: botão + render das seções + estados (loading/erro/fallback).
4. Smoke prod (1 análise real) + verificação de cap.
