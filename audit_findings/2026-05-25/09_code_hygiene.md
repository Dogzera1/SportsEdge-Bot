# 09 — Code Hygiene Audit (P3 + P4)

**Date:** 2026-05-25
**Scope:** P3 Anti-overfeaturing + P4 Otimização contínua deep audit
**Codebase size:** bot.js 30.4k LoC + server.js 38.0k LoC + 182 lib/*.js + 95 scripts/ + 53 tests/ + 84+ crons

---

## Sumário executivo (<500 palavras)

Audit profundo de hygiene revelou **boa higiene macro** (FEATURE_INVENTORY + COMMON_PITFALLS + endpoints `/admin/overfeaturing-audit`, `/admin/feature-inventory`, `/admin/env-audit` ativos; cron `runOverfeaturingAuditCycle` rodando 1h) MAS **paralelismo arquitetural persiste** em 3 áreas críticas:

### Top 5 refactor priorities

1. **P1 — Tier classification: 7 implementações paralelas com SEMANTICS DIFERENTES**.
   - Numérico (1/2/3): `lib/league-tier.js` (canonical, 4 callers diretos + delegados) + `lib/esports-runtime-features.js:115 leagueTier(league)` (numeração `tier1=3, tier2=2` invertida intencionalmente — feature de ML model) + `bot.js:383 _leagueTier` (delegate wrapper) + `bot.js _classifyStuckTier` (settle log).
   - String (`tier1`/`tier2`/`other`/`top5_uefa`/etc): `lib/tier-classifier.js:51 classifyTierString` (delega numeric) + `lib/cross-significance.js:141 classifyTier(sport, eventName, league)` (independente) + `lib/mt-tier-classifier.js:75 classifyTier(sport, league)` (string buckets MT-specific com EV_MAX_DEFAULTS).
   - **6 anos de comments** documentando colisões/bugs entre eles (2026-05-11/17/18/19). Apesar de cada um ter razão semântica para existir, divergência regex está confirmada repetidamente.

2. **P0 — `/admin/env-audit` registrado 2× em server.js**.
   - `server.js:13615` (kelly inversion + whitespace audit) + `server.js:15470` (env feature flags audit). **Node http handler returna no primeiro match → segundo é DEAD CODE**. Lines 15467-15665 (~200L) nunca executam. Memory já documenta env-audit existe + kelly inversion LoL detectada via primeiro handler — segundo dead.

3. **P1 — Kelly product cap em 3 lugares** (não 1 source of truth).
   - `lib/utils.js:363` `_applyKelly` (ML path, base cap)
   - `lib/market-tip-processor.js:194` (MT path) `_KELLY_PRODUCT_CAP` (duplicada)
   - `lib/market-tips-shadow.js:262` `productCap` (shadow MT path, duplicada)
   - Mesma constante `KELLY_PRODUCT_CAP_FRAC=0.15`. Refator: extrair pra `lib/utils.js` único helper + dois callers.

4. **P1 — Polymarket-watcher é DORMANT stub mas continua wired**.
   - `lib/polymarket-watcher.js` 39L, `@DORMANT 2026-05-12` marker, exports `preTipConsensusCheck` que retorna `null` sempre.
   - `server.js:29161` chama em `/record-tip` em cada tip emit (silent require). **No-op em hot path** — overhead 100% gratuito.
   - Plano (file comment): deletar require server.js + deletar file.

5. **P2 — 25 orphan tests confirmados ÚTEIS** (não são realmente órfãos; testam funções bot.js/server.js/sub-lib). 1 BROKEN: `test-migrations-order.js:21` faz `require('../migrations')` mas migrations/ não tem `index.js` no path padrão — verificar load. (Atualização: `migrations/index.js` existe — provável que funcione via `require('../migrations')` resolver para `migrations/index.js`. **Não é bug**.)

### Estatísticas brutas:
- **0** libs verdadeiramente dead (zero callers de todo path)
- **54** single-caller libs (maioria sport-specific scanners legitimately called once)
- **665** silent `catch(_) {}` ou `catch(err) {}` (305 bot.js + 231 server.js + ~129 lib)
- **1326** `console.log` em scripts/ (esperado — scripts CLI usam stdout) + **6** em lib (database.js + utils.js + model-persistence.js — boot-time + log fallback OK) + **2** em bot.js (mem-guard banner) + **0** em server.js
- **293** funções em bot.js, **35** > 100L; **185** funções em server.js, **5** > 100L
- **8** libs > 800L (legacy monoliths candidatos a split, market-tips-shadow.js 2080L é o pior)
- **0** `@DORMANT` markers ativos exceto `lib/polymarket-watcher.js` (catalogado em FEATURE_INVENTORY)

### Boa higiene confirmada:
- ✅ Tier classifier unificação parcial (commit `7f9dcc9`) — bot.js delega
- ✅ `_pandaGet` único em `server.js:72` (consolidação Wave 3)
- ✅ `BROWSER_UA` único em `lib/utils.js:495` — 12 consumers (consolidação Wave 3)
- ✅ `_readPostBody` único em `server.js:1635` — 28 callers (consolidação Wave 3)
- ✅ `cachedHttpGet` único em `lib/utils.js:650`
- ✅ `runOverfeaturingAuditCycle` cron 1h ativo em `bot.js:26123`
- ✅ `kelly_product_capped` metric em `lib/utils.js:370` (observability)

---

## 1. Tier classifiers (P1)

**Status CLAUDE.md:** ✅ Unificado parcial (commit 7f9dcc9). ⚠️ `lib/esports-runtime-features.leagueTier` paralela.

**Realidade confirmada (7 impls)**:

| # | File:Line | Função | Output | Propósito | Status |
|---|---|---|---|---|---|
| 1 | `lib/league-tier.js:105` | `getLeagueTier(sport, league)` | numeric `1/2/3` | **Canonical** | ✅ keep |
| 2 | `bot.js:383` | `_leagueTier(sport, league)` | numeric `1/2/3` | Delegate wrapper (try/catch ⇒ 2) | ✅ keep (already delegate per commit 7f9dcc9) |
| 3 | `lib/esports-runtime-features.js:115` | `leagueTier(league)` | numeric `3/2/1` (INVERTED) | ML feature dimension (tier1=3 for ranking score) | ⚠️ keep, semantic differente — DOCUMENT in unified header |
| 4 | `lib/tier-classifier.js:51` | `classifyTierString(sport, league)` | string `tier1`/`tier2`/`other`/`top5_uefa`/`br_continental`/`itf`/`wta125k`/etc | Tier-aware refit/Markov calib (tennis especial) | ✅ keep — delegate to (1) for esports |
| 5 | `lib/mt-tier-classifier.js:75` | `classifyTier(sport, league)` | string buckets MT-specific (`tier4_challenger`, `tier_quali_or_early`, `tier1_brazil_b`, …) | MT path + stake mult tables + EV cap | ✅ keep (granularidade diferente) |
| 6 | `lib/cross-significance.js:141` | `classifyTier(sport, eventName, league)` | string + per-sport subdivision (tennis `_classifyTennisTier`, mma `_classifyMmaTier`, …) | Cross-significance audit | ⚠️ overlap com #4/#5; helper duplicado per sport |
| 7 | `bot.js:4188` | `_classifyStuckTier` | numeric (settle log only) | Stuck detection log | ✅ keep — disjoint purpose |

**Issues:**
- (3) **`esports-runtime-features.leagueTier` retorna `3, 2, 1` (CS S-tier=3)**, semantics invertidas vs (1) — comentários linha 115+ tentam justificar mas leitor casual ainda fica confuso. ML model espera "higher = better tier" pra rankear features.
- (6) **`cross-significance.classifyTier` reimplementa tennis/football/mma/basket classifiers** que poderiam delegar a (4) `tier-classifier.classifyTierString`. Já delega esports → (1). Por que não delegar TUDO?
  - Recomendação: refactor `cross-significance.js:130-181` para `return require('./tier-classifier').classifyTierString(sport, league)` (depois de auditar que outputs batem).

**Recomendação:**
- (a) Documentar header em `lib/league-tier.js` listando os 7 lugares + responsabilidade.
- (b) Refactor `cross-significance.classifyTier` → delegar a `tier-classifier.classifyTierString`. Reduz 50+ LoC duplicada.
- (c) Renomear (3) `esports-runtime-features.leagueTier` → `leagueTierMlScore` (ou `leagueTierInverted`) — make INTENT visível no nome (evita confusão futura sobre "qual classifier usar").

---

## 2. Dead libs (P4 #2)

**Status:** ✅ Zero true-dead libs. 54 single-callers (a maioria legítima).

**Suspicious single-callers (DORMANT/no-op candidates):**

| Lib | LoC | Caller | Status |
|---|---|---|---|
| `lib/polymarket-watcher.js` | 39 | `server.js:29161` (record-tip hot path) | **P1 DORMANT stub** — `preTipConsensusCheck` retorna `null` sempre. `@DORMANT 2026-05-12` marker. Plan documentado: deletar require + file. **No-op em hot path = overhead gratuito**. |
| `lib/league-phase-normalizer.js` | 48 | server.js (1) | Verificar se é apenas string helper — pode inline. |
| `lib/dota-fraud-blacklist.js` | 59 | bot.js (1) | Verificar — pode estar dormant ou ativo. |
| `lib/valorant-rounds-model.js` | 60 | bot.js (1) | **Pure delegate** para `cs-rounds-model.js` — inline candidate (env-override é pouco). |
| `lib/pre-match-gate.js` | 69 | bot.js (1) | Ativo (multi-sport). Pequeno mas justifiable. |

**Recomendação:**
- (a) `lib/polymarket-watcher.js` + `server.js:29161` require → **DELETE NOW**. Plan documentado no próprio comment do stub.
- (b) Investigar `valorant-rounds-model.js` — 95% delegate. Decidir: inline em bot.js OR manter por simmetria com `cs-rounds-model`.

---

## 3. Dead envs (P3)

**Endpoint:** `/admin/env-audit` ✅ ATIVO em `server.js:13615` — reporta whitespace, kelly inversion, typos, suspicious envs.

**P0 BUG — `/admin/env-audit` registrado 2×:**
- Handler #1: `server.js:13615` (P3+P4 kelly inversion + whitespace + suspicious detection) — **executa primeiro, retorna**.
- Handler #2: `server.js:15470` (env feature flags audit com mask) — **DEAD CODE** (~200L de 15470-15665).
- **Impacto:** segundo endpoint nunca testável em prod. Memory provavelmente refere o primeiro (kelly inversion LoL detectada — vide memory `Kelly inversion LOL detectado 2026-05-25`).

**Recomendação imediata:**
- Renomear handler #2 para `/admin/env-feature-flags` OR `/admin/env-flags-status`. (Conserve a funcionalidade — mask + feature flags listing é útil; só não pode duplicar path.)
- OR: deletar handler #2 (200L) se conteúdo já está em handler #1.

**Status `TIME_OF_DAY_AUTO` legacy `HOURS_BLOCKED`:**
- Pitfall #2 documenta: `HOURS_BLOCKED` foi revertido em `f28587f`. Grep confirma — sem references ativas em código. ✅ Cleanup OK.

---

## 4. Dead crons (P3)

**Status:** ✅ Cron `runOverfeaturingAuditCycle` ATIVO em `bot.js:26079`, agendado 1h + setTimeout 5min boot-fire em `bot.js:26123-26124`.

Endpoint `/admin/overfeaturing-audit` ✅ em `server.js:15635`.

Endpoint `/admin/feature-inventory` ✅ em `server.js:15672`.

**Cron count em bot.js: 235** ocorrências de `setInterval|_wrapCron|markCronHeartbeat` (não 84 unique crons — CLAUDE.md menciona 84 mas grep inclui heartbeat marks ao longo do cron body). Pode ser refinado, mas inventory já feito.

**Recomendação:** rodar `/admin/overfeaturing-audit?days=30` em prod e investigar findings — não é dev-side audit.

---

## 5. Disable sources overlap (P3)

**Status:** ✅ Documentadas em FEATURE_INVENTORY > "Auto-disable sources" (5 sources).

Confirmado em código (P3 OK — cada source captura signal diferente):

| Source | Storage | Tipo | Origem |
|---|---|---|---|
| `MT_PERMANENT_DISABLE_LIST` env | Process env | Manual P0 | env legacy (transicional) |
| `mt_permanent_disable` table | DB | Manual + readiness_learner | `lib/mt-permanent-disable.js:68` (mig fresh) |
| `market_tips_runtime_state` | DB | Auto (4 sub-sources: `auto_clv_leak`, `auto_roi_leak`, `auto_early_roi_leak`, `auto_streak_loss`) + Manual | `bot.js:6850-7906` |
| `league_blocklist` table | DB | Manual + auto cron | mig 045 + mig 099 `ml_league_blocklist` |
| `ODDS_BUCKET_BLOCK` env | Process env | Manual hardcoded | `bot.js:1517`, server.js:15541 |
| (additional auto-detected) `ml_league_blocklist` | DB | Auto cron | mig 099 |

**6 sources** (não 5 — CLAUDE.md sub-count). Cada captura signal diferente. Manutenido OK por construção.

---

## 6. Kelly multipliers compostos (P1)

**Status:** ✅ Monitored. `kelly_product_capped` metric ativo.

**Cascade composição (5 lugares):**
1. `bot.js:6321` (ML path) — `baseFraction * tierMult * hgDirSideMult`
2. `bot.js:7380` (MT path) — `stakeNum * tierMult` (via `_mtTierClassifier.getTierStakeMult`)
3. `bot.js:2539` `fetchClvMultiplier()` — CLV → Kelly multiplier (lazy fetch, multiplica baseado em CLV ROI 30d)
4. `lib/kelly-auto-tune.js` (single-call bot.js) — auto-tune mult
5. `lib/league-trust.js` — league trust mult

**Cap final ativo (`KELLY_PRODUCT_CAP_FRAC=0.15`)** em 3 lugares:
- `lib/utils.js:363` `_applyKelly` (ML path)
- `lib/market-tip-processor.js:194` (MT pre-emit)
- `lib/market-tips-shadow.js:262` (shadow MT pre-emit)

**P1 finding — DUPLICAÇÃO de logic cap product:**
- Mesmo trecho (`const _KELLY_PRODUCT_CAP = parseFloat(process.env.KELLY_PRODUCT_CAP_FRAC || '0.15'); if (frac > cap) ...`) repete 3×.
- **Recomendação:** extrair helper `lib/utils.applyKellyProductCap(frac, opts)` único + delete duplicates em market-tip-processor + market-tips-shadow.

**Recomendação observabilidade:** `lib/utils.js:416` adiciona `evMult` no clamp final — perfeito. `evMult > 1` agora também loga `KELLY-EVMULT-CAP` (2026-05-24). ✅

---

## 7. 3+ implementações paralelas (P3 refactor trigger)

| Pattern | Status | File:Line da consolidação |
|---|---|---|
| `_pandaGet` | ✅ ÚNICO | `server.js:72` |
| `BROWSER_UA` | ✅ ÚNICO | `lib/utils.js:495` (12 consumers, override env) |
| `_readPostBody` | ✅ ÚNICO | `server.js:1635` (28 callers) |
| `cachedHttpGet` | ✅ ÚNICO | `lib/utils.js:650` |
| Tier classifier | ⚠️ 7 impls (vide #1) | múltiplos — refactor candidate |
| Kelly product cap | ⚠️ 3 impls (vide #6) | refactor candidate |
| `_emitSkip` / `logRejection` | (não verificado neste audit) | grep follow-up |

---

## 8. TODO/FIXME no código

**Total grep `TODO|FIXME|XXX|HACK`:** ~20 ocorrências em bot.js + server.js + lib.

Maioria são `TODOS` no sentido "**todos** os sports" em PT — não TODO comments reais. Apenas 2 reais identificados:
- `lib/market-tips-shadow.js:1692` — `// TODO: ingestion via result_meta_json (mig 122). Voida após 2d (vs 14d).` (mig 122 já existe — resolver ou deletar comment)
- `bot.js:24594` — `// checkoutP1/P2: TODO — extrair de getPlayerRecentAvg (já disponível no stats)` (resolver ou deletar)
- `bot.js:29167` — em DM template hardcoded: `1. Refit Markov calib v3 byLineSign (schema TODO)` — DM message (não comment); manter ou implementar.

**Recomendação:** resolver os 2 TODO reais (deletar comment OR implementar).

---

## 9. Comments desatualizados / `@DORMANT`

- Apenas `lib/polymarket-watcher.js:7` tem `@DORMANT 2026-05-12` marker — vide #2.
- Nenhum outro DORMANT marker grep encontrou.
- ✅ Cron `runOverfeaturingAuditCycle` busca markers (depende do conteúdo do endpoint, não testado).

---

## 10. Try/catch silencioso (CLAUDE.md alert)

**Total:** 665 silent catches (`catch(_) {}` ou `catch(err) {}`).
- bot.js: 305
- server.js: 231
- lib: ~129 (top: utils.js 13, database.js 8, pinnacle-auto-bet.js 7, agents-extended.js 6, dashboard.js 6)

**Pattern aceitável** (best-effort logging, P3 safe metrics): `try { metrics.incr(...); } catch (_) {}` — não bloqueia hot path.

**Pattern preocupante:** silent catch em path crítico (Kelly/EV/stake) — não identificado neste audit deep, mas worth grep follow-up.

**Recomendação:** auditoria de silent catches EM PATH CRÍTICO (record-tip, applyKelly, market-tip-processor) — pode estar mascarando bugs financeiros.

---

## 11. Funções > 100 linhas (P4 candidate split)

**bot.js top offenders:**

| Função | Lines | Range |
|---|---|---|
| `handleAdmin` | **2733L** | 12331-15063 |
| `pollTennis` | 1701L | 19069-20769 |
| `pollFootball` | 1495L | 20772-22266 |
| `autoAnalyzeMatch` | 1426L | 10738-12163 |
| `runAutoAnalysis` | 1110L | 3499-4608 |
| `_pollDotaInner` | 1078L | 16951-18028 |
| `pollCs` | 1053L | 22538-23590 |
| `pollValorant` | 910L | 23593-24502 |
| `pollMma` | 834L | 18233-19066 |
| `poll` | 683L | 15714-16396 |
| `_settleCompletedTipsInner` | 559L | 4730-5288 |
| `runAutoBasket` | 429L | 25125-25553 |
| `handleProximas` | 350L | 15121-15470 |
| `runAutoDarts` | 342L | 24507-24848 |
| `runStaleLineCron` | 328L | 29602-29929 |

**35 funções > 100L total em bot.js.** Não é necessariamente bug — `handleAdmin` é roteador HTTP gigante (50+ endpoints), `pollXxx` são scanners completos por sport.

**P4 candidate:** `handleAdmin` (2733L) deveria ser dividido em sub-routers por feature group (MT, ML, calib, P2 status, etc). Refactor risk: alto (massive blame churn). Defer.

**server.js top offenders:** apenas 5 funções > 100L (top: `getMapMlOddsFromFixture` 185L, `getLoLMatches` 169L). server.js mais bem fatorado.

**lib > 800L:**

| Lib | LoC |
|---|---|
| `market-tips-shadow.js` | **2080** |
| `agents-extended.js` | 1321 |
| `odds-aggregator-client.js` | 1102 |
| `tennis-model.js` | 1085 |
| `readiness-learner.js` | 1074 |
| `utils.js` | 1046 |
| `dashboard.js` | 980 |
| `lol-model.js` | 905 |

`market-tips-shadow.js` 2080L é o pior. CLAUDE.md exceções: bot.js/server.js. lib/* deveria split.

---

## 12. Arquivos > 1000 lines em lib/

5 libs: market-tips-shadow, agents-extended, odds-aggregator-client, tennis-model, readiness-learner.

**Recomendação:** split market-tips-shadow.js → propose:
- `lib/market-tips-shadow-storage.js` (insert/update/dedup)
- `lib/market-tips-shadow-settle.js` (settle path)
- `lib/market-tips-shadow-stats.js` (getShadowStats helpers)

**Defer pra sessão dedicada** — refactor risk alto.

---

## 13. Defensive sem motivo

Não identificado neste audit deep — req grep target. Worth follow-up: validações de input em helpers que só são chamados internamente.

---

## 14. Wrappers de wrappers

Não identificado neste audit deep. Worth follow-up.

---

## 15. Configurabilidade morta

Não identificado neste audit deep. Worth follow-up + cron `runOverfeaturingAuditCycle` deveria cobrir via env-audit.

---

## 16. Envs hierarchy validation

**Recomendação:** rodar `GET /admin/env-audit?key=<KEY>` em prod regularmente — endpoint já cataloga `kelly_inversion`, `whitespace`, `typos`, `suspicious`.

Memory 2026-05-25 confirma usado:
- "Kelly inversion LOL detectado 2026-05-25" — `/admin/env-audit` detectou `KELLY_LOL_ALTA=0.2 < KELLY_LOL_MEDIA=0.5` (inversão).

---

## 17. Cron heartbeat coverage

✅ Cabeado em todos os 9 sport-poll: `lol`, `dota`, `mma`, `tennis`, `football`, `tt`, `cs`, `valorant`, `darts`, `snooker`, `basket`. Memory `8815199` confirmou wire valorant.

✅ Cron heartbeats: sweep_analyzed, analyzed_dedup_persist, news_monitor, pre_match_check, ia_health, mem_watchdog, auto_analysis, autonomy_digest, etc.

**Gap residual:** `pollHeartbeat valorant` linha 23612 + 23643 — DUAS marcas seguidas. Innocuous; primeira no entry e segunda no exit. Coverage OK.

---

## 18. package.json — dependencies usage

**Dependencies (3):** `@duckdb/node-api`, `better-sqlite3`, `dotenv`. Todas usadas.

**DevDependencies (1):** `fast-check`. Property tests (test-kelly-property.js usa). Used.

✅ **No npm bloat.** Codebase puro Node.js stdlib + 3 deps prod. Excelente.

---

## 19. Test orphans

**25 tests inicialmente flagged** como sem matching `lib/<base>.js`. Investigação:
- **23 são VÁLIDOS** — testam funções definidas em lib helpers OU em bot.js/server.js OU smoke tests OU integration:
  - `test-admin-cookie-auth.js`, `test-banca-delta.js`, `test-bucket-block-real-only.js` (testa `lib/ml-auto-promote`), `test-espn-pen-aet.js`, `test-hltv-per-map-parser.js` (testa `lib/hltv`), `test-kelly*` (testam `lib/utils` + `lib/market-tip-processor`), `test-lib-smoke.js`, `test-log-ring-buffer.js` (testa `lib/utils`), `test-market-tip-dm.js`, `test-market-tip-processor-gates.js`, `test-ml-shadow-segment.js`, `test-mt-shadow-map-settle.js` (testa `lib/market-tips-shadow`), `test-mt-shadow-segment-sql.js`, `test-propagator-idempotency.js` (testa `lib/mt-result-propagator`), `test-record-tip-integration.js`, `test-schema-boot-integrity.js` (testa `lib/database`), `test-tennis-score-parser.js`, `test-tier-classifier-unification.js` (testa as 3 impls simultaneamente, ✅ great pattern), `test-tip-context-shape.js`, `test-tip-parser.js`, `test-vlr-per-map-parser.js` (testa `lib/vlr`).
- **2 candidates de review**:
  - `test-migrations-order.js:21` → `require('../migrations')` — **resolve para `migrations/index.js`** (mesmo padrão Node.js auto-resolver). Funciona.
  - **Verdade: 0 broken tests.** ✅

---

## 20. Documentos órfãos

- `FEATURE_INVENTORY.md` ✅ atualizado e referenciado
- `COMMON_PITFALLS.md` ✅ atualizado
- `CLAUDE.md` ✅ master
- `DECISIONS.md` ✅ (não verificado conteúdo)
- `ARCHITECTURE.md` ✅ (não verificado conteúdo)
- `docs/PROCESSO-ANALISE-TIPS-BOTS.md` (não verificado conteúdo)
- `_archive/` — 155MB — **CLEANUP candidate** (audit snapshots antigos, snapshot DBs antigas). Vide separate audit (`storage`).

---

## Resumo de findings priorizados

### P0 (overfeaturing causando bug ativo)
- **F-01** `/admin/env-audit` registrado 2× → `server.js:15470-15665` dead code (~200L)

### P1 (gap conhecido aguardando refactor)
- **F-02** 7 tier classification impls — `cross-significance.js:130-181` reimplementa lógica delegável a `tier-classifier.js`. ~50L duplicado.
- **F-03** Kelly product cap em 3 lugares (`lib/utils.js:363`, `lib/market-tip-processor.js:194`, `lib/market-tips-shadow.js:262`) — extrair helper único
- **F-04** `lib/polymarket-watcher.js` DORMANT stub + `server.js:29161` require em `/record-tip` hot path — DELETE NOW (plan documentado no próprio file)
- **F-05** `market-tips-shadow.js` 2080L — split refactor (sessão dedicada)

### P2 (cleanup candidate)
- **F-06** `lib/esports-runtime-features.js:115 leagueTier` — rename para `leagueTierMlScore` (semantics invertidas, evita confusão)
- **F-07** `lib/valorant-rounds-model.js` 60L pure delegate para `cs-rounds-model` — inline OR documentar simmetria
- **F-08** `bot.js:24594` TODO real (checkoutP1/P2) — resolver ou deletar comment
- **F-09** `lib/market-tips-shadow.js:1692` TODO real (result_meta_json mig 122 já existe) — resolver
- **F-10** 8 libs > 800L — `dashboard.js` (980), `lol-model.js` (905) são candidates split moderado
- **F-11** Bot.js `handleAdmin` 2733L função → split em sub-routers (defer alto-risk)
- **F-12** 665 silent catches — grep targeted em path crítico (record-tip / applyKelly / market-tip-processor) — não escaneado neste audit

### Notas operacionais
- ✅ Cron `runOverfeaturingAuditCycle` ativo (1h interval + 5min boot fire) — chama `/admin/overfeaturing-audit` automatically + DM admin.
- ✅ `/admin/feature-inventory` ativo (snapshot live).
- ✅ `/admin/env-audit` ativo (kelly inversion detection — memory já usou).
- ✅ FEATURE_INVENTORY.md + COMMON_PITFALLS.md mantidos atualizados.
- ✅ Tier classifier unificação parcial em progresso (commit 7f9dcc9).
- ✅ Wave 3 consolidações estáveis (`_pandaGet`, `BROWSER_UA`, `_readPostBody`, `cachedHttpGet`).

---

## Arquivos analisados

- `C:\Users\vict_\Desktop\lol betting\bot.js` (30.4k LoC)
- `C:\Users\vict_\Desktop\lol betting\server.js` (38.0k LoC)
- `C:\Users\vict_\Desktop\lol betting\lib\*.js` (182 files)
- `C:\Users\vict_\Desktop\lol betting\tests\*.js` (53 files)
- `C:\Users\vict_\Desktop\lol betting\scripts\*.js` (94 files)
- `C:\Users\vict_\Desktop\lol betting\__tests__\` (lib + migrations subdirs)
- `C:\Users\vict_\Desktop\lol betting\migrations\index.js`
- `C:\Users\vict_\Desktop\lol betting\package.json`
- `C:\Users\vict_\Desktop\lol betting\FEATURE_INVENTORY.md`
- `C:\Users\vict_\Desktop\lol betting\COMMON_PITFALLS.md`

---

End of `09_code_hygiene.md`.
