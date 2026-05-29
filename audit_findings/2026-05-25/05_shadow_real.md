# P2 Shadow vs Real — Deep Re-audit 2026-05-25

**Escopo:** Re-verificação completa de compliance P2 (Shadow=causa, Real=sintoma) em todo o codebase. Cobre Wave 1/2/3 violators históricos, caça de novos violators, endpoints informacionais, detectores P2-compliant, calibration shadow fallback (novo opt-in 2026-05-22), AI shadow audit cron, CSA suggestions, hg-neg-readiness, ML-auto-promote (novo) e auto-promote per-sport overrides.

**Veredicto:** ✅ **P2 compliance ROBUSTA**. Zero P0 ativos. Zero violators novos identificados. Toda decisão que afeta tip real está gateada por `is_shadow=0`. Todas as DM/recomendações de shadow têm disclaimer "research-only". Detectores armados e P2-compliant by construction.

---

## Sumário (top 5 findings)

1. ✅ **Wave 1/2/3 todos compliant** — 9 envs `*_REAL_ONLY` default `true`, todos gateados consistentemente; `/admin/p2-status` reporta `compliance_summary` accurate. (`lib/market-tips-shadow.js:1800`, `bot.js:7643/9176`, `server.js:14854-14864`, `lib/ev-calibration.js:89`, `lib/league-trust.js:72`, `lib/mt-auto-promote.js:451`, `lib/lol-kills-calibration.js:42`, `lib/readiness-learner.js:312`)

2. ✅ **Wave 4 (`GATE_OPTIMIZER_REAL_ONLY`) discovered + fixed em 2026-05-11** — gate-optimizer suggestions agora default `is_shadow=0`. (`lib/gate-optimizer.js:81-82`, `server.js:14869`). **NÃO documentado na memory** — recomendado atualizar CLAUDE.md/MEMORY.md.

3. ✅ **ML-auto-promote (`ML_AUTO_PROMOTE_REAL_ONLY`) — novo violator wave fixed proativamente** — segue mesmo pattern de mt-auto-promote: PROMOTE shadow OK (pre-promote eval), REVERT/LEAGUE real-only. (`lib/ml-auto-promote.js:8,12-27,32,212,276,294`). **NÃO documentado em wave lists** — adicionar ao P2-status endpoint pra surface.

4. ✅ **Detectores armados** — `shadow-vs-real-drift` (cron 24h, `bot.js:28685-28727`), `gate-attribution` (segunda 15h UTC, `bot.js:28991-29036`), `ai-shadow-audit-cron` (24h DM-only, `bot.js:28807-28837`), `cross-significance` daily (24h, `bot.js:28839-28932` — DM-only, "P2-compliant — sugestão somente"), `hg-neg-readiness` (24h DM-only, `bot.js:29147-29173`). Todos NON-action.

5. ⚠️ **P2 finding: novo opt-in `EV_CALIB_FALLBACK_SHADOW_SPORTS=tennis,mma` (2026-05-22)** — `lib/ev-calibration.js:96-101,143-161` permite shadow alimentar EV calib quando sport está starved. CLAUDE.md P2 explicitamente permite shadow alimentar calibration refit (research universe). **Mas o output (`mult`) multiplica stake real**. Justificativa do comentário (`P2-safe: shadow alimenta refit (research universe) — não vira decisão sintoma`) está debatível porque `getEvCalibrationMult()` SHRINKS stake (não block, não disable). Se shadow universe não é representativo (low-EV bucket), pode shrinkar stake real abaixo do ideal. **Não é P0 (mult não bloqueia), mas P1 — auditar empiricamente: tennis+mma estão setados em prod? Comparar OOS pré/pós activation.**

---

## 1. Re-audit Wave 1/2/3 (cada violator histórico)

### Wave 1 (commits eeb8af8 e anteriores) — 5 originais, default `true`:

