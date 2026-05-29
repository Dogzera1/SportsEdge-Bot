# Auditoria FINANCEIRA — pipeline Kelly/EV/stake/calib (2026-05-28)

> Escopo: lib/market-tip-processor.js, lib/ev-calibration.js, lib/calibration.js, lib/sport-mt-calib.js, lib/odds-markets-scanner.js, lib/utils.js (_applyKelly), lib/league-tier.js, lib/league-trust.js, e paths EV/stake/Kelly + split shadow/real em bot.js. Cruzado com L1-L3 do FINDINGS_SO_FAR + prod baseline.
> **Conclusão central:** o leak NÃO é bypass de calib nem violação de cap. É (1) o modelo de pricing super-estima win-prob no lado OVER (calib não cobre esse lado por tier) e (2) os GATES de EV selecionam adversamente justamente as tips mais super-estimadas. Calib aplicada, EV gates funcionando — mas a seleção fica invertida quando o modelo é overconfident.

---

### [SEV: P0] EV-gate adverse selection: gate minEv seleciona as tips MAIS overconfident (raiz do paradoxo LoL shadow +7% / real −37%)
- **Onde**: `lib/odds-markets-scanner.js:93-101` (`_pushTip`: shadow=`ev>=shadowEvCap`, promotable=`ev>=minEv && oddOk`) + `lib/market-tip-processor.js:67` (gate `ev_min`, `DEFAULT_MIN_EV=8`). Shadow e real usam o MESMO `pModel`/calib (`_pushTip` empurra `entry` idêntico) — divergência é só nos gates.
- **Evidência** (prod `byev_lol.json`, lol total/OVER, shadow research): EV bucket 10-15% → hit 23%, ROI **−52.8%**, calib_gap **+65.2pp**, avg_pmodel 0.466; bucket 5-10% → ROI −33.8%, gap +40.7pp; bucket <5% → ROI −40.5%, gap +43.5pp. MAS bucket 15-20% → hit 57%, ROI +59% (gap −42pp). O modelo super-estima OVER por +40-65pp nos buckets de EV baixo/médio — exatamente os que o gate real promove (`minEv=8` corta <8% e deixa passar 8-25%). `risk_metrics.json`: lol real n=21 ROI **−28.4%** com **avg_clv +2.2** (CLV positivo + ROI negativo = adverse selection clássica). `sportdetail_lol.json`: real d30 −37.3% vs shadow d30 +1.6%; gate-attribution lol blocked_pct=0% (nenhum gate corta lol real).
- **Impacto financeiro**: principal sangria do sistema. LoL real −R$8,39 / R$29,5 stake (30d). Mecanismo generaliza pra todo sport com modelo overconfident (calib_gap negativo sistêmico do L3). Quanto maior o EV reportado, pior o outcome — o gate de EV está priorizando perdedoras.
- **Causa raiz**: EV é computado sobre `pModel` calibrado (`_ev(pCalib, odd)`, scanner:118/153), mas a calib residual ainda deixa +40-65pp de gap no lado OVER (vide P1 abaixo). Como `EV = pCalib*odd − 1`, prob inflada → EV inflado → tip passa o gate `minEv` com folga. O gate de EV é um RANKER de overconfidence, não de edge real, quando o modelo está miscalibrado num sub-segmento.
- **Fix proposto** (NÃO aplicar): (a) gate de divergência pModel-vs-Pinnacle-close por market/side (existe `FB-DIVERGENCE-GATE` em bot.js:7289 só p/ football — estender cross-sport, P5); (b) cap de EV por (sport,market,side) data-driven onde calib_gap>X em real; (c) **prioritário**: refit calib LoL total/OVER por tier+side (vide P1) — sem isso o gate continua selecionando errado.
- **Cross-sport**: SIM, arquitetural. `odds-markets-scanner.scanMarkets` é genérico (lol/cs/dota2/valorant). Tennis HG mostra o mesmo padrão invertido em escala menor (shadow HG away −11.7%/home −15.5% mas real +11%): real só sobrevive em tennis porque o EDGE de HG/totalGames está em buckets diferentes. Football, basket, dota2 todos com calib_gap negativo no L3.

---

