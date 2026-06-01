# Match Lab — Game Profile (leitura de partida) — Design

**Data:** 2026-06-01
**Evolui:** `docs/superpowers/specs/2026-06-01-lol-match-lab-design.md` (Match Lab base)
**Status:** design aprovado em brainstorming (aguardando review do spec)

---

## 1. Objetivo

Enriquecer o painel **Match Lab** do `/edge` com uma camada de **leitura de partida** que ajuda o usuário a decidir aposta. Hoje o painel mostra `P(blue vence)`, breakdown Elo/draft e confrontos de rota. Esta feature acrescenta, **display-only**, quatro blocos pedidos pelo usuário:

1. **Quem domina cada fase** (early / mid / late)
2. **Odd justa + edge** (odd break-even do modelo; edge se o usuário informar a odd da casa)
3. **Como o jogo tende a ser** (tempo esperado, win condition, estilo de comp — teamfight/pick/poke/split)
4. **Confiança & qualidade do dado** (amostra, campeões conhecidos, alertas)

## 2. Princípio inegociável — dado medido vs estimado

Num sistema de aposta, **não se fabrica sinal**. Cada número exibido carrega um rótulo de origem:

- **MEDIDO** (dado duro): só o **early game** — temos `golddiff/xpdiff/csdiff @10 e @15` reais por campeão+rota.
- **ESTIMADO** (tendência): **late/scaling** (via duração de jogo) e **mid** (transição). Exibidos, mas marcados visualmente como estimativa, com confiança própria.
- **QUALITATIVO** (leitura de composição): **estilo teamfight/pick** — derivado de tags de classe da Riot por heurística; **não** validado contra resultado. Marcado como leitura, não predição.

O aviso fixo **"draft é sinal fraco — leitura, não ordem de aposta"** permanece no painel (herdado do Match Lab base: draft-only mal supera coinflip; Elo é o sinal real).

## 3. Não-objetivos (escopo fechado)

- **NÃO** altera `getLolProbability`, `predictMatch`, EV, stake, Kelly ou qualquer money-path. O `prob`/`probBlue` continua **byte-idêntico** ao do Match Lab atual — só acrescentamos leitura ao redor.
- **NÃO** emite tip, **NÃO** calcula stake. O "edge" exibido é informativo, com ressalva de que o modelo não bate a closing line da Pinnacle.
- **NÃO** adiciona cron, env novo, nem dependência npm. **NÃO** adiciona migration (artefatos são JSON commitados, padrão do Draft/Match Lab).

## 4. Fontes de dados

| Fonte | Uso | Cobertura confirmada (01/06) |
|---|---|---|
| `oracleselixir_players` (SQLite, 41.040 linhas, 2026) | timing early (`golddiff/xpdiff/csdiff@10/@15`), scaling (`gamelength`×`result`) | `golddiff@15` em 91,9%; `position` 100%; 136 células champ×role com n≥20; 88 campeões com amostra em jogos curtos+longos; 168 campeões distintos |
| Riot **Data Dragon** `champion.json` (JSON estático público, sem API key) | tags de classe (`Fighter/Tank/Mage/Assassin/Marksman/Support`) → estilo de comp | baixado 1×, commitado como artefato |

## 5. Arquitetura

Segue o padrão do projeto (artefatos pré-computados + lógica em `lib/` + endpoint display-only + render na UI). Nenhuma query pesada no caminho do request — tudo resolvido por lookup em artefato carregado uma vez (lazy-load, como `lol-draft-model`/`lol-match-predict`).

### Arquivos novos

- `scripts/train-lol-champion-timing.js` — agrega `oracleselixir_players` → `lib/lol-champion-timing.json`. Só DB local, sem rede.
- `scripts/fetch-lol-champion-tags.js` — baixa Data Dragon `champion.json` (versão latest via `versions.json`) → `lib/lol-champion-tags.json`. Roda uma vez.
- `lib/lol-champion-timing.json` — artefato (ver §6.1).
- `lib/lol-champion-tags.json` — artefato (ver §6.4).
- `lib/lol-game-profile.js` — lógica `computeGameProfile(...)`. **Display-only** (header explícito, como `lol-match-predict.js`).
- `test/lol-game-profile.test.js` — testes da lógica.

### Arquivos modificados

