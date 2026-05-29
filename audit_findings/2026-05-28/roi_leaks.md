# ROI / Calibracao — Auditoria granular de leaks -> lucro (2026-05-28)

> Agente: ROI/calib. Fonte: JSONs prod .tmp_audit/baseline_2026_05_28/ (commit fb9f42e, snapshot ~19:43Z). REAL = is_shadow=0 (risk_metrics, analytics_<sport>.marketsport, tips_by_conf, cross_sig .real). SHADOW = research-only (P2: nunca dispara block/cap; alimenta calib/causa).
> P2: toda acao de SINTOMA (disable/cap/Kelly) so e proposta quando real CONFIRMA (IC95 real nao cruza zero). Edges de shadow ficam como investigar/promover-se-real.

## Sumario executivo (impacto financeiro REAL 30d)

| Sport | n | ROI real | Profit (R$) | Veredito |
|---|---|---|---|---|
| **tennis** | 141 | **+10.3%** | **+8.49** | EDGE — carrega o sistema (HG +14.1% / n=135) |
| cs | 27 | +7.4% | +1.51 | edge leve (TOTAL +28.8%) |
| dota2 | 9 | +5.3% | +0.66 | small |
| valorant | 11 | +1.3% | +0.24 | Sharpe **-0.23** (outlier mascara) |
| football | 4 | +39.5% | +1.58 | small |
| basket | 3 | -53.1% | -2.39 | small |
| **lol** | 21 | **-28.4%** | **-8.39** | **LEAK — anula quase todo o lucro tennis** |
| **TOTAL** | 216 | **+0.99%** | **+1.70** | quase breakeven |

**Leitura central:** o sistema ganha **+R$10.5 no tennis HG** e perde **-R$8.4 no LoL** (TOTAL -R$4.33 + ML -R$4.06). LoL real = so 2 markets (TOTAL+ML), ambos sangram. Matar/calibrar LoL e blindar tennis HG nos buckets bons converte breakeven em lucrativo de verdade.

---

## L1+L3 — [P0] LoL real e 100% leak (TOTAL + ML), calib overestima ~30-39pp

- **Onde**: analytics_lol.marketsport, analytics_lol.calibration, cross_sig.by_sport.lol, sport_leak_summary.
- **Evidencia (REAL is_shadow=0)**:
  - LoL real so tem 2 markets emitindo: **TOTAL n=13 ROI -61.9%** (profit -R$4.33, avgEV 11.6%) e **ML n=8 ROI -26.2%** (profit -R$4.06, avgEV 13.9%). Soma = -R$8.39 = todo o leak LoL.
  - Calib bin 60-70%: n=13, **predito 62% vs hit real 23.1% -> gap -38.9pp** (calib_significant=TRUE).
  - cross_sig (includeArchived): **lol.TOTAL real n=24 ROI -41.9% IC95 [-76.4, -7.4]** -> LEAK CONFIRMADO. **lol.ML real n=27 ROI -33.0% IC95 [-63.6, -2.5]** -> LEAK CONFIRMADO.
  - EV-bucket REAL: LoL EV 8-12% -> -22.3%; **EV >12% -> -88.8% (n=7, -R$7.10)**. Quanto mais edge o modelo acha, mais perde. brier_skill **-0.0755** (pior que coin-flip).
  - CLV LoL +0.2% (157 capt, 44pos/32neg) -> linha de fechamento NAO bate o modelo; o problema e **calibracao/selecao no emit, nao execucao lenta**.
- **Impacto financeiro**: -R$8.39/30d (todo o leak do sistema). EV inflado -> stake mal alocado.
- **Causa raiz**: modelo LoL overestima win prob ~30-39pp na faixa 60-70% (onde caem quase todos os tips). EV = p_model*odd-1 fica positivo falso. Refit: bin 0.6-0.65 tinha rawP 0.5366 (53.7% real) precificado ~62%.
- **Fix proposto** (P2-safe, real confirma):
  1. **TOTAL ja disabled** — lol|TOTAL|under (manual 05-24) + lol|total|null (auto_loss_streak hoje 19:26). Confirmar que pega TOTAL inteiro (nao so under) — ver L1b.
  2. **LoL ML**: KELLY_LOL_ML=0.0 OU cap agressivo (KELLY_LOL_ALTA/KELLY_LOL_MEDIA) ate refit ML; home side e o pior (L2b). Disable ML home se persistir.
  3. Refit calib LoL ML (nao existe bin ML no calib atual — so total). Sem calib ML, EV ML sai cru e inflado.