| Env | Lib/path | Default check | Filter is_shadow=0 |
|---|---|---|---|
| `MT_LEAK_REAL_ONLY` | `lib/market-tips-shadow.js:1800` | ✅ default `true` | ✅ INNER JOIN tips `is_shadow=0 AND archived=0 AND result IN ('win','loss','void','push') AND ABS(julianday) < 14` (pattern canônico) |
| `MT_ROI_GUARD_REAL_ONLY` | `bot.js:7643` | ✅ default `true` | ✅ JOIN canônico cross-sport |
| `MT_BUCKET_GUARD_REAL_ONLY` | `bot.js:9176` | ✅ default `true` | ✅ JOIN canônico |
| `MT_VALIDATION_REAL_ONLY` | `server.js:20127-20128` | ✅ default `true` | ✅ Auto-disable em `runMtCalibValidationAlert` (`bot.js:26517-26594`) consume `/admin/mt-calib-validation` que JÁ aplica filter. `bot.js:26547-26553` então persist `auto_calib_gap` baseado em real-only output |
| `KILLS_CALIB_REAL_ONLY` | `lib/lol-kills-calibration.js:42` | ✅ default `true` | ✅ `lib/lol-kills-calibration.js:54` `AND COALESCE(t.is_shadow, 0) = 0` |

### Wave 2 (commit c618bd9) — 3 violators descobertos no re-audit, default `true`:

| Env | Lib/path | Status |
|---|---|---|
| `EV_CALIB_REAL_ONLY` | `lib/ev-calibration.js:89-90` | ✅ default `true`; `shadowFilter = realOnly ? "AND COALESCE(is_shadow, 0) = 0" : ''` |
| `LEAGUE_TRUST_REAL_ONLY` | `lib/league-trust.js:72,103-114` | ✅ default `true`; bloco shadow gated, primary SELECT já usa `AND COALESCE(is_shadow,0) = 0` (linha 88) |
| `MT_AUTO_PROMOTE_REAL_ONLY` | `lib/mt-auto-promote.js:451`, doc lines 19-22, JOIN canônico `:147-160` | ✅ default `true`; PROMOTE lê shadow puro (pre-promote eval P2), REVERT/LEAGUE lê REAL via INNER JOIN tips `is_shadow=0` |

### Wave 3 (commit cb016b7) — readiness-learner default flippado `is_shadow=1→0`:

- **snapshot** (`lib/readiness-learner.js:296-340`) — `isShadowVal` default `0` em snapshot byMarket + byLeague + bySportBucket
- **verify** (`lib/readiness-learner.js:794-813`) — comment `(P2 fix): default flippado shadow→real`. `WHERE is_shadow = ${isShadowVal}` com default 0
- **holdout search** (`lib/readiness-learner.js:199-208`) — `WHERE is_shadow = ${isShadowVal}`
- **opt-in OFF**: `READINESS_LEARNER_AUTO` default OFF (`server.js:14880-14881` confirma `note: 'opt-in OFF default'`). Memory: "NÃO ativar sem 1-2 ciclos dry_run validados"

**Veredicto Wave 1/2/3:** ✅ **100% compliant.** Nenhum regression desde último audit.

### Wave 4 (descoberto 2026-05-11, não estava em CLAUDE.md):

| Env | Lib/path | Status |
|---|---|---|
| `GATE_OPTIMIZER_REAL_ONLY` | `lib/gate-optimizer.js:81-82` | ✅ default `true`; `shadowFilter = realOnly ? 'AND COALESCE(is_shadow, 0) = 0' : ''` |

**Aparece em `/admin/p2-status` como `wave4_real_only_guards` (`server.js:14868-14870`).** Documentado na issue list (linha 14887-14890) mas CLAUDE.md P2 só menciona Wave 1/2/3. **Recomendação: atualizar CLAUDE.md P2 status para incluir Wave 4.**

### Wave 5 implícito — `ML_AUTO_PROMOTE_REAL_ONLY` (não documentado!):

| Env | Lib/path | Status |
|---|---|---|
| `ML_AUTO_PROMOTE_REAL_ONLY` | `lib/ml-auto-promote.js:32,412-413` | ✅ default `true`; comments line 27 "PROMOTE shadow ok, REVERT/LEAGUE real-only" |

