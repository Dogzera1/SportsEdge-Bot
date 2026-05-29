# Fios já puxados (baseline) — vá direto à CAUSA RAIZ destes

Estes sinais já foram extraídos dos endpoints. Não re-descubra — confirme no código/dados e ache a causa raiz + fix.

## L1 — LoL TOTAL market CRITICAL (sport_leak_summary)
- n=13, ROI **-61.86%**, calib_gap **-38.93pp**, win 23% vs expected 62%, calib_significant=TRUE.
- Memory prévia: `lib/lol-mt-calib.json` bin[0] cobre 0.3-0.65 (35pp de largura) → p_model trava em ~0.6202 constante p/ 12/13 tips. Bin largo demais. Fix arquitetural (refit maxBinWidth=0.10 OU interpolação inter-bin) estava pendente. CONFIRME se o bin ainda está largo e se mt-permanent-add realmente parou o bleeding (n=13 sugere que NÃO parou totalmente).

## L2 — Paradoxo LoL shadow +7.3% vs real -37.3% (shadow_vs_real)
- shadow_recent ROI +7.27% (n=169) mas real_recent **-37.29%** (n=21). Normalmente real ≥ shadow (real passou mais gates). LoL invertido.
- Hipóteses a testar: (a) market TOTAL (L1) domina o real mas é raro no shadow; (b) gates de seleção real escolhem perdedoras; (c) calib/EV aplicada em real difere da do shadow; (d) Kelly/stake amplifica perdas em real.
- gate-attribution mostra LoL blocked_pct=**0%** (NENHUM gate atua em LoL real) → tips ruins passam livres.

## L3 — Calib gap sistêmico negativo (modelo overestima win prob → infla EV)
- LoL TOTAL -38.9pp, LoL ML -30.9pp (n=8), tennis TOTAL_GAMES -41.1pp (n=6, significant), dota2 MAP1 -24.5pp (n=4), basket ML -39.6pp (n=3).
- Padrão cross-sport: win real << win esperado pelo modelo. EV inflado sistematicamente. Bate com memory "calib gap -20pp sistêmico". É o tema central. Quantifique por (sport,market,bucket) e ache se a aplicação de calib em REAL está correta.

## L4 — DB bloat + OOM (db_stats, boot_diag, memory_breakdown)
- DB 387.9MB, **freelist 219.3MB (56%!) reclaimable via VACUUM**. page_count 99301, freelist_pages 56140.
- boot_diag: `last_oom_snapshot` 2026-05-28T06:01 rss_mb=**380**, heap 128/155 (heap_size_limit 228MB). 1 OOM hoje de manhã. last_launcher_exit=SIGTERM (Railway). bot crash_count=0 agora (estável no momento).
- Tabelas: match_results 229k, oracleselixir_players 153k, tennis_match_stats 115k, oracleselixir_games 30k, dota_live_snapshots 12k, market_tips_shadow 3952, tips 4645, ml_gate_rejected_audit 3598.
- Investigar: qual DELETE gera 56k freelist sem vacuum? PRAGMA auto_vacuum atual? VACUUM seguro em Railway 512MB (precisa ~388MB temp)? incremental_vacuum? Retenção de tabelas grandes.

## L5 — valorant CLV 3.5% (clv_coverage)
- valorant n=115, n_with_clv=**4** (3.5%!). cs 38.4%, basket 43.5%, dota2 71.4%. tennis/lol/football/mma ok.
- Memory diz VAL CLV foi fixado 25/05 (commits f5670c3+2cc3d00 — /odds branch valorant). 30d window pode incluir pré-fix, mas só 4/115 é grave. Confirme se branch /odds valorant está funcionando AGORA (capturas recentes têm CLV?).

## L6 — football settle stuck 160h (health_overview)
- football 1 pending tip oldest 160.4h (6.7 dias). Memory: match_id format mismatch (aggregator BR `agg_*` slugs vs match_results API-Football/Sofascore namespace). ~140 shadow stuck cross-sport (tennis 63/mma 35/football 17/cs 13/dota2 8) — quantos são jogos FUTUROS (normal) vs passados (leak)?

## L7 — gate sharp_divergence net -0.81 (gate_attribution)
- Único gate ativo. saved_loss 11 vs lost_profit 11.81 → net -0.81 (corta quase tanto edge quanto salva). tennis +0.16 (ok), valorant -0.27, football -0.86. Candidato a refinar (relaxar onde net<0, manter onde >0). MELHORIA.

## Outros sinais
- theOddsApi quota disabled=true (keyConfigured=true) — intencional? deepseek 0 calls em maio (cap $10) — AI off ou tracking bug (memory project_ai_tracking_bug)?
- app=degraded com alerts=[] — descobrir o que seta degraded no /health handler (lastAnalysis=null? boot_count?).
- env-audit: 2 duplicate tokens (OPPORTUNITY=SNOOKER, TIPS_UNIFIED=CS) — provável intencional, baixa prio.
- reconciliation: bankroll drifts=0, divergences=0 ✅ (íntegro). real-pl n=0 (auto-bet off, esperado).
