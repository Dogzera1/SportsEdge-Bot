# Tennis ML home/p1 overconfidence — ATP Roland Garros

CAUSE investigation (P2-safe — análise apenas, sem auto-action).

## TL;DR

A causa **dominante** é uma combinação de:

1. **`team1` (emit-time) ≠ `p1` (training-time)** — training rotula `p1` como **menor alfabético** (`scripts/extract-tennis-features.js:244-245`). Em runtime, `team1/team2` vêm do feed (Pinnacle/Sofa) e **não** seguem ordem alfabética; o modelo trained recebe features `diff_1-2` em uma orientação arbitrária mas a saída `modelP1` ainda é mapeada para `match.team1` em `bot.js:20580-20582`. Isso por si só **não causa viés sistemático** (é simétrico), MAS combina com (2) abaixo.

2. **Mismatch de calibração entre eras (Bo5 Slam underrepresented)** — modelo treinado tem `elo × bestOf5` como interaction (`train-tennis-model.js:105-106`), mas o sample de Slams (Bo5, ~4 torneios/ano de 70+ no tour) é minoritário no CSV — provavelmente <8% das 30k+ linhas. A interação **superestima** o edge do favorito em Bo5 porque sample histórico tem `eloBlend` mais extremo nos Slams (top 32 seedeados, draw assimétrico) mas a probabilidade real do favorito é **menor** do que modelos Bo3 transferidos prevêem (regressão à média entre Slam top players já tightens).

3. **Isotonic calibration DEFAULT DISABLED desde 2026-04-28** (`lib/tennis-model.js:23-32`). Comentário explícito: "shift médio +21..+34pp falso, modelo tipa underdogs com edge alto". Disabled = `finalP1` sai cru do trained, **sem correção**. Em Bo5 RG isso é o oposto: modelo **trained** já viesa a favor de favorito por interaction `elo_x_bestof5`, e calib que reduziria isso está OFF.

4. **`_applyClvCalib('tennis')`** (`tennis-model.js:1028`) provavelmente puxa em direção a closing line — para favoritos RG, a closing é tight (-130/-150) → puxa P1 PRA CIMA → reforça overconf home.

5. **Direcionalidade home/p1 = lado do match.team1 do feed**, que para tennis Pinnacle costuma ser o **maior ranqueado / favorito** (Pinnacle ordena por seed/ranking). Sample 120 ML shadow home -R$124 vs 109 away +R$63: assimetria de R$188 em 229 tips confirma **viés direcional de favorito**, não geographic home.

---

## Evidência por hipótese (ranqueada)

### H1 (90% likely): Trained model amplifica favorito em Bo5 Slam via `elo_x_bestof5` interaction + isotonic OFF

**Arquivo:linha**:
- `scripts/train-tennis-model.js:105-108` — feature `bestOf===5 ? eloBlend : 0` (+ `surface==='clay' ? eloBlend : 0`)
- `lib/tennis-model-trained.js:166-168` — runtime monta mesmo tail `bestOf===5 ? eloBlend : 0`
- `lib/tennis-model.js:986` — bestOf é detectado por regex `grand slam|wimbledon|us open|roland|australian` → bestOf=5 em RG
- `lib/tennis-model.js:32` — `TENNIS_ISOTONIC_DISABLED=true` default
- `lib/tennis-model.js:1037-1042` — `tennisSegmentGate` ainda multiplica `confidence` × 1.15 em Grand Slam Bo5

**Mecanismo composto**:
- eloBlend (P1−P2) é grande em R1/R2 RG (seed vs qualifier): ex 1900 vs 1600 = +300
- interaction `elo_x_bestof5 = +300`, peso aprendido positivo → bumpa P1
- `surface_clay × eloBlend = +300` → bumpa de novo (clay favorece favorito em weights, mas RG real é o oposto: clay LONGOS rallies favorecem defensores/underdog vs hardcourt server-dominated)
- confidence × 1.15 segment gate → **mais blend pra modelo** vs implied → menos regulariza
- isotonic OFF → não corrige overshoot residual
- CLV-calib ON → puxa pra implied (closing também favorito) → reforça

**Experimento de validação**:
```
# 1. Backtest isolando RG/AusOpen/USO/Wim
node -e "/* score tips reais com TENNIS_ISOTONIC_DISABLED=false e comparar Brier */"

# 2. Em /admin (se existir) splitar shadow tennis por bestOf:
GET /admin/mt-shadow-by-league?sport=tennis&days=30&key=...
# (provavelmente não filtra bestOf — adicionar `format` ao groupBy seria o feature gap)

# 3. Spot check: contar quantos training rows tem best_of=5
grep -c ",5,clay," data/tennis_features.csv  # se existir
```