**NÃO está no `/admin/p2-status` endpoint nem em CLAUDE.md.** Lê `is_shadow=1` (linha 277/294) só em path PROMOTE (shadow-only path, P2-explicit). REVERT/LEAGUE usa `tips is_shadow=0` via INNER JOIN. **Recomendação: adicionar a `wave2_real_only_guards` ou criar `wave5_real_only_guards` no endpoint `/admin/p2-status`.**

---

## 2. Caça de novos violators (cross-codebase grep)

### Padrão: `FROM market_tips_shadow` em path de decisão de sintoma

Lista completa dos consumers de `market_tips_shadow`:

| File:line | Path | Decisão de sintoma? | P2-compliant? |
|---|---|---|---|
| `lib/market-tips-shadow.js:389,424,616,630,...` | Storage/inserts próprios | n/a (write) | ✅ |
| `lib/clv-capture.js:115,149,193,256` | CLV capture pra shadow rows | ❌ não decide | ✅ |
| `lib/cross-significance.js:358` | Read shadow rows pra comparar com real | ❌ DM-only suggestion | ✅ (linha do msg `'P2-compliant — sugestão somente'`) |
| `lib/gate-attribution.js:152` | Counterfactual report shadow opcional | ❌ Source-toggle, DM only | ✅ (default real, `shadow=true` é opt-in pra cross-reference) |
| `lib/league-trust.js:114` | Gated por `LEAGUE_TRUST_REAL_ONLY=true` | ❌ skipped default | ✅ |
| `lib/lol-kills-calibration.js:70` | Calibration refit (research-permitted) | ❌ calib refit é P2-allowed | ✅ |
| `lib/lol-kills-calibration.js:184-201` evaluate auto-disable | Reports `action: 'disable_recommended'` | ⚠️ persiste em gates_runtime_state | ✅ comment "antes agregava direto, agora opt-out KILLS_CALIB_REAL_ONLY default true" — auto-disable agora baseado em real `JOIN tips is_shadow=0` |
| `lib/mt-auto-promote.js:221,253,311,341,373` | PROMOTE shadow / REVERT real | ❌ shadow-only PROMOTE = P2-allowed | ✅ |
| `lib/mt-permanent-disable.js`, `lib/mt-preflight.js:41` | preflight cruza shadow recente com disable | ❌ disclaimer `P2-compliant — preflight cruza disables ativos × shadow recente. recommended_action é decisão humana — NÃO auto-execute` (linha 207) | ✅ |
| `lib/brier-holdout-eval.js:98` | OOS isotonic eval — research only | ❌ comparison só, sem decisão | ✅ |
| `lib/readiness-learner.js` | NÃO lê market_tips_shadow (lê tips com is_shadow var) | n/a | ✅ Wave 3 fixed |
| `lib/shadow-vs-real-drift.js:71-251` | Drift detector DM-only | ❌ "NÃO automatiza ação. Apenas DM informativo" (linha 11) | ✅ |
| `lib/ev-calibration.js:143-161` | NEW shadow fallback opt-in `EV_CALIB_FALLBACK_SHADOW_SPORTS` | ⚠️ output mult MULTIPLICA stake real | ⚠️ **flagged P1** — vide finding #5 abaixo |

**Resultado:** Zero violators ativos. Todos os consumers de `market_tips_shadow` em paths de decisão são gateados por env `*_REAL_ONLY` (default `true`), são DM-only sugestões, ou são P2-explicit allowed paths (PROMOTE pre-promote, calibration refit).

### Padrão: `is_shadow = 1` em path de decisão real

