# P1 Granularidade — Audit profundo 2026-05-25

**Escopo:** Auditoria do princípio P1 (toda análise/correção considera granularidade sport/tier/league/market/side/bucket/confidence/regime/Bo3vsBo5). File:line evidence.

**Universos cobertos:** tier classifiers, hot-path decisions, hierarchy envs, schema v2 calib, sample fallback, endpoints admin, MT leak guards, EV calibration data-driven, anti-patterns, Bo3 vs Bo5 separation.

---

## SUMÁRIO EXECUTIVO (top 5)

1. **[P1] LoL/CS/Dota2/Valorant MT calib (`lib/lol-mt-calib.json`) é tier-agnostic** — só tem `markets.X.bins` + `markets.X.sides[side].bins` (file head ~line 74 mostra só `sides`, **zero `tiers`**). Tennis Markov calib em contraste tem `markets.X.tiers[tier].bins` (line 109, 376) com `wta_main/atp_main/atp_challenger`. CS/Dota2/Valorant `<sport>-mt-calib.json` files **nem existem em disco** (memory anota commit 038f0db criou `lib/cs-mt-calib.json` mas arquivo not found). LoL tier1 ROI +25.4% shadow vs tier3 -55% (audit 2026-05-11) = exatamente o leak que calib tier-aware resolveria — calib monolítica subajusta tier1 EDGE e superestima tier3. `lib/sport-mt-calib.js:18-22` declara suportar v2 schema cross-sport mas só tennis tem schema v2.

2. **[P1] EV calibration data-driven não tem dimensão `confidence` (ALTA/MEDIA/BAIXA)** — `lib/ev-calibration.js` cache layers são `bySportMarketTierBucket/bySportMarketBucket/bySportBucket/byBucketGlobal` (line 32-39, 183-200). Granularidade vai até tier × bucket, mas **NÃO considera conf**. Tier `lol|TOTAL|tier2|EV5-8` vai produzir mesmo mult pra ALTA e BAIXA, contradizendo P1 dimensão 7 ("Confidence ALTA/MEDIA/BAIXA — tratamento por tier de confidence") e os defaults Kelly `ALTA=0.25 / MEDIA=1/6 / BAIXA=0.10` (`bot.js:6160`). Endpoint `/admin/tips-by-confidence` (`server.js:16051-16054`) expõe breakdown por conf mas decisão (`stake *= ev_mult`) ignora.

3. **[P1] 5 tier classifiers paralelos ainda coexistem** (CLAUDE.md status diz "✅ Tier classifier unificado commit 7f9dcc9" — não 100% verdade):
   - **#1 Canonical numeric:** `lib/league-tier.js getLeagueTier()` (1/2/3) — 126 linhas, cobre 5 sports (lol/cs/dota/val/tennis/football/basket/mma); **MMA `_mmaTier` é minimalista** (line 94-99, 3 regex, sem ONE/PFL ranking awareness); **basket/snooker/darts/tabletennis não cobertos** caem em `return 3` default.
   - **#2 ML feature parallel:** `lib/esports-runtime-features.js leagueTier()` (line 115) — **convenção invertida (3=top, 1=other)** — comentário linha 109-113 reconhece que delibera-se manter divergente "preserva feature parity com modelo treinado". Ainda exporta numeric 3=top.
   - **#3 String classifier:** `lib/tier-classifier.js classifyTierString()` — retorna `'atp_main'/'tier1'/'top5_uefa'` strings; consultado por `/admin/shadow-tier-divergence`. **Basket/mma/darts/snooker/tabletennis retornam null** (line 24 dochrum) → endpoint `unclassified` fallback.
   - **#4 MT-tier paralelo:** `lib/mt-tier-classifier.js classifyTier()` (line 75) — string format diferente (`'tier1_la_liga'/'tier4_lower'`) com `TIER_DEFAULT_MULT` (`bot.js:7373` ref). Pattern divergente de #3.
   - **#5 bot.js wrapper:** `bot.js:383-388 _leagueTier()` — delegate OK pra #1 com fallback 2.
   - **Bug pendente:** #2 inversão semântica é tech debt explícito documentado em CLAUDE.md.

