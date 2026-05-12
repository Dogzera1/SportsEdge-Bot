---
description: Audita código novo procurando bugs financeiros (Kelly/EV/stake/bankroll)
---

Audite o **diff atual não-commitado** (ou últimos 3 commits se working tree clean) procurando bugs financeiros. Não corrija — liste `arquivo:linha — descrição em 1 frase`. Ignore `scripts/`, `tests/`, `*.bak`.

## O que procurar

**Math monetária (Node sem Decimal):**
1. Comparação `===` ou `==` entre `Number` representando stake/odd/EV/profit (deveria ser `Math.abs(a-b) < EPSILON`)
2. `parseFloat()` em `tip.stake_units` / `tip.odds` / `tip.ev_pct` sem `Number.isFinite()` check
3. Arredondamento no meio do cálculo em vez de na fronteira de output (deveria ser `.toFixed(N)` só ao apresentar)
4. Divisão sem proteção contra zero em cálculo de EV/ROI (`profit/stake` sem `stake > 0` guard)
5. Multiplicação `odd * stake` sem validar `Number.isFinite(odd) && odd >= 1.01`

**Limites SAGRADOS (CLAUDE.md):**
6. Constante hardcoded acima de `MAX_KELLY_FRAC = 0.10` em `lib/market-tip-processor.js`
7. `KELLY_AUTO_TUNE_CEILING` excedido (default 1.50) — busca multiplicadores Kelly compostos
8. `MT_MIN_ODD` floor (1.40) bypassed em código novo
9. `MT_EV_CAP_PCT` (50) excedido sem env override documentada
10. `DAILY_TIP_LIMIT` per sport não respeitado em novo path de emissão

**Stake & bankroll:**
11. Stake calculado sem checagem de `bankroll` ou `getBaseline().unit_value`
12. `isShadow=0` (real) emit sem hierarquia Kelly mult (`KELLY_<SPORT>_<MARKET>_<CONF>` > `KELLY_<SPORT>_<CONF>` > `KELLY_<CONF>`)
13. `record-tip` chamado sem `tipProfitReais()`/`tipStakeReais()` recompute na resposta
14. Permanent disable list (`MT_PERMANENT_DISABLE_LIST`) bypassed

**Erro silencioso em path crítico:**
15. `catch (_) {}` ou `catch (e) {}` envolvendo `serverPost('/record-tip')`, Pinnacle fetch, Telegram send
16. `await sendTelegram(...).catch(() => null)` engolindo falha de DM real (alert TG403 deveria desinscrever)

## Padrão de output

```
bot.js:18450 — EV recompute usa `=== 0` em vez de EPSILON, falha em odds 1.0000001
lib/x.js:120 — stake calculado sem cap MAX_KELLY_FRAC=0.10 (vê CLAUDE.md "Limites SAGRADOS")
```

Ordene por severidade (financeira > correção > cosmética). Foco em **path real** (`is_shadow=0`), não shadow.