| File:line | Context | P2-compliant? |
|---|---|---|
| `lib/ev-calibration.js:157` | DENTRO de bloco `if (realOnly && fallbackSports.length)` — opt-in explícito | ⚠️ vide #5 |
| `lib/gate-attribution.js:132,137` | Opt-in shadow source pra cross-reference report | ✅ default real |
| `lib/ml-auto-promote.js:212,276,294` | PROMOTE shadow path (pre-promote eval P2-allowed) | ✅ |
| `lib/pinnacle-auto-bet.js:317` | EXPLICIT BLOCK: `if (tipRow.is_shadow === 1) { skip }` | ✅ correto |
| `lib/readiness-learner.js:296` | Comment histórico — agora flippado | ✅ |
| `lib/shadow-vs-real-drift.js:101,201,251` | Drift detector — purpose é COMPARAR shadow vs real | ✅ DM only |

**Resultado:** Zero violators.

---

## 3. Endpoints informacionais — disclaimer compliance

### Endpoints com disclaimer "research-only" em payload (✅):

| Endpoint | Disclaimer location | Texto |
|---|---|---|
| `/admin/mt-shadow-by-league` | `server.js:24402` | `'shadow data is research-only — do NOT use for automated decisions; symptom treatment requires is_shadow=0 evidence (P2)'` |
| `/admin/ml-shadow-by-league` | `server.js:24549-24555` | Conditional shadow vs real disclaimer |
| `/admin/mt-shadow-by-line` | `server.js:24730-24731` | Conditional source=shadow/all disclaimer |
| `/admin/mt-shadow-by-ev` | `server.js:24796` | Standard research-only disclaimer |
| `/admin/blocklist-stats` | `server.js:30955-30957` | Research-only |
| `/shadow-readiness` | `server.js:33579,33818` | Conditional shadow source |
| `/admin/shadow-vs-real-snapshot` | implícito (return inclui `note` linha 14071) | ✅ "P2-safe read-only timeline" |
| `/admin/shadow-tier-divergence` (`server.js:24133`) | linha 24145 comentário "P2-safe via mode" | ⚠️ **falta disclaimer explícito no payload** — recomendação P2 |
| `/admin/cross-significance` (`server.js:13959`) | `server.js:13963` comment | ✅ "P2 compliant: read-only, sem auto-action. Suggestion text apenas (DM via cron Fase 2)" |
| `/admin/mt-promote-preflight` | `lib/mt-preflight.js:207` | ✅ `disclaimer: 'preflight cruza disables ativos × shadow recente. recommended_action é decisão humana — NÃO auto-execute. P2-compliant.'` |
| `/admin/mt-promote-explain` | `lib/mt-promote-explain.js:440` | ✅ "P2-compliant: research-only recommendation. NÃO auto-execute gate changes..." |

### ⚠️ Endpoint sem disclaimer explícito no payload:

- **`/admin/shadow-tier-divergence`** (`server.js:24121-24290`) — usa `market_tips_shadow` direto, retorna recomendações tier-aware ("Refit tier-aware vale"). Não vi `disclaimer:` no body do return. **P2 finding — adicionar disclaimer.**

### ⚠️ Endpoint `/admin/mt-shadow-revert-suspects` (`server.js:25886-26010`):

Apply mode (`apply=1`) faz UPDATE em `market_tips_shadow SET result=NULL` (reverte settlement). Não é P2 violation (mexe em shadow rows apenas, não disable real markets), mas é write op admin-gated. Sem disclaimer no payload mas safe-by-scope (só toca shadow universe).

---

## 4. Pattern canônico cross-sport — JOIN tips real

Confirmado canônico cross-sport (espelha CLAUDE.md):

```sql
INNER JOIN tips t ON
  t.sport = mts.sport
  AND UPPER(t.market_type) = UPPER(mts.market)
  AND COALESCE(t.is_shadow, 0) = 0
  AND (t.archived IS NULL OR t.archived = 0)
  AND t.result IN ('win','loss','void','push')
  AND ABS(julianday(COALESCE(t.sent_at, t.settled_at)) - julianday(mts.created_at)) < 14
  AND (norm participants matched both directions)
```

