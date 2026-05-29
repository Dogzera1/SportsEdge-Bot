# Financial Audit — SportsEdge-Bot
**Data:** 2026-05-25
**Scope:** Kelly fraction / EV / stake / bankroll / auto-bet / settle math
**Method:** Read-only static audit. Não modificou código.

---

## TL;DR

- **P0 (afeta dinheiro AGORA): 0**
- **P1 (afeta dinheiro EM CONDIÇÃO): 6**
- **P2 (info/improvement): 9**

A arquitetura financeira está em estado defensivo razoável após os 21 commits de audit em 2026-05-19/05-21/05-24. `KELLY_PRODUCT_CAP_FRAC=0.15` enforce em `_applyKelly` (lib/utils.js:356) + `kellyStakeForMarket` (lib/market-tip-processor.js:186) é o último-bastião contra explosão composta de multipliers. `MAX_STAKE_UNITS=15` (env) + `MARKET_TIP_MAX_STAKE_UNITS=2` (hardcode default em `lib/market-tip-processor.js:35`) tampam o stake absoluto. Bankroll update é atômico em `db.transaction()` cross-sport (server.js:4915-4924). Nenhum P0 com impacto AGORA detectado.

Top 5 issues prioritárias estão listadas no fim do relatório.

---

## CONTEXTO DE PROTEÇÕES JÁ IMPLEMENTADAS

Antes de listar findings, registrar safety net existente:

### Kelly composition cap (lib/utils.js:363, lib/market-tip-processor.js:194)
```js
const _KELLY_PRODUCT_CAP = parseFloat(process.env.KELLY_PRODUCT_CAP_FRAC || '0.15');
if (frac > _KELLY_PRODUCT_CAP) { _effFrac = _KELLY_PRODUCT_CAP; }
```
Aplica em **AMBOS** paths (ML via `_applyKelly`, MT via `kellyStakeForMarket`). Limite: 0.15 = 1.5× SAGRADO `MAX_KELLY_FRAC=0.10`.

### Final stake cap (server.js:28286)
```js
const _maxStakeUnits = Math.max(1, parseFloat(process.env.MAX_STAKE_UNITS || '15'));
if (_stakeUnitsCurrent > _maxStakeUnits) { _stakeUnitsCurrent = _maxStakeUnits; t.stake = `${_maxStakeUnits}u`; }
```
Cap em `/record-tip` ANTES do INSERT — proteção contra payload atacante.

### MT stake cap dupla
- `MARKET_TIP_MAX_STAKE_UNITS=2` (default, hardcoded em lib/market-tip-processor.js:35)
- Após `MARKET_TIP_MAX_STAKE_UNITS` clamp, ainda passa por `applyGlobalRisk` (cap, drawdown, perf, leagueMult) em bot.js:7398-7420

### EV sanity cap (server.js:28275)
```js
const _evCap = parseFloat(process.env.RECORD_TIP_EV_CAP_PCT || '50');
if (!t.isShadow && evN > _evCap) { _emitSkip('ev_sanity_cap'); return; }
```

### Bankroll atômico (server.js:4915-4924)
```js
db.transaction(() => {
  db.prepare(`UPDATE tips SET result=?, stake_reais=?, profit_reais=? WHERE id=? AND result IS NULL`)...
  if (!tip.is_shadow) {
    db.prepare(`UPDATE bankroll SET current_banca = round(current_banca + ?, 2) WHERE sport=?`)...
  }
})();
```
**Atomic single-row** (`+= profitR` via SQL — sem read-then-write TOCTOU).

### Last-line dedup (server.js:29206)
```sql
SELECT id ... WHERE sport=? AND match_id=? AND market_type=? AND tip_participant=?
  AND is_shadow=0 AND (result IS NULL OR result NOT IN ('void','push'))
```
Imediatamente antes de `stmts.insertTip.run()`. + idx unique `idx_tips_unique_active` (mig 120) backstop UNIQUE constraint race → classifica `409` + log `INFO` (server.js:29365-29370).

---

# P0 FINDINGS

**Nenhum P0 detectado** que afete dinheiro AGORA. Os bugs históricos P0 dos commits 812830b (5 auto-bet fixes), ade938a (shadow gate cross-sport), 593607a (record-tip catch scope), 97b23e2 (tips-history dedup) e 9a7f715 (MT auto-bet wire) estão corrigidos e verificados.

