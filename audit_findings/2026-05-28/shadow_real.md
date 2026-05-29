# Auditoria P2 (shadow=causa / real=sintoma) + Mecanismo do paradoxo LoL — 2026-05-28

> Escopo duplo. (A) re-audit minucioso de compliance P2 procurando NOVOS violators. (B) mecanismo no CÓDIGO do paradoxo LoL (shadow +7.3% / real -37.3%). Investigação e report apenas — nenhum código editado.

---

## RESUMO EXECUTIVO

**(A) P2 compliance: LIMPO. Nenhum novo violator.** Os 9 fixes das waves 1-3 seguem válidos. Re-verifiquei todos os componentes de decisão de SINTOMA (disable/cap/block/throttle/flip/auto-set) — cada um filtra `is_shadow=0 AND archived=0` corretamente, tem env `<COMPONENT>_REAL_ONLY` default-true, e todos os endpoints `/admin/*-shadow-*` carregam disclaimer research-only. 1 achado de observability (não-violação): linha `auto_loss_streak` no disable-list exibe `roi_pct=6.32` (positivo) enganoso, mas a DECISÃO usou `tips is_shadow=0` correto.

**(B) Paradoxo LoL — diagnóstico: principalmente (a) CALIB + (c) MARKET-MIX. NÃO é violação P2; é leak de seleção (anti-edge) + calib do lado `over` ausente.** A correção P2-compliant (refit calib com outcomes reais) JÁ foi parcialmente executada por outro agente nesta sessão (`refit_lol_total_v2.json`).

---

## (A) P2 COMPLIANCE — RE-AUDIT MINUCIOSO

### Componentes de decisão de SINTOMA verificados (todos P2-compliant ✅)

| Componente | Arquivo:linha | Filtro real | Env opt-out (default) |
|---|---|---|---|
| MT leak guard (CLV/ROI) | `lib/market-tips-shadow.js:1824` | `INNER JOIN tips ... is_shadow=0 AND archived=0 AND result IN(...) ±14d + norm bidirecional` (pattern canônico CLAUDE.md) | `MT_LEAK_REAL_ONLY` (true) |
| auto_loss_streak | `bot.js:8050-8064` | `tips ... COALESCE(is_shadow,0)=0 AND (archived IS NULL OR archived=0) AND result IN('win','loss')` | `MT_LEAK_STREAK_AUTO` (on); comentário "P2-compliant: usa tips is_shadow=0" |
| auto_early_roi_leak | `bot.js:8008-8030` | mesma fonte `s` (snapshot real-gated via INNER JOIN) | `MT_LEAK_EARLY_AUTO` |
| auto_clv_leak | `bot.js:8089-8112` | idem | (CLV cutoff env) |
| Kelly auto-tune | `lib/kelly-auto-tune.js:73,179` | `COALESCE(is_shadow,0)=0 AND archived=0` (hardcoded) | `KELLY_AUTO_TUNE_ML_ONLY` |
| League trust | `lib/league-trust.js:72,106` | real query `is_shadow=0 AND archived=0`; bloco `market_tips_shadow` (l.112) gateado por `if(!realOnly)` | `LEAGUE_TRUST_REAL_ONLY` (true) |
| EV calibration | `lib/ev-calibration.js:89-90` | `shadowFilter = "AND COALESCE(is_shadow,0)=0"`; query `is_shadow=1` (l.154) é só FALLBACK quando sport sem volume real (permitido P2) | `EV_CALIB_REAL_ONLY` (true) |
| MT auto-promote | `lib/mt-auto-promote.js:445-451` | REVERT/LEAGUE_BLOCK usam `_statsBySportReal`/`_statsBySportMarketReal` (`INNER JOIN tips is_shadow=0`); PROMOTE usa shadow (pre-promote eval — explicitamente permitido P2) | `MT_AUTO_PROMOTE_REAL_ONLY` (true) |
| ML auto-promote | `lib/ml-auto-promote.js:276-295,415` | `tips WHERE is_shadow=? AND archived=0`; bucket-block gateado | `ML_AUTO_PROMOTE_REAL_ONLY` + `ML_BUCKET_BLOCK_REAL_ONLY` (true) |
| Readiness learner | `lib/readiness-learner.js:30,208,296-313` | Wave 3 fix confirmado: snapshot/verify/holdout default `is_shadow=0`; `hard_disable` (l.714) lê snapshot real | default OFF (`READINESS_LEARNER_AUTO`) |
| Gate optimizer | `lib/gate-optimizer.js:79-82` | recommend-only (DM, sem auto-apply); `shadowFilter` realOnly | `GATE_OPTIMIZER_REAL_ONLY` (true) |
| LoL kills calib | `lib/lol-kills-calibration.js:42,54` | real JOIN `is_shadow=0 AND archived=0`; `disable_recommended` (l.201) → bot.js:7637 só **DM admin** (sem auto-disable) | `KILLS_CALIB_REAL_ONLY` (true) |
| Shadow-vs-real drift | `lib/shadow-vs-real-drift.js:11` | "P2 compliance: NÃO automatiza ação. Apenas DM informativo." Compara shadow(is_shadow=1) vs real(is_shadow=0) separados → só `row.alert` | `SHADOW_VS_REAL_DRIFT_AUTO` (on) |