Verificado em:
- `lib/market-tips-shadow.js:1800` (leak guard, comment "espelha mt-result-propagator.js:155")
- `lib/lol-kills-calibration.js:54-65`
- `lib/mt-auto-promote.js:147-160` (commentado como "JOIN canônico market_tips_shadow ↔ tips real")
- `bot.js:7643` (ROI guard sided)
- `bot.js:9176` (bucket guard)
- `server.js:20127-20140` (mt-calib-validation realJoin)

**Veredicto:** Pattern unificado, sem drift cross-sport.

---

## 5. Calibration refit — shadow fallback (NOVA feature 2026-05-22)

### EV_CALIB_FALLBACK_SHADOW_SPORTS — auditar empiricamente

`lib/ev-calibration.js:96-101,143-161`:

```js
// Opt-in explícito via EV_CALIB_FALLBACK_SHADOW_SPORTS=tennis,mma (CSV).
// P2-safe: shadow alimenta refit (research universe) — não vira decisão sintoma.
const fallbackSportsRaw = String(process.env.EV_CALIB_FALLBACK_SHADOW_SPORTS || '').trim();
// ...
if (realOnly && fallbackSports.length) {
  // shadow rows merged into rows[] que vai pro aggregator
  // → impacta mult per (sport, market, tier, bucket)
}
```

**Análise P2:** Comment "shadow alimenta refit (research universe)" é correto em princípio — CLAUDE.md P2 PERMITE shadow alimentar calibration refit. Porém:

- O **output** desse refit é `mult` em `aggSportMarketTier`/`aggSportMarket`/`aggSport` → consumed por `getEvCalibrationMult()` → multiplicado em `stake` real (vide `utils.js:331`, `market-tip-processor.js:111`).
- Se shadow universe não é representativo (low-EV bucket distribuído differently de real), pode **shrinkar stake real abaixo do ideal**.
- Não é P0 (mult só SHRINKS stake, não bloqueia tip). Não é tratamento de sintoma (não dispara block).
- Ainda assim, **diferente de "shadow alimenta refit que cria calibração isotônica" (que é raw model probability adjustment) — aqui shadow influencia STAKE SIZE direto via multiplier sobre real bucket performance**.

**Recomendação P1:**
- Validar empiricamente: setar `EV_CALIB_FALLBACK_SHADOW_SPORTS` em prod?
- Comparar mult per (sport, bucket) pré/pós activation
- Se tennis tem `KELLY_TENNIS_HG_MEDIA=0.3` ALREADY (memory documenta), verificar se fallback shadow está rebaixando ainda mais via stake mult
- Adicionar comment em ev-calibration.js linha 96 reforçando: "ATENÇÃO: este merge afeta stake real via mult. Validar shadow universe representatividade antes de set CSV em prod."

### Calib refit cadence per sport

- Tennis: `tennis-markov-calib` watcher (`lib/tennis-markov-calib.js:_setupWatcher`) re-reads JSON em mtime change. Memory: refit fired 2026-05-25 ✅
- LoL: `lol-mt-calib.json` cron daily (cron 2026-05-23 evening reported)
- CS: `cs-mt-calib.json` (NEW 2026-05-21 commit 038f0db, antes não existia!)
- Dota2/Valorant: aguardam sample n≥30 shadow
- EV calib (cross-sport): refit em-memória cada cron call

### Calib stale (>7 dias) — bridge pra DM?

Procurei por `calib_stale` cron — não encontrado dedicated cron. CLV-stale alert existe (`bot.js`) mas não é calib. **Tech debt P2:** seria útil DM admin se markov calib JSON mtime > N dias.

---

## 6. mt-auto-promote logic — PROMOTE shadow / REVERT real

Confirmado em `lib/mt-auto-promote.js` doc lines 12-27:

```
1. PROMOTE (shadow→real): sport-level. Lê shadow puro (pre-promote eval P2).
2. REVERT (real→shadow): sport-level real (sintoma — sport JÁ em real).
3. LEAGUE_BLOCK/UNBLOCK: real (sintoma)
```