- `server.js` — endpoint `/api/lol-match-analyze`: ler `bookOdds` opcional do body; chamar `computeGameProfile`; anexar campo `gameProfile` à resposta. (O bloco do endpoint hoje vive em ~`server.js:5334`.)
- `public/lol-live-dashboard.html` — renderizar as seções novas + input "odd da casa"; funções `dlRenderMatchResult` (~linha 2131) ganham os blocos.

### Reuso (anti-duplicação, P3)

- `normalizeChampion`, `normalizeRole` de `lib/lol-champions.js`.
- `sigmoid`/`logit`/shrinkage no estilo de `lib/lol-draft-model.js` (empirical-Bayes já existe lá — extrair helper se for o caso, não copiar).
- `computeGameProfile` recebe os dados já calculados pelo endpoint (probBlue, side, laneMatchups, knownChamps do `predictMatch`/`computeDraftWinProb`) — **não** recomputa o que o draft model já produz.

## 6. Definição de cada métrica (a matemática)

Toda agregação por lado usa os 5 campeões+rotas daquele lado do draft do usuário (médias históricas independentes — os campeões do usuário não jogaram entre si; comparamos perfis típicos).

### 6.1 Artefato de timing — `lib/lol-champion-timing.json`

Gerado por `train-lol-champion-timing.js`:

```jsonc
{
  "meta": { "generatedAt": "...", "rows": 41040, "minCellN": 20 },
  "byChampRole": {
    "aatrox|top": { "golddiff15": 312.4, "xpdiff15": 188.1, "csdiff15": 5.2, "n": 287 },
    ...
  },
  "scaling": {
    "aatrox": { "index": -0.04, "wrShort": 0.53, "wrLong": 0.49, "nShort": 140, "nLong": 96 },
    ...
  },
  "expectedLen": { "aatrox": 1912, ... }   // avg gamelength (s) por campeão
}
```

- **`golddiff15`/`xpdiff15`/`csdiff15`**: média do respectivo `*diffat15` para aquele `champion|position`. É o diferencial vs oponente direto aos 15min — proxy de força do campeão na rota.
- **`scaling.index`**: `wrLong − wrShort`, onde `wrShort` = win-rate em jogos com `gamelength < p33` e `wrLong` = win-rate em jogos com `gamelength > p66` (percentis globais do dataset). **Shrinkage empirical-Bayes** puxa `index` para 0 quando `nShort`/`nLong` são pequenos. Campeões com amostra fraca (80 de 168) ficam perto de neutro — coerente com o rótulo "estimativa".
  - **Limitação documentada:** jogos curtos têm viés de stomp (o vencedor encerra cedo). `index` é um proxy ruidoso, por isso é rotulado estimativa e nunca exibido como número cravado.
- Lookup miss (campeão/rota fora do artefato) → contribuição **neutra** (golddiff 0 / scaling 0) + flag de qualidade.

### 6.2 Perfil por fase

- **early_edge** = `mean(golddiff15_blue) − mean(golddiff15_red)` (com xp/cs como âncora secundária exibida). **measured = true**.
- **late_edge** = `mean(scaling.index_blue) − mean(scaling.index_red)`. **measured = false** (estimativa).
- **mid_edge** = `(early_edge_norm + late_edge_norm) / 2` — transição, **menor confiança**, rotulada.
- Cada fase → `winner ∈ {blue, red, even}` (banda morta perto de 0 = "even"), magnitude normalizada (0–5), e `confidence` derivada da amostra (n dos lookups) + (para late) penalidade fixa de estimativa.
- **Tratamento visual proporcional à confiança** (decisão 01/06): **early** = barra cheia em destaque (medido); **mid** = barra esmaecida (estimativa/transição); **late** = **selo discreto de texto, sem barra** (ex.: "leve vantagem X ~") — o scaling é o número mais ruidoso (viés de stomp), então não recebe o mesmo peso visual das outras fases. O payload (§7) carrega os mesmos campos para as três; a diferença é só de render.
- Âncora exibida no early: o `golddiff15`/`xpdiff15` agregado do lado favorecido (ex.: "+340g, +1.2k xp @15").

### 6.3 Tempo esperado & win condition

- **expectedTime** = `mean(expectedLen)` dos 10 campeões → bucket: `curto` (<29min) / `médio` (29–34min) / `longo` (>34min). Exibe minutos aprox.
- **winCondition**: string gerada por template a partir de `early_edge`, `late_edge`, `expectedTime`. Regras (ordem de precedência):
  - Um lado favorecido em early **e** late → "Lado X favorecido em todas as fases."
  - Blue early + red scaling (ou vice-versa) → "X leva a vantagem na rota; precisa converter antes de Y escalar pro late."
  - Edges pequenos em tudo → "Partida equilibrada; decisão tende a vir de execução, não de draft."

