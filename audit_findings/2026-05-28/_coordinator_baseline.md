# Auditoria completa 2026-05-28 — Baseline do coordenador

Coletado dos endpoints de prod (commit `fb9f42e`, 19:36-19:43Z). Espinha dorsal da síntese. Os 6 agentes aprofundam cada fio.

## Estado financeiro (risk-metrics 30d, tips reais is_shadow=0)
| Sport | n_settled | ROI | Sharpe | Veredito |
|---|---|---|---|---|
| tennis | 141 | **+10.3%** | 0.069 | EDGE (carrega o sistema) |
| cs | 27 | +7.4% | 0.214 | edge leve |
| dota2 | 9 | +5.3% | 0.105 | small-n positivo |
| football | 4 | +39.5% | 0.49 | small-n |
| valorant | 11 | +1.3% | **-0.23** | ⚠️ ROI+ mas Sharpe− (1 outlier mascara leak) |
| basket | 3 | **-53%** | -0.80 | small-n leak |
| **lol** | **21** | **-28.4%** | **-0.67** | **LEAK GRAVE** |
| mma/darts/snooker/tt | 0 | — | — | sem real settled |
| **OVERALL** | — | **+0.99%** | — | **quase breakeven** (R$1.70 / R$172.5) |

→ Alavanca de lucratividade: cortar LoL/basket (arrastam overall) + proteger/expandir tennis/cs. Stakes minúsculas (~R$0.55/tip) — unit value só sobe após edge confirmado.

## Leaks confirmados (sport_leak_summary, days=30)
- **LoL TOTAL**: n=13 ROI **-61.9%** calib_gap **-38.9pp** win23%/exp62% — CRITICAL, calib_significant. (bin largo 0.3-0.65 → p trava 0.62)
- LoL ML: n=8 ROI -18% calib_gap -30.9pp
- tennis TOTAL_GAMES: n=6 ROI -67% calib_gap -41pp (significant!)
- dota2 MAP1_WINNER: n=4 ROI -23.8% calib_gap -24.5pp
- basket ML: n=3 ROI -53% calib_gap -39.6pp (mas CLV +33% — variância)

## Paradoxo LoL (shadow_vs_real)
shadow_recent **+7.3%** (n=169) vs real_recent **-37.3%** (n=21). gate-attribution: LoL blocked_pct=**0%** (nenhum gate atua). Real está pegando as piores tips. → agentes #1 (dados) + #4 (mecanismo).

## Calib gap sistêmico
-24 a -41pp cross-sport (modelo overestima win prob → infla EV). Tema central dos leaks.

## Infra / estabilidade
- app=**degraded**; `bot_boot_count_24h=20`; 1 OOM hoje 06:01 (rss **380MB**, heap_limit 228MB). last_launcher_exit=SIGTERM (Railway). crash_count=0 agora (estável no momento).
- **DB 387.9MB, freelist 219.3MB (56%) reclaimable via VACUUM** — bloat massivo.
- memCritical=false agora (rss 259-262MB). OOM é intermitente.

## Settle
- ~140 shadow stuck >24h (tennis 63/mma 35/football 17/cs 13/dota2 8) — quantos futuros vs leak?
- football real 1 tip stuck **160h** (6.7d). Memory: match_id mismatch agg_* slugs.

## CLV
- valorant **3.5%** (4/115!), cs 38%, basket 43%, dota2 71% — capture quebrado. tennis/lol/football/mma ok.

## Gates
- sharp_divergence net **-0.81** (corta tanto edge quanto salva). tennis +0.16 ok, valorant/football negativos.

## Compliance / saúde OK
- P2 ✅, frozen_holdout 60d ✅, reconciliation bankroll drifts=0 divergences=0 ✅, nightly_retrain ran_today ✅, crons error_count=0 (2 stale benignos), env-audit 2 dup tokens (provável intencional).

## ⚠️ Trabalho UNCOMMITTED / NÃO-DEPLOYED (não está em prod fb9f42e)
- **`lib/league-rollup.js`** (M, 77 inserções, comentários 2026-05-18 → parado 10d): adiciona rollup de liga para `lol`/`dota2`/`cs2`/`football`/`basket` (antes só `esports`/`cs`). Consumido por `stake-adjuster.js` (4×) + server.js (2×). Sem deploy, prod fragmenta sample desses sports por liga → stake adjustment subajusta. Syntax OK. **Validar lógica + decidir commit/deploy.**
- **`lib/tennis-weights.json`** local 340KB vs prod 251KB (`.bak.20260528` criado 15:40, current 15:42 hoje) — possível retrain local não-deployed. Investigar (agente #1).
- 26 outros untracked (audit_findings/ antigos, .tmp_audit/) — housekeeping.