---

# P1 FINDINGS (afeta dinheiro EM CONDIÇÃO)

## P1-1: getKellyFraction cap erróneo do baseFraction em `<= 1` permite Kelly fraction = 1.0
**Files:** `bot.js:6285-6298`
```js
if (mktNorm && baseFraction == null) {
  const perSportMarket = process.env[`KELLY_${spEnv}_${mkEnv}_${key}`];
  if (Number.isFinite(v) && v > 0 && v <= 1) baseFraction = v;  // ← v <= 1 PERMITE 0.999
}
```
Validação `v <= 1` permite envs como `KELLY_TENNIS_HANDICAP_GAMES_ALTA=1.0` (= 100% Kelly = blow-up). Apenas `_KELLY_PRODUCT_CAP=0.15` em `_applyKelly` salva — mas se user explicitar `KELLY_PRODUCT_CAP_FRAC=1.0` no Railway (override CRITICAL), nenhuma rede existe.
**Impacto:** condicional (precisa env malformed + KELLY_PRODUCT_CAP_FRAC overridden). Risk alto se autorelay typo.
**Fix sugerido:** cap inline `v <= 0.50` (~5× max Kelly) ao invés de `<= 1`. Limite o que pode ser dado pelo user via env.

## P1-2: Steam BOOST mult aplicado FORA do cap KELLY_PRODUCT_CAP
**Files:** `bot.js:3792, 3792, 4387, 4393, 17846`
```js
kellyFraction = kellyFraction * _clvAdjLive.mult;  // CLV cap 1.5
kellyFraction = kellyFraction * _steamLive.mult;    // Steam cap 1.5 (STEAM_BOOST_MAX_MULT default 1.50)
const tipStake = calcKellyWithP(modelPForKelly, tipOdd, kellyFraction, ...);
```
Composição: baseFraction × CLV (até 1.5) × Steam (até 1.5) = até `0.10 × 1.5 × 1.5 = 0.225` antes de entrar em `_applyKelly`. Ali o `KELLY_PRODUCT_CAP_FRAC=0.15` corta — mas em paths legados ou environments custom (cap > 0.15), Steam+CLV podem compor 2.25× sobre baseline. **Audit P0-2 fix (commit `bb7849a` 2026-05-21)** clamp `_effFrac × evMult` mas Steam não entra nesse cap chain — entra ANTES.
**Impacto:** condicional. `_KELLY_PRODUCT_CAP` cap funcional defende. Mas defense-in-depth não inclui Steam.
**Recomendação:** registrar Steam boost no log `KELLY_PRODUCT_CAP_FRAC` audit + considerar normalizar a chain (CLV ×, tier ×, trust ×, autotune ×) ANTES de aplicar Steam.

## P1-3: STEAM_BOOST aplica process.env mutation (mas é safe — call sync)
**Files:** `lib/velocity-tracker.js:209-218`
```js
const windowPrev = process.env.VELOCITY_WINDOW_MIN;
process.env.VELOCITY_WINDOW_MIN = process.env.STEAM_BOOST_WINDOW_MIN || '10';
// ... checkVelocity é sync ...
if (windowPrev !== undefined) process.env.VELOCITY_WINDOW_MIN = windowPrev; else delete process.env.VELOCITY_WINDOW_MIN;
```
**Confirmado seguro hoje** porque `checkVelocity` é função sync (verificado lib/velocity-tracker.js:49) — Node.js single-threaded JS event loop não interrompe entre a mutação e restore.
**Impacto:** P2 (improvement). MAS: se algum dev futuro tornar `checkVelocity` async ou adicionar `await` no meio, criará race. Robust fix: passar opts inline ao invés de mutar env.

## P1-4: `unit_value` tier-aware = ratio current_banca / initial_banca pode subcharger
**Files:** `lib/sport-unit.js:62-72`, `server.js:4879-4901`
Quando a `current_banca` cai abaixo do `initial_banca` (drawdown 60%+ → tier `0.50`), todas as tips FUTURAS pagam stake em escala menor:
- pré-DD: 1u = R$1.00
- pós-DD: 1u = R$0.50