### H2 (75% likely): Quali sub-slice tem rank gap brutal não capturado por features small-sample

**Arquivo:linha**:
- `lib/tennis-model.js:20691-20695` — `smallSample = minAll<10 || minSurf<5` exige EV≥10% (não bloqueia, só raise floor)
- Quali draw RG: jogadores rank 100-250 (qualifier) vs rank 50-100 (main-entry). Elo pode estar **stale** em qualifiers — pouco match em main tour.
- Features `rank_diff`, `rank_points_log_ratio` ficam **enormes** (`log(7000/300)≈3.2`) → trained extrapola.

**Sample size memory**: shadow ATP RG quali n=65 -R$40 = **62%** do leak total ATP RG vem da slice quali (R$124 total).

**Experimento**:
- Filtrar shadow ATP RG tips onde `match.league` contém "Qualifying" ou similar → re-rodar ROI sem essas → se ROI flat, H2 confirmado.
- Endpoint sugerido: já tem `_tennisQualifierShadow` (`bot.js:20595`) → essa flag deveria bloquear emit em **real**; verificar se também bloqueia AI/IA shadow ML.

### H3 (60% likely): Surface×Best-Of interaction com sign errado para clay

**Arquivo:linha**:
- `lib/tennis-model.js:103-109` — `CLAY_KEYWORDS` inclui RG explicitamente
- `scripts/train-tennis-model.js:107` — `surface==='clay' ? eloBlend : 0` feature
- Weights v1 trained 2026-04-18 (`tennis-weights.json` metadata): ECE test = 0.026 (look great in aggregate), mas **acc test = 65%** — média global, não tier-stratified.

**Hipótese específica**: weights aprenderam que clay AMPLIFICA elo edge (favorito ganha mais em clay porque ralleys longos fadem o weaker server), mas **Grand Slam Bo5 + clay** é uma combinação onde upset rate é MAIOR (5h matches, fatigue swing). Modelo aplica clay-favorito + bo5-favorito = double up.

**Experimento**:
- Inspecionar `tennis-weights.json` campo `logistic.w` na posição `elo_x_clay` e `elo_x_bestof5` — assinatura confirma direção.
- Backtest histórico: top-N ATP RG matches últimos 5 anos, comparar `trainedP1` vs outcome — calibration plot por seed-gap bin.

### H4 (50% likely): H2H ensemble peso amplifica favorito em Slam

**Arquivo:linha**:
- `lib/tennis-h2h-ensemble.js` (referenciado em `bot.js:19600`)
- `lib/tennis-model.js:620-664` — h2hSubModel com `regStrength=min(1, n/8)` → n=8+ full weight 0.20
- Slams reúnem top players que tem H2H histórico LONGO (8-15 matches), todos em variadas superfícies/formats — H2H regularizado mas direção pode favorecer favorito persistentemente (Djoko vs lower-ranked).

**Experimento**:
- Setar `TENNIS_H2H_WEIGHT=0.05` (se env existir) ou rodar simulação removendo h2h sub-model em RG real-only e medir ROI counterfactual.

### H5 (40% likely): Recency form/fatigue NÃO captura "first clay tournament"

**Arquivo:linha**:
- `lib/tennis-model.js:402-474` — `computeFatigueIndex` só conta dias e matches recentes, **não** distingue surface dos matches recentes
- Jogador que jogou Monte-Carlo/Rome (clay) chega RG aclimatado; jogador que pulou clay swing chega frio. Feature ausente.

**Experimento**:
- Verificar `data/tennis_features.csv` se tem `clay_matches_last_30d` ou `surface_match_count_recent`. Se não, **feature gap** confirmado.

### H6 (30% likely): `match.team1` orientation contaminada quando feed é live vs pre

Tennis tem 2 fontes: Pinnacle (pre) + Sofascore (live). Se uma reverte team1/team2 ordering vs outra, P1 cross-source mistura.

**Experimento**:
- Query: `SELECT pick_side, COUNT(*), AVG(profit) FROM tips WHERE sport='tennis' AND market_type='ML' AND is_shadow=1 AND league LIKE '%Roland%' GROUP BY pick_side, is_live`.

### H7 (20% likely): WTA RG comparison — controle

Se WTA RG shadow não mostra overconf home (memory diz "ATP main n=149 + quali n=122"), e WTA é Bo3 sempre → isola **Bo5 ATP** como variável.

**Experimento**:
```
GET /admin/shadow-readiness?source=shadow&sport=tennis&days=30&groupBy=league&league=Roland
# Splitar por liga ATP vs WTA — se WTA ROI ≥ 0 e ATP ≤ −10%, Bo5 confirmed.
```