### Endpoints informacionais (disclaimer research-only presente ✅)
- `/admin/mt-shadow-by-league` server.js:25207 — disclaimer presente (o flag histórico da MEMORY foi resolvido).
- `/admin/mt-shadow-by-ev` server.js:25601 — disclaimer presente.
- ML mirror server.js:25355, 25536 — disclaimer + source claro.
- server.js:31800, 34424, 34663 — disclaimers presentes.
- `/admin/*-by-league` (byleague_lol.json baseline) — disclaimer no payload.
- **Nenhum endpoint mistura `is_shadow=0` + `market_tips_shadow` no mesmo agregado de decisão.** Os 2 `UNION ALL` em server.js (21006, 27925/37241, 38739) são contagem de teams em `match_results`, sem relação com shadow/real.
- **Nenhum `disable_recommended` / auto-action por shadow sem human review** (grep retornou só o kills-calib que é DM-only).

### Achado de observability (NÃO-violação P2)
- **`bot.js:8072` — coluna `roi_pct` gravada em `auto_loss_streak` é proxy enganoso.** A linha do disable-list mostra `roi_pct: 6.32` (positivo) e `clv_pct: -1.2`, o que parece contradizer um disable. Causa: o disable grava `s.roiPct`/`s.avgClv` (métrica do snapshot do leak-guard, agregada via INNER JOIN de pares shadow↔real) enquanto a DECISÃO de streak usa query separada de `tips is_shadow=0` (4 losses consecutivas). Ambas são real-gated, mas a coluna persistida não é a métrica da decisão. **Impacto:** humano lendo `/admin/mt-disable-list` pode achar que disable foi indevido. **Fix sugerido (P2, sem aplicar):** gravar nas colunas o n/result da janela de streak (ou um campo `decision_metric`) em vez do `s.roiPct` do snapshot. MELHORIA, baixa prioridade.

---

## (B) PARADOXO LoL — MECANISMO NO CÓDIGO

**Dado central (readiness `group_by=sport_market`, source=real, 30d):**
- Real LoL = **TOTAL n=13 (win 23% / exp 62% / gap −38.9pp / ROI −61.9% / CLV −9.5)** + **ML n=8 (win 37.5% / exp 68.4% / gap −30.9pp / ROI −18%)**.
- Shadow LoL = **ML n=110 (win 60.9% / exp 64.5% / gap −3.6pp / ROI +7.35% / CLV +2.79)** + total shadow under n=215 ROI **+8.5%** / over n=90 ROI **−14%**.

Ou seja: em shadow o universo é dominado pela ML bem-calibrada (+7.35%) e pelo under (+8.5%). Em real o universo está enviesado para TOTAL/over miscalibrado. Isso é market-mix + calib, não um gate escolhendo perdedoras ativamente.

