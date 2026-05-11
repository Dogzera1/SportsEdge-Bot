# Common Pitfalls

Top cases reais de bugs/erros que aconteceram. **Leia antes de mexer em área similar.**

## 1. OOM crash loop 2026-05-07 (Railway 512MB cap)

Bot rebootou 243× em ~24h. Root cause: SQLite cache_size default + WAL crescendo. Fix `8401ffe`: `cache_size=-8000` (8MB cap) + `mmap_size=0` + memory CRIT 440MB global flag pra crons defer. **Antes de aumentar workload, checar `BOT_MEM_RSS_CRIT_MB` env.**

## 2. Hour-gate redundante com TIME_OF_DAY_AUTO (2026-05-11)

Criei `lib/hour-gate.js` sem grep antes. **Já existia** `TIME_OF_DAY_AUTO` em `server.js:23081` com mesma intent — granular per (sport, hour, market), cache 1h, auto-block ROI ≤-25% n≥8. Revertido em commit `f28587f`, deletado em `c025dc6`. **Lição:** sempre grep `<intent_keyword>_AUTO` antes de implementar.

## 3. Tier classifier inconsistency (2026-05-11)

CBLOL classificado como `tier1` em `bot.js _leagueTier` inline mas `tier2` em `lib/league-tier.js`. **3 classifiers paralelos existiam.** Fix `7f9dcc9`: `bot.js _leagueTier` delegate para `lib/league-tier.getLeagueTier`. **Lição:** se aparecer função paralela com mesma intent, refactor pra delegate.

## 4. Shadow filter quebrando bankroll (2026-05-06 caso "DD 66.5%")

`/bankroll` endpoint somava `profit` incluindo shadow tips mas filtrava `peak` excluindo shadow. **Falso DD 66.5% tennis.** Fix `836374c`: shadow filter consistente em ambos cálculos. **Lição:** quando filtrar `is_shadow=0`, fazer em TODAS queries que consomem PnL.

## 5. urljoin Python NÃO faz URL-encoding de acentos

```python
urljoin(BASE, "brasileirão-série-a")  # → 302 redirect pra homepage
```
Fix no scraper BR: pre-encode no dict como `"brasileir%C3%A3o-s%C3%A9rie-a"`. **Lição:** acentos em URL path precisam encoding manual.

## 6. page.content() vs page.evaluate() em React/Vue hydration

`__TBD_PRELOADED_CATALOG__` Betfair sumia após hydration. Solução: usar `page.evaluate("() => window.__TBD_PRELOADED_CATALOG__")` direto, antes do React desligar. **Lição:** SPA inline state precisa snapshot via `evaluate`, não via DOM.

## 7. `tf_playwright_stealth` import name

Pacote PyPI = `tf-playwright-stealth` mas módulo importado = `playwright_stealth`. ImportError silencioso quebra stealth. **Sempre `from playwright_stealth import stealth_async`.**

## 8. Webshare quota 402 silencioso

`X-Webshare-Error: 402, X-Webshare-Reason: bandwidthlimit` aparece em curl, mas proxy ainda passa requests sem stealth efetivo. **Antes de debug "scraper não funciona", checar proxy quota.**

## 9. Agentes alucinando 30-40% (2026-05-09 audit)

3 de 5 P0s reportados pelos agentes Explore eram falsos: AUTO_SHADOW "lê shadow" (não lia), bankroll race "fixed" (já fixed antes), KILLS_CALIB_REAL_ONLY "missing" (já existia). **Verificação manual obrigatória antes de aplicar fix.** Nunca trust report sem grep yourself.

## 10. Cleanup #3 strict-eq voidando antes de fuzzy settle (2026-05-09)

`runMtSettleMismatchCleanup3` SQL strict-equality voidava tips 14d antes do fuzzy match path emitir win/loss. 163 tips em 5 sports reconciliadas. **Lição:** ordering de crons importa — settle ANTES de cleanup zumbi.

## 11. Kelly multipliers cascata composta

Effective stake = `baseline × sport_mult × auto_tune × tier_mult × clv_mult × trust_mult` = até 6 mults. Aumentar 1 mult sem checar produto = stake explosion. **Antes de mexer Kelly, calcular produto efetivo `/admin/risk-metrics`.**

## 12. Shadow → real decisões (P2 violations)

8 sistemas decidiam baseado em `market_tips_shadow` ao invés de `tips WHERE is_shadow=0`: leak_guard, roi_guard, bucket_guard, validation, kills_calib, ev_calib, league_trust, mt_auto_promote. **Sempre `is_shadow=0 AND archived=0` em sintoma (block/disable/cap/mult). Shadow só para causa (refit, research).**

## 13. ESPN dead code em prod (2026-05-11)

`external/sportsbook-odds-scraper/` (1422 lines) + 7 test files órfãos + exception hierarchy single-impl. Deletado em massa após confirmar grep zero references. **Antes de bulk-delete, AskUserQuestion + grep imports.**

## 14. Walk-forward refit quebrado (retention shadow ~30-90d)

`/admin/mt-refit-calib` defaults `days=90, eval_days=30` falhava porque shadow tips só persistem ~45d. Fix: defaults `days=45, eval_days=14`. **Antes de defaults longos, conferir retention da tabela source.**

## 15. Boot loop confundido com OOM

`rapid_boot_count_1h=6-7` em logs Railway costuma ser sinal de **muitos deploys** (não OOM real). Verificar timestamp e diff entre boots antes de assumir crash loop. User esclareceu múltiplas vezes — não disparar emergency rollback sem checar.

## 16. /admin/mt-refit-calib REVERTE em redeploy

Refit que atualiza `markets.X.bins` em memory state NÃO é persistido em arquivo, só DB calib table. Redeploy zera. **Refit pós-redeploy obrigatório.**

## 17. Sport key mismatch CS vs CS2

Propagator filtrava `sport='cs2'` mas tips eram emitidas com `sport='cs'`. MT tips ficavam pending pra sempre. Fix `e3ae90a`: normalize cs2→cs. **Antes de comparar sport string, normalizar.**

## 18. FROZEN_HOLDOUT_DAYS=0 default = overfitting

Auto-tunes (kelly, mt_promote, gates, ev_calib, learned_corr, readiness, leak, bucket) treinavam em mesmos dados que serão re-avaliados. **Set `FROZEN_HOLDOUT_DAYS=60` em prod.** Valida via `/admin/holdout-status`.