Two paths:
- `_shadowOnlyAgg()` (line 205-221) — pre-promote evaluation, P2-allowed
- `_realJoinAgg()` (line 238-253) — REVERT, JOIN canônico

Opt-out `MT_AUTO_PROMOTE_REAL_ONLY=false` reverte path REVERT pra shadow. **Default true.** ✅

Per-sport overrides (`MT_AUTO_PROMOTE_WINDOW_DAYS_<SPORT>`, `MT_AUTO_PROMOTE_EVAL_SINCE_<SPORT>`, `MT_AUTO_PROMOTE_MIN_SETTLED_<SPORT>`) listados em `/admin/p2-status` (`server.js:15724-15737`) — visibility OK.

---

## 7. Shadow-vs-real-drift detector

`lib/shadow-vs-real-drift.js`:
- Doc line 11: "P2 compliance: NÃO automatiza ação. Apenas DM informativo. Decisão (revert/disable) fica humana."
- Cron 24h cooldown (`bot.js:28685-28727`). Trigger 40min pós-boot.
- Reads BOTH `is_shadow=1` (lines 101, 201) AND `is_shadow=0` (lines 159, 232) — purpose é COMPARAR ambos.
- DM com gap+drop signature (default 5pp gap, 3pp drop). Dedup 24h.
- `SHADOW_VS_REAL_DRIFT_AUTO` default `true` (linha 32, `bot.js:28693`).
- `/admin/shadow-vs-real-snapshot` (`server.js:14371`) é endpoint snapshot completo. ✅

---

## 8. Gate-attribution counterfactual

`lib/gate-attribution.js`:
- Doc line 15: "P2 compliance: lê APENAS is_shadow=0 (real settled). Shadow não entra."
- Real-only por default (linha 124 `WHERE COALESCE(is_shadow, 0) = 0`).
- Opt-in `shadow=true` opcional (linha 114, 132-137) pra cross-reference — não default.
- Cron: segunda 15h UTC (`bot.js:28991-29036`). DOW=1, hour_utc=15. ✅
- Métrica: `saved_loss` (gate blocked, tip teria sido loss) vs `lost_profit` (gate blocked, tip teria sido win). Top 5 por `|net|`.
- `GATE_ATTRIBUTION_AUTO` default `true`.

---

## 9. P2 single source of truth — /admin/p2-status

`server.js:14839-14950`:

**Reportado:**
- `wave1_real_only_guards`: 5 envs (MT_LEAK/MT_ROI_GUARD/MT_BUCKET_GUARD/MT_VALIDATION/KILLS_CALIB)
- `wave2_real_only_guards`: 3 envs (EV_CALIB/LEAGUE_TRUST/MT_AUTO_PROMOTE)
- `wave4_real_only_guards`: 1 env (GATE_OPTIMIZER) ← **não documentado em CLAUDE.md/MEMORY.md**
- `detectors_p2_compliant`: SHADOW_VS_REAL_DRIFT_AUTO, GATE_ATTRIBUTION_AUTO, ROI_CUSUM_DISABLED
- `readiness_learner`: includes note pos-Wave 3
- `frozen_holdout`: `default_days` + recommended_min 60
- `auto_promote_per_sport_overrides`: ml + mt
- `compliance_issues`: array com {env, severity, issue}
- `compliance_summary`: `✅` ou `⚠️ N issue(s)`

**Issue list gera:**
- P0 se qualquer wave env é `false`
- P2 se detector OFF
- P1 se `FROZEN_HOLDOUT_DAYS < 60`

**Gap: NÃO inclui `ML_AUTO_PROMOTE_REAL_ONLY`** — adicionar em `wave2_real_only_guards` ou criar `wave5`.

**Gap: NÃO inclui `EV_CALIB_FALLBACK_SHADOW_SPORTS` value** — apesar de P2-safe by design, surface da config seria útil pra admin verificar.

---

## 10. Readiness-learner activation status