- **Cross-sport**: dota2 MAP1 (gap -24.5pp), basket ML (gap -39.6pp) tem o MESMO padrao (small n). E a doenca sistemica L3.

### L1b — [P1] Disable LoL TOTAL com escopo possivelmente incompleto + repo calib STALE
- **Onde**: disable_list.json, lib/lol-mt-calib.json (repo) vs calibmeta_lol (prod).
- **Evidencia**: disable list tem lol|TOTAL|under (uppercase, side=under) e lol|total|null (auto, hoje). Os n=13 tips reais TOTAL settled 05-14->05-28 — emitidos **antes** do auto-disable de hoje. O repo lib/lol-mt-calib.json esta **desatualizado** (fittedAt 2026-05-12, nSamples=168, sem tiers, bin under 0.55-0.65 pCalib **0.6202** = a fonte do trava-em-62%). Mas o **prod ja refittou** (calibmeta_lol fittedAt **2026-05-28T19:41 nSamples=165 COM tiers**) e ha refit_v2 local (n=273, **maxBinWidth=0.05**, tier1 under 0.595 / tier2 0.473 / other 0.492).
- **Impacto**: enquanto repo != prod, deploy do repo REVERTE a calib boa.
- **Causa raiz**: (a) auto_loss_streak so disparou apos 4 perdas (reativo); (b) repo nao atualizado com refit prod (P4 — divergencia repo/prod).
- **Fix proposto**: commitar o calib refittado tier-aware no repo. NAO editar agora (pre-flight financeiro).
- **Nota tecnica**: applyCalib (sport-mt-calib.js:112-120) **JA interpola linear entre mids** e **JA e tier/side-aware** (linhas 99-108). O trava-em-62% NAO era bug de largura de bin — era (i) pCalib identico em 2 bins adjacentes (0.6202) + (ii) ausencia de bins tier-aware no repo (tier2/other recebia o 0.62 do tier1). Refit prod corrige ambos. Memory maxBinWidth/interpolacao-pendente pode ser fechada.

---

## L2 — [P0] Paradoxo LoL shadow +7.3% vs real -37.3%: RESOLVIDO (mix de market/side)

- **Onde**: shadow_vs_real, byleague_lol (shadow), byev_lol (shadow), analytics_lol.marketsport (real), gate_attr.
- **Causa (dados, nao codigo)**:
  1. **Shadow LoL +7.3% e dominado por TOTAL/under tier1** (LCK +35%, EWC +15%, LCS +50.7%, CBLOL +53.8%) com calib boa (byev under buckets EV 10-30%: calibgap -7 a +6pp, ROI +12 a +28%). cross_sig: **lol.TOTAL under SHADOW n=295 +8.4%**.
  2. **Real LoL e so TOTAL+ML** e cai nos **bolsos ruins**: TOTAL avgEV so 11.6% (bucket EV 8-12% -> -22%, >12% -> -88.8%). cross_sig: **lol.TOTAL under REAL n=23 -39.3%** vs shadow under +8.4% no MESMO market/side -> selecao real pegou o subconjunto perdedor (low-EV + over residual + ligas fora do tier1 bom).
  3. **gate_attr: LoL blocked_pct = 0%** -> NENHUM gate atua em LoL real. Tips com calib inflada passam livres. Tennis 24 blocks (+0.16), basket 2 (+0.89); LoL = zero defesa.
- **Veredito**: paradoxo = **composicao** (shadow tem bolso bom tier1-under-EVmedio; real concentra no bolso ruim) + **ausencia de gate**. Nao e bug de calib (essa, em prod, esta OK pos-refit).
- **Fix proposto**: (a) restringir LoL real ao bolso lucrativo do shadow — LOL_SHADOW_LEAGUES/tier1-only + EV-floor mais alto; (b) ligar gate em LoL. MELHORIA: promover **TOTAL/under tier1 EV 15-30%** (bolso +28% no shadow) quando real confirmar.

### L2b — [P1] LoL ML home overconfidence (real confirmado)
- **Evidencia**: cross_sig **lol.ML home real n=14 ROI -51.4% IC95 [-88.0, -14.75]** -> LEAK CONFIRMADO; ML away n=13 -11.9% [-63.8, +40.1] inconclusivo. Mesma assinatura do tennis ML home (ml_home_overconf_investigation.md): modelo favorece favorito/home demais.
- **Fix**: disable lol|ML|home (real IC95 confirma) OU KELLY_LOL_ML cap. P2-OK pois e real.