Race window: settle vai usar `stake_reais` STORED se disponível (linha 4890). MAS quando stake_reais é NULL (tips legacy ou bug de insertTip path), fallback recompute via tier ATUAL — gerando inconsistência.
**Fix histórico já aplicado em server.js:4894-4897** ("audit P1-6"): fallback usa `initial_banca` (ratio=1.0 = tier base) para evitar subcharge/overcharge. Mas:
- Recompute paths em server.js:10614-10623 e 10718-10725 (sweep settle path) usam `bk?.current_banca || 0` — INCONSISTENTE com o fix mais recente em 4894.
**Impacto:** tips legacy sem stake_reais stored podem ser settled com magnitude errada.
**Lugar:** `server.js:10614` e `server.js:10718` deveriam mirror `server.js:4894-4897` (usar initial_banca).
**Devil's advocate:** sample de tips sem stake_reais legacy é provavelmente pequeno em 2026 (mig 026 já aplicado). Mas vale a normalização.

## P1-5: MT path `recordMarketTipAsRegular` aplica `MT_GLOBAL_RISK_DISABLED` opt-out
**Files:** `bot.js:7397`
```js
if (!/^(1|true|yes)$/i.test(String(process.env.MT_GLOBAL_RISK_DISABLED || ''))) {
  // applyGlobalRisk (drawdown taper, KELLY_<SPORT>_MULT, daily stop, banca drained)
}
```
Opt-out de **emergency** documentado. Se user set `MT_GLOBAL_RISK_DISABLED=true` no Railway, MT bypassa TODOS gates do applyGlobalRisk — incluindo `banca_drained` (bot.js:6395). Tipo de gateway que precisa de visual audit periódico.
**Impacto:** condicional. Default OFF (=ON applyGlobalRisk). Se opt-in ativo + DD severo + sport drained, stake passa.
**Fix sugerido:** documentar em `/admin/p2-status` se essa env está ativa + WARN no boot.

## P1-6: `getLeagueTrust` shadow path tem fallback raro mas `_conflictCount` log pode confundir auditoria
**Files:** `lib/league-trust.js:113-145`
Dedup de market_tips_shadow tracking results conflicting (linha 136-141) loga WARN mas continua processando — o "valor mais recente created_at" pode ser o LOSS que sobrescreveu um WIN prévio (settle bug). `roi` resultante pode ser distorcido.
**Impacto:** P1 baixo. Atualmente `LEAGUE_TRUST_REAL_ONLY=true` (default) skipa esse bloco shadow inteiro (linha 109 — `if (!realOnly) { ... }`). Só dispara em config legacy.
**Fix sugerido:** já adequado pelo default real-only. Manter monitoramento via DM `WARN, LEAGUE-TRUST, dedup conflicts` em logs.

---

# P2 FINDINGS (info/improvement)

## P2-1: `MARKET_TIP_MAX_STAKE_UNITS` cap aplica APÓS evMult/throttle, **antes** de `applyTrustToStake`
**Files:** `lib/market-tip-processor.js:262-265`
```js
let units = fractional * totalBankrollUnits;
const cap = Number.isFinite(capEnv) && capEnv > 0 ? capEnv : DEFAULT_MAX_STAKE_UNITS; // 2
if (units > cap) units = cap;
return snapStakeUnits(units);  // 0.5u step
```
Stake máximo retornado: 2u (hardcode). Mas `_mtTryRecordAndShouldDm` em bot.js:7330 pode aplicar **market_mult até 2.0×** (linha 7368-7371) DEPOIS do stake retornado pela `kellyStakeForMarket`. Logo `stake` final pode chegar a 4u sem precisar de cap raise. **Bom defense-in-depth** mas confuso pra debug — DM mostra "Kelly 0.10 fracionário" mas stake é market_mult applied.
**Recomendação:** padronizar telemetria (log INFO no recordMarketTipAsRegular qual cap foi acionado se houver).

## P2-2: `_KELLY_DEFAULTS = { ALTA: 0.25, MEDIA: 1/6, BAIXA: 0.10 }` em bot.js:6160 não cita SAGRADO 0.10
**Files:** `bot.js:6160`, `lib/market-tip-processor.js:29`
- bot.js ML path: `ALTA = 0.25` (4×SAGRADO)
- MTP: `MAX_KELLY_FRAC = 0.10` (=SAGRADO)
**Não é bug** — bot.js applies em `calcKellyWithP` que passa pra `_applyKelly` que cap em 0.15. Mas o comment em CLAUDE.md "MAX_KELLY_FRAC = 0.10" sugere SAGRADO = 0.10. ALTA 0.25 só é safe porque o cap 0.15 corta. Importante saber: se cap removed, ALTA = 25% Kelly por padrão é uma exposição enorme.
**Recomendação:** comment explícito no CLAUDE.md "ML path usa 0.25/0.167/0.10 mas KELLY_PRODUCT_CAP_FRAC=0.15 cap effective product".