- `READINESS_LEARNER_AUTO` default OFF (memory: "NÃO ativar sem 1-2 ciclos dry_run validados")
- `server.js:14880-14881` note: "opt-in OFF default; pós Wave 3 (commit cb016b7) snapshot+verify+holdout default flippado is_shadow=1→0. Validar com POST /admin/readiness-learner-run?dry_run=1 antes de ON."
- Pre-condition pra activate: rodar `POST /admin/readiness-learner-run?dry_run=1&days=30` 1-2x, validar `r.applied` + `r.verified`.
- **Status atual:** ainda OFF — memory não documenta validação dry_run feita.

---

## 11. Cross-sport learnings — novos sports

Memory documenta novos paths sport (basket_q, fb1h, snooker, tt, darts, CS-rounds, val-rounds). Audit:

- `lib/cs-rounds-model.js` (`scanCsRoundsMarkets`): pricer pure, sem read de tips/shadow — ✅ não afeta P2
- `lib/football-1h-model.js`: sem grep hit em `is_shadow|FROM tips|market_tips_shadow|disable` — pricer/predictor pure
- `lib/basket-mt-scanner.js`: sem grep hit
- `lib/darts-ml.js`, `lib/snooker-ml.js`, `lib/darts-mt-scanner.js`, `lib/snooker-mt-scanner.js`: sem grep hit — todos pure-prediction libs

**Veredicto:** Novos sports não introduziram violators. Pricers são pure (input pricing → output EV) sem touch de DB tips. Auto-promote/leak guards iteram via `SPORTS` array genérico e captam novos sports automaticamente.

---

## 12. AI shadow audit cron

`lib/ai-shadow-audit-cron.js`:
- Doc: "monitoring detector pra tips AI shadow/real ... AI shadow tips (via _runAiShadow) são settled em match_results mas NÃO alimentam nenhum learner ML existente"
- Cron 24h (`bot.js:28807-28837`). DM-only ("P2-compliant — apenas info").
- Triggers: `ROI < AI_AUDIT_ROI_FLOOR` (-15%) OR `avgEV > AI_AUDIT_EV_CEILING` (30%) com `n >= AI_AUDIT_MIN_N` (20).
- Source: tips table via `tip_reason LIKE 'AI shadow POC%' OR LIKE 'AI ML %' OR LIKE '%DeepSeek%'` (`lib/ai-shadow-audit-cron.js`).
- **Covers BOTH real + shadow universes** — mas é monitoring (não decisão).
- `AI_SHADOW_AUDIT_AUTO` default `true`. ✅

---

## 13. HG-neg-readiness (Tennis HG- monitor)

`lib/hg-neg-readiness.js`:
- Doc line 6: "P2-compliant: só ALERTA admin (não auto-action). Decisão (refit calib, ajustar Kelly hierarchy) fica humana."
- Source: `tips WHERE COALESCE(is_shadow, 0) = 0 AND sport = 'tennis' AND market_type = 'HANDICAP_GAMES'` — ✅ real-only
- Cron 24h (`bot.js:29147-29173`). DM-only.
- `HG_NEG_READINESS_AUTO` default `true`. ✅

---

## 14. CSA (Cross-Significance Analyzer) — **action: KELLY_CUT investigado**

⚠️ **Concern:** `lib/cross-significance.js:501` retorna `{ action: 'KELLY_CUT', mult: 0.70, note: 'shadow IC95 ROI hi confirma leak' }`.

**Verificação:** Esse `action` é APENAS texto em payload de alerta para DM. Confirmado em:
- `bot.js:28912-28932` — `runCsaDaily` formatá em string Telegram `${a.suggestion ? '\n  ➜ ' + a.suggestion : ''}` e envia DM
- Mensagem termina com `"P2-compliant — sugestão somente. Decisão humana."` (`bot.js:28929`)
- Grep `'KELLY_BOOST'|'KELLY_CUT'` cross-codebase retornou ZERO outros callers além de definition e mention em response

✅ **Não viola P2.** Suggestion é text only, never applied.

---

## 15. Auto-promote shadow→real path (PROMOTE shadow)