4. **[P0] `mt_market_league_blocklist` e `mt_permanent_disable_list` não têm coluna `tier`** — `mig 077` (line 1890) define `(sport, market, league_norm)` PK; `mig 108` (line 2857) define `(sport, market, side)` PK; `mig 091` (line 2256) só adicionou `tier` em `market_tips_runtime_state` (auto-disable transitório). Permanent disable list seed em mig 108 mostra `('lol','total','','audit prod 2026-04-30 — ROI -54% n=10')` — **bloqueia LoL TOTAL across all tiers** mesmo que tier1 LoL TOTAL tenha edge. Anti-pattern explícito de CLAUDE.md ("LoL UNDER 2.5 ruim → desativar UNDER 2.5 todo").

5. **[P1] Bo3 vs Bo5 ausente no schema calib + ausente do tier classifier tennis** — `lib/lol-markets.js:46-99` tem matemática Bo3/Bo5 correta (binomial first-to-N closed form), `lib/tennis-markov-model.js:582,533` tem `boMult = bestOf===5 ? 1.4 : 1.0` (override fixed pra aces/DF), MAS:
   - **Calib JSON não particiona por Bo** — `lib/tennis-markov-calib.json` tier keys são `wta_main/atp_main/atp_challenger` sem `_bo3/_bo5` split. Grand Slam Bo5 (men's) vs WTA Bo3 são treinadas juntas em `atp_main`/`wta_main`.
   - **`esports-segment-gate` tem Bo3/Bo5 nas policies (`tier1.Bo5` etc, line 14)** — correto. Mas EV calib + Markov calib + tennis-mt-calib NÃO fazem o split.
   - **Memory tennis_df_model_pendency_2026_05_25 já levanta:** "validar Bo5 multiplier 1.4x ou Negative Binomial vs Poisson" — Bo5 inflation 1.4× é uma constante hardcoded, não data-driven per (player, surface, bo).

---

## ACHADOS DETALHADOS

### 1) Tier classifiers — status 5 paralelos

| # | Arquivo | Função | Tipo retorno | Sports cobertos | Status |
|---|---|---|---|---|---|
| 1 | `lib/league-tier.js:105` | `getLeagueTier(sport,league)` | numeric 1/2/3 (1=top) | lol/cs/dota/val/tennis/football/basket/mma | **CANONICAL** |
| 2 | `lib/esports-runtime-features.js:115` | `leagueTier(league)` | numeric 3/2/1 (3=top, **INVERTIDA**) | lol/cs/dota/val (esports only) | ML feature parity (locked) |
| 3 | `lib/tier-classifier.js:51` | `classifyTierString(sport,league)` | string ('atp_main'/'tier1'/'top5_uefa') | tennis/lol/cs/dota/val/football | Used by `/admin/shadow-tier-divergence` (line 24148) and Markov calib routing |
| 4 | `lib/mt-tier-classifier.js:75` | `classifyTier(sport,league)` | string ('tier1_la_liga'/'tier4_lower') | tennis/lol/cs/dota/val/football/basket | Used by `_getTierMTStakeMult` |
| 5 | `bot.js:383` | `_leagueTier(sport,league)` | numeric (delegate #1) | all sports | wrapper |

**Issues:**
- `_mmaTier` (`lib/league-tier.js:94-99`) só checa `\bufc\b|pfl championship|bellator` tier1 + `lfa|cage warriors|one championship|rizin|pfl` tier2 — **ignora ranking/event tier** (UFC numbered events vs Fight Night vs APEX), divergente do que `_KELLY_TIER_MULT_DEFAULTS.mma` em `bot.js:6209` ({1: 1.10, 2: 0.90, 3: 0.40}) implica.
- `_basketTier` (line 81-91) tem exclude de `nba G/Summer/2K/D-League` ok, MAS `tier2: euroleague|wnba|euro?cup|acb|nbb|liga endesa|nbl|cba|chinese basketball` mistura **WNBA com EuroCup** quando WNBA é tier1 nos defaults Kelly (boot ROI history). 
- `_tennisTier` retorna numeric 1/2/3, **string classifier #3 retorna 6 valores** (atp_main/wta_main/atp_challenger/wta_challenger/wta125k/itf). Mapeamento numeric→string non-trivial.

### 2) Decisões hot path sem granularidade

**Decisões sport-wide presentes (legítimas):**
- `<SPORT>_MARKET_TIPS_ENABLED=true` (`bot.js:6809,6915,7006,12684`) — promote toggle per sport. Granular per market via `mt_market_league_blocklist` (line 7373 mt-tier-classifier ref `football|tier4_lower 0.7`). OK.
- `<SPORT>_ML_DISABLED` (`lib/ml-auto-promote.js:189`) — sport-wide ML route to shadow. OK pra emergency.

**Decisões mistas — granular OK mas com defaults questionáveis:**
- `runMtBucketGuardCycle` (`bot.js:7680,7697,7713,7729`) — GROUP BY `(sport, market, side)` e `(sport, market, side, league)` ✅ granular. Tier não entra direto, mas mig 091 (`market_tips_runtime_state` ADD tier) ainda usado em `bot.js:7811-8075` `DELETE` com `tierCond`.
- `mt_permanent_disable_list` (mig 108, lib/mt-permanent-disable.js) — PK = `(sport, market, side)`, **sem tier** — entries seed em mig 108:2872 incluem `('lol','total','','ROI -54% n=10')` que bloqueia TOTAL across all tiers da LoL. n=10 é sample crítico mas bloqueio é sport-wide sem qualificação tier. **PROBLEMA P1.**

### 3) Hierarchy envs

**Kelly hierarchy** (`bot.js:6181-6280` `getKellyFraction`):
1. `KELLY_<SPORT>_<MARKET>_<CONF>` ex `KELLY_TENNIS_HANDICAP_GAMES_MEDIA=0.40` ✅
2. `KELLY_<SPORT>_<CONF>` ex `KELLY_TENNIS_MEDIA=0.5` ✅
3. `KELLY_<CONF>` ex `KELLY_MEDIA=0.5` ✅
4. `_KELLY_DEFAULTS[conf]` ✅

Após base fraction, `_getTierKellyMultiplier(sport, league)` aplica mult tier (`bot.js:6219`). **Conclusão:** hierarchy está implementada, mas **NÃO inclui tier** na cadeia base (tier é separado como multiplicador). Falta opção `KELLY_<SPORT>_<MARKET>_<TIER>_<CONF>` pra leak por tier dentro de market.

**Bonus:** `_resolveHgDirSideMult` (`bot.js:6237+`) implementa **HG×dir×side** específico — `KELLY_<SPORT>_HG_<DIR>_<SIDE>` (line 6232). **Padrão útil mas hardcoded a HANDICAP_GAMES** — não generalizado pra outros (TOTAL_OVER/UNDER, KILLS_MAP1, etc).

**Momentum env hierarchy** (cross-sport tier-aware ✅):
- LoL: `LOL_MOMENTUM_<TIER>` (bot.js:11088) > `LOL_MOMENTUM` (11090) > 0.10 default (`lib/lol-series-model.js:23`)
- Dota: `DOTA_MOMENTUM_<TIER>` (17287,17332) > `DOTA_MOMENTUM` > 0.04
- CS: `CS_MOMENTUM_<TIER>` (22754,22758) > `CS_MOMENTUM` > 0.04
- Valorant: **AUSENTE** — sem `VALORANT_MOMENTUM_<TIER>` despite CLAUDE.md menciona "commit 95cc4a0 CS/Dota/Val" cross-sport fix. Grep confirma só 3 sports.

**Calib path env per-sport:** `lib/sport-mt-calib.js:36` resolve `${SPORT.toUpperCase()}_MT_CALIB_PATH` env per sport ✅; disable opt-out via `${SPORT.toUpperCase()}_MT_CALIB_DISABLED=true` ✅.

### 4) Schema v2 tier-aware — status per sport

| Sport | Calib file | v1 bins | v2 tiers | v2.1 sides | tier-aware? |
|---|---|---|---|---|---|
| **tennis** | `lib/tennis-markov-calib.json` | ✅ | ✅ (`wta_main`,`atp_main`,`atp_challenger` line 109-494) | ✅ (sides nested) | **SIM** |
| **lol** | `lib/lol-mt-calib.json` (3.5KB) | ✅ | ❌ (line 74 só `sides`) | ✅ | NÃO |
| **cs** | `lib/cs-mt-calib.json` | ❌ NOT FOUND | — | — | NÃO (memory diz commit 038f0db criou; arquivo ausente) |
| **dota2** | `lib/dota2-mt-calib.json` | ❌ NOT FOUND | — | — | NÃO |
| **valorant** | `lib/valorant-mt-calib.json` | ❌ NOT FOUND | — | — | NÃO |
| **football** | n/a | n/a | — | — | NÃO (sem calib MT) |
| **basket** | n/a | n/a | — | — | NÃO |
| **mma** | n/a | n/a | — | — | NÃO |
| **darts** | `lib/darts-isotonic.json` | ❌ não verificado | — | — | NÃO |
| **snooker** | `lib/snooker-isotonic.json` | ❌ não verificado | — | — | NÃO |
| **tabletennis** | n/a | — | — | — | NÃO |

**Issue P0:** memory anota "Tennis (n=723) + LoL (n=135, tiers ativos) + CS (n=45) calib v2/v2.1 ativos" (commit 038f0db), **mas verificação local mostra LoL JSON sem tier section e CS/Dota2/Val JSONs missing**. Provavelmente JSONs em Railway prod foram refit'd mas não commitados ao git (caso `dota2-mt-calib.json` aparece em commits anteriores que não estão refletidos local). **Verificar via `/admin/mt-calib-status` ou similar antes de assumir gap.**

### 5) Sample tier insuficiente fallback

**Tennis fit script:** `scripts/fit-tennis-markov-calibration.js:307,370-371` — `MIN_TIER_N=30` default; `n<MIN_TIER_N → fold into default` ✅ implementado.

**Esports MIN_TIER_N esports:** `bot.js:28540-28544` comment: "MIN_TIER_N=30 hardcoded — sample LoL last 90d distribuído tier1=34/...; sample >= MIN_SIDE_N=30 por (tier,side). tiers_only=true preserva flat fallback." **OK — fallback presente.**

**EV calibration:** `lib/ev-calibration.js:106` — `minNTier = max(minN, EV_CALIB_MIN_N_TIER || 15)`. Cascade fallback tier+market → market → sport → global (`lib/ev-calibration.js:271-292`) ✅.

**Conclusão:** sample fallback adequado. Mas alguns nós como `mt_market_league_blocklist` block com `n=10 ROI≤-10%` (`lib/mt-auto-promote.js` envs `MT_AUTO_PROMOTE_LEAGUE_MIN_N=10`) — limites baixos pra n=10 + tier-agnostic = falsos positivos prováveis em ligas tier3.

### 6) Filtros endpoints admin granular

**Endpoints com tier filter:**
- `/admin/shadow-tier-divergence?sport=&days=&market=&minN=` (`server.js:24121`) — ✅ tier dimension explicit; recomenda refit per-tier; **cross-sport delegate via classifyTierString**
- `/admin/tips-by-confidence?sport=&days=` (`server.js:16051-16054`) — ✅ conf dimension explicit (2026-05-21)

**Endpoints SEM tier filter (anti-pattern):**
- `/admin/mt-shadow-by-league?sport=&days=&minN=` (`server.js:24285`) — só `(sport, league)` agg, **tier NÃO em params** — apesar de league já conter tier semântico, audit aggregate dilui.
- `/admin/tips-real-by-league?sport=&days=&league_match=` (`server.js:23950`) — mesma issue
- `/admin/ml-shadow-by-league?sport=&days=&minN=&league_match=` (`server.js:24420`) — idem
- `/admin/mt-shadow-by-ev?sport=&days=` (memory mt_disable session) — sem tier
- `/admin/cross-significance?sport=tennis,lol&days=` (`server.js:13959`) — multiplos sport CSV ✅, mas dimensões hardcoded em `cross-significance.js:150` `SPORTS_WITH_TIER` (tennis/lol/cs/cs2/dota2/valorant/football/basket/mma) — falta darts/snooker/tabletennis cobertura.

**Conclusão:** Maioria dos endpoints adequados pra tier via `league` indireto (`league_match=` URL param), mas filter explícito `tier=` ausente — humano precisa entender que `league=Roland Garros` = tier1.

### 7) MT leak guards granularidade

**runMtBucketGuardCycle** (`bot.js:7680-7729`): GROUP BY `mts.sport, mts.market, mts.side` + `+ mts.league` ✅ side+league. **Tier ausente do GROUP BY** mas presente no DELETE filter (line 7811 `tierCond`). OK pra leak detection per (sport,market,side,league); tier captura layer extra via mig 091.

**runMarketTipsLeakGuard** (`bot.js:7834`) e `runMtBucketGuardCycle` (9164): ambos respeitam `MT_LEAK_REAL_ONLY=true` default (P2 compliance) + `REAL_ONLY` opt-out (line 9174 comment).

**Cross-check cs/dota/val/tennis/football/basket/mma:**
- Cron `mt_leak_guard` (line 28209) é genérico cross-sport via SPORTS array.
- Cron `mt_bucket_guard` (line 27505) idem.
- Defaults granular para todos via SQL — não há per-sport branch. ✅

**Issue:** `mt_permanent_disable_list` (mig 108) — sem tier col → block sport-wide mesmo lendo de evidência tier-specific.

### 8) EV calibration data-driven per (sport, bucket, tier)

**Schema atual** (`lib/ev-calibration.js:32-39, 183-200, 271-292`):
```
bySportMarketTierBucket  // 'sp|MK|tier|idx'  ← tier-aware (2026-05-14 added)
bySportMarketBucket      // 'sp|MK|idx'
bySportBucket            // 'sp|idx'
byBucketGlobal           // 'idx'
```

**Cascade lookup** (`lib/ev-calibration.js:271-292`): tier+market → market → sport → global ✅.

**Dimensões ausentes:**
- **Side direction** (`over/under`, `home/away`, `team1/team2`) — **NÃO segmenta** — grep `lib/ev-calibration.js` retorna zero matches pra `side|direction|over|under`. Mesmo bucket EV mas lados opostos podem ter ROI muito diferente (memory `project_session_2026_05_17` documenta hg-neg readiness é EDGE +47.9% IC95 enquanto hg-pos é LEAK). Calib monolítica per side.
- **Confidence** (ALTA/MEDIA/BAIXA) — **NÃO segmenta** (zero matches).
- **Bo3 vs Bo5** — não considera (mais relevante a esports).

### 9) Anti-patterns ativos

| # | Anti-pattern | Status | Evidência |
|---|---|---|---|
| 1 | "Disable sport global via env" | ✅ Não present (envs per market via `*_MARKET_TIPS_ENABLED`, granular) | `bot.js:6915,7006` |
| 2 | "Calib monolítica pra sports sem tier-aware refit" | ❌ **Presente** (LoL/CS/Dota2/Val MT calib não tier-aware; football/basket/mma sem calib) | `lib/lol-mt-calib.json` line 74 só `sides` |
| 3 | "Dashboard KPI overall sem breakdown granular" | 🟡 Parcial — `/admin/sport-detail`, `/admin/shadow-tier-divergence`, `/admin/cross-significance` permitem drill | `server.js:13412,24121,13959` |
| 4 | "Decisões em sample agregado sem split per-tier" | 🟡 Parcial — leak guards têm side/league/tier (mig 091); promote thresholds não consideram tier | `lib/mt-auto-promote.js:14` |
| 5 | "Permanent disable sport-wide quando bug é tier-specific" | ❌ **Presente** | mig 108:2872 LoL TOTAL block sport-wide; CS UNDER 2.5 tier2/3 block sport-wide |

### 10) Bo3 vs Bo5 separation

**Esports** (`lib/lol-markets.js`):
- `mapScoreDistribution(pMap, bestOf, opts)` (line 49) — closed-form binomial first-to-N ✅
- `seriesWinProb` (99), `handicapProb` (124), `totalMapsProb` (147), `exactScoreProb` (167) — todos param `bestOf` ✅
- `esports-segment-gate.js:14-93` — POLICY = `{game: {tier1/tier2/tier3: {Bo1/Bo3/Bo5: ...}}}` ✅ 3-D granular

**Tennis** (`lib/tennis-markov-model.js`):
- `priceTennisMatch({bestOf=3})` (165) — ✅ accepts param
- `_simMatch(pA,pB,bestOf)` (105-106) — `setsToWin = Math.ceil(bestOf/2)` ✅
- `estimateTennisAces/DoubleFaults` — `boMult = bestOf===5 ? 1.4 : 1.0` (line 533, 582) — **constante 1.4× HARDCODED**, not data-driven
- `tennis-model.js:986` — `bestOf: /grand slam|wimbledon|us open|roland|australian/i.test(league) ? 5 : 3` — heuristic via regex; women slam Bo3 NÃO detectado.

**Tennis calib JSON** — NÃO particiona por Bo:
- `lib/tennis-markov-calib.json` tier keys: `wta_main, atp_main, atp_challenger` — **mistura Bo3 (WTA+ATP non-Slam) com Bo5 (ATP Slam)** sob mesmo `atp_main`.

**Conclusão Bo3/Bo5:**
- esports: ✅ 100% — math + gate aware
- tennis: 🟡 50% — model math OK, mas calib JSON não split + multiplicador 1.4× hardcoded em aces/DF

---

## P5 Cross-sport check (executado)

**Tier classifier coverage gaps cross-sport:**

| Sport | numeric `lib/league-tier` | string `lib/tier-classifier` | MT calib tier-aware |
|---|---|---|---|
| lol | ✅ | ✅ tier1/tier2/other | ❌ |
| cs/cs2 | ✅ | ✅ | ❌ (file missing) |
| dota2 | ✅ | ✅ | ❌ (file missing) |
| valorant | ✅ | ✅ | ❌ (file missing) |
| tennis | ✅ | ✅ atp_main/etc | ✅ |
| football | ✅ | ✅ top5_uefa/br_continental/other | ❌ |
| basket | ✅ | ❌ null | ❌ |
| mma | ✅ (minimal) | ❌ null | ❌ |
| darts | ❌ (defaults to 3) | ❌ null | ❌ |
| snooker | ❌ (defaults to 3) | ❌ null | ❌ |
| tabletennis | ❌ (defaults to 3) | ❌ null | ❌ |

**Padrão:** cross-sport tier classifier #1 cobre 8/11 sports (faltam darts/snooker/tt); #3 string-aware cobre 6/11. Calib tier-aware existe só em 1/11 sports (tennis). Esports calib JSONs missing locais = audit gap (precisa verificar prod via endpoint).

---

## Priorização findings

### P0 — granularidade FALTANDO causando leak conhecido
1. **`mt_permanent_disable_list` sem tier col** — entries tipo `('lol','total','')` bloqueiam TOTAL across ALL tiers da LoL apesar de leak ser tier2/3 only. Sport-wide block quando granular bastaria. **Migration upgrade**: ADD COLUMN tier + re-seed.
2. **LoL/CS/Dota/Val MT calib JSON sem tier section** — embora `lib/sport-mt-calib.js` suporte v2 schema, JSONs efetivos no repo são v1 (LoL `lib/lol-mt-calib.json` line 74 só `sides`). Memory anota refit já fired but local mismatch. Verificar Railway state vs git.

### P1 — granularidade faltando mas low impact ou já compensado
3. **EV calibration sem dimensão side/conf** — `lib/ev-calibration.js` cascade vai até tier+market+bucket, mas side direção (over/under, home/away) e conf (ALTA/MEDIA/BAIXA) não consideradas → mesmo mult pra ALTA bucket1 e BAIXA bucket1.
4. **Valorant MOMENTUM env tier-aware ausente** — LoL/CS/Dota têm `<SPORT>_MOMENTUM_<TIER>` cascade (`bot.js:11088,17287,22758`). Valorant não. Memory cita commit 95cc4a0 cobrir cross-sport mas grep não encontra `VALORANT_MOMENTUM_TIER` no código.
5. **Tennis calib não particiona Bo3 vs Bo5** — `atp_main` tier key mistura ATP Slam Bo5 com ATP 250/500 Bo3 same calib bucket. Memory já cita pendência `tennis_df_model_pendency` (Bo5 multiplier 1.4x review).
6. **5 tier classifiers paralelos** — `lib/esports-runtime-features.leagueTier` semantics invertida ainda mantida (P3 documentado mas não resolvido); `lib/mt-tier-classifier` e `lib/tier-classifier` retornam strings diferentes para mesma intent.
7. **basket/mma/darts/snooker/tabletennis sem string tier classifier** — `lib/tier-classifier.js` retorna null pra esses sports. `/admin/shadow-tier-divergence?sport=basket` cai em `unclassified`. Coverage gap audit per-tier impossible cross-sport.

### P2 — info/improvement
8. `_KELLY_TIER_MULT_DEFAULTS` defaults conservadores pros 6 sports tier-agnostic (`bot.js:6201-6212`) — todos tier1=1.10-1.20 / tier3=0.40-0.50 sem refit per sport (comment "spread conservador, refit defaults após sample >50/tier per sport").
9. `/admin/mt-shadow-by-league` / `/admin/ml-shadow-by-league` / `/admin/tips-real-by-league` não aceitam param `tier=` explícito — humano precisa interpretar tier via `league` (workaround OK pra audit drill, mas semantics implícita).
10. `_mmaTier` minimalista em `lib/league-tier.js:94-99` — só 3 regex. UFC numbered vs Fight Night vs APEX (mesma org, sample heterogeneity) não captura.
11. `_basketTier` mistura WNBA em tier1 (line 88 `/\bnba\b|euroleague|wnba/`) — WNBA pode merecer tier2 dado regime / volume / sharp coverage. Não verifica.
12. HG-dir-side hardcoded a HANDICAP_GAMES (`bot.js:6237 _resolveHgDirSideMult`) — outros markets bi-direcionais (TOTAL_OVER/UNDER, KILLS_MAP1) não generalizados. Caso pra abstrair em helper.
13. Football `mt-tier-classifier.js TIER_DEFAULT_MULT` (`'football|tier1_la_liga': 0.7`, `'football|tier1_brazil_b': 1.15`) — sintaxe inconsistente com `_KELLY_TIER_MULT_DEFAULTS` (numeric tiers vs string keys).

---

## Arquivos relevantes

- `C:\Users\vict_\Desktop\lol betting\lib\league-tier.js` — canonical tier #1 (126 LoC)
- `C:\Users\vict_\Desktop\lol betting\lib\esports-runtime-features.js:115` — leagueTier invertida #2 (ML feature parity)
- `C:\Users\vict_\Desktop\lol betting\lib\tier-classifier.js` — string classifier #3
- `C:\Users\vict_\Desktop\lol betting\lib\mt-tier-classifier.js` — string classifier #4 (paralelo a #3)
- `C:\Users\vict_\Desktop\lol betting\bot.js:383` — `_leagueTier` wrapper delegate #5
- `C:\Users\vict_\Desktop\lol betting\bot.js:6181-6280` — `getKellyFraction` hierarchy cascade
- `C:\Users\vict_\Desktop\lol betting\bot.js:6201-6212` — `_KELLY_TIER_MULT_DEFAULTS`
- `C:\Users\vict_\Desktop\lol betting\lib\ev-calibration.js:32-39,183-200,271-292` — EV calib cascade (tier+market+bucket, falta side+conf)
- `C:\Users\vict_\Desktop\lol betting\lib\tennis-markov-calib.json:109,376` — tier sections (only sport com v2)
- `C:\Users\vict_\Desktop\lol betting\lib\lol-mt-calib.json:74` — só sides, sem tier section
- `C:\Users\vict_\Desktop\lol betting\lib\sport-mt-calib.js:18-22` — factory comment claims v2.1 support but only tennis uses
- `C:\Users\vict_\Desktop\lol betting\migrations\index.js:2845-2890` — mig 108 mt_permanent_disable schema (sem tier)
- `C:\Users\vict_\Desktop\lol betting\migrations\index.js:1860-1910` — mig 077 mt_market_league_blocklist (sem tier)
- `C:\Users\vict_\Desktop\lol betting\migrations\index.js:2256+` — mig 091 mt_runtime_state ADD tier (auto-disable só)
- `C:\Users\vict_\Desktop\lol betting\server.js:24121-24280` — `/admin/shadow-tier-divergence` (tier dimension primary)
- `C:\Users\vict_\Desktop\lol betting\server.js:16051-16054` — `/admin/tips-by-confidence` (conf dimension)
- `C:\Users\vict_\Desktop\lol betting\lib\esports-segment-gate.js:14-93` — POLICY 3D (tier × bo)
- `C:\Users\vict_\Desktop\lol betting\lib\tennis-markov-model.js:533,582` — `boMult=1.4` hardcoded aces/DF Bo5
- `C:\Users\vict_\Desktop\lol betting\bot.js:11088` — LOL_MOMENTUM_<TIER>
- `C:\Users\vict_\Desktop\lol betting\bot.js:17287,22758` — DOTA/CS_MOMENTUM_<TIER>; VALORANT FALTA
- `C:\Users\vict_\Desktop\lol betting\FEATURE_INVENTORY.md:11-31` — gate + Kelly mult layers
- `C:\Users\vict_\Desktop\lol betting\COMMON_PITFALLS.md` — CBLOL tier1 vs tier2 case + 7f9dcc9 fix

---

## Conclusão

Sistema fez progresso significativo em P1 (5 tier classifiers funcionais, cascade hierarchy Kelly, segment gate 3D, leak guard tier-aware mig 091, endpoint shadow-tier-divergence cross-sport). Principais lacunas remanescentes:

- **Calib tier-aware é tennis-only** apesar da factory `sport-mt-calib.js` ter sido criada genérica — refit cross-sport pendente.
- **mt_permanent_disable_list sport-wide** quebra P1 (block tier1+tier2+tier3 quando evidência é só tier2/3).
- **EV calib não considera side/conf**, dois dimensões P1 críticas pra tip emission decision.
- **5 classifiers paralelos** ainda existem (P3 + P4 anti-overfeaturing pendency). Convergir para 1-2 não-trivial pois ML feature parity (#2) é locked.

P0 fixes recomendados (autorização user separada): (1) mig add tier col em `mt_permanent_disable_list`; (2) refit cross-sport MT calib v2 com tiers; (3) ev-calibration adicionar side+conf dimension.
