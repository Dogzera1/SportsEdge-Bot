# Architecture

Desenho high-level. Para regras/princípios, ver [CLAUDE.md](./CLAUDE.md).
Para detalhes de cada workflow, ver [WORKFLOW_SPORTSEDGE.md](./WORKFLOW_SPORTSEDGE.md).

## Fluxo de uma tip (pipeline)

```
[1] Poll fontes  →  [2] Model predict  →  [3] EV/edge calc  →  [4] Gate cascade
                                                                    │
                                                                    ▼
                                                          ┌─────────┴─────────┐
                                                    [5a] Shadow log     [5b] Real emit
                                                          │                   │
                                                          └─────────┬─────────┘
                                                                    ▼
                                          [6] Settle (win/loss)  →  [7] Refit calib + auto-tune
```

## Componentes

| # | Stage | Arquivo principal | Função |
|---|---|---|---|
| 1 | **Poll** | `bot.js` (runAutoAnalysis / pollFootball / pollCs / etc) | Busca matches+odds via HTTP de Pinnacle / Sofascore / PandaScore |
| 2 | **Model** | `lib/lol-model.js`, `lib/tennis-model.js`, `lib/cs-ml.js`, `lib/football-model.js`, etc | P_modelo per outcome (Elo + Markov + trained logistic/isotonic blend) |
| 3 | **EV calc** | inline em scanner per sport | EV = P × odd − 1, edge_pp vs implied |
| 4 | **Gates** | `lib/esports-segment-gate.js` + ev-cap + sharp-divergence + tier-aware EV min/max + `lib/league-trust.js` + `lib/pre-match-gate.js` + odds-bucket-gate + leak-guard runtime state | Filtros antes de qualquer emit |
| 5a | **Shadow** | `lib/market-tips-shadow.js` `logShadowTip` → tabela `market_tips_shadow` | Pesquisa: captura tudo EV ≥ 0% (research universe, P2) |
| 5b | **Real** | `lib/market-tip-processor.js` `recordMarketTipAsRegular` → tabela `tips` (`is_shadow=0`) + Telegram DM | Emission real: passa todos gates + DM admin (P2 sintoma) |
| 6 | **Settle** | `bot.js settleCompletedTips` + `lib/database.js` | match-result fetch → win/loss/void; CLV captura |
| 7 | **Refit** | `scripts/refresh-all-isotonics.js` (nightly 3 UTC) + `scripts/fit-tennis-markov-calibration.js` | Calib refit usando shadow data (research correto, P2) |
| 8 | **Auto-tune** | `lib/kelly-auto-tune.js` (daily) + `lib/market-tips-shadow.js runMarketTipsLeakGuard` (hourly) | Real-only: tune Kelly mult, auto-disable segments com leak (CLV/ROI/streak) |

## Comunicação

- **Intra-process bot.js**: function calls síncronos + `Map`s em memória (analyzedMatches, analyzedCs, etc) + setInterval/setTimeout crons (~84 total).
- **Bot ↔ Server (mesmo processo)**: `serverGet/serverPost('/record-tip', ...)` — internal HTTP loopback.
- **Bot ↔ Scrapers externos (HTTP)**:
  - `hltv-proxy/` (FastAPI Python) ← `lib/hltv.js` via `HLTV_PROXY_BASE` env
  - `Public-Sofascore-API/` (Django Python) ← `lib/sofascore-*.js` via env
  - `agregador-odds/` (Playwright Python, **repo separado** em `C:/Users/vict_/Desktop/agregador de odds + ferramentas`) ← `lib/odds-aggregator-client.js` via Supabase REST
- **Persistence**: SQLite via `better-sqlite3` (`sportsedge.db` ~155MB, WAL mode, cache 8MB cap).
- **Notification**: Telegram bot tokens por sport (`TELEGRAM_TOKEN_<SPORT>`), DM admin via `ADMIN_CHAT_IDS`.

## Dois universos de dados (P2 — ver CLAUDE.md)

- `market_tips_shadow` = **CAUSA** (research, EV ≥ 0%, todos candidates).
- `tips` (`is_shadow=0 AND archived=0`) = **SINTOMA** (real, passou todos gates).
- Refit alimenta-se de shadow. Leak guards / auto-tunes alimentam-se de real. Não invertível.

## Deploy

- Bot principal: Railway `us-east4` (Virginia)
- Scraper worker: Railway `sa-east-1` (São Paulo) — repo separado `agregador-odds`
- Externos (hltv-proxy, Public-Sofascore-API): mesma Railway, services dedicados
