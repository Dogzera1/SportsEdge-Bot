# SÍNTESE — Auditoria completa 2026-05-28 (6 agentes) → plano leaks→lucro

Prod `fb9f42e`, snapshot 19:36–19:43Z. 6 agentes Opus paralelos + baseline do coordenador. Relatórios fonte: `roi_leaks.md`, `dinheiro.md`, `banco_settle.md`, `shadow_real.md` (resumo), `adversarial.md` (resumo), `externos.md` (resumo), `_coordinator_baseline.md`.

## Veredito
Sistema **breakeven (+0.99% ROI 30d, n=216)**. Não há leak difuso — há **2 concentrações**: o **tennis HG ganha +R$10.5** e o **LoL perde −R$8.4** (anula quase tudo). A causa estrutural é **uma só**, triangulada por 3 agentes independentes: **o gate de EV faz seleção adversa**. P2 está limpo, bankroll íntegro, Kelly-frac e EV-cap intactos. **A maior alavanca de lucratividade é estancar o LoL — converte +0.99% → ~+10% (ROI tennis).**

---

## 🎯 CAUSA RAIZ ESTRUTURAL (P0) — gate de EV = seleção adversa
**`lib/odds-markets-scanner.js:93` + `market-tip-processor.js:67` (DEFAULT_MIN_EV=8).**
Quando o modelo está overconfident num sub-segmento (calib_gap negativo), `EV = pCalib·odd − 1` fica inflado **por causa da overconfidence, não de edge real**. O gate `minEv≥8` então promove justamente as tips mais super-estimadas. Evidência decisiva: **LoL real CLV +2.2 mas ROI −37%** (CLV+ com ROI− = seleção adversa clássica); EV>12% em LoL → **−88.8%**. Generaliza a **todo sport com calib_gap negativo** (L3). Manifesta-se pior em LoL porque **0% das tips LoL passam por qualquer gate** (gate-attribution blocked_pct=0).

---

## P0 — sangra dinheiro / risco financeiro grave

### 1. LoL real = 100% leak (−R$8.39/30d) — [confirmado real IC95]
- TOTAL real n=24 ROI −41.9% IC95 **[−76.4,−7.4]**; ML real n=27 −33% IC95 **[−63.6,−2.5]**; **ML home n=14 −51.4% IC95 [−88,−14.7]**.
- Calib overestima 30–39pp na faixa 60–70% (onde caem quase todas). TOTAL já auto-disabled hoje (loss-streak); **ML não tem disable nem calib própria**.
- **Fix**: (quick) `KELLY_LOL_ML` cap agressivo OU disable `lol|ML|home` (real IC95 confirma); (estrutural) refit calib LoL ML + ligar gate em LoL.

### 2. `/settle` sem autenticação — [segurança, mover dinheiro]
- `server.js:35063`: aceita `winner` arbitrário no body → `UPDATE tips SET profit_reais` + `updateBankroll` (35280/35319). Sem auth/token/rate-limit/loopback-check. Vetor: `POST /settle?sport=lol {matchId,winner}` credita/debita banca sem aposta.
- **Fix**: aplicar `requireLoopbackOrAdmin` (padrão já existe em `server.js:8688`).

### 3. `/record-tip` token gate OPT-IN e OFF em prod — [segurança, injetar tips reais]
- `server.js:28919`: só exige token se `RECORD_TIP_TOKEN_REQUIRED=true`; `defenses_active` não lista → rollout fase-2 nunca concluído.
- **Fix**: setar `RECORD_TIP_TOKEN_REQUIRED=true` (+ token) OU aplicar loopback-or-admin.

---

## P1 — leak confirmado / bug sério

### 4. LoL OVER sem calib side-aware por tier
- `calibmeta_lol` (prod): `total.tiers.tier1` tem `sides.under` mas **não `over`** → OVER cai em bin agregado pCalib≈0.61 inútil. O lado que sangra não é corrigido. (`lib/sport-mt-calib.js:90`)
- **Fix**: refit forçando side-split over+under por tier.

### 5. Divergência repo↔prod do calib LoL — risco de deploy + possível não-persistência
- REPO `lib/lol-mt-calib.json` = 12/05 sem tiers (ruim); PROD = 28/05 tier-aware (bom). **Deploy do repo reverteria a calib boa.** Calib vive em `/app` (efêmero Railway) → confirmar se persiste entre redeploys ou reseta ao repo a cada deploy (até 24h de calib ruim).
- **Fix**: commitar a calib tier-aware ao repo + confirmar mecanismo de persistência (`/data` vs `/app`).

### 6. Multiplicadores de stake MT fora do cap absoluto
- `bot.js:7375-7438`: trust×stakeMult×tier (até ~3.12×) aplicados DEPOIS do cap de 2u; `MARKET_TIP_MAX_STAKE_UNITS` não é reaplicado; clamp de `applyGlobalRisk` só dispara se `MAX_STAKE_UNITS`/`<SPORT>_MAX_STAKE_UNITS` setado. Não viola MAX_KELLY_FRAC (fração OK) — viola o teto de **unidades** MT.
- **Fix**: `Math.min(MARKET_TIP_MAX_STAKE_UNITS, stakeAdjusted)` após tierMult (bot.js:7437); confirmar `MAX_STAKE_UNITS` em prod.

### 7. `app=degraded` falso → mascara alertas reais
- `server.js:8499/8768`: `lastAnalysisAt=null` porque `/record-analysis` **não tem caller** no bot. `stale=true` eterno; alert real é gated atrás de `lastAnalysisAt` truthy → `alerts=[]` esconde tudo. (boy-who-cried-wolf)
- **Fix**: cabear heartbeat OU trocar fonte de `stale` por gauge local que o server conhece.

