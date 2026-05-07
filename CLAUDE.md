# Premissas arquiteturais — não podem ser violadas

Este arquivo lista os princípios fundamentais do projeto. **Toda análise, correção, refactor e nova feature deve respeitar essas regras.** Violações precisam de justificativa explícita do user (não decisão unilateral).

---

## P1 — Granularidade primeiro

**Regra:** Toda análise e correção deve considerar a granularidade adequada — não tratar o sport/sistema como bloco único quando há sub-partições com comportamento heterogêneo.

**Por quê:** Performance agregada esconde leaks/edges localizados. ROI overall +5% pode mascarar tier1 +15% / tier2 -8%. Calibração monolítica subajusta tier-specific (caso tennis ATP Challenger leak 2026-05-07: shadow ROI -2.3% overall, mas Challenger sozinho -12.6%; refit por tier necessário).

**Como aplicar — dimensões a considerar antes de qualquer decisão:**

1. **Sport** (lol/cs/dota/valorant/tennis/football/basket/mma/darts/snooker/tt) — não generalizar entre sports
2. **Tier** dentro do sport — esports (tier1/tier2/other), tennis (Slam/Masters/250-500/Challenger/ITF), football (top5/UEFA/BR/continental), basket (NBA/Euroleague/regional), mma (UFC/Bellator/regional)
3. **League** — tier sozinho às vezes não captura (CBLOL ≠ LFL apesar de ambos tier2)
4. **Market** — ML, handicap, totals (under/over), kills, MAP_WINNER, AH, BTTS, etc.
5. **Side** — over/under, home/away, team1/team2, draw — tratamentos podem ser direcionais
6. **Bucket de odd** — 1.4-1.6 / 1.6-2.0 / 2.0-2.5 / 2.5-4.0 / >4.0 — leaks tipicamente concentram em buckets
7. **Confidence** (ALTA/MÉDIA/BAIXA) — tratamento por tier de confidence
8. **Período/regime** — pré/live, pre-match/in-play, regimes históricos (split changes 2026-04-22)
9. **Bo3 vs Bo5** — formato muda matemática (totais, sweep prob)

**Anti-patterns (NÃO fazer):**
- ❌ "Tennis ROI -2% → bloquear tennis MT global"
- ❌ "LoL UNDER 2.5 ruim → desativar UNDER 2.5 todo"
- ❌ "Calib monolítica para todos os sports/tiers"
- ❌ Refit modelo só com sample agregado (sem split per-tier)
- ❌ Dashboard só com KPI overall, sem breakdown granular

**Patterns (fazer):**
- ✅ Por padrão buckets em qualquer análise (bucket × tier × side é mínimo)
- ✅ Schema v2 tier-aware (caso tennis Markov calib: `markets.X.tiers[tier].bins`)
- ✅ Env hierarchy: `<SPORT>_<PARAM>_<TIER>` > `<SPORT>_<PARAM>` > default
- ✅ Filtros em endpoints `/admin/*-by-league` / `/admin/shadow-tier-divergence` permitem audit per-granularidade
- ✅ Quando sample tier é insuficiente (n<20), fallback default (não decidir)

**Status atual no projeto:**
- ✅ Tennis Markov calib v2 (tier-aware) — schema implementado
- ✅ LoL momentum env tier-aware (LOL_MOMENTUM_TIER1/TIER2/OTHER)
- ✅ CS2/Dota/Val momentum tier-aware (commit 95cc4a0)
- ✅ Endpoint `/admin/shadow-tier-divergence` cross-sport
- ✅ MT leak guards com side+tier+league granularidade (mig 091)
- ✅ EV calibration data-driven per (sport, bucket)
- ⚠️ Tech debt: 3 tier classifiers paralelos não unificados (LoL inline / lib/league-tier numeric / endpoint inline)

---

## P2 — Shadow=causa, Real=sintoma

**Regra:** Análise de tips shadow é estritamente para entender CAUSA (calibração, regime change, model drift). Tratamento de SINTOMA (block, disable, cap, throttle) só pode ser triggered por dados de tips reais (`is_shadow=0`).

**Por quê:**
- Shadow é research universe — captura tips com EV ≥ 0% (shadowMinEv default 0)
- Real é dispatched universe — passou todos gates (EV ≥ minEv, oddOk, maxPerMatch, league trust, etc)
- Shadow ROI é estruturalmente menor que real ROI (low-EV bucket pesa shadow pra baixo)
- Auto-disable baseado em shadow → bloqueia coleta de research → feedback loop ruim
- Caso histórico: 69 markets bloqueados equivocadamente por leak guards lendo shadow direto (2026-05-06)

**Como aplicar:**

**Shadow data PODE alimentar:**
- ✅ Calibration refit (todas predições com outcomes reais — universo correto)
- ✅ Reports/digests pra humano analisar e decidir
- ✅ A/B comparison (shadow vs shadow filtered)
- ✅ Tier divergence audit (`/admin/shadow-tier-divergence`)
- ✅ Gate optimizer suggest-only mode
- ✅ Detecção de drift de modelo (warn → human review)
- ✅ Pre-promote evaluation quando sport ainda não tem real volume (caso football MT promote check)

**Shadow data NÃO PODE:**
- ❌ Auto-disable markets/sides/leagues
- ❌ Auto-set caps de odd/EV/Kelly
- ❌ Auto-flip sport para shadow-only mode
- ❌ Trigger alert "disable_recommended" sem human review
- ❌ Bloquear emissão de tips real