---

## L3 — [P1] Calib gap sistemico: modelo overestima win prob -> infla EV (cross-sport)

- **Onde**: sport_leak_summary, byev_tennis/byev_lol (shadow), analytics_*.calibration.
- **Evidencia**: gaps negativos REAIS: LoL TOTAL -38.9pp, LoL ML -30.9pp, tennis TOTAL_GAMES -41.1pp (n=6, sig), dota2 MAP1 -24.5pp, basket ML -39.6pp. SHADOW confirma o eixo: **quanto maior o EV-bucket, maior o overshoot**:
  - tennis HG home EV 5-10%: gap **+65pp** (n=19, ROI -57.4%); EV 20-30%: +50pp (n=195); EV>30%: +77pp (n=208).
  - tennis HG away EV 20-30%: +43pp (n=208); EV>30%: +73pp (n=163).
  - tennis TG over EV>30%: +75pp (n=97, -27.3%). LoL TOTAL over EV>30%: +126pp (n=14, -64%).
- **Impacto**: EV = p_model*odd-1; com p_model inflado, EV e falso -> tips de alto-EV sao os piores (LoL EV>12% -88.8%; BAIXA|2.5-4.0 EV 29.3% -> -40%).
- **Causa raiz**: calib nao puxa o suficiente predicoes de alta confianca. Em REAL calib+gates filtram os piores (real HG away +15.4%, real TG over n=0), mas o **eixo de overconfidence e estrutural** e reaparece em market novo sem calib madura. Tennis real OK ate 60% (gap -1.8 a -6.4pp), mas **60-70% gap -10.3pp**.
- **Refit recente resolveu? PARCIAL**. mt_brier_history: tennis HG drift -0.0227 (stable/improving), TG +0.001 (stable), LoL TOTAL -0.0275 (improving). MAS janelas recentes 7d ainda tem picos: LoL TOTAL offset-4 predP 0.7524 vs hit 0.3846 (brier 0.4824). LoL kills map1/map2 **degrading** (drift +0.10/+0.12). basket handicap degrading (+0.068).
- **Fix proposto**: (1) manter FROZEN_HOLDOUT_DAYS=60; refit periodico ja roda. (2) **EV-cap por (sport,market,bucket)** mais conservador no topo (EV>20% e onde o gap explode). (3) promover so onde |calib_gap|<10pp E IC95 real positivo.
- **Cross-sport**: universal (LoL, tennis, dota2, basket, valorant).

---

## L4 — [MELHORIA/P1] Tennis HG e o motor; lucro concentrado em sub-buckets (P1 granularidade)

- **Onde**: cross_sig.by_sport.tennis.HANDICAPGAMES, tips_by_conf.by_confidence_tier_tennis, analytics_tennis.
- **Evidencia (REAL, IC95)** — EDGES confirmados:
  - **HG dir:NEG real n=51 ROI +33.4% IC95 [+1.78, +64.98]** -> EDGE CONFIRMADO.
  - **HG dir_side:NEG_away real n=37 ROI +39.6% IC95 [+1.29, +77.83]** -> EDGE CONFIRMADO (o NEG_away +47% da memory, agora +39.6%).
  - HG away real n=186 +15.4% [-0.32, +31.06]; by tier: **atp250-500 +26.9%** (n=42), **wta_tour +22.1%** (n=25), masters +5.6%, **slam +1.1%** (n=76, RG drag).
  - tips_by_conf: **ALTA|tier2_atp_wta_main n=55 ROI +29.1%** vs ALTA|tier1_slam_masters n=58 **+3.7%**.
- **LEAKS confirmados (SHADOW — P2: investigar, nao auto-cortar; alguns ja tratados)**:
  - HG POS_home shadow n=464 -21.1% IC95_hi -11.91 (real POS_home n=79 -4.2% flat); **side:home ja disabled** (manual 05-21).
  - HG tier:challenger shadow n=450 -27.4% IC95_hi -16.55 (real challenger n=0 — ja nao emite).
  - TG over/POS_over shadow n=232 -16.3% IC95_hi -6.05 (real over n=0); **tennis|totalgames|under** disabled 05-27 (5/5 loss WTA clay).
