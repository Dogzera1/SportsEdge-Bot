# Endpoint Audit — 2026-05-25

**File:** `C:/Users/vict_/Desktop/lol betting/server.js` (39,204 lines)
**Endpoints detected:** 490
**Admin auth model:** ADMIN_KEY (timing-safe) via header `x-admin-key` (preferred), HttpOnly cookie session, or deprecated query `?key=` (logged WARN, rejected on destructive paths).

## Auth distribution

| Auth pattern | Count |
|---|---|
| ADMIN_HEADER_ONLY | 9 |
| ADMIN_HEADER_OR_QUERY | 127 |
| GLOBAL_GATE_ANY | 6 |
| GLOBAL_GATE_POST | 15 |
| NONE | 171 |
| REQUIRE_ADMIN | 162 |

## Risk distribution

| Risk | Count |
|---|---|
| HTML_OR_LOGIN | 15 |
| OK | 391 |
| P0_ADMIN_READ_NO_AUTH | 3 |
| P0_ADMIN_WRITE_NO_AUTH | 1 |
| P0_MONEY_NO_AUTH | 7 |
| P0_WRITE_NO_AUTH | 9 |
| P2_CSRF_RISK | 64 |

## Auth implementations (server.js:4033-4520)

- `ADMIN_KEY` — `process.env.ADMIN_KEY`, timing-safe via `require('crypto').timingSafeEqual` (server.js:4163 `_adminKeyEq`)
- `ADMIN_STRICT=true` default — when `ADMIN_KEY` empty, admin routes BLOCKED (commit 2026-04-28)
- `isAdminRequest(req)` (L4171) — accepts header `x-admin-key` OR `Authorization: Bearer <key>` OR session cookie `__Host-adminSession` (HttpOnly, prod-only Secure)
- `_isAdminQueryKeyDeprecated(req, parsed, endpoint)` (L4194) — DEPRECATED `?key=` fallback, logs WARN, REJECTED on destructive paths (regex `_DESTRUCTIVE_PATHS` L4258)
- `requireAdmin(req, res)` (L4483) — full check + IP lockout (`_isAdminLocked` L4395) + CSRF on cookie session mutations + sends 401/403
- CSRF token gen on `/admin/login` POST, required for state-changing cookie sessions; CLI x-admin-key path bypasses CSRF (autenticação per-request explicita)
- Global gate at L5009-5014: `ADMIN_ROUTES_ANY` Set (6 entries) + `ADMIN_ROUTES_POST` Set (17 entries) → `requireAdmin` enforced before handler. Includes `/record-tip`, `/settle`, `/set-bankroll`, `/reset-tips`.
- `/record-tip` (L28106): GLOBAL_GATE_POST + optional shared-secret `x-record-tip-token` (RECORD_TIP_TOKEN_REQUIRED env) + body cap 64KB
- Rate limit (L4553 `rateLimit`): 60req/min general, 10req/min for EXPENSIVE_ROUTES (`/claude`, `/odds`, `/handicap-odds`, `/mma-odds`), per-IP per-bucket
- POST body cap (L1635 `_readPostBody`): default 64KB via `POST_MAX_BODY_BYTES` env; 0/27 calls pass explicit cap (all use default); `/record-tip` overrides to 64KB explicit, `/admin/news-impact-inject` 50KB, `/metrics/ingest` 256KB, `/logs/ingest` 500KB
- Stack trace gate (L4094 `_EXPOSE_STACK_DEV`): NODE_ENV !== 'production' OR isAdminRequest — 13 sites use `_EXPOSE_STACK_DEV ? e.stack : undefined` pattern (safe in prod)
- IP lockout (L4395-4502): per-IP failure counter, 10 fails in 15min → 60min lock; loopback exempt
- XFF trust (L4051): only when socket from trusted proxy CIDRs (Railway 10.0.0.0/8 by default)
- HSTS + nosniff + X-Frame-Options DENY + Referrer-Policy applied globally (L4993-5002)
- CORS: default `*`, env `CORS_ALLOWED_ORIGINS` whitelist option
- HexStrike defense (L4263+): scanner UA blocklist + honeypot paths (`/.env`, `/wp-admin`, etc) + attack pattern WAF → 24h auto-ban

## P0 findings (no auth on sensitive endpoints)

### P0.1 — /admin/mark-dm-dispatched POST (no auth, mutates tips.dm_dispatched_at)

