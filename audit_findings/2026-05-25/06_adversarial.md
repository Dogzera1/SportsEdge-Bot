# Adversarial / Pentest Audit — SportsEdge-Bot
**Date:** 2026-05-25
**Scope:** Web auth, SQL injection, race conditions, secret leaks, DM spam, auto-bet, Telegram, scraper, DoS, deserialization
**Methodology:** Static analysis. No exploit attempted.

---

## Executive Summary

The codebase has substantial defense-in-depth investment: lockout/CSRF/cookie session/CORS allowlist/security headers/HexStrike scanner ban/destructive-path query.key block/timing-safe key compare/HSTS/X-Frame-Options. Most `/admin/*` endpoints are properly gated by `requireAdmin()` (4483) or `isAdminRequest()+_isAdminQueryKeyDeprecated()` patterns, plus there is a centralized gate at server.js:5009-5014 for `ADMIN_ROUTES_ANY`/`ADMIN_ROUTES_POST` sets.

However, **there is a category of non-`/admin/*` endpoints that mutate database state and are NOT in either set, with NO inline auth check, and are publicly reachable**. These are the highest-impact findings. Combined with seed-* endpoints that ingest external API data into `match_results` (the table that drives settle), an attacker can poison settle and induce false `win`/`loss` outcomes.

Secondary findings include trust of Railway-internal CIDR `100.64.0.0/10` for lockout/IP-allowlist bypass (any Railway tenant on shared network can hit admin endpoints), default-permissive CORS `*` when `CORS_ALLOWED_ORIGINS` is unset, and `e.message` leak in 411 error response branches.

---

## TOP 5 ATTACK VECTORS

| # | Vector | Severity | Impact |
|---|---|---|---|
| 1 | `/seed-cs-history`, `/seed-valorant-history`, `/seed-dota`, `/seed-tabletennis`, `/seed-valorant-maps-from-vlr` — POST with `apply=1`, NO AUTH, writes to `match_results`. Attacker can flood arbitrary winners/scores. | P0 | Settle poisoning → false wins/losses → bankroll corruption |
| 2 | `/void-tip?id=N&sport=X` — GET, NO AUTH. Voids any tip silently. Attacker enumerates ids 1..N, voids real wins/losses → P&L manipulation, audit trail says `odds_wrong`. | P0 | Selective void of real-money tips |
| 3 | `/void-bad-tennis`, `/void-bad-darts`, `/void-bad-mma`, `/void-market-tips-bogus` — POST `?apply=1`, NO AUTH. Bulk void with attacker-controlled threshold (`minEv` query). Bypasses ADMIN_KEY entirely. | P0 | Mass void of pending tips → bankroll mismatch |
| 4 | Railway-internal CIDR `100.64.0.0/10` bypasses lockout + IP allowlist (`_isLoopbackIp` 4391, `_isIpInAllowlist` 4454). Any Railway co-tenant can attempt admin brute-force unlimited. | P1 | Lockout bypass for brute-force ADMIN_KEY (8 digits = ~100M). At 60 req/min admin global cap that's 6 years per IP, but multiple CGNAT IPs accelerate. |
| 5 | CORS default `*` when `CORS_ALLOWED_ORIGINS` env unset (4979). Reflects to OPTIONS responses. Combined with public mutation endpoints, enables CSRF via malicious site `<form action="https://.../seed-cs-history" method=POST>`. | P1 | Cross-origin CSRF on unauth'd mutation endpoints |

---

## P0 — Immediate $$$ Exploit

### F1. Seed endpoints — unauthenticated `match_results` write
**Files:** `server.js:26691` (`/seed-dota`), `26764` (`/seed-tabletennis`), `26816` (`/seed-cs-history`), `26893` (`/seed-valorant-history`), `27047` (`/seed-valorant-maps-from-vlr`)

**Issue:** All POST, NOT in `ADMIN_ROUTES_POST` Set (server.js:4588). Handler has no `requireAdmin()` call. Body cap absent (uses ad-hoc parsing, not `_readPostBody`).