**Real data (`tips WHERE is_shadow=0 AND archived=0`) DEVE alimentar:**
- ✅ Leak guard (CLV/ROI auto-disable)
- ✅ Kelly auto-tune
- ✅ League trust score
- ✅ Bankroll Guardian flips
- ✅ Permanent disable list

**Pattern padrão para crons que decidem (cross-sport):**
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

Use env opt-out `<COMPONENT>_REAL_ONLY=true` (default) para preservar comportamento.

**Status atual no projeto (2026-05-07):**
- ✅ 9/9 violators corrigidos. Wave 1 (5 originais, commits eeb8af8 e anteriores):
  - runMarketTipsLeakGuard (`MT_LEAK_REAL_ONLY`)
  - runMarketTipsRoiGuardSided (`MT_ROI_GUARD_REAL_ONLY`)
  - runMtBucketGuardCycle (`MT_BUCKET_GUARD_REAL_ONLY`)
  - /admin/mt-calib-validation auto-disable (`MT_VALIDATION_REAL_ONLY`)
  - computeKillsCalibration (`KILLS_CALIB_REAL_ONLY`)
- ✅ Wave 2 (re-audit "verifique se shadow está puro", commit c618bd9):
  - lib/ev-calibration (`EV_CALIB_REAL_ONLY` — flippado false→true; mult que multiplica stake real não pode ter shadow contaminando)
  - lib/league-trust (`LEAGUE_TRUST_REAL_ONLY` novo; trust ratio aplicado em stake real era misturado com market_tips_shadow)
  - lib/mt-auto-promote (`MT_AUTO_PROMOTE_REAL_ONLY` novo; PROMOTE shadow=ok/eval, REVERT/LEAGUE=real/sintoma)
- ✅ Wave 3 (commit cb016b7): readiness-learner snapshot+verify+holdout default flippado is_shadow=1→0
- ✅ Detectores P2-compliant adicionais:
  - lib/shadow-vs-real-drift (cron 24h) — early warning quando shadow ROI degrada e real ainda OK
  - lib/gate-attribution (cron weekly) — counterfactual: saved_loss vs lost_profit per gate
- ⚠️ Tech debt menor: ~3 endpoints informacionais display shadow data sem disclaimer "research-only" (mt-shadow-by-league é misleading — feedback prévio em memory)

**Quando flagrar shadow ROI ruim:**
1. Próximo passo é INVESTIGAR CAUSA — não bloquear
2. Hipóteses: model bias? data source? regime change? calibração desatualizada? sample pequeno?
3. Soluções na causa: refit calib, tier-aware schema, env override, model rollback
4. Bloqueio só se já houver real data confirmando o leak

---

## Como adicionar premissas novas

Quando o user lembrar de outro princípio fundamental:
1. Adicione como `## P<n> — <título>` neste arquivo
2. Estruture com Regra / Por quê / Como aplicar / Anti-patterns / Patterns / Status
3. Atualize a memory `feedback_*.md` correspondente
4. Cross-reference em `memory/MEMORY.md` na seção "Princípios arquiteturais"

---

## Convenções para violações

Se em algum momento for necessário violar uma premissa (caso edge raro), o commit message deve:
1. Citar explicitamente qual premissa está violando (`P1`/`P2`)
2. Justificar por quê é exceção
3. Listar plano de retorno à conformidade (se aplicável)

Sem essa transparência, qualquer violação é code smell que precisa ser refactorada.

---

## Configurações operacionais recomendadas (Railway env)

Defaults que devem estar setados em prod além dos opt-ins padrão:

### Overfitting protection (auto-tunes)

```
FROZEN_HOLDOUT_DAYS=60
```

**Por quê:** auto-tunes (kelly_auto_tune, mt_auto_promote, gates_autotune, ev_calibration, learned_corrections, readiness_learner, leak/bucket guards) treinam em janela rolling 30-90d. Sem holdout, decisão "promote MT" / "tune kelly_mult" é tomada usando dados que serão re-avaliados pelos mesmos sistemas — overfitting estrutural. Defaults atuais com `FROZEN_HOLDOUT_DAYS=0` (OFF) deixam todos vulneráveis.

**Tradeoff:** auto-tunes ficam menos reativos (60d pra incorporar regime change novo). Aceitável vs churn em ruído. Override per-sistema disponível (`FROZEN_HOLDOUT_KELLY_DAYS=120` etc).

**Validação:** `GET /admin/holdout-status` (admin auth) retorna `{ default_days, per_system: {kelly: {days, cutoff_iso}, mt_auto_promote: {...}, ...} }`. Confirmar que `default_days >= 60` em prod.

### Shadow vs real drift detection

```
SHADOW_VS_REAL_DRIFT_AUTO=true   # default já é true
```

P2-compliant: só DM admin, sem auto-action. Cron 24h às 8h local. Detecta modelo base degradando enquanto gates mascaram em real.

### Gate attribution counterfactual

```
GATE_ATTRIBUTION_AUTO=true       # default já é true
```

Cron seg 15h UTC. DM admin com top 5 gates por |saved_loss − lost_profit|. Identifica gates cortando edge.

### Readiness learner (opt-in OFF)

```
# READINESS_LEARNER_AUTO=true    # NÃO ativar sem 1-2 ciclos dry_run validados
```

Após Wave 3 fix (commit cb016b7) está P2-compliant — snapshot+verify+holdout usam `is_shadow=0`. Recomendação antes de ON: rodar `POST /admin/readiness-learner-run?dry_run=1&days=30` 1-2x e revisar `r.applied` + `r.verified`.