### [SEV: P1] LoL total/OVER essencialmente NÃO-calibrado por tier — só lado `under` tem bins side-aware
- **Onde**: `lib/lol-mt-calib.json` (refit hoje 2026-05-28T19:41, via `calibmeta_lol.json`) + `lib/sport-mt-calib.js:90-123` (`applyCalib` cascade tier+side → tier → side → market).
- **Evidência**: `calibmeta_lol.json` → `markets.total.tiers.tier1` tem `sides.under` (4 bins, n=75) mas NÃO tem `sides.over`. Pra OVER tier1, o cascade cai no layer market-wide `total` (bins agregados over+under) que, por PAV, produz pCalib ~0.61-0.62 uniforme (vide `lol-mt-calib.json` total bins). O lado OVER (que perde −40 a −52% em real) recebe calib agregada que NÃO corrige sua overconfidence específica. Last shadow tip prod: LPL total over 3.5, **p_model=0.6126** — exatamente o pCalib travado do bin agregado.
- **Impacto financeiro**: OVER continua emitindo com prob super-estimada → alimenta o P0 acima. UNDER (lado calibrado, +8.5% shadow n=215) está bloqueado via `lol|total||` (disable_list) — ou seja, o sistema bloqueou o lado BOM e deixou o lado RUIM mal-calibrado passar.
- **Causa raiz**: refit usa `stratify` que só gera bins side-aware quando há sample suficiente por (tier,side); OVER tier1 não atingiu min_n → sem bins próprios. Bin agregado over+under mistura dois regimes opostos (under hit ~66%, over hit ~23%) num pCalib médio inútil pra ambos.
- **Fix proposto**: refit forçando side-split em `total` (over E under) por tier mesmo com n menor, OU desbloquear `lol|total|under` (lado lucrativo) e manter disable só em `lol|total|over`. Confirmar se o disable `lol|total||` (market inteiro) está cortando UNDER bom junto — provável over-block (P2 viola: foi disable manual, mas corta o lado lucrativo).
- **Cross-sport**: checar CS/dota2/valorant `*-mt-calib.json` têm mesma assimetria over-sem-bins (sport-mt-calib é compartilhado). CS calib n=45 era recém-criada (memory) — provável idêntico.

---

### [SEV: P1] Multiplicadores de stake MT aplicados FORA do cap Kelly — coerência de cap depende de env opcional
- **Onde**: `bot.js:7375-7438` (cadeia MT real: `applyTrustToStake` ×0.15-1.20 → `<SPORT>_<MARKET>_STAKE_MULT` ×≤2.0 → `tierMult` ×≤1.30) aplicada DEPOIS de `kellyStakeForMarket` (que já capou em `MARKET_TIP_MAX_STAKE_UNITS`=2u e fração ≤0.15). Depois `applyGlobalRisk` (bot.js:7450 / def 2642).
- **Evidência**: `kellyStakeForMarket` (market-tip-processor.js:244) retorna stake já capado em 2u. As 3 multiplicações subsequentes podem levar a 2u × 1.20 × 2.0 × 1.30 = **6.24u** (ou 3.12u sem STAKE_MULT). `applyGlobalRisk` TEM composed-cap (bot.js ~2688 `maxAdjusted = desiredUnits * composedCap`) e clamp absoluto (`<SPORT>_MAX_STAKE_UNITS`/`MAX_STAKE_UNITS`), MAS: (1) o composed-cap mede só `adjusted/desiredUnits` (multiplicadores DENTRO de applyGlobalRisk: league×drawdown×perf×sport×dyn), não enxerga a inflação upstream trust×stakeMult×tier; (2) o clamp absoluto só dispara se `<SPORT>_MAX_STAKE_UNITS` ou `MAX_STAKE_UNITS` env estiver setado — `MARKET_TIP_MAX_STAKE_UNITS` (o cap MT real, 2u) NÃO é reaplicado pós-multiplicadores.
- **Impacto financeiro**: se `MAX_STAKE_UNITS`/`<SPORT>_MAX_STAKE_UNITS` não setados em prod, stake MT final pode exceder o cap MT de 2u em até ~3x. Amplifica variância das perdas no exato segmento que sangra (P0). Atualmente mitigado porque tennis/lol em drawdown ativam taper ×0.35, e `last_tip` real foi 2u (path ML, não MT) — mas é cap-incoerência latente. NÃO viola MAX_KELLY_FRAC (fração capada upstream) — viola o cap ABSOLUTO de unidades MT.
- **Causa raiz**: cap MT absoluto (`MARKET_TIP_MAX_STAKE_UNITS`) vive dentro de `kellyStakeForMarket`; os multiplicadores de stake são aplicados depois no caller sem reaplicar esse teto. `applyGlobalRisk` usa env diferente (`MAX_STAKE_UNITS`).
- **Fix proposto**: reaplicar `Math.min(MARKET_TIP_MAX_STAKE_UNITS, stakeAdjusted)` após o tierMult (bot.js:7437) OU passar o teto MT pra applyGlobalRisk. Verificar se `MAX_STAKE_UNITS` está setado em prod (`env_audit.json`).
- **Cross-sport**: SIM — o helper `_mtTryRecordAndShouldDm`/bloco 7375-7466 é genérico p/ todos os MT (lol/cs/dota2/valorant/tennis/football/...).