The settle path uses `match_results` rows to determine `winner` per tip. If `/seed-cs-history?days=180&apply=1` is invoked with PandaScore-shaped data (or just relies on PandaScore being available and matches having a winner), attacker can:
1. Fire `POST /seed-cs-history?apply=1` repeatedly — populates `match_results` `game='cs'` rows.
2. Same for dota2/valorant/tabletennis.
3. **More dangerous**: even if PandaScore data is "legit", an attacker can use this to inflate compute cost (PandaScore API rate-limit, Railway egress) — pure DoS vector.

The handler at 26816 reads `PANDASCORE_TOKEN` env, fires up to 50 pages × 100 matches outbound per call. No rate-limit per-caller specific to this endpoint (only the generic 60/min general bucket at 5006).

**Real-world impact:** Combined with `/admin/repair` auto-archive (memory: 7d threshold), poisoned `match_results` rows persist and feed `settleShadowTips` + non-ML settle paths. Bankroll integrity loss.

**Fix:** Add `if (!requireAdmin(req, res)) return;` at handler entry. Add `'/seed-*'` to `ADMIN_ROUTES_POST` set.

---

### F2. `/void-tip` — unauth GET write to tips
**File:** `server.js:11010`

GET request, NO auth check, NO confirmation token, mutates `tips.result='void'` via `stmts.voidTipById` / `voidTipByMatch`. `stmts.addVoidedTip` inserts audit reason `'odds_wrong'`.

Attacker enumerates `?id=1`, `?id=2`, ..., `?sport=lol|tennis|cs|...`. Real money tips become `result='void'` → bankroll PnL recalc treats them as no-op (refund). Selective void of *winning* tips effectively steals profit, *losing* tips reduces losses (still bad for audit).

**Sport whitelist:** None — `sport = parsed.query.sport || 'esports'` accepts any string.

**Fix:** `if (!requireAdmin(req, res)) return;` at line 11011. Also missing rate-limit specific to void endpoints.

---

### F3. `/void-bad-tennis`, `/void-bad-darts`, `/void-bad-mma`, `/void-market-tips-bogus`
**Files:** `server.js:26668` (market_tips_shadow), `27721`, `27777`, `27836`

POST with `?apply=1` triggers bulk update on tips/market_tips_shadow without auth. Even with `minEv` etc as parameters, attacker controls heuristics:
- `/void-bad-tennis?apply=1` mass-voids tennis pending tips (heuristic `ev<7%` or `ev≥30%`).
- `/void-bad-mma?apply=1` same.
- `/void-market-tips-bogus?sport=tennis&minEv=0.01&hours=720&apply=1` voids EVERY market_tips_shadow row last 30d.

The SQL at line 26679 also contains a non-parameter interpolation `${hours}` — `parseInt` makes it safe, but only because of explicit `parseInt`. Defense-in-depth: missing.

**Fix:** `requireAdmin` at each handler entry.

---

### F4. `/void-old-pending` — IS in ADMIN_ROUTES_POST but `apply=1` query
**File:** `server.js:27996` — covered by central gate (4588 set). OK. Listed only to confirm.

---

## P1 — Potential Bypass

### F5. CGNAT 100.64.0.0/10 auto-bypass lockout AND IP allowlist
**File:** `server.js:4385-4392` (`_isLoopbackIp`), `4446-4454` (`_isIpInAllowlist`)

Both functions whitelist `100.64.0.0/10` (Railway internal CGNAT). Rationale was preventing internal bot.js → server.js loopback from being locked out. But Railway's CGNAT is shared across tenants — meaning **another Railway service in the same region can hit `/admin/*` from a CGNAT IP, bypassing both layers**.