## P2-3: `calcKellyFraction(evStr, oddsStr, ...)` deriva p de EV (circular)
**Files:** `lib/utils.js:325`
```js
const p = (ev + 1) / odds;  // p derivado de EV
return _applyKelly(p, odds, frac, opts);
```
Comment já reconhece "aproximação quando p do modelo não está disponível". Caller LoL ML usa `calcKellyWithP(modelPForKelly, ...)` quando disponível — OK. Outros callers (snooker BAIXA, darts BAIXA — bot.js:24746, 25030) usam `calcKellyWithP(pickP, pickOdd, ...)` com pickP direto, OK.
**Mas alguns callers default para `calcKellyFraction(tipEV, tipOdd, frac, ...)`** (bot.js:18901 mma) — quando `modelPForKelly` é null, falls back to EV-derived p. p_derived = (ev/100 + 1)/odd ≠ p_model. Em casos extremos (EV=20%, odd=1.5): p_derived = 1.2/1.5 = 0.80 vs p_model real talvez 0.60. Kelly inflado.
**Impacto:** P2 baixo se modelo sempre tem p, mas precisa garantir todos paths passam `modelP`. Risk: se modelo retorna null modelP, EV-derived path super-confiança o Kelly.

## P2-4: `MARKET_TIP_MAX_EV = 25` em market-tip-processor.js:40 vs `MT_EV_CAP_PCT = 50` em server.js (`RECORD_TIP_EV_CAP_PCT`)
**Files:** `lib/market-tip-processor.js:40`, `server.js:28275`
- shouldSendMarketTip rejeita EV > 25%
- /record-tip rejeita EV > 50% (apenas para is_shadow=0)
Layer redundante. MT path passa pelo `shouldSendMarketTip` (cap 25) ANTES de chegar em `/record-tip` (cap 50) → MT effectively limited to 25. ML path bypassa shouldSendMarketTip → fica only no /record-tip cap 50.
**Asymmetric protection.** ML EV até 50% chega à banca; MT até 25%. Não é bug per se mas confusão de docs.

## P2-5: `kelly_product_capped` metric não emitido em paths Steam-pre-cap
**Files:** `lib/utils.js:373`, `lib/market-tip-processor.js:200`
Métrica `kelly_product_capped` só dispara quando `frac > _KELLY_PRODUCT_CAP` na entrada de `_applyKelly`. Steam mult aplicado FORA do flow `_applyKelly` (em bot.js inline) pode subir kellyFraction de 0.10 base × 1.5 (CLV) × 1.5 (Steam) = 0.225 — `_applyKelly` corta pra 0.15 com counter, MAS counter não distingue "stuff antes" vs "stuff durante". Difícil debug se métrica disparar muito.
**Recomendação:** tag adicional na métrica (`source: steam_clv_combined`) para diferenciar paths.

## P2-6: floating point comparações sem EPSILON detectadas
**Files:** `bot.js:5350` (`const profit = Number(tip.profit_reais);`), múltiplos paths bankroll
Nenhuma comparação direta `a === b` em paths money detectada em busca. CLAUDE.md exige `Math.abs(a - b) < EPSILON` mas todos os locais críticos usam Numeric ops e `.toFixed(2)` para fronteira (server.js:4904-4906, 10620, 10722). **Compliance OK.**

## P2-7: `getSportUnitValue` tier-discretization pode causar saltos não-suaves entre tiers
**Files:** `lib/sport-unit.js:35-44`
```js
[3.00, 3.00], [2.00, 2.00], [1.50, 1.50], [1.20, 1.20], [0.80, 1.00], [0.60, 0.80], [0.40, 0.60], [0.00, 0.50],
```
Salto 0.80→1.00 (ratio=0.80) ou 1.00→1.20 (ratio=1.20) pode gerar pulo de 20% no stake_reais por uma fração de unit_value. Em tips emitidas durante a transição, `stake_reais` armazenado é o ratio AO MOMENTO — settle reusa stored = OK. Mas próxima tip pós-transição salta. **Não é bug**, é design intentional (discretização). Apenas note.