Documentado e P2-explicit em:
- `lib/mt-auto-promote.js:19,205-221` (`_shadowOnlyAgg`)
- `lib/ml-auto-promote.js:12,276-294`

Ambos são **pre-promote evaluation** — P2 explicitamente permite (linha CLAUDE.md "Pre-promote evaluation quando sport ainda não tem real volume").

Per-sport window narrowing via `<MT|ML>_AUTO_PROMOTE_WINDOW_DAYS_<SPORT>` reduz risk de promote baseado em janela ampla velha.

`MT_AUTO_PROMOTE_REQUIRE_CI` default `true` + `MT_AUTO_PROMOTE_CI_LOWER_THRESHOLD` default `0` exige IC95% lower > 0 antes de promote. Conservador. ✅

---

## 16. Pendências/Tech debt observadas

1. **Adicionar `ML_AUTO_PROMOTE_REAL_ONLY` ao endpoint `/admin/p2-status`** — atualmente não é tracked. (server.js:14854-14864)
2. **Adicionar `EV_CALIB_FALLBACK_SHADOW_SPORTS` value ao `/admin/p2-status`** — visibility da config (mesmo P2-safe, surface da choice é útil)
3. **Documentar Wave 4 (GATE_OPTIMIZER_REAL_ONLY) em CLAUDE.md P2 status section** — atualmente só Wave 1/2/3 mencionados
4. **Documentar Wave 5 implícito (ML_AUTO_PROMOTE_REAL_ONLY) em CLAUDE.md**
5. **Disclaimer no payload de `/admin/shadow-tier-divergence`** — endpoint não tem `disclaimer` explícito (apesar de comentado P2-safe internamente)
6. **Audit empírico de `EV_CALIB_FALLBACK_SHADOW_SPORTS=tennis,mma`** se setado em prod — comparar mult per bucket pré/pós activation
7. **Calib stale cron** — não há DM se markov-calib JSON mtime > N dias (atualmente só CLV stale)

---

## Cross-sport (P5) verification

Pattern P2 é cross-sport por construção (libs iteram `SPORTS` array genérico). Verificado:
- `lib/market-tips-shadow.js`, `lib/league-trust.js`, `lib/ev-calibration.js`, `lib/mt-auto-promote.js`, `lib/ml-auto-promote.js`, `lib/kelly-auto-tune.js`, `lib/gate-optimizer.js` — todos sport-agnostic
- Detectores (`shadow-vs-real-drift`, `gate-attribution`, `ai-shadow-audit-cron`) iteram `SPORTS` array
- `_isShadowDispatch(rec, sport)` em bot.js generic — não há sport miss em path emit

Cross-check: novos sports (basket_q/fb1h/cs-rounds/val-rounds/darts/snooker/tt) — auto-coberto pelos guards genéricos via `sport` field em market_tips_shadow + tips tables.

---

## Conclusão

**Sistema P2-compliance está em estado robusto.** Wave 1/2/3 holds. Wave 4 (GATE_OPTIMIZER) e Wave 5 (ML_AUTO_PROMOTE) implementados mas não documentados em CLAUDE.md. Detectores armed. Disclaimers em quase todos endpoints informacionais. CSA suggestion texts são DM-only. Calibration shadow fallback (`EV_CALIB_FALLBACK_SHADOW_SPORTS`) é P2-safe by design mas merece audit empírico se ativo.

**Próximas ações sugeridas (não aplicadas):**
1. Adicionar `ML_AUTO_PROMOTE_REAL_ONLY` + `GATE_OPTIMIZER_REAL_ONLY` doc em CLAUDE.md P2 section
2. Adicionar disclaimer no payload de `/admin/shadow-tier-divergence`
3. Verificar prod env `EV_CALIB_FALLBACK_SHADOW_SPORTS` value via `/admin/env-audit`
4. Considerar adicionar `compliance_issues` warn quando `EV_CALIB_FALLBACK_SHADOW_SPORTS` não-empty (semi-violação de pureza)