### 8. DB bloat 219MB (56%) → amplifica OOM
- `auto_vacuum=NONE` nunca setado (`lib/database.js:24`); DELETEs não devolvem páginas. DB 387MB num cap 512MB = OOM container-kill (06:01 hoje, rss 380MB). **Boot loop = redeploy Railway, NÃO crash** (SIGTERM, crash_count=0).
- **Fix**: backup → 1 VACUUM full em janela baixa → `auto_vacuum=INCREMENTAL` + cron incremental guardado por isMemCritical; env `MALLOC_ARENA_MAX=2` (barato/reversível).

### 9. Retenção mira tabelas erradas
- `5eb06fa` (hoje) cobre tabelas minúsculas; `match_results` 229k, `dota_live_snapshots` 12k, `super_odd_events`, `bookmaker_delta_samples` **sem retenção** (bot.js:26546). 2 sistemas de retenção paralelos (P3).
- **Fix**: adicionar tabelas live grandes (30–60d) ao target.

### 10. 4 football `agg_*` zombies real-money
- `server.js:40047` `archiveOrphanNonML` não checa match futuro (arquivou #3595/#3811 que são 31/05) nem espera `resolveAlias` (#3908/#3913 passados nunca settlaram = ROI perdido).
- **Fix**: guard de match futuro (espelhar `match_end_at` de `/void-old-pending` server.js:28847) + investigar resolveAlias agg_*.

### 11. valorant CLV 3.5% (4/115) — edge não-mensurável
- Mismatch de fonte: matches do PandaScore × odds só do Pinnacle (não carrega VCT). ROI +1.3% com Sharpe −0.23, 100% VCT Americas. **Não promover VAL até CLV>40%.** cs/basket CLV ~40% também frágil (basket CLV +34% = captura errada → red flag no basket ML −53%).
- **Fix**: fonte de odds secundária no branch valorant OU close terminal + `markFeedSuccess('pinnacle','valorant')`.

### 12. Calib gap sistêmico (overconfidence cresce com EV)
- Gaps +24 a +126pp nos buckets EV>20% (LoL/tennis/dota2/basket). Refit recente melhorou (drift estável) mas zona 60–70% e **kills LoL map1/map2 degrading** (drift +0.10/+0.12).
- **Fix**: EV-cap por (sport,market,bucket) mais conservador no topo; promover só onde |gap|<10pp E IC95 real+.

### 13. `/admin/upsert-match-result` aceita `?key=` + lockout isenta RFC1918
- `server.js:21935` fora de `_DESTRUCTIVE_PATHS` (key na URL = leak via log) → poisoning de settle. `server.js:4454` lockout isenta toda faixa RFC1918/CGNAT (brute-force distribuível da key 8 dígitos).
- **Fix**: adicionar a `_DESTRUCTIVE_PATHS`; estreitar isenção de lockout a loopback puro.

### 14. Zero `isMemCritical()` no server.js (24 no bot)
- `runSettleSweep`/refit OLAP no server sem guard de memória → empurrão final pro OOM.
- **Fix**: importar `mem-shared.isAnyProcessCritical()` e guardar settle_sweep + retenção.

---

## MELHORIAS — edges não explorados / lucratividade

### M1. Tennis HG NEG_away é o motor (+39.6% IC95 [+1.3,+77.8], n=37) — boost
- dir:NEG +33.4% [+1.78,+64.98] n=51; ALTA|tier2_atp_wta +29.1% n=55. **Slam/RG flat (+1.1%) — não escalar lá.**
- **Ação**: boost `KELLY_TENNIS_HANDICAP_GAMES_*` mult 1.1–1.2 (cross_sig sugere 1.1, IC95 lo +1.3%); manter `KELLY_TENNIS_HG_POS_HOME=0.5` + side:home disabled.

### M2. Desbloquear `lol|total|under` (+8.5% shadow n=215)
- Disable de market inteiro `lol|total||` corta o lado **lucrativo** junto com o over ruim. **Validar com real (is_shadow=0) antes — P2**; se confirmar, trocar por disable só `lol|total|over`.

### M3. Afinar gate sharp_divergence + estender a LoL
- net −0.81 global (tennis +0.16 ok, valorant/cs negativos, **LoL=ausente**). Relaxar onde net<0, estender cobertura a LoL.

### M4. Deploy de melhorias paradas (validar antes)
- `lib/league-rollup.js` uncommitted 10d (rollup liga lol/dota2/cs2/football/basket → consumido por stake-adjuster). `tennis-weights.json` local 340KB ≠ prod 251KB.

### M5. theOddsApi/DeepSeek = kill switches intencionais (não bugs) — confirmar com user se quer reativar (basket perde 1 fonte de odds com theOddsApi off).

---

## ✅ Verificado OK (não re-auditar)
P2 compliance limpo (12+ componentes, REAL_ONLY, disclaimers). MAX_KELLY_FRAC=0.10 + KELLY_PRODUCT_CAP_FRAC=0.15 intactos. Calib de probabilidade aplicada (sem bypass). EV-cap 25 + pModel ceiling + MT_MIN_ODD enforçados. Float/precision ok. Bankroll reconciliation drifts=0. Auth admin robusta (timing-safe, CSRF, WAF). Sem SQLi. Sem secret leak. PRAGMAs ok (falta só auto_vacuum). Índices settle ok. nightly_retrain rodando.

## Tech debt (P3/P4)
3 tier classifiers paralelos (2 usados em mults diferentes na MESMA tip → inconsistência tier1/tier2). 2 sistemas de retenção paralelos. 3 caminhos de void com thresholds espelhados à mão. XSS potencial no admin console (innerHTML concat). gate-attribution units-as-reais (dormante, unit_value=1).