---

### [SEV: P1] EV→ROI calib (lib/ev-calibration) NÃO corrige overconfidence de probabilidade — só encolhe stake pós-fato; não conserta o gate
- **Onde**: `lib/ev-calibration.js` (curva EV-bucket→mult de shrink) aplicada em `kellyStakeForMarket:217` e `_applyKelly:390`.
- **Evidência**: `getEvCalibrationMult` retorna mult [0.20,1.5] baseado em ROI realizado por bucket de EV — multiplica o STAKE, não a probabilidade. O EV usado nos GATES (`tip.ev`, scanner:129) é pré-shrink. Logo, mesmo que a curva encolha o stake de um bucket ruim, a tip AINDA passa o gate `minEv` e é emitida (stake menor, mas emitida e contada como real loss). Buckets LoL over com ROI −33 a −52% (n=11-13) podem nem ter min_n=20 por (sport,market) → cai no fallback HIGH_EV_THROTTLE genérico ×0.6, insuficiente p/ gap +65pp.
- **Impacto financeiro**: a defesa data-driven existente mitiga magnitude (stake menor) mas não EVITA a tip ruim nem corrige a seleção adversa. Falsa sensação de "calib resolve".
- **Causa raiz**: dois conceitos distintos confundidos no design — calibração de PROBABILIDADE (sport-mt-calib/calibration.js, conserta EV) vs calibração EV→ROI (ev-calibration, só encolhe stake). A segunda não substitui a primeira.
- **Fix proposto**: tratar EV→ROI shrink como segunda linha; a correção primária é P1-calib-side acima. Considerar gate `ev_max` por (sport,market,side) data-driven quando ROI real do bucket < limiar (P0).
- **Cross-sport**: compartilhado por todos via utils._applyKelly + market-tip-processor. Comportamento idêntico cross-sport.

---

### [SEV: P2] gate-attribution.js soma profit_units (units) como profit_reais (BRL) quando source='all'
- **Onde**: `lib/gate-attribution.js:172-173` (`COALESCE(stake_units,1) AS stake_reais`, `COALESCE(profit_units,0) AS profit_reais` no branch `market_tips_shadow`) — depois concatenado com rows de `tips` onde stake/profit_reais são BRL reais.
- **Evidência**: `tips_unit_audit.json` → `target_unit_value=1`, `n_affected=0`. Unit value atual = R$1.00 ⇒ units == reais numericamente HOJE, então o bug está DORMANTE (bate com memory PnL unit-mismatch 2026-05-28). Mas o alias mistura unidades quando a banca cruzar tier (unit_value ≠ 1).
- **Impacto financeiro**: ZERO agora (research-only cron, P2-compliant, não age sobre stake; e unit_value=1). Ativaria distorção de RELATÓRIO (não de dinheiro) quando unit_value≠1.
- **Causa raiz**: shadow MT armazena só units; mapeado p/ shape comum com alias enganoso em vez de normalizar por unit_value.
- **Fix proposto**: documentar que gate-attribution shadow_mt é em units OU normalizar por unit_value como nos 5 sites do fix anterior (90579cd). Baixa prioridade.
- **Cross-sport**: o cron é cross-sport; afeta todos no breakdown shadow_mt.

---