### B1 — CALIB: lado `over` do TOTAL NÃO tem bins de calibração (CAUSA RAIZ #1)
- **Onde:** `lib/lol-mt-calib.json` → `markets.total.sides` tem **apenas `under`** (confirmado: `sides keys: ['under']`). Aplicação em `lib/sport-mt-calib.js:90-110` (`applyCalib`).
- **Mecanismo:** para uma tip **over**, `applyCalib` tenta `tiers[tier].sides[over]` → `tiers[tier]` → `sides[over]` → cai no **top-level `total.bins`**. Esses bins top-level vêm de sample misto/under-dominado. Uma over com `pRaw≈0.45` (onde a maioria das over reais ficam — `byev_lol.json avg_pmodel` 0.43–0.47) cai no bin `[0.3-0.55]` → **pCalib=0.4134**, mas o win real desse bucket é **23-27%** (`byev_lol`: lt5 hit 25% gap +43.5pp; 5-10 hit 27% gap +40.7pp; 10-15 hit 23% gap +65.2pp).
- **Resultado:** EV inflado ~16-65pp no lado over → over-bets perdedoras passam o gate de EV e viram tips reais. O lado **under** (que TEM bins, pCalib 0.62 ≈ rawP 0.65) é o lucrativo (+8.5% shadow).
- **Impacto financeiro:** TOTAL real ROI −61.9% (n=13), o maior dreno de LoL. Bucket EV 10-15% over: ROI −52.8% n=13.
- **Fix proposto (P2-compliant — refit com outcomes reais, NÃO bloquear por shadow):** refit calib `total` com **lado `over` explícito** + `maxBinWidth≤0.10` (o bin under `0.55-0.65` de 10pp ainda mascara — pina 12+ tips em p=0.6202). **JÁ EXECUTADO parcialmente nesta sessão:** `audit_findings/2026-05-28/refit_lol_total_v2.json` (fitted 17:47Z, n=273, maxBinWidth enforced, bins 0.05-0.10) — puxa pCalib do cluster 0.6-0.65 de 0.61→**0.5441** e 0.4-0.45→**0.3229**, alinhando com real. **PENDÊNCIA:** esse refit é `eval_mode=in_sample_legacy` (eval_days=0) — validar walk-forward (eval_days>0) antes de promover, e confirmar que gerou sides over/under, não só agregado.

### B2 — MARKET-MIX + disable cortou o lado VENCEDOR (CAUSA RAIZ #2)
- **Onde:** disable-list (baseline `disable_list.json`) + `sportdetail_lol.blocklist_entries`:
  - `lol|TOTAL|under|` (manual, 2026-05-24, "ROI −34.6% n=23 90d") — **corta o under**, que em shadow é **+8.5% (n=215)**.
  - `lol|total||` (market-level, source `auto_loss_streak`, hoje 19:26Z) — corta TOTAL inteiro.
- **Mecanismo:** com under cortado, as tips TOTAL reais que ainda escapam concentram-se no lado **over** (−14% shadow, −52% real em buckets de EV baixo). O disable removeu o edge e deixou o leak. Combinado com B1 (over sem calib), a seleção real fica estruturalmente anti-edge.
- **Nota P2:** o `lol|TOTAL|under` foi adicionado com evidência REAL (n=23 90d ROI −34.6%) — não é violação. Mas o conflito de granularidade (under real −34.6% 90d vs under shadow +8.5% 30d) sugere **regime/calib drift no under**, não que o under seja estruturalmente ruim. O `auto_loss_streak` market-level (`lol|total||`) hoje é redundante com o disable side-specific e captura ruído de variância (4 losses).
- **Fix proposto:** (1) após refit B1 com lado over+under, reavaliar real por side com a nova calib antes de manter o disable do under; (2) o guard market-level já tem proteção (bot.js:7957 skipa market-level quando existe disable manual side-specific) — confirmar que o `auto_loss_streak` de hoje não sobrescreveu o intent (a entry market-level `side=null` coexiste com a side-specific `under`, então o over segue tecnicamente "ativo" mas sem under nem calib correta = pior cenário).