## P2-8: Pinnacle auto-bet `markBetExecuted` não está em transação com bankroll
**Files:** `lib/pinnacle-auto-bet.js:262-272`
```js
db.prepare(`UPDATE tips SET pinnacle_bet_id=?, pinnacle_bet_status=?, pinnacle_actual_odd=?, pinnacle_bet_at=? WHERE id=?`)
  .run(...)
```
Single statement OK (atomic). Não há mudança de bankroll aqui (auto-bet apenas EMITE para executor; bankroll atualiza apenas no settle). **OK design**, mas note: o executor (Playwright/HTTP) pode falhar APÓS bot achar que apostou (registro `placed` em DB mas Pinnacle rejeitou). Reconciliação via Phase 3 cron precisa existir. Memory `project_pinnacle_auto_bet_2026_05_21.md` confirma Phase 3 pending.

## P2-9: Daily TIP limit não distingue MT por (sport, market) granularmente em todos paths
**Files:** `server.js:28371-28395`
`DAILY_TIP_LIMIT_<SPORT>_<MARKET>` impl. existe + count via tips ML + market_tips_shadow MT. **Mas:** se MT tip via `recordMarketTipAsRegular` falha por dedup (last-line caught), counter incrementa em UI antes? Não — só conta `admin_dm_sent_at IS NOT NULL` em market_tips_shadow. OK.
**Recomendação:** documentar P3 - daily cap por (sport, market) já existe granular.

---

# CHAIN DE MULTIPLIERS — VERIFICAÇÃO COMPLETA

Path MT (recordMarketTipAsRegular) bot.js:7126+:
```
stake_input (de kellyStakeForMarket, já capped a 2u + KELLY_PRODUCT_CAP_FRAC inside)
  → applyTrustToStake (cap [0.15, 1.20] OK por league-trust.js:174-176)
  → market_mult per (sport, market) — cap [0, 2.0] em bot.js:7367
  → tier_mult per (sport, league) — defaults em _KELLY_TIER_MULT_DEFAULTS bot.js:6194 — cap [0.30, 1.30]
  → applyGlobalRisk (drawdown, perf, league, dailyLimit, MAX_STAKE_UNITS)
```

Pior caso multiplicado (tudo no max):
- stake_input = 2u (capped MARKET_TIP_MAX_STAKE_UNITS)
- × trust 1.20
- × market_mult 2.0
- × tier_mult 1.30
- × applyGlobalRisk (sport_mult max 1.50 + dyn 1.20 — em bot.js:6960-7000)
- × applyGlobalRisk cap MAX_STAKE_UNITS=15 ← FINAL CLAMP

`2 × 1.20 × 2.0 × 1.30 × 1.5 × 1.2 = 11.232u` → cap em 15u (default) deixa passar.

**Recomendação P1:** considere reduzir defaults max múltiplas vias quando product > 5× baseline. Ou cap `MAX_STAKE_UNITS=8` (Railway env), reduzindo blow-up risk via 1u-tip-max-blow-7x rule.

Path ML (calcKellyWithP) bot.js:3782+:
```
baseFraction = getKellyFraction(sport, conf, market, league)
  = _KELLY_DEFAULTS[conf]                     // 0.10 / 0.167 / 0.25
    * (market_override OR _KELLY_SPORT_MULT[sport] OR auto_tune_mult OR default)
    * _getTierKellyMultiplier(sport, league)  // [0.30, 1.30]
    * _resolveHgDirSideMult                    // [0, 2.0]
  → kellyFraction *= clvAdj.mult              // [0, 1.5] - lib/utils.js
  → kellyFraction *= steamBoost.mult          // [1.0, 1.5]
  → calcKellyWithP → _applyKelly cap KELLY_PRODUCT_CAP_FRAC=0.15
  → output = `${stake}u`
  → applyGlobalRisk(sport, units, league)     // cap MAX_STAKE_UNITS
```