### [SEV: MELHORIA] Desbloquear lado lucrativo lol|total|UNDER (edge +8.5% n=215 bloqueado por disable de market inteiro)
- **Onde**: `disable_list.json` / `sportdetail_lol.json` blocklist_entries `["lol|total||", "lol|total_kills_map2|under|"]`.
- **Evidência**: shadow LoL total/under n=215 ROI **+8.5%** (lado bom); total/over n=90 ROI −14% (lado ruim). O disable `lol|total||` (market inteiro, sem side) corta AMBOS. P1 do projeto manda granularidade por side.
- **Impacto financeiro**: edge de +8.5% (n=215, sample robusto) não capturado. Maior oportunidade de "leak→lucro" identificada.
- **Causa raiz**: disable manual feito no market inteiro em vez de só no lado over (provável reação ao −61% do TOTAL agregado, que era dominado pelo over).
- **Fix proposto** (requer evidência real, não shadow — P2): validar com tips reais is_shadow=0 do lado under; se confirmar, trocar `lol|total||` por `lol|total|over|` (disable só over). NÃO agir só em shadow.
- **Cross-sport**: padrão de over-block por market inteiro vale auditar em CS/dota2 (disable_list tem `basket/cs/dota2 total/over`).

---

## Itens VERIFICADOS e OK (não-findings — registro p/ não re-auditar)
- ✅ `MAX_KELLY_FRAC=0.10` intacto (market-tip-processor.js:29). Composite cap `KELLY_PRODUCT_CAP_FRAC=0.15` em `_applyKelly` (utils.js:363) E `kellyStakeForMarket` (market-tip-processor.js:194) — ambos os paths (ML+MT) capam a FRAÇÃO. KELLY_GLOBAL_MULT (≤2.0) agora entra no clamp final (fix 2026-05-28, utils.js:423) — nenhum multiplicador de FRAÇÃO escapa o 0.15.
- ✅ Calib de probabilidade É aplicada antes do EV em shadow E real identicamente (scanner:65-67,118,153). NÃO há bypass de calib. (Hipótese inicial L1/L3 de "calib pulada" REFUTADA.)
- ✅ EV cap MT: `DEFAULT_MAX_EV=25` + gate `ev_max` (market-tip-processor.js:71) rejeita >25% (abaixo do MT_EV_CAP_PCT sagrado 50 — mais conservador). pModel ceiling 0.75-0.90 por sport (linha 142). MT_MIN_ODD floor 1.40 hierárquico (linha 88-103). Todos enforçados no path real.
- ✅ EV_CALIB_REAL_ONLY / LEAGUE_TRUST_REAL_ONLY default true (P2-compliant — shadow não contamina mult de stake real). Confirmado ev-calibration.js:89, league-trust.js:72.
- ✅ Float/precision: `kellyStakeForMarket`/`_applyKelly` usam `Number.isFinite` em pModel/odd/frac; `snapStakeUnits` arredonda só no output; `buildMarketTipDM:384` guarda `parseFloat(tip.odd)` com isFinite+`>1`. Nenhum `===` em dinheiro encontrado nos paths quentes. `calcKellyFraction`/`calcKellyWithP` retornam '0u' fail-safe em input inválido (NÃO aposta — CLAUDE.md compliant).
- ✅ PnL unit-mismatch: DORMANTE (unit_value=1, tips_unit_audit n_affected=0). Único site residual gate-attribution.js:173 (P2 acima).
- ✅ snapStakeUnits step 0.5u (market-tip-processor.js:179); stake_reais via `stakeU * unitVal` com `.toFixed(2)` na fronteira (bot.js:77).

## Otimizações detectadas (NÃO aplicadas)
- `lib/league-rollup.js` (diff uncommitted) é só mapping de nomes de liga (lol/dota2 split) — sem math financeira; não toca stake. OK por construção.
- 3 tier classifiers paralelos persistem (P3 tech debt conhecido): `_leagueTier` bot.js / `lib/league-tier` / `_mtTierClassifier` (lib/mt-tier-classifier) — o mult de tier Kelly (bot.js:6356, getLeagueTier) e o mult de tier STAKE (bot.js:7425, classifyTier) usam classifiers DIFERENTES → possível inconsistência tier1/tier2 entre os dois multiplicadores aplicados na mesma tip. Vale unificar (fora de escopo deste audit).