### B3 — AUSÊNCIA de gate em LoL real (CAUSA RAIZ #3, secundária)
- **Onde:** `gate_attr.json` → `lol: total=21 blocked=0 blockedPct=0` — **NENHUM gate atua em LoL real.** O único gate ativo cross-sport é `sharp_divergence` (fire em tennis/cs/valorant), que não dispara em LoL.
- **`ml_gate_rej.json`:** as 43 rejeições LoL são todas `ev_sanity` (ceiling 50/80, tips LIVE com odd 2.4-4.9 e EV 64-159%) + 6 `ai_disabled_no_fallback`. Ou seja, o gate de EV só pega os **outliers extremos** (EV>50%); as over moderadas (EV 5-30%, que B1 infla) **passam livres**.
- **Mecanismo:** leak por FALTA de gate (não excesso). Sem `sharp_divergence`/drift gate cobrindo LoL, e com `ev_sanity` ceiling alto demais para o regime LoL, nada filtra a over miscalibrada.
- **Fix proposto (P2-compliant — gate baseado em sinal estrutural, não em shadow ROI):** estender cobertura do gate `sharp_divergence` (ou drift gate de odds) para LoL — é um gate de SINAL (linha sharp vs nossa) que não depende de shadow ROI. Alternativa: baixar `LOL_*_EV_SANITY_CEILING` para o regime atual (over com EV 10-15% e p_model 0.45 já é anti-edge). Ambos atuam na seleção real sem violar P2.

### NÃO é (b) "gate escolhendo perdedoras" nem (d) "stake"
- **(b) descartado:** gate não está escolhendo perdedoras — não há gate nenhum (blocked_pct=0). A seleção ruim vem do EV inflado por calib (B1), não de um filtro mal-calibrado.
- **(d) stake descartado como causa raiz:** Kelly/stake amplifica perdas mas não as cria. As perdas são de win-rate real (23-37%) << modelo (62-68%) = problema de probabilidade (calib), não de sizing. Stake só piora a magnitude.

### Confirmação: calib NÃO difere entre shadow e real (hipótese (c) "calib diferente" descartada)
- `scanMarkets` (bot.js:11197) usa `calibLib = getSportMtCalib('lol')` e produz `_scanResult.promotable` (candidatas a real) e `_scanResult.shadow` da **MESMA** calibração. Não há versão de calib separada para real vs shadow. A diferença real×shadow é 100% market-mix + disable, não calib divergente.

---

## DIAGNÓSTICO FINAL DO PARADOXO LoL

**(a) CALIB** (primária) + **(c) MARKET-MIX** (primária) + falta de gate (B3, secundária). NÃO é (b) gate anti-edge nem (d) stake.

Cadeia causal: lado `over` do TOTAL sem bins de calib → EV inflado +16-65pp → over perdedoras viram real; disable cortou o under (lucrativo) deixando over (leak); nenhum gate filtra over moderada. Shadow é carregado pela ML bem-calibrada (gap −3.6pp) + under (+8.5%) que em real estão respectivamente diluída e bloqueada.

**Fix P2-compliant (ordem):** (1) refit calib LoL TOTAL com lado over+under + maxBinWidth≤0.10 [JÁ iniciado em refit_lol_total_v2.json — validar walk-forward]; (2) re-medir real por side com nova calib antes de manter disable do under; (3) estender gate sharp_divergence/drift para LoL OU baixar EV-sanity ceiling. Tudo na CAUSA (calib/gate baseado em real), nada bloqueando por shadow ROI.

---

## P5 CROSS-SPORT — calib side-completeness

Verifiquei se a falta do lado `over` (B1) se repete em outros sports (mesma lib `sport-mt-calib.js`):

- **`lol-mt-calib.json` v1**: `total` → `rootSides=['under']` apenas. **BUG confirmado (lado over ausente).** Sem tiers.
- **`tennis-markov-calib.json` v1**: `totalGames` → **ambos `over`+`under` por tier** (atp_challenger/atp_main/wta125k/wta_main); `handicapGames` → ambos `home`/`away`. **CORRETO.** Tennis é o sport lucrativo (+10.3% real) — calib side-completa.
- `cs-mt-calib.json` / dota2 / valorant: **ausentes no disco local** (cs criado em prod via `038f0db`; dota2/val sample insuficiente per MEMORY). Não consegui validar side-completeness localmente — **recomendo confirmar em prod** via `GET /admin/mt-calib-validation?sport=cs` que o lado over/under do CS também existe (CS total/over já está disabled na lista, mas se o under CS depender de fallback top-level mal-fit, mesmo risco latente).

**Conclusão P5:** o defeito de lado-ausente é **LoL-específico hoje** (tennis está correto), mas é arquitetural — o refit de QUALQUER sport TOTAL/HANDICAP deve emitir os 2 lados (stratify=tier_side já faz isso no tennis). O `refit_lol_total_v2.json` precisa confirmar que gerou `sides.over`+`sides.under`, não só agregado top-level — senão o fix não resolve B1.