- **File:** server.js:22782
- **Impact:** Attacker can UPDATE tips SET dm_dispatched_at = NOW() for arbitrary tip IDs. Breaks DM delivery audit (`/admin/dm-dispatch-audit` returns nothing → silent Telegram outage missed). Indirectly affects bankroll integrity audit trail.
- **Fix:** Add `if (!requireAdmin(req, res)) return;` at line 22783 (mirror /admin/dm-dispatch-audit at L22807).

### P0.2 — /admin/analytics + /api/analytics + /analytics-data (no auth, info leak)

- **File:** server.js:16765
- **Impact:** Public exposure of all analytics-metrics (ROI by sport/league, EV calibration, win rates, shadow vs real comparison, leak detection metrics, etc). Competitive intelligence leak — any visitor sees full strategy state, identifies our edges and leaks.
- **Note:** `/analytics-data` alias may have been intentional for public dashboard, but /admin/analytics should not be public.
- **Fix:** Add `if (!requireAdmin(req, res)) return;` after the path check at L16766.

### P0.3 — Non-admin POST endpoints mutate DB without auth

9 endpoints accept POST and mutate DB without any auth check:

| File:line | Endpoint | Mutation |
|---|---|---|
| server.js:26668 | `/void-market-tips-bogus` | UPDATE market_tips_shadow SET result='void' WHERE sport=? AND ev>=N AND created_at > now-Nh |
| server.js:26691 | `/seed-dota` | INSERT match_results (PandaScore/Sofa/VLR fetch up to 90d history) — can be triggered to spam SQLite WAL + Railway memory |
| server.js:26764 | `/seed-tabletennis` | INSERT match_results (PandaScore/Sofa/VLR fetch up to 90d history) — can be triggered to spam SQLite WAL + Railway memory |
| server.js:26816 | `/seed-cs-history` | INSERT match_results (PandaScore/Sofa/VLR fetch up to 90d history) — can be triggered to spam SQLite WAL + Railway memory |
| server.js:26893 | `/seed-valorant-history` | INSERT match_results (PandaScore/Sofa/VLR fetch up to 90d history) — can be triggered to spam SQLite WAL + Railway memory |
| server.js:27047 | `/seed-valorant-maps-from-vlr` | INSERT match_results (PandaScore/Sofa/VLR fetch up to 90d history) — can be triggered to spam SQLite WAL + Railway memory |
| server.js:27721 | `/void-bad-tennis` | UPDATE tips SET result='void' WHERE sport='tennis' (with ?apply=1) — affects bankroll |
| server.js:27777 | `/void-bad-darts` | UPDATE tips SET result='void' WHERE sport='darts' (with ?apply=1) — affects bankroll |
| server.js:27836 | `/void-bad-mma` | UPDATE tips SET result='void' WHERE sport='mma' (with ?apply=1) — affects bankroll |

- **Fix:** Add to `ADMIN_ROUTES_POST` set at server.js:4588 (single-line change per endpoint).

## P1 findings

### P1.1 — CSRF surface: 107 /admin/* endpoints accept GET AND POST (query.key bypasses CSRF on cookie sessions)

Server only enforces CSRF token on POST when cookie-session is used (L4233 `_adminCsrfRequired`). For endpoints that accept BOTH POST and GET (mutation via GET), attacker can craft phishing `<img src="https://prod/admin/mt-disable?sport=lol&market=TOTAL&side=under&reason=x&key=LEAKED">` if ADMIN_KEY ever leaked via Referer/logs.
Mitigation already in place: `_DESTRUCTIVE_PATHS` regex (L4258) rejects `?key=` on `/admin/mt-block-league`, `/admin/mt-disable`, `/admin/mt-promote`, `/admin/force-sync-bankroll`, `/admin/void-tips-batch`, `/admin/unsettle-market-tips`, `/admin/restore-voided-market-tips`, `/admin/mt-unblock-league`, `/admin/mt-restore`, `/admin/reanalyze-void`, `/admin/match-result-sources-cleanup`. Other state-changing GET+POST endpoints lack this protection.

**Endpoints with GET+POST that are NOT in _DESTRUCTIVE_PATHS (CSRF candidates):**