Worst case kellyFraction pre-cap: 0.25 × 1.0 × 1.30 × 2.0 × 1.5 × 1.5 = 1.46 ← cap em 0.15 = **9.7× cut**.
**Confidence:** `KELLY_PRODUCT_CAP_FRAC=0.15` cap salva o sistema. Métrica `kelly_product_capped` deve disparar regularmente.

---

# BANKROLL TRACE: TIP GANHADORA COMPLETA

Path:
1. **Emit** (bot.js ML scanner): kelly computed → stakeUnits → POST `/record-tip` body { stake: "1.5u", ... }
2. **/record-tip server-side** (server.js:28106+):
   - Token/auth/temporal/EV gates
   - Portfolio Kelly cross-cycle discount applied (server.js:28301-28318)
   - Clamp `_stakeUnitsCurrent > MAX_STAKE_UNITS=15`
   - DAILY_TIP_LIMIT check
   - LearnedCorrections (prob_shrink/ev_shrink): mutates t.ev / t.modelPPick before insert
   - Compute stake_reais: `_stakeReaisPre = stakeUnits × unit_value(banca)`
   - Last-line dedup query
   - INSERT INTO tips (stake_reais, stake, ev, model_p_pick, ... )
   - Return tipId
3. **Match resolves**: settle path (server.js:4869-4928 ou similar):
   - Fetch `tip.stake_reais` stored (linha 4890)
   - `profitR = stakeR * (odds - 1)` if win, else `-stakeR` (linha 4904)
   - `db.transaction(() => { UPDATE tips SET ..., stake_reais, profit_reais ... ; UPDATE bankroll SET current_banca = round(current_banca + profitR, 2) WHERE sport=? })`
4. **Bankroll integrity**: `/bankroll-audit` (server.js:17473-17486) compara stored `current_banca` vs `initial_banca + SUM(profit_reais)` → drift detection.

**Drift risks identificados:**
- Tip emitida COM `stake_reais` stored → drift = 0 (estado consistente sempre via atomic transaction). ✅
- Tip emitida SEM `stake_reais` (rare legacy) → settle recompute via `bk.current_banca` (server.js:10618) ⚠️ — usa banca CURRENT, não initial. Fixed em server.js:4894 mas NÃO em 10614/10718.

**Concurrent settle race:**
- 2 cycles paralelos settling mesma tip (id=X) → ambos `UPDATE tips SET result=? WHERE id=? AND result IS NULL`. Apenas 1 succeed (WHERE clause). Outro falha silentemente.
- Bankroll update dentro da mesma transaction → atomic. ✅ FIX previously confirmed (audit P0-2 maio).

**Concurrent settle different tips, same sport, ms apart:**
- Each tx is atomic. SQLite WAL mode → readers don't block writers but writers serialize. Bankroll updates `current_banca += profitR` (server-driven, not read-then-write). Race-safe. ✅

---

# QUERIES SQL PARA VALIDAÇÃO MANUAL

### 1. Bankroll drift cross-sport
```sql
SELECT
  b.sport,
  b.current_banca AS stored,
  ROUND(b.initial_banca + COALESCE(SUM(t.profit_reais), 0), 2) AS computed,
  ROUND(b.current_banca - (b.initial_banca + COALESCE(SUM(t.profit_reais), 0)), 2) AS drift
FROM bankroll b
LEFT JOIN tips t ON t.sport = b.sport AND COALESCE(t.is_shadow, 0) = 0 AND (t.archived IS NULL OR t.archived = 0)
  AND t.result IN ('win', 'loss', 'push')
GROUP BY b.sport
HAVING ABS(drift) > 0.50
ORDER BY ABS(drift) DESC;
```

### 2. Tips com stake_reais NULL após settled (potencial drift)
```sql
SELECT id, sport, sent_at, settled_at, stake, stake_reais, profit_reais, result
FROM tips
WHERE result IN ('win','loss')
  AND stake_reais IS NULL
  AND COALESCE(is_shadow, 0) = 0
  AND (archived IS NULL OR archived = 0)
ORDER BY sent_at DESC LIMIT 100;
```

### 3. Tips com stake > MAX_STAKE_UNITS (cap bypass evidence)
```sql
SELECT id, sport, sent_at, stake, stake_reais, ev, market_type, sent_at, tip_participant
FROM tips
WHERE COALESCE(is_shadow, 0) = 0
  AND (archived IS NULL OR archived = 0)
  AND CAST(REPLACE(REPLACE(stake, 'u', ''), ',', '.') AS REAL) > 15
ORDER BY sent_at DESC;
```