---

## Como `home/p1` é decidido (resposta à pergunta-side direta)

1. **Training** (`scripts/extract-tennis-features.js:244-245`):
   ```js
   const [p1, p2] = winner < loser ? [winner, loser] : [loser, winner];
   ```
   **p1 = MENOR alfabético**, deterministic, agnóstico a ranking/favorito.

2. **Runtime emit** (`bot.js:20580-20582`):
   ```js
   const _pickIsT1Tn = norm(tipPlayer).includes(norm(match.team1));
   const _modelPPickTn = _pickIsT1Tn ? mlResultTennis.modelP1 : mlResultTennis.modelP2;
   ```
   `modelP1` é mapeado pra `match.team1`, que **não** é alfabético — é o que o feed Pinnacle/Sofa deu como primeiro. Pinnacle convencionalmente ordena por **seed/ranking** em tennis (favorito primeiro).

3. **Storage**: `pick_side` é gravado como string do nome do tipPlayer (não 't1'/'home' canônico no caso ML tennis). A análise externa que reportou "home/p1 = home/p1 = favorito" provavelmente está agregando por `pick_side==team1_of_match` que = lado do feed.

**Consequência**: O training feature `eloBlend = p1−p2` (alphabetical) tem sinal aleatório porque `winner<loser` não correlaciona com elo. Mas em **runtime** quando passamos `eloOverall1` para a função, estamos passando `elo(team1_do_feed)` que **correlaciona com favorito** (Pinnacle ordena pelo favorito). Isso **viola o invariant de treino** — o modelo aprendeu pesos esperando `p1=alfabético` mas recebe `p1=favorito` em runtime.

Mismatch crítico em `lib/tennis-model-trained.js:103-105`:
```js
const eloBlend = p1Blend - p2Blend;  // runtime p1 = feed team1 = ~favorito
```
vs training `extract-tennis-features.js:261` onde `p1Blend - p2Blend` é signed-alphabetical.

**Esta é provavelmente a CAUSA RAIZ matemática** — explicaria por que ML errra mais quando o gap elo é grande (Bo5 Slam = seedeados claros vs qualifiers), pois weight aprendido em distribuição symmetric-alphabetical sendo aplicada em distribuição one-sided-favorite.

---

## Ranking final (causa primária)

| # | Hipótese | Confiança | Validação custo |
|---|----------|-----------|-----------------|
| **1** | **p1 alphabetical (train) vs p1 feed-order (runtime) mismatch** | **90%** | Quick: dump 50 RG features runtime + training pair p/ samples conhecidos |
| 2 | Isotonic OFF + segment gate ×1.15 não corrigem overshoot Bo5 | 85% | Backtest com `TENNIS_ISOTONIC_DISABLED=false` em shadow histórico |
| 3 | Quali sub-slice (n=65, -R$40) modelo extrapola rank gap | 75% | Split shadow ATP RG por quali flag |
| 4 | clay×eloBlend + bestOf5×eloBlend double-amplify favorito | 60% | Inspect weights JSON `logistic.w` positions |
| 5 | Surface-recent-form ausente como feature | 40% | Verificar CSV headers |

---

## Anti-actions (P2 — não fazer agora)

- ❌ Não bloquear ATP RG, não setar Kelly cap, não disable home/p1 — análise está em fase de causa
- ❌ Não auto-flip isotonic ON sem refit (comentário 2026-04-28 já justifica disable)
- ❌ Não mexer em `match.team1` ordering (mudaria tudo downstream)

## Next steps recomendados (research-only)

1. **Verificar H1 numericamente**: rodar `scripts/test-tennis-trained.js` com inputs idênticos exceto swap `(elo1,elo2)` — se `predictTrainedTennis(A,B).p1 + predictTrainedTennis(B,A).p1 ≠ 1.0` então o modelo não é simétrico e o mismatch alfabético/feed importa.

2. **Refit trained model** restaurando invariant: ou treinar com p1=team1_feed (favorito=p1) consistentemente, OU em runtime randomizar/alfabetizar antes de chamar `predictTrainedTennis` e remap.

3. **Per-format calib (P1 do projeto)**: estender Markov v3 schema (`atp_main.formats.bo5`) que já cobre HG → cobrir ML também. Refit `lib/tennis-model-isotonic.json` v3 com bins split por `bestOf` + `surface`.

4. **WTA comparison query**: confirma se Bo5-ATP é a variável.

5. **Dispatched feature gap audit**: o modelo não tem `clay_matches_last_30d`, `first_event_of_clay_swing`, `seed_in_draw` — features clássicas em tennis pro betting.