- L9312 `/admin/basket-elo-reset`
- L9329 `/admin/basket-seed`
- L9411 `/admin/basket-train`
- L11688 `/admin/settle-market-tips-shadow`
- L11706 `/admin/sync-hltv-results`
- L11727 `/admin/sync-cs-per-map-rounds`
- L11857 `/admin/cs-permap-manual`
- L11934 `/admin/sync-valorant-per-map-rounds`
- L11953 `/admin/settle-mt-shadow-kills-manual`
- L12000 `/admin/settle-mt-shadow-kills`
- L12322 `/admin/boot-diag`
- L12375 `/admin/memory-breakdown`
- L12430 `/admin/db-stats`
- L12620 `/admin/match-result-sources-breakdown`
- L12668 `/admin/forensics`
- L13174 `/admin/today`
- L13615 `/admin/env-audit`
- L13707 `/admin/holdout-status`
- L13830 `/admin/nightly-retrain-status`
- L13889 `/admin/tip-debug`
- L14001 `/admin/learning-activity`
- L14146 `/admin/cross-significance-history`
- L14200 `/admin/gate-attribution-snapshot`
- L14234 `/admin/ml-gate-rejected-audit`
- L14281 `/admin/sofascore-proxy-health`
- L14371 `/admin/shadow-vs-real-snapshot`
- L14421 `/admin/sport-leak-summary`
- L14842 `/admin/p2-status`
- L14957 `/admin/baseline-shadow-stats`
- L15013 `/admin/cron-status`

### P1.2 — POST body cap default 64KB across 27 _readPostBody callers — fragile if a future endpoint accepts large payloads via implicit default

0 of 27 `_readPostBody` calls pass explicit `maxBytes`. Default is 64KB (server.js:1637 `POST_MAX_BODY_BYTES` env). `/metrics/ingest` overrides to 256KB, `/logs/ingest` to 500KB (acceptable). Future endpoint that should accept larger payloads will hit 413 silently; or attacker can probe to learn limits.

### P1.3 — /lol/ev-manual-365 uses isAdminRequest only (no query.key fallback) — INCONSISTENT auth pattern

- **File:** server.js:36609
- **Detail:** Only 9 endpoints use the stricter `isAdminRequest` only (no `_isAdminQueryKeyDeprecated` fallback): `/metrics/ingest`, `/admin/watchdog-trigger`, `/admin/digest-trigger`, `/admin/pnl-trigger`, `/admin/pnl-daily-now`, `/admin/pnl-volume-debug`, `/admin/pnl-granular`, `/admin/alerts`, `/lol/ev-manual-365`.
- Other 127 admin endpoints accept `?key=` (deprecated). Pattern inconsistency = footgun: if a contributor copies one pattern but pastes other use case, auth model becomes inconsistent.
- **Recommendation:** standardize on `requireAdmin(req, res)` (162 use this — most consistent).

### P1.4 — Sensitive read endpoints public (no auth on 146 GET endpoints)

Examples: `/shadow-tips`, `/unsettled-tips`, `/market-tips-recent`, `/market-tips-by-sport`, `/clv-histogram`, `/tips-em-risco`, `/pending-tips-audit`, `/clv-by-league`, `/bankroll-audit`, `/equity-curve`, `/tips-history`, `/bankroll`, `/ml-weights`, `/ml-dashboard`, `/shadow-readiness`, `/shadow-summary`, `/ai-impact`, `/roi-by-book`, `/roi-by-league`, `/league-roi`, `/roi`, `/calibration-stats`.
Many of these expose strategy edges (ROI by league, calibration metrics, shadow vs real comparison). Competitive intel leak.
Some may need to stay public for dashboard. Add `PUBLIC_DASHBOARD=true` opt-in env to keep public; default should require auth.

## P2 findings

### P2.1 — /admin/login POST: rate limit per-IP 10 fails / 15min, then 60min IP lock — OK, but 8-digit ADMIN_KEY (per memory) means 10^8 keyspace. Lockout mitigates brute-force, but consider stronger key.

### P2.2 — Inflight dedup absent on most sport-matches endpoints (commit 6621e72 only had partial)

Pending: cross-sport inflight dedup audit recommended in separate task.

## Full endpoint table (sorted by line)