A determined attacker spinning up a Railway free tier could reach `/admin/login` from a 100.64.x.x IP, bypassing lockout AND allowlist. They still need the ADMIN_KEY (8-digit numeric → 100M combos, but bot's TLS+SQL serialization probably limits to 50-100 req/s practically). Combined with `global._adminLoginFails` map per IP, attacker rotates CGNAT IPs via Railway worker spawning.

**Mitigation:** Tighten CGNAT match: only allow specific known internal IPs via env `RAILWAY_INTERNAL_IPS=10.x,...`. Or require an additional secret header for loopback bypass (HMAC of timestamp + shared internal token).

---

### F6. `/admin/login` rate limit per-IP only (not global)
**File:** `server.js:7724-7747`

`global._adminLoginFails` is a Map keyed by IP, 10 fails per 15min window. The general admin lockout at 4395 (`_isAdminLocked`) does NOT apply to `/admin/login` (it's not gated by `requireAdmin`). Attacker on multiple IPs:
- Each IP: 10 attempts / 15min = 40/h = 960/day.
- 1000 IPs × 960 = ~1M attempts/day.
- 8-digit key with 100M combos → 100 days expected.

For the noted "8-digit numeric key accepted" preference, this is a meaningful risk if `100.64.0.0/10` is reachable from external attackers via Railway shared CGNAT.

**Mitigation:** Add the failed `/admin/login` IP to the global `_adminFailureMap` lockout. Consider 2FA via Telegram DM verification.

---

### F7. CORS wildcard default when `CORS_ALLOWED_ORIGINS` unset
**File:** `server.js:4977-4988`

`allowOrigin = '*'` is the default when env not set. Plus `Access-Control-Allow-Headers` includes `x-admin-key`. Browser policy still blocks credentialed CORS with `*` for cookies, but `x-admin-key` header CAN be sent cross-origin (preflighted) if `*` was replaced with reflected origin. **Currently safe because the wildcard prevents `Access-Control-Allow-Credentials: true`** — but the unauth mutation endpoints (F1-F3) are still vulnerable to CSRF via `<form>` POST (form doesn't need CORS).

**Recommendation:** Set `CORS_ALLOWED_ORIGINS` env explicitly to known dashboard origins. Move toward `Access-Control-Allow-Origin: null` for safety.

---

### F8. `e.message` leak in error responses
**Files:** 411 occurrences, e.g. `server.js:5141, 5358, 6147, 6321, 8678, 7611, 7677, 9133, 11042, 22561, 26683, 26888, ...`

Common pattern: `catch (e) { sendJson(res, { error: e.message }, 500); }`. e.message may leak:
- File paths (`ENOENT: ... '/app/data/sportsedge.db'`)
- SQL errors with column names (better-sqlite3 errors include SQL text)
- Network errors with internal proxy URLs (`Hostname/IP doesn't match certificate's altnames`)

While `_stackForReq(req, e)` (4095) gates `e.stack` properly, `e.message` is always exposed. Lines 7059, 7335, 7360, 7383, 7444, 27042, 27142, 27400, 27589, 27710, 27944, 37887, 37921 even include `stack: _EXPOSE_STACK_DEV ? e.stack : undefined` — in dev (`NODE_ENV !== 'production'`) stack is exposed. **Verify `NODE_ENV=production` is set in Railway env.**

**Recommendation:** Wrap error responses through a helper that scrubs e.message of paths/SQL text. Production-only generic error message + log full error server-side.

---

### F9. `/admin/time-of-day-analysis` `tzOffset` direct SQL interpolation
**File:** `server.js:15780` — `'${tzOffset} hours'` inside `datetime(...)`

`tzOffset = parseFloat(parsed.query.tz_offset_hours || '-3')`. `parseFloat('-3 OR 1=1')` returns `-3` (parses prefix then stops), so SQL injection NOT exploitable. However, NaN edge case: `parseFloat('xyz')` returns `NaN`, becomes `'NaN hours'` in SQL → SQLite throws "invalid argument". This causes 500 error revealing SQL via `e.message` (F8). Defensive minimum: `Number.isFinite(tzOffset)` check + clamp to [-12, +14].

---

### F10. `/admin/tips-unit-rescale` minor SQL concat (covered by `requireAdmin`)
**File:** `server.js:16318` — `sql += ' AND sport = ' + sportFilter.replace(/'/g, "''")`

Manual quote-escape. Risky pattern (should be `?` bind), but currently admin-only and `sportFilter` already lowercased + trimmed. Defense: use parameter binding.

---

## P2 — Hardening / Lower Severity

### F11. /record-tip token gate opt-in
**File:** `server.js:28114`

`RECORD_TIP_TOKEN_REQUIRED=true` env opt-in. If unset in prod, `/record-tip` accepts any payload with no auth. Memory `project_full_audit_2026_05_23` flagged this as P0. Code path now exists but **enforcement depends on Railway env being set**. Verify via `/admin/env-audit` that `RECORD_TIP_TOKEN_REQUIRED=true` and `RECORD_TIP_TOKEN` is configured. Without this, an external attacker can `POST /record-tip` with arbitrary tip → recorded as real → DM admin → bankroll updates on settle.

### F12. XSS in admin dashboards (innerHTML with API data)
**Files:** `server.js:8260, 13028, 13160, 13371, 13483, 13552, 13595, 17341, 17343, ...` (29 patterns)

All inside admin-gated HTML pages. Data comes from JSON API responses but is rendered via string concat into innerHTML. If `e.message` or `j.error` contains attacker-controlled HTML (e.g. via a previous SQL injection or via an event_name with HTML), it executes JS in admin's browser session. Stored XSS path:
1. Attacker → `POST /record-tip` with `event_name: '<img src=x onerror=fetch(...)>'` (if F11 unprotected).
2. Admin browses `/admin/today.html` → renders `event_name` via innerHTML → XSS executes.

**Fix:** Use `textContent` for user data. Escape via `.replace(/[&<>"']/g, ...)` helper.

### F13. Stack trace in dev mode (`NODE_ENV !== 'production'`)
**File:** `server.js:4094, 7059, ...` (16 lines)

Documented behavior. Verify Railway sets `NODE_ENV=production`. If misconfigured, stack traces with full paths leak.

### F14. PandaScore API token in Authorization header for unauth `/seed-*`
**File:** `server.js:26821, 26898`

`headers = { 'Authorization': 'Bearer ${PANDASCORE_TOKEN}' }` — sent outbound to PandaScore. Not directly leaked, but combined with F1 (unauth seed endpoints), any attacker can burn PandaScore quota at will. Repeated `/seed-valorant-history?days=180` hits 50 pages × 100 = 5000 outbound requests. PandaScore plan quota exhaustion attack.

### F15. `/admin/repair` 7d auto-archive on non-ML pending tips
**File:** `server.js:17441-17468`

Admin-gated, but `apply=true` default (no confirm token). Memory documented bug where pre-game MT tips were archived prematurely. Still risk in current code: any admin (or session hijacker) can trigger mass auto-archive with one GET. Add `?confirm=true` requirement.

### F16. Path traversal in matchId/sport
Not found. All user input that touches DB is bound via `?` placeholders or whitelisted via `Set.has(sport)`.

### F17. Telegram bot tokens
**File:** `bot.js` ADMIN_IDS check ubiquitous (140+ matches). chat_id verified via `ADMIN_IDS.has(String(chatId))` (12332, 12458, etc). No tokens logged (only `process.env.SOFASCORE_PROXY_BASE` boolean check). OK.

### F18. Auto-bet executor — HTTP path
**File:** `lib/pinnacle-auto-bet.js` — POSTs to `PINNACLE_EXECUTOR_URL/place-bet` with `x-executor-token: PINNACLE_EXECUTOR_TOKEN`.

- Token IS sent (header). Good.
- No HMAC of payload (replay attack: same `tip_id` placement 2× possible if executor doesn't dedup). Executor code at `scripts/pinnacle-executor-example.js` returns synthetic `ticket_id = MOCK-${Date.now()}-${random}` in mock mode — no idempotency key in payload.
- `expected_odd` is sent. If executor accepts at any price ≤ `expected_odd * (1+slippage_pct)`, attacker between bot and executor (MITM, but TLS) can't manipulate. But if executor has its own bug (Playwright re-tries on stale price), slippage compounds.

**Phase 1 only** (DRY-RUN default), so financial impact currently zero unless `PINNACLE_AUTO_BET_ENABLED=true` AND `PINNACLE_EXECUTOR_URL` set.

**Hardening:** Add idempotency key (`request_id` UUID per bet attempt). Reject 2nd request with same key.

### F19. Telegram polling — no webhook signature validation
**File:** `bot.js:15724` (`getUpdates` polling)

Polling-based (`getUpdates` long-poll), so no webhook secret needed. Updates come direct from `api.telegram.org` over TLS. OK.

### F20. Memory exhaustion via `_rl` map (rate-limit Map)
**File:** `server.js:4542-4552`

Has 5min eviction sweep. Hard cap not explicit beyond the sweep. Attacker with many unique IPs can grow Map to millions of entries between sweeps. Hard cap `_rl.size > 1_000_000` defensive missing.

### F21. /admin/analytics-ui prompt() exposes ADMIN_KEY to JS scope
**File:** `server.js:17285`

`const ADMIN_KEY = new URLSearchParams(location.search).get('key') || prompt('admin key:') || '';`

Stored in JS closure scope, used in URL queries to `/admin/analytics?key=...`. Visible in browser DevTools network tab + browser history + Referer header. Same issue as `_isAdminQueryKeyDeprecated` warns about (server.js:4189). The HTML dashboard should use cookie session login flow (`/admin/login`) not query.key.

---

## What's Working (Defenses Verified)

- **Timing-safe key compare** (`_adminKeyEq`, 4163).
- **HttpOnly+SameSite=Strict+__Host- cookie session** for browser admin (4101-4156).
- **CSRF token** required for cookie-session mutations (4232-4248).
- **HexStrike scanner UA blocklist + honeypot paths + WAF patterns** (4263-4313).
- **POST body cap default 64KB** (`_readPostBody`, 1635-1652).
- **Body cap explicit** for `/set-bankroll`, `/record-tip`, `/claude` per memory.
- **ADMIN_KEY strict mode default** (4039) — empty key = 503 in prod.
- **All Telegram admin commands** check `ADMIN_IDS.has(String(chatId))` (140+ occurrences).
- **SQL injection**: 16 template-literal `db.prepare` cases reviewed — all use placeholder count from sanitized arrays (sportSet, idsCsv int-parsed, marketsArg.map(?), table names from sqlite_master, parseInt-clamped days). **No exploitable SQLi found.**
- **Destructive paths** (`_DESTRUCTIVE_PATHS`, 4258) require header `x-admin-key`, not query — blocks CSRF via image tag + URL log leak.
- **HSTS / X-Frame-Options DENY / nosniff** applied globally (4996-5002).
- **Lockout 10 fails / 15min → 30min ban** for admin endpoints (4372-4378). Loopback bypass (4385) is intentional for IPC.

---

## Recommended Immediate Actions

1. **Add `requireAdmin()` to `/seed-*`, `/void-tip`, `/void-bad-*`, `/void-market-tips-bogus`.** Or add them to `ADMIN_ROUTES_POST` Set. ~10 lines per endpoint.
2. **Verify `RECORD_TIP_TOKEN_REQUIRED=true` is set in Railway env** (`/admin/env-audit`). Critical.
3. **Verify `NODE_ENV=production`** (gates `_EXPOSE_STACK_DEV`).
4. **Set `CORS_ALLOWED_ORIGINS`** to known dashboard origins explicitly.
5. **Tighten `_isLoopbackIp` CGNAT match** — Railway internal IPs only via env allowlist, not blanket `100.64.0.0/10`.
6. **Add idempotency key** to auto-bet executor payload before Phase 2 production toggle.
7. **Replace `innerHTML` with `textContent`** in admin dashboards where data comes from API (XSS hardening).
8. **`?confirm=true`** for `/admin/repair` apply=true.

---

## Notes

- No exploitation attempted. All findings are static-analysis based.
- Admin key brute-force is mitigated by lockout+rate-limit in normal IP scenarios; CGNAT bypass is the only real risk.
- The codebase has heavy defense-in-depth investment — most P2 items have explicit fixes already designed (just not yet enabled or env-configured).
- P0 findings (F1-F3) are categorically `requireAdmin()` missing in handlers — straightforward fix.