- **Impacto**: HG carrega +R$10.5; upside em **atp250-500/wta_tour NEG_away**. Slam/RG HG ~flat -> nao escalar la.
- **Acao (MELHORIA, real confirma)**: **boost Kelly NEG_away** (KELLY_TENNIS_HANDICAP_GAMES_* mult 1.1-1.2; cross_sig sugere 1.1, IC95 lo +1.3%). Manter KELLY_TENNIS_HG_POS_HOME=0.5 + side:home disabled. **Nao** escalar slam HG (real +1.1%).
- **Cross-sport**: padrao favorito/POS/home superestimado reaparece em LoL ML home, basket ML.

---

## L5 — [P1] valorant CLV coverage 3.5% (4/115) — edge nao-mensuravel

- **Onde**: clv_coverage, clv_leak.bySport, sportdetail_valorant.
- **Evidencia**: valorant n=115, n_with_clv=**4 (3.5%)**, avg_clv -10.6% nos 4. Real ROI +1.3% MAS **Sharpe -0.23** e **100% concentracao em VCT Americas** (n_leagues=1). vs cs 38.4%, dota2 71.4%, lol 87.2%, tennis 97.1%.
- **Impacto**: nao da pra validar edge valorant. ROI +1.3% com Sharpe negativo = media puxada por 1 acerto grande.
- **Causa raiz**: branch /odds valorant adicionado 25/05 (f5670c3+2cc3d00). 4/115 sugere captura ainda nao populando ou cache miss pos-fix.
- **Fix proposto**: verificar capturas valorant pos-25/05 (outro agente cobre mecanismo). Enquanto CLV<40%, **nao promover valorant**; tratar +1.3% como inconclusivo.
- **Cross-sport**: cs (38.4%) e basket (43.5%) tambem baixos — captura CLV esports/basket fragil vs tennis/lol/football.

---

## L7 — [MELHORIA] Unico gate ativo (sharp_divergence) corta quase tanto edge quanto salva

- **Onde**: gate_attr.
- **Evidencia**: sharp_divergence n=31, savedLoss 11.0 vs lostProfit 11.81 -> **net -0.81**. Por sport: tennis +0.16, basket +0.89, valorant -0.27, cs -0.09, **lol 0 (nao atua)**.
- **Impacto**: gate quase neutro global; ajuda tennis/basket, atrapalha valorant/cs de leve, **ausente em LoL** (onde o leak L1 passou livre).
- **Fix proposto**: afinar threshold por sport — relaxar onde net<0 (valorant/cs), manter onde net>0, e **estender cobertura a LoL** (blocked_pct=0).

---

## Pendencias / nao-bloqueadores
- **tennis TOTAL_GAMES n=6 ROI -67.3%** (LOW): over/under games small-sample; over-leak estrutural em shadow (TG over n=363 -16.3% IC95_hi -6.05). under disabled 05-27. n real insuficiente.
- **basket ML n=3 -53%**, **dota2 MAP1 n=4 -23.8%**: small sample, gap grande mas IC95 cruza zero (calib_significant=false). Aguardar n>=10 ou cap preventivo via KELLY_<SPORT>.
- **mt_brier kills LoL map1/map2 degrading** (drift +0.10/+0.12, predP ~0.77 vs hit 0.43 recente) — proximo a vigiar; map2/under ja disabled (gap +125pp).

---

## TOP 5 (por impacto financeiro)
1. **[P0] LoL real = 100% leak** (TOTAL -61.9% + ML -26.2%, -R$8.39/30d, anula o lucro tennis). Calib overestima 30-39pp; EV>12% -> -88.8%.
2. **[P0] Paradoxo LoL resolvido**: shadow +7.3% (TOTAL/under tier1) != real -37% (bolso ruim low-EV) + gate LoL = 0% block. Causa = composicao+ausencia de gate, nao bug de calib.
3. **[P1] Calib gap sistemico**: overconfidence cresce com EV (gaps +24 a +126pp em EV>20%); refit melhorou (drift estavel) mas zona 60-70% e kills LoL ainda inflados.
4. **[MELHORIA] Tennis HG = motor (+R$10.5)**: edge real em NEG_away atp250-500/wta_tour (+39.6% IC95 [+1.3,+77.8]); slam/RG flat (+1.1%). Boost Kelly NEG_away, nao escalar slam.
5. **[P1] valorant CLV 3.5%**: edge nao-mensuravel, Sharpe -0.23, 100% VCT Americas — nao promover ate CLV>40%.

**Maior alavanca:** estancar o LoL (TOTAL ja disabled hoje; falta cortar/calibrar ML + ligar gate em LoL) converte o sistema de breakeven (+0.99%) para o ROI real do tennis (~+10%), pois o LoL sozinho consome quase todo o lucro do tennis HG.