| Line | Path | Methods | Auth | Risk |
|---|---|---|---|---|
| 7724 | `/admin/login` | POST | NONE | HTML_OR_LOGIN |
| 7771 | `/admin/logout` | POST | NONE | HTML_OR_LOGIN |
| 7784 | `/admin/me` | GET | NONE | HTML_OR_LOGIN |
| 8974 | `/admin/basket-resettle-audit` | GET/ANY | REQUIRE_ADMIN | OK |
| 9283 | `/admin/basket-elo-list` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 9312 | `/admin/basket-elo-reset` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 9329 | `/admin/basket-seed` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 9411 | `/admin/basket-train` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 9561 | `/admin/basket-train-status` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 9785 | `/unsettled-tips` | GET/ANY | NONE | P0_MONEY_NO_AUTH |
| 9804 | `/admin/tennis-sources-diag` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 9867 | `/admin/football-settle-diag` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 9953 | `/admin/football-sync-diag` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 10073 | `/admin/alias-audit` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 10157 | `/admin/tip-audit` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 10235 | `/admin/zombie-scan` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 10334 | `/admin/tennis-tip-match-debug` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 10450 | `/admin/tennis-stuck-bulk-diag` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 10549 | `/admin/tennis-player-stats-debug` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 10581 | `/admin/tennis-force-settle-tip` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 10652 | `/admin/tennis-mt-force-settle-tip` | GET/ANY | REQUIRE_ADMIN | OK |
| 10749 | `/tennis-settle-debug` | GET/ANY | NONE | P0_MONEY_NO_AUTH |
| 11051 | `/admin/reanalyze-void` | POST | REQUIRE_ADMIN | OK |
| 11629 | `/admin/repair-market-tips-dedup` | POST | REQUIRE_ADMIN | OK |
| 11672 | `/admin/purge-voided-market-tips` | POST | REQUIRE_ADMIN | OK |
| 11688 | `/admin/settle-market-tips-shadow` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 11706 | `/admin/sync-hltv-results` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 11727 | `/admin/sync-cs-per-map-rounds` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 11745 | `/admin/pinnacle-auto-bet-status` | GET | ADMIN_HEADER_OR_QUERY | OK |
| 11833 | `/admin/pinnacle-bet-confirm` | POST | ADMIN_HEADER_OR_QUERY | OK |
| 11857 | `/admin/cs-permap-manual` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 11934 | `/admin/sync-valorant-per-map-rounds` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 11953 | `/admin/settle-mt-shadow-kills-manual` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 12000 | `/admin/settle-mt-shadow-kills` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 12322 | `/admin/boot-diag` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 12375 | `/admin/memory-breakdown` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 12430 | `/admin/db-stats` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 12473 | `/admin/match-result-sources-cleanup` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 12553 | `/admin/match-result-sources-unique-check` | GET,POST | REQUIRE_ADMIN | OK |
| 12620 | `/admin/match-result-sources-breakdown` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 12668 | `/admin/forensics` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 12742 | `/admin/index.html` | GET/ANY | NONE | HTML_OR_LOGIN |
| 12742 | `/admin/` | GET/ANY | NONE | HTML_OR_LOGIN |
| 12742 | `/admin` | GET/ANY | NONE | HTML_OR_LOGIN |
| 12927 | `/admin/forensics.html` | GET/ANY | NONE | HTML_OR_LOGIN |
| 13044 | `/admin/quick-stats.html` | GET/ANY | NONE | HTML_OR_LOGIN |
| 13174 | `/admin/today` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 13254 | `/admin/today.html` | GET/ANY | NONE | HTML_OR_LOGIN |
| 13383 | `/admin/sport-detail.html` | GET/ANY | NONE | HTML_OR_LOGIN |
| 13493 | `/admin/cron-status.html` | GET/ANY | NONE | HTML_OR_LOGIN |
| 13615 | `/admin/env-audit` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 13707 | `/admin/holdout-status` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 13723 | `/admin/test-broadcast` | GET,POST | REQUIRE_ADMIN | OK |
| 13771 | `/admin/security-status` | GET,POST | REQUIRE_ADMIN | OK |
| 13830 | `/admin/nightly-retrain-status` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 13889 | `/admin/tip-debug` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 13964 | `/admin/cross-significance` | GET/ANY | REQUIRE_ADMIN | OK |
| 13979 | `/admin/hg-neg-readiness` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 14001 | `/admin/learning-activity` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 14083 | `/admin/clv-history` | GET | ADMIN_HEADER_OR_QUERY | OK |
| 14146 | `/admin/cross-significance-history` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 14200 | `/admin/gate-attribution-snapshot` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 14234 | `/admin/ml-gate-rejected-audit` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 14281 | `/admin/sofascore-proxy-health` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 14371 | `/admin/shadow-vs-real-snapshot` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 14421 | `/admin/sport-leak-summary` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 14543 | `/admin/tennis-calib-meta` | GET | REQUIRE_ADMIN | OK |
| 14555 | `/admin/tennis-calib-raw` | GET | REQUIRE_ADMIN | OK |
| 14595 | `/admin/news-impact` | GET | REQUIRE_ADMIN | OK |
| 14610 | `/admin/news-impact-inject` | POST | REQUIRE_ADMIN | OK |
| 14630 | `/admin/live-tips-debug` | GET | REQUIRE_ADMIN | OK |
| 14710 | `/admin/portfolio-kelly` | GET | REQUIRE_ADMIN | OK |
| 14733 | `/admin/sport-mt-calib-meta` | GET | REQUIRE_ADMIN | OK |
| 14747 | `/admin/fit-sport-mt` | POST,GET | REQUIRE_ADMIN | OK |
| 14795 | `/admin/fit-sport-mt-status` | GET | REQUIRE_ADMIN | OK |
| 14816 | `/admin/fit-tennis-markov` | POST,GET | REQUIRE_ADMIN | OK |
| 14842 | `/admin/p2-status` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 14957 | `/admin/baseline-shadow-stats` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 15013 | `/admin/cron-status` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 15165 | `/admin/pending-tips-diag` | GET,POST | REQUIRE_ADMIN | OK |
| 15237 | `/admin/football-trained-coverage` | GET,POST | REQUIRE_ADMIN | OK |
| 15297 | `/admin/re-propagate-mt` | GET,POST | REQUIRE_ADMIN | OK |
| 15352 | `/admin/match-diagnostic` | GET,POST | REQUIRE_ADMIN | OK |
| 15470 | `/admin/env-audit` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 15556 | `/admin/tg-commands` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 15635 | `/admin/overfeaturing-audit` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 15654 | `/admin/reconciliation` | GET | ADMIN_HEADER_OR_QUERY | OK |
| 15672 | `/admin/feature-inventory` | GET | ADMIN_HEADER_OR_QUERY | OK |
| 15769 | `/admin/time-of-day-analysis` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 15842 | `/admin/risk-metrics` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 15980 | `/admin/live-vs-pre-roi` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 16054 | `/admin/tips-by-confidence` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 16197 | `/admin/tips-unit-audit` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 16298 | `/admin/tips-unit-rescale` | POST | ADMIN_HEADER_OR_QUERY | OK |
| 16383 | `/admin/sport-correlation` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 16474 | `/admin/sport-shadow-envs` | GET,POST | REQUIRE_ADMIN | OK |
| 16531 | `/admin/sport-detail` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 16614 | `/admin/blocklist-stats` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 16669 | `/admin/mt-status` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 16723 | `/admin/mt-promote-explain` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 16765 | `/admin/analytics` | GET/ANY | NONE | P0_ADMIN_READ_NO_AUTH |
| 16795 | `/admin/watchdog-trigger` | GET,POST | ADMIN_HEADER_ONLY | OK |
| 16816 | `/admin/digest-trigger` | GET,POST | ADMIN_HEADER_ONLY | OK |
| 16835 | `/admin/pnl-trigger` | GET,POST | ADMIN_HEADER_ONLY | OK |
| 16857 | `/admin/pnl-daily-now` | GET,POST | ADMIN_HEADER_ONLY | OK |
| 16946 | `/admin/pnl-volume-debug` | GET | ADMIN_HEADER_ONLY | OK |
| 16998 | `/admin/pnl-granular` | GET | ADMIN_HEADER_ONLY | OK |
| 17109 | `/admin/kelly-mult-set` | POST,GET | REQUIRE_ADMIN | OK |
| 17137 | `/admin/mt-bucket-skip-set` | POST,GET | REQUIRE_ADMIN | OK |
| 17168 | `/admin/alerts` | GET,POST | ADMIN_HEADER_ONLY | OK |
| 17189 | `/admin/match-results-reconcile` | GET,POST | REQUIRE_ADMIN | OK |
| 17208 | `/admin/alerts-resolve` | POST,GET | REQUIRE_ADMIN | OK |
| 17251 | `/admin/analytics.html` | GET/ANY | NONE | HTML_OR_LOGIN |
| 17251 | `/admin/analytics-ui` | GET/ANY | NONE | P0_ADMIN_READ_NO_AUTH |
| 17360 | `/admin/cs-live-debug` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 17427 | `/admin/repair` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 17529 | `/admin/force-sync-bankroll` | POST | REQUIRE_ADMIN | OK |
| 17613 | `/admin/run-settle` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 18367 | `/admin/move-football-mt-to-shadow` | GET/ANY | REQUIRE_ADMIN | OK |
| 18827 | `/admin/ev-calibration` | GET/ANY | REQUIRE_ADMIN | OK |
| 19200 | `/admin/arb-events` | GET/ANY | REQUIRE_ADMIN | OK |
| 19215 | `/admin/sync-oe-players` | POST,GET | REQUIRE_ADMIN | OK |
| 19248 | `/admin/aggregator-status` | GET/ANY | REQUIRE_ADMIN | OK |
| 19309 | `/admin/golgg-test` | GET/ANY | REQUIRE_ADMIN | OK |
| 19327 | `/admin/thespike-test` | GET/ANY | REQUIRE_ADMIN | OK |
| 19339 | `/admin/sync-thespike` | POST,GET | REQUIRE_ADMIN | OK |
| 19363 | `/admin/stratz-test` | GET/ANY | REQUIRE_ADMIN | OK |
| 19373 | `/admin/sync-stratz-matchups` | POST,GET | REQUIRE_ADMIN | OK |
| 19392 | `/admin/tennis-abstract-test` | GET/ANY | REQUIRE_ADMIN | OK |
| 19403 | `/admin/sync-tennis-abstract` | POST,GET | REQUIRE_ADMIN | OK |
| 19434 | `/admin/fb-features` | GET/ANY | REQUIRE_ADMIN | OK |
| 19460 | `/admin/football-data-test` | GET/ANY | REQUIRE_ADMIN | OK |
| 19472 | `/admin/sync-football-data` | POST,GET | REQUIRE_ADMIN | OK |
| 19495 | `/admin/understat-test` | GET/ANY | REQUIRE_ADMIN | OK |
| 19506 | `/admin/sync-understat` | POST,GET | REQUIRE_ADMIN | OK |
| 19529 | `/admin/lol-xcheck` | GET/ANY | REQUIRE_ADMIN | OK |
| 19548 | `/admin/golgg-objectives` | GET/ANY | REQUIRE_ADMIN | OK |
| 19560 | `/admin/sync-golgg-objectives` | POST,GET | REQUIRE_ADMIN | OK |
| 19623 | `/admin/sync-golgg-matches` | POST,GET | REQUIRE_ADMIN | OK |
| 19653 | `/admin/kills-calibration` | GET/ANY | REQUIRE_ADMIN | OK |
| 19670 | `/admin/health-overview` | GET/ANY | REQUIRE_ADMIN | OK |
| 19767 | `/admin/scenarios` | GET/ANY | REQUIRE_ADMIN | OK |
| 19874 | `/admin/real-pl` | GET/ANY | REQUIRE_ADMIN | OK |
| 19955 | `/admin/errors` | GET/ANY | REQUIRE_ADMIN | OK |
| 19983 | `/admin/feed-health` | GET/ANY | REQUIRE_ADMIN | OK |
| 19994 | `/admin/oe-status` | GET/ANY | REQUIRE_ADMIN | OK |
| 20036 | `/admin/mt-brier-history` | GET/ANY | REQUIRE_ADMIN | OK |
| 20122 | `/admin/mt-calib-validation` | GET/ANY | REQUIRE_ADMIN | OK |
| 20199 | `/admin/super-odd-events` | GET/ANY | REQUIRE_ADMIN | OK |
| 20212 | `/admin/stale-line-events` | GET/ANY | REQUIRE_ADMIN | OK |
| 20225 | `/admin/book-bug-events` | GET/ANY | REQUIRE_ADMIN | OK |
| 20244 | `/admin/scraper-health` | GET/ANY | REQUIRE_ADMIN | OK |
| 20258 | `/admin/scraper-debug-snapshots` | GET/ANY | REQUIRE_ADMIN | OK |
| 20274 | `/admin/scraper-debug-snapshot` | GET/ANY | REQUIRE_ADMIN | OK |
| 20291 | `/admin/br-edges-now` | GET/ANY | REQUIRE_ADMIN | OK |
| 20311 | `/admin/casa-scorecard` | GET/ANY | REQUIRE_ADMIN | OK |
| 20383 | `/admin/bookmaker-deltas` | GET/ANY | REQUIRE_ADMIN | OK |
| 20415 | `/admin/refresh-isotonics` | GET/ANY | REQUIRE_ADMIN | OK |
| 20449 | `/admin/rollback-model` | GET/ANY | REQUIRE_ADMIN | OK |
| 20500 | `/admin/set-tip-clv` | POST | REQUIRE_ADMIN | OK |
| 20537 | `/admin/clv-capture-trace` | GET/ANY | REQUIRE_ADMIN | OK |
| 20585 | `/admin/clv-by-book` | GET/ANY | REQUIRE_ADMIN | OK |
| 20645 | `/admin/clv-leak` | GET/ANY | REQUIRE_ADMIN | OK |
| 20645 | `/admin/clv-coverage` | GET/ANY | REQUIRE_ADMIN | OK |
| 20672 | `/admin/clv-leak` | GET/ANY | NONE | P0_ADMIN_READ_NO_AUTH |
| 20771 | `/bankroll-audit` | GET/ANY | NONE | P0_MONEY_NO_AUTH |
| 20842 | `/admin/rebuild-tip-reais` | POST | REQUIRE_ADMIN | OK |
| 21028 | `/admin/tip-archive` | POST,GET | REQUIRE_ADMIN | OK |
| 21264 | `/admin/upsert-match-result` | POST | REQUIRE_ADMIN | OK |
| 21295 | `/admin/void-tips-batch` | POST | REQUIRE_ADMIN | OK |
| 21342 | `/admin/restore-voided-market-tips` | POST | REQUIRE_ADMIN | OK |
| 21357 | `/admin/unsettle-market-tips` | POST | REQUIRE_ADMIN | OK |
| 21378 | `/admin/void-orphan-market-tips` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 21446 | `/admin/mt-unvoid-recent` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 21488 | `/admin/mt-promote-audit` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 21551 | `/admin/mt-pending-trace` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 21703 | `/admin/mt-resettle-tennis-handicap` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 21752 | `/admin/mt-resettle-suspects` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 21816 | `/admin/mt-tips-suspect` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 21884 | `/admin/unsettle-tip-by-id` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 21922 | `/admin/mt-settle-audit` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 22014 | `/admin/mt-promote` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 22046 | `/admin/mt-auto-promote` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 22099 | `/admin/ml-auto-promote` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 22168 | `/admin/mt-promote-status` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 22192 | `/admin/mt-market-promote-status` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 22217 | `/admin/mt-market-promote-set` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 22238 | `/admin/tips-clv-clean-suspect` | POST,GET | REQUIRE_ADMIN | OK |
| 22287 | `/admin/clv-clean-suspect` | POST,GET | REQUIRE_ADMIN | OK |
| 22327 | `/admin/auto-shadow-reset` | POST,GET | REQUIRE_ADMIN | OK |
| 22482 | `/admin/mt-disable` | POST,GET | REQUIRE_ADMIN | OK |
| 22533 | `/admin/mt-restore` | POST,GET | REQUIRE_ADMIN | OK |
| 22569 | `/admin/mt-permanent-list` | GET,POST | REQUIRE_ADMIN | OK |
| 22589 | `/admin/mt-permanent-add` | POST,GET | REQUIRE_ADMIN | OK |
| 22611 | `/admin/mt-permanent-remove` | POST,GET | REQUIRE_ADMIN | OK |
| 22635 | `/admin/mt-block-league` | POST,GET | REQUIRE_ADMIN | OK |
| 22664 | `/admin/mt-unblock-league` | POST,GET | REQUIRE_ADMIN | OK |
| 22688 | `/admin/mt-block-tier-leagues` | POST,GET | REQUIRE_ADMIN | OK |
| 22738 | `/admin/mt-enable` | POST,GET | REQUIRE_ADMIN | OK |
| 22756 | `/admin/mt-disable-list` | GET/ANY | REQUIRE_ADMIN | OK |
| 22782 | `/admin/mark-dm-dispatched` | POST | NONE | P0_ADMIN_WRITE_NO_AUTH |
| 22806 | `/admin/dm-dispatch-audit` | GET | REQUIRE_ADMIN | OK |
| 22858 | `/admin/basket-series-info` | GET/ANY | REQUIRE_ADMIN | OK |
| 22929 | `/admin/tip-resettle` | GET/ANY | REQUIRE_ADMIN | OK |
| 22989 | `/admin/tips-list` | GET/ANY | REQUIRE_ADMIN | OK |
| 23074 | `/admin/mt-promote-preflight` | GET,POST | REQUIRE_ADMIN | OK |
| 23099 | `/admin/mt-refit-calib` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 23669 | `/admin/mt-historical-learnings` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 23950 | `/admin/tips-real-by-league` | GET/ANY | REQUIRE_ADMIN | OK |
| 24050 | `/admin/shadow-logging-health` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 24133 | `/admin/shadow-tier-divergence` | GET,POST | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 24285 | `/admin/mt-shadow-by-league` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 24420 | `/admin/ml-shadow-by-league` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 24574 | `/admin/mt-shadow-by-line` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 24743 | `/admin/mt-shadow-by-ev` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 24808 | `/admin/mt-shadow-comprehensive-audit` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 24978 | `/admin/mt-shadow-audit` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 25235 | `/admin/mt-settle-diag` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 25308 | `/admin/mt-repropagate` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 25479 | `/admin/mt-shadow-unsettle` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 25502 | `/admin/mt-shadow-unsettle-batch` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 25891 | `/admin/mt-shadow-revert-suspects` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 25971 | `/admin/settle-tennis-hg-orphans` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 26112 | `/admin/ml-calibration` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 26257 | `/admin/lol-kills-debug` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 26316 | `/admin/tip-find` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 26355 | `/admin/mt-tip-trace` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 26419 | `/admin/mt-revert-suspects` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 26523 | `/admin/clear-stale-is-live` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 26543 | `/admin/mt-resync-bankroll` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 26603 | `/admin/backfill-mt-labels` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 26668 | `/void-market-tips-bogus` | POST | NONE | P0_WRITE_NO_AUTH |
| 26691 | `/seed-dota` | POST | NONE | P0_WRITE_NO_AUTH |
| 26764 | `/seed-tabletennis` | POST | NONE | P0_WRITE_NO_AUTH |
| 26816 | `/seed-cs-history` | POST | NONE | P0_WRITE_NO_AUTH |
| 26893 | `/seed-valorant-history` | POST | NONE | P0_WRITE_NO_AUTH |
| 27047 | `/seed-valorant-maps-from-vlr` | POST | NONE | P0_WRITE_NO_AUTH |
| 27227 | `/stake-multiplier` | GET/ANY | NONE | P0_MONEY_NO_AUTH |
| 27302 | `/admin/recompute-ev-pending` | POST | REQUIRE_ADMIN | OK |
| 27408 | `/admin/apply-trained-predictions` | POST | REQUIRE_ADMIN | OK |
| 27451 | `/admin/rerun-pending-trained` | GET/ANY | REQUIRE_ADMIN | OK |
| 27595 | `/admin/backtest-trained` | GET/ANY | REQUIRE_ADMIN | OK |
| 27721 | `/void-bad-tennis` | POST | NONE | P0_WRITE_NO_AUTH |
| 27777 | `/void-bad-darts` | POST | NONE | P0_WRITE_NO_AUTH |
| 27836 | `/void-bad-mma` | POST | NONE | P0_WRITE_NO_AUTH |
| 27904 | `/admin/backfill-mma-events` | POST | REQUIRE_ADMIN | OK |
| 27955 | `/admin/migrate-football-market-types` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 29469 | `/admin/eval-football-poisson` | POST | REQUIRE_ADMIN | OK |
| 29636 | `/admin/train-football-poisson` | POST | REQUIRE_ADMIN | OK |
| 29849 | `/admin/seed-football-secondary` | POST | REQUIRE_ADMIN | OK |
| 29955 | `/admin/reset-sport-cooldown` | POST | REQUIRE_ADMIN | OK |
| 29973 | `/admin/cleanup-football-shortleagues` | POST | REQUIRE_ADMIN | OK |
| 30048 | `/admin/dynamic-threshold` | POST | REQUIRE_ADMIN | OK |
| 30526 | `/admin/league-block` | POST | REQUIRE_ADMIN | OK |
| 30548 | `/admin/blocklist-add` | POST,GET | REQUIRE_ADMIN | OK |
| 30573 | `/admin/blocklist-remove` | POST,GET | REQUIRE_ADMIN | OK |
| 30586 | `/admin/blocklist-list` | GET/ANY | REQUIRE_ADMIN | OK |
| 30599 | `/admin/drift-guard-stats` | GET/ANY | REQUIRE_ADMIN | OK |
| 30732 | `/admin/league-unblock` | POST | REQUIRE_ADMIN | OK |
| 30748 | `/admin/delete-empty-bankroll` | POST | REQUIRE_ADMIN | OK |
| 31388 | `/admin/mt-reapply-filters` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 31471 | `/admin/mt-dupes` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 31543 | `/admin/recompute-market-tip-stakes` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 31774 | `/admin/mt-promote-diag` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 32979 | `/clv-kelly-multiplier` | GET/ANY | NONE | P0_MONEY_NO_AUTH |
| 33854 | `/admin/readiness-learner-run` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 33866 | `/admin/readiness-corrections` | GET/ANY | ADMIN_HEADER_OR_QUERY | OK |
| 33880 | `/admin/readiness-corrections-prune` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 33895 | `/admin/readiness-correction-revert` | POST,GET | ADMIN_HEADER_OR_QUERY | P2_CSRF_RISK |
| 34606 | `/bankroll-baseline` | GET | NONE | P0_MONEY_NO_AUTH |
| 35564 | `/admin/sync-sackmann` | POST | REQUIRE_ADMIN | OK |
| 35785 | `/admin/dota-snapshot-collect` | POST | REQUIRE_ADMIN | OK |
| 36088 | `/bankroll` | GET/ANY | NONE | P0_MONEY_NO_AUTH |
| 37218 | `/admin/sofa-tennis-probe` | GET/ANY | REQUIRE_ADMIN | OK |
| 37325 | `/admin/mma-sofa-probe` | GET/ANY | REQUIRE_ADMIN | OK |