### 6.4 Estilo de comp (teamfight/pick) — `lib/lol-champion-tags.json`

Artefato de Data Dragon: `{ "aatrox": { "tags": ["Fighter"], "info": { "attack": 8, "defense": 4, "magic": 3, "difficulty": 4 } }, ... }`.

Heurística de classificação por comp (contagem de classes dos 5 campeões), rótulo dominante + confiança **baixa** (qualitativo):

| Estilo | Gatilho (aprox.) |
|---|---|
| **pick** | ≥2 Assassin, ou Assassin + alto burst single-target |
| **teamfight** | ≥2 frontline (Tank/Fighter) + ≥1 Mage (AoE) |
| **poke/siege** | ≥2 Mage + Marksman de range |
| **split** | ≥2 Fighter/Juggernaut com perfil de duelo (peso por `info.attack` alto) |
| **balanceado** | nenhum gatilho dominante |

**Limitação documentada:** tags Riot são genéricas (6 classes), não dizem estilo diretamente. O rótulo é **leitura de composição**, exibido como qualitativo, jamais como predição de resultado. Campeão sem tag → ignorado na contagem + reduz confiança do estilo.

### 6.5 Odd justa & edge

- **fairOdds.team1** = `1 / probTeam1`; **fairOdds.team2** = `1 / (1 − probTeam1)` (2dp; `probTeam1` já vem do `predictMatch`, orientado ao lado de team1).
- **edge** (só quando `bookOdds` informado, referente a team1): `probTeam1 × bookOdds − 1`, exibido em %. Acompanha aviso: *"break-even = odd justa; modelo não bate a linha da Pinnacle — leitura, não recomendação."* `edge = null` se `bookOdds` ausente/inválido.

### 6.6 Qualidade

`quality = { knownChamps, totalChamps (=10), avgLaneN, eloConfidence, tier, warnings[] }`. `tier ∈ {alta, média, baixa}` a partir de `knownChamps/10`, `avgLaneN` e `eloConfidence`. `warnings`: ex. "3 campeões sem dado de timing", "amostra de rota baixa", "scaling com pouca amostra".

## 7. Contrato da API

**Request** `POST /api/lol-match-analyze` (campo novo, opcional):
```jsonc
{ "team1": "...", "team2": "...", "side": "blue", "blue": [...], "red": [...], "league": "...",
  "bookOdds": 1.85 }   // novo: odd da casa pro team1 (opcional)
```

**Response** (campo novo `gameProfile`; resto inalterado):
```jsonc
{
  "ok": true, "prob": 0.7345, "probBlue": 0.7345, "components": {...}, "confidence": 1, "label": "forte",
  "gameProfile": {
    "phases": {
      "early": { "winner": "blue", "edge": 0.62, "bars": 4, "measured": true,
                 "anchor": { "golddiff15": 340, "xpdiff15": 1200 }, "confidence": 0.8 },
      "mid":   { "winner": "blue", "edge": 0.30, "bars": 3, "measured": false, "label": "transição", "confidence": 0.4 },
      "late":  { "winner": "red",  "edge": -0.25, "bars": 2, "measured": false, "label": "estimativa", "confidence": 0.45 }
    },
    "expectedTime": { "seconds": 1920, "bucket": "médio" },
    "winCondition": "Blue leva a rota; precisa converter antes do Red escalar pro late.",
    "compStyle": { "blue": { "style": "teamfight", "confidence": 0.5 },
                   "red":  { "style": "pick", "confidence": 0.45 } },
    "fairOdds": { "team1": 1.36, "team2": 3.77 },
    "edge": 0.359,            // null se bookOdds ausente
    "quality": { "knownChamps": 10, "totalChamps": 10, "avgLaneN": 76, "eloConfidence": 1,
                 "tier": "alta", "warnings": [] }
  }
}
```

Se não houver draft (só times): `gameProfile.phases`/`compStyle` = null com mensagem "informe o draft pra ver as fases"; `fairOdds`/`edge`/`quality.elo` seguem válidos.

## 8. Layout da UI (painel Match Lab)