### 4. Kelly product capped metric counter
```
GET /admin/metrics-summary?days=7&counter=kelly_product_capped
```
Se > 0 alto, indica composition chain regularly hitting cap — defesa funcionando.

### 5. Bankroll guardian drift log (90d retention)
```sql
SELECT sport, COUNT(*) AS n_drift, AVG(stored - computed) AS avg_drift, MAX(detected_at) AS last
FROM bankroll_drift_log
WHERE detected_at >= datetime('now', '-30 days')
GROUP BY sport
ORDER BY n_drift DESC;
```

### 6. P0 inversion check (KELLY_<SPORT>_ALTA < KELLY_<SPORT>_MEDIA)
Already implemented as boot-time WARN in server.js:236-249. Audit via `/admin/env-audit`.

---

# CROSS-SPORT BUG VERIFICATION (P5)

Verifiquei se padrões financeiros bugados em um sport replicam em outros:

| Pattern | LoL | CS | Dota2 | Val | Tennis | Football | Basket | MMA |
|---|---|---|---|---|---|---|---|---|
| KELLY_<SPORT>_BAIXA path | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| applyGlobalRisk wired MT | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| applyTrustToStake MT only (não ML) | ⚠ | ⚠ | ⚠ | ⚠ | ⚠ | ⚠ | ⚠ | ⚠ |
| Composed mult chain in scanner | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠ | ⚠ | ✅ |

**Nota**: applyTrustToStake (lib/league-trust) is **ML path missing** cross-sport. Apenas MT (recordMarketTipAsRegular bot.js:7333) usa. ML scanners não invocam league-trust → tipo de tip ML com sport+league em sangrosa não sofre trust adjustment. Possível P1 mas P2-classificado porque CLV mult em ML path já captura sinal (via /clv-kelly-multiplier endpoint).

**Football/Basket** scanner também não usam steam_boost / clv_kelly inline (verificar bot.js:21423, 21516, 22115 — não há `kellyFraction *= ...`). MT path passa por `_mtTryRecordAndShouldDm` que aplica trust + market_mult + tier_mult + risk — OK.

---

# TOP 5 ITEMS (priorizar próxima sessão)

1. **P1-1: `KELLY_<SPORT>_<MARKET>_<CONF>` env validation cap `<= 1.0`** — permite Kelly fraction = 1.0 = blow-up se KELLY_PRODUCT_CAP_FRAC overridden. Reduzir para `<= 0.50` em bot.js:6285-6298.

2. **P1-4: Settle path inconsistency (server.js:10614, 10718 vs 4894)** — paths 10614/10718 usam `bk.current_banca` quando 4894 fix usa `initial_banca`. Normalizar pra mirror fix.

3. **P1-2: Steam BOOST aplicado fora cap chain** — kellyFraction `× steamMult` antes de `_applyKelly` cap. Defense-in-depth ainda OK via cap interno, mas escapaments possíveis se cap removed.

4. **P1-5: `MT_GLOBAL_RISK_DISABLED` opt-out emergency** — env perigosa. Add WARN no boot quando set + display em /admin/p2-status.

5. **P2-2/P2-5: Documentação CLAUDE.md actualizar** — _KELLY_DEFAULTS ALTA=0.25 vs MAX_KELLY_FRAC=0.10 confusion. Clarify SAGRADO interpretation: `KELLY_PRODUCT_CAP_FRAC=0.15` é o final-cap real do sistema.

---

# OPTIMIZATIONS DETECTED (não aplicadas, P4)

- `getSteamBoost` mutar `process.env` em vez de passar opts ao `checkVelocity` (lib/velocity-tracker.js:209-218) — design smell, sync-safe today mas frágil.
- `applyTrustToStake` only called em MT path. Considerar ML path also.
- 3 separate `_KELLY_*` constants in bot.js:6160 + lib/market-tip-processor.js:29 + lib/utils.js:328 default `0.25` — could centralize.
- Helper `parseFloat(String(stake || '1').replace('u','').replace(',','.')) || 1` repeated 20+ times across server.js/bot.js — extract `parseStakeUnits()` helper.

---

**End of report. Findings documentadas. Próximo passo: usuário decide quais P1 enderessar.**
