# Calib bin collapse — refit attempt 2026-05-26

## Sintoma (sessão tennis red)

3 tips TG UNDER 18.5/19.5 games tinham `model_p_pick = 0.5536` IDÊNTICO.
2 tips HG home -6.5/-7.5 tinham `model_p_pick = 0.4529` IDÊNTICO.

Calib v3 LIVE 2026-05-25 mas TG wta_main bo3 under = **2 bins / n=32** = bin width ~17pp. Predições com p_raw em mesma faixa colapsam pra 1 valor calibrado.

## Tentativa: lower minBin + larger train window

| Config | Tier wta_main TG under | Backtest OOS post (n=198, eval=14d) | Brier post |
|---|---|---|---|
| Current (days=45, minBin=6) | bins=2 n=32 | hit=28.3% ROI=-9% | 0.205 |
| days=90, minBin=4 | bins=2 n=32 | hit=28.3% ROI=-9% | 0.205 |
| days=90, minBin=3 | bins=2 n=32 | hit=28.3% ROI=-9% | 0.205 |
| days=180, minBin=4 | bins=2 n=28 | hit=28.3% ROI=-9% | 0.205 |
| days=180, minBin=4, eval_days=0 (in-sample) | bins=2 n=146 | hit=31.6% ROI=+9.6% | 0.213 |

**TG bins não muda independente de minBin/days.** Causa: p_raw samples concentrados em faixa estreita (~0.50-0.60 Markov output), binning algorithm não enxerga bimodalidade para splitar.

HG atp_challenger melhora de 2→3 bins com minBin=3, mas é marginal.

## Por que minBin sozinho não resolve

Bin collapse não é problema de granularidade do binning — é problema de **distribuição** das predições raw. Quando 3 tips diferentes têm p_raw ~ 0.65, qualquer binning binário/ternário coloca todos no mesmo bin → mesmo p_calib.

Fix real precisa **calib smooth** (não-binned):
- Platt scaling (sigmoid fit)
- Isotonic regression sem agregação em bins
- Beta calibration

Estes produzem p_calib(p_raw) contínuo, sem step function. Tips com p_raw ligeiramente diferentes obtêm p_calib ligeiramente diferentes.

## Decisão: NO WRITE

Não foi escrita nova calib. Razão:
1. minBin reduction só melhora HG atp_challenger (2→3 bins) — gain marginal
2. TG bins inalterados independente de config
3. Backtest OOS roi=-9% pior que pre raw -4.9% — calib piora performance em eval window (Roland Garros R1 regime shock)
4. In-sample roi=+9.6% mas é overfit-biased

## Pendência arquitetural

- Upgrade `lib/tennis-markov-calib.js` para usar Platt scaling ou isotonic non-binned
- Estimar custo: 1-2 sessões + validação OOS rigorosa
- Cross-sport (P5): LoL TOTAL calib bin pendency idêntica (memory `lol_total_calib_bin_pendency_2026_05_25` bin[0] 0.3-0.65 cobre 12 tips constantes) — mesma class
- Defer até ter sample maior ou prioridade explicita

## Mitigação curto-prazo já em vigor

- `mt-runtime-disable` agora enforça (commit `4a33fb5`) — `tennis|totalGames|under` + `tennis|handicapGames|home` bloqueiam novos tips
- TG UNDER e HG home não fira mais em real até disable removido
- Bleeding direto contido

## Próximos passos sugeridos (defer)

1. Coletar mais sample Bo5 TG (US Open 2026, AO 2027) antes de re-tentar refit
2. POC Platt scaling em side branch — validar gain vs current bins
3. Re-avaliar quando real ROI tennis estabilizar pós-fix enforcement