```
┌─ MATCH LAB ─ T1 (azul) vs Gen.G (vermelho) ─────────────┐
│ P(T1 vence): 73,4%        ●●●●●●●○○○  forte             │
│ Odd justa:    T1 1.36   ·   Gen.G 3.77                  │
│ Odd da casa: [____]  →  edge: +35,9%  (se digitar)      │
├─────────────────────────────────────────────────────────┤
│ QUEM DOMINA CADA FASE                                    │
│ EARLY  ▰▰▰▰▱  T1       medido · +340g, +1.2k xp @15     │
│ MID    ▰▰▰▱▱  T1       estimativa                        │
│ LATE   · leve vantagem Gen.G ~  (scaling, sinal fraco)  │
├─────────────────────────────────────────────────────────┤
│ COMO O JOGO TENDE A SER                                  │
│ • Tempo esperado: médio (~32 min)                       │
│ • Estilo: T1 teamfight · Gen.G pick                     │
│ • T1 leva a rota; precisa converter cedo antes do       │
│   Gen.G escalar pro late.                                │
├─────────────────────────────────────────────────────────┤
│ CONFRONTOS DE ROTA (Δ azul)          ← já existe hoje    │
│ top +6.4pp(159)  ·  bot −3.0pp(34)  ·  mid +2.1pp(63) … │
├─────────────────────────────────────────────────────────┤
│ QUALIDADE: 10/10 campeões · amostra boa · Elo confiável │
│ ⚠ draft é sinal fraco — leitura, não ordem de aposta    │
└─────────────────────────────────────────────────────────┘
```

Estilo segue o terminal existente do `/edge` (barras com blocos, cor azul/vermelho por lado). Estimativas usam `~` e tom esmaecido; medido em destaque.

## 9. Edge cases & fallbacks

- **Campeão desconhecido** (fora dos artefatos): timing/scaling neutros, conta em `knownChamps`, gera warning. Não quebra.
- **n baixo** em champ×role: shrinkage puxa pro neutro; `measured` segue true mas `confidence` cai.
- **Só draft, sem times**: fases/estilo OK; win prob via draft-only (já tratado no Match Lab base); sem Elo na qualidade.
- **Só times, sem draft**: fases/estilo = null + dica; odd justa/Elo normais.
- **`bookOdds` inválido** (≤1 ou não-número): `edge = null`, input ignorado silenciosamente.
- **Artefato ausente** (deploy sem o JSON): `gameProfile = null` + log WARN; painel base segue funcionando (degradação graciosa, como o draft model).

## 10. Testes (`test/lol-game-profile.test.js`)

Testar comportamento real, não trivialidade:
- early/mid/late edges e `winner` a partir de fixtures de timing (favorece blue / favorece red / even).
- shrinkage: champ com n baixo → contribuição perto de neutro.
- classificação de estilo: comp teamfight, pick, poke, balanceado.
- `fairOdds` = 1/p e `edge` = p·odd−1 (incl. `bookOdds` ausente → null).
- fallbacks: campeão desconhecido → neutro+warning; sem draft → phases null.

Rodar com o runner atual (`npm test` / suíte existente — 912 testes hoje). Sem mock de Telegram/DB de produção.

## 11. Riscos & mitigação

| Risco | Mitigação |
|---|---|
| Usuário trata leitura como recomendação de aposta | Aviso fixo "draft é sinal fraco" + ressalva no edge + rótulos medido/estimado/qualitativo |
| Scaling enviesado por stomps | Shrinkage + rótulo estimativa + limitação documentada (§6.1) |
| Estilo teamfight/pick impreciso | Confiança baixa explícita + rótulo qualitativo (§6.4) |
| Data Dragon muda formato/versão | Script pina a versão no artefato; runtime só lê JSON commitado |
| Overfeaturing (P3) | Reusa normalize/sigmoid/shrinkage; sem env/cron novo; um endpoint estendido, não paralelo |

## 12. Plano de entrega (alto nível — detalhe no plano de implementação)

1. `scripts/fetch-lol-champion-tags.js` + `lib/lol-champion-tags.json`
2. `scripts/train-lol-champion-timing.js` + `lib/lol-champion-timing.json`
3. `lib/lol-game-profile.js` (lógica + testes)
4. Endpoint `/api/lol-match-analyze` (bookOdds + gameProfile)
5. UI (`lol-live-dashboard.html`): seções + input odd da casa
6. Smoke prod + verificação
