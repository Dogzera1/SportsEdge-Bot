# Audit Integrações Externas — 2026-05-25

Auditoria profunda 11 integrações: Pinnacle Guest, Sofascore proxy, HLTV, PandaScore, ESPN, Riot lolesports, TheOdds API, Telegram, Supabase, scraper BR, VLR (Valorant), TheSpike.

Status: **6 P0 + 9 P1 + 5 P2 identificados**. Arquitetura geral robusta com bons padrões (warn-once throttling, per-host throttle, cooldown 429, key-expired gauges, ESPN fallback futebol). Gaps principais: PandaScore sem rate-limit/backoff, scraper BR cron schedule não confirmado, Supabase service-key risk em endpoints, VLR scraper frágil regex (mudou 4× em 5 dias).

---

## P0 — Crítico (feed quebrado afetando $$$)

### P0-1: PandaScore sem rate limit nem backoff exponential

**File**: `server.js:71-82` `_pandaGet()`

```js
async function _pandaGet(pathOrUrl) {
  if (!PANDASCORE_TOKEN || PANDASCORE_TOKEN === 'your-pandascore-token') {
    return { status: 0, body: '{}', error: 'token_missing' };
  }
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${PANDASCORE_BASE}${pathOrUrl}`;
  try { return await httpGet(url, _PANDA_HEADERS); }
  catch (e) { return { status: 0, body: '{}', error: e?.message || 'fetch_error' }; }
}
```

**Issue**: helper unificado 2026-05-19 consolidou bearer header + .catch, mas:
- **Sem throttleHost** (Sofa/HLTV têm `throttleHost('sofascore', 200ms)` — Panda não).
- **Sem retry/backoff** em 429 (Panda plan tier limita a `~1000 req/h` em free).
- **Sem distinção 403 (plan limit)** vs `401` (token bad) vs `429` (rate). Memory `project_valorant_live_stats_gap_2026_05_23` documenta 403 em `/valorant/games/{id}` — caller só vê `status !== 200` → silent fail.
- `psBackoff` em `server.js:5026` é **flag derivada** (`riotMatches.length < 10`), **não controla rate** — só seleciona fonte.

**Impact**: Caso prod: bursts de 20-30 chamadas `/lol/matches/running` + `/csgo/matches/{id}` + `/valorant/matches/running` em paralelo no boot pode esgotar quota; subsequent chamadas retornam 429 silenciosamente.

**Fix**: aplicar `throttleHost('pandascore', 500ms)` em `_pandaGet` + retry exponential em 429 + DM admin em 403 (plan_limit signal).

---

### P0-2: Pinnacle Guest API key hardcoded sem rotation pipeline

**File**: `lib/pinnacle.js:24` 

```js
const API_KEY = process.env.PINNACLE_API_KEY || 'CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R';
```

**Detection wire OK**: `lib/pinnacle.js:56-66` seta gauge `pinnacle_key_expired` + log ERROR warn-once 1h em 401/403. Bot.js:1070-1081 lê gauge e DM admin (age_s < 7200 → DM ativo).

**Issue residual**:
- Hardcoded fallback é **bom** (memory `reference_pinnacle_key_rotation` confirma key é pública — frontend pinnacle.com expõe). 
- MAS nenhum **automation** de rotation: memory `reference_pinnacle_key_rotation` documenta procedure manual (DevTools → X-API-Key → Railway env). Se Pinnacle rotaciona key e DM dispara, há janela 6-24h até user reagir.
- **Single point of failure**: 20 consumers em `server.js` (LoL/CS/Dota/VAL/Tennis/Football/MMA/Basket/Darts/Snooker), todos dependem deste fallback. Sem failover.
- `PINNACLE_ODDS_UPPER_BOUND=50` cap (`lib/pinnacle.js:135`) protege feed poisoning mas hardcoded — sem dynamic adjust per-sport.

**Impact**: rotation diária possível. Memory `reference_pinnacle_key_rotation_2026_05_23` indica casos histórios. Sem rotation auto, pipeline esports/tennis/football quebra silent até DM ler.

**Fix**: scraper headless puppeteer em cron 24h captura X-API-Key da página pinnacle.com → update settings table → restart hot-reload.

---

### P0-3: Sofascore proxy 403 cross-sport — current pending

**Files**: 
- `lib/sofascore-tennis.js:99-104` (logSofaNon200)
- `lib/sofascore-mma.js:75-82` (idem)
- `lib/sofascore-football.js:69-130` (proxy/direct path + 403 warn)
- `bot.js:1108-1131` (`sofa_watchdog` cron 60min + 6h DM cooldown)

**Issue current** (memory `project_sofascore_proxy_pendency_2026_05_25`):
- Proxy + direct ambos 403 (CF block). 
- TENNIS-SYNC upserted=0 (2 cycles).
- MMA-DISCOVERY rawCount=0 (3+ cycles).
- `SOFASCORE_IMPERSONATE` env atual `chrome146` — provider WAF detectou.
- Watchdog `bot.js:1108` está implementado e ativo (6h DM cooldown).

**Wire architecture**:
```
Public-Sofascore-API service (Railway) ← bot consume SOFASCORE_PROXY_BASE
        ↓ proxies para api.sofascore.com via curl_cffi impersonate
        ← retorna 200|404|403 conforme WAF
```

Quando proxy 403: `lib/sofascore-football.js:80-82` log WARN 1h-throttled per (status, hostname). Mas **proxy 403 sustained = no symbolic fix em código** — user action: rotate SOFASCORE_IMPERSONATE (chrome131→chrome124→safari260→chrome146 histórico).

**Impact**: 
- TENNIS schedule/H2H stats stale.
- MMA discovery ZERO (sofa primary). ESPN fallback parcial pra MMA.
- Football enrich (form/H2H) stale; ESPN fallback principal OK (700 events/3d).
- Darts/Tabletennis sem fallback.

**Fix**: 
1. Code-side: implementar rotation automatic SOFASCORE_IMPERSONATE em watchdog (cycle through chrome146→safari260→chrome131→firefox147 quando 3+ ciclos 403).
2. Public-Sofascore-API service: log proxy WAF detect signal.

---

### P0-4: ADMIN_KEY=14725836 + ADMIN_STRICT default flipado pra TRUE

**Files**: 
- `server.js:4033-4043` (key load)
- `server.js:4164-4172` (timingSafeEqual)
- Memory `feedback_admin_key_short_accepted_2026_05_20` (user mantém 8 dígitos)

**Issue**: 
- 8 dígitos numpad (`14725836`) — brute-force ~3min com 100 req/s. User aceita após audit (memory).
- `ADMIN_STRICT=true` default 2026-04-28 (good) — rotas admin bloqueadas se ADMIN_KEY=''. Override via `ADMIN_KEY_OPEN=true`.
- `timingSafeEqual` em `server.js:4167` — bom (timing attack-safe).
- MAS query param em URL (`?key=14725836`) — leak em Railway logs, proxy logs, browser history.

**Impact**: ataque brute-force sustained pode quebrar key 3-5min. Tudo `/admin/*` acessível inclui MT disable, mt-promote, calib refit, tip-archive. Ataque OWASP A07 (broken auth).

**Fix** (user-side): rotate key pra 16+ chars random + use header `x-admin-key` only (não query param).

---

### P0-5: HLTV /results scrape blocker — Plan B partial

**Files**: 
- `lib/hltv-results-sync.js` (sync bulk via /results)
- `bot.js:25847-25856` (cron `hltv_results_sync` interval 15min + setTimeout 8min boot warmup)

**Issue** (memory `project_mt_handlers_phase2_2026_05_21`):
- `019bfa8` `/results` scrape retornou empty/blocked em live test 5/5 hltv_id_not_found.
- Plan B: `scripts/sync-hltv-results.js` extraído pra lib (`hltv-results-sync.js`) wirado em cron 15min default.
- Em `lib/hltv-results-sync.js:114-130` há detecção CF challenge body match `/just a moment|cf-browser-verification|cloudflare/i` + early break — bom defensive.

**Risk**: HLTV CF block intermittent pode zerar match_results hltv_* por dias → CS per-map settle blocked (memory `project_cs_val_shadow_dm_mismatch_2026_05_21` indica per-map ingest depende disso).

**Cron rate**: 15min × maxPages=3 = ~10 reqs/15min — razoável vs CF.

**Wire OK**: `bot.js:25847-25856` deployed. Cron interval **boot warmup setTimeout = 8min** após Railway boot.

**Impact**: CS handicap_rounds_mapN / total_rounds_mapN markets ficam stuck (mig 122). PandaScore backup (`lib/pandascore-cs-stats.js`) provê per-map mas reqs PS = mesmo problema P0-1.

**Fix**:
1. Aumentar `HLTV_RETRY_ATTEMPTS=5` (default 3, env settable).
2. Adicionar metric counter `hltv_results_sync_blocked_streak` → DM admin quando >3 consecutivos.

---

### P0-6: Telegram broadcast loop sem global rate limit (30 msg/sec)

**Files**:
- `bot.js:2927+` (`sendDM`)
- `bot.js:3069-3090` (DM admin loop)
- `bot.js:4015-5488` (broadcast tip dispatch per user)

**Wire**:
- Per-token cooldown 429 ✅ (`_tgCooldown` Map + `_tgSetCooldown` clamp 1-300s).
- TG403 auto-unsub ✅ (`_tg403BlockedThisSession` Set + persist disco + retry skip).
- Per-token 429 → set cooldown ✅.
- Tg timing/metrics counters ✅.
- `family: 4` IPv4 only ✅ (Railway IPv6 issue documented).

**Gaps**:
- **Sem global 30 msg/sec rate limit**: Telegram bot global limit é 30 mensagens/segundo. Broadcast loop em `bot.js:4015` itera todos subscribers fire-and-forget sem global throttle. Se sub list crescer >100, burst pode atingir TG global rate limit → 429 cascade.
- **Per-chat 1 msg/sec**: Telegram bot per-chat limit. Loop atual não enforce — mesma chat pode receber 5 tips em <1s.
- 113 ocorrências `sendDM(` em bot.js (grep count) — sem coordinator central.

**Mitigation existente**: 429 cooldown reaction (em vez de prevention). Once cooldown ativo, **todas concorrentes** aguardam — não é perfeito mas evita hammer.

**Impact**: surtos durante tips ML scanner cluster (LoL+CS+VAL+Dota live simultâneos) podem disparar 429 prolongado em token compartilhado `TELEGRAM_TOKEN_ESPORTS`. Memory `bot.js:10661+10698+10727` confirma esports/lol/valorant compartilham token.

**Fix**: implementar global queue throttle em `tgRequest` ou `sendDM` — `await throttleHost('telegram-${token}', 35)` ms (30 msg/sec = 33ms gap).

---

## P1 — Gap operacional

### P1-1: PandaScore /valorant/games/{id} 403 plan limit — workaround via VLR não 100%

**Files**: 
- `lib/vlr.js:437-461` (`getValorantMatchMapResults`)
- `lib/valorant-per-map-ingest.js:23+46` (consumer)
- `bot.js:25879+` (cron `val_permap_ingest` default ON)

**Wire**:
- VLR scraper funcional (memory `project_valorant_live_stats_gap_2026_05_23` REVISÃO confirma VLR funciona em prod).
- Cron 30min defaults: `VAL_PERMAP_INGEST_DAYS=14`, `VAL_PERMAP_INGEST_LIMIT=15`.

**Issues**:
- VLR HTML regex **frágil**: comments em lib/vlr.js confirmam **4 mudanças regex em 5 dias** (2026-05-20, 24, 25 × 2). Linha 437+ `score` regex precisou ajuste para "mod-final" extra modifier + trailing space. Próximo VLR layout change → silent break.
- `_httpGet` `lib/vlr.js:11-26` sem retry/backoff (15s timeout, single attempt).
- Rate-limit "≥2s entre calls" documentado em comment (`bot.js:25879`) mas **não enforced** em `lib/vlr.js` — call quase parallel via Promise.all causa burst.

**Impact**: Valorant per-map ingest stuck quando VLR layout muda; primary ML continua via PandaScore mas per-map markets (handicap_rounds_mapN/total_rounds_mapN) ficam stale.

**Fix**: 
1. Adicionar `throttleHost('vlr', 2000)` em `_httpGet`.
2. Counter `vlr_parse_fail` granular per regex pattern (mirror `hltv_fetch_fail`).

---

### P1-2: TheOdds API quota tracking ausente

**Files**:
- `server.js:1654-1660` (`theOddsGet` body)
- `server.js` 50+ ocorrências `theOddsGet` em diversos endpoints

```js
async function theOddsGet(theOddsUrl) {
  return await theOddsQueue.enqueue(`theodds:${theOddsUrl}`, async () => {
    const ttlMs = parseInt(process.env.HTTP_CACHE_THEODDS_TTL_MS || '', 10) || 15 * 60 * 1000;
    return await cachedHttpGet(theOddsUrl, { provider: 'theodds', ttlMs })
      .catch(() => ({ status: 500, body: '[]' }));
  });
}
```

**Issues**:
- Cache 15min ✅ (boa).
- Queue enqueue ✅.
- **Sem leitura header `X-Requests-Remaining`/`X-Requests-Used`**: TheOdds API expõe quota em response headers — code não captura. Quota é finita (free 500/mês, paid 100k/mês).
- **Sem alert quando quota near zero**: opaque até erro 401 "quota exceeded".
- `.catch(() => ({ status: 500, body: '[]' }))` swallow errors silently — não fire markFeedFailure.

**Impact**: quota exhaustion silenciosa → MMA/Tennis odds fallback dies → no auto-bet possible em sports não-Pinnacle.

**Fix**: 
1. Capturar headers no `cachedHttpGet` (modify utils to expose).
2. Gauge `theodds_quota_remaining` + DM admin quando <10%.
3. `markFeedFailure` no `.catch` (mirror Pinnacle pattern).

---

### P1-3: VLR scraper rate limit "≥2s" não enforced em código

**Files**: `lib/vlr.js:11-26`, `bot.js:25879` (cron comment)

```js
function _httpGet(path) {
  return new Promise((ok, ko) => {
    const req = https.request({
      host: 'www.vlr.gg', path, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SportsEdge/1.0)' }
    }, res => { /* ... */ });
    req.on('error', ko);
    req.setTimeout(15000, () => { req.destroy(); ko(new Error('vlr timeout')); });
    req.end();
  });
}
```

Comment em `bot.js:25879` afirma "Rate-limit 2s entre calls" mas NENHUM `throttleHost` nem `_sleep` em lib/vlr.js. 

**Concrete consumer**: `lib/valorant-per-map-ingest.js:46` `await getValorantMatchMapResults(t1, t2, sentMs)` — chamada serial dentro do bulkIngest loop. Mas `findFinishedMatchByTeams` (vlr.js:411+) itera múltiplas pages results (`fetchResults(pg)`) sem sleep.

**Impact**: VLR.gg pode aplicar IP ban transient. Quando settle cron + per-map cron rodam simultâneos → 2-3 reqs back-to-back.

---

### P1-4: ESPN soccer/basket retorno completed sem PEN aggregate

**Files**: 
- `lib/espn-soccer.js:120-200` (parse completed)
- `lib/espn-basket.js:90-180` (idem)

**Wire OK**: 2026-05-06 fixes:
- Allowlist FINAL_STATUSES (`STATUS_FINAL`, `STATUS_FULL_TIME`, `STATUS_FINAL_AET`, `STATUS_FINAL_PEN`, `STATUS_END_OF_REGULATION`).
- PEN/AET correction: regulamentar = 1H+2H linescores (não inclui pênaltis).
- `STATUS_AGGREGATE` excluído (UCL/UEL 2nd leg — aggregate score não exposto).

**Gap**: 
- `STATUS_AGGREGATE` drop silencioso — settle path cai em auto-void-stuck após cutoff (memory). Aggregate 1X2 settles **never** → tip fica stuck void.
- Forfeit detection (`isForfeit`) só em espn-basket — espn-soccer não detecta WO (memory log indica football tem forfeit casos via discipline panel).

**Impact**: 2nd leg UCL tips 1X2 never settle correctly.

**Fix**: scrape `competitions[0].aggregateScore` se disponível em ESPN nested response.

---

### P1-5: TG global token compartilhado esports/lol/valorant + AI dispatch

**Files**: `bot.js:10661-10733`

```js
{ dmTokenEnv: 'TELEGRAM_TOKEN_ESPORTS', sport: 'lol' }
{ dmTokenEnv: 'TELEGRAM_TOKEN_MMA',     sport: 'mma' }
{ dmTokenEnv: 'TELEGRAM_TOKEN_CS',      sport: 'cs' }
{ dmTokenEnv: 'TELEGRAM_TOKEN_ESPORTS', sport: 'dota2' }  // SHARES with LoL
{ dmTokenEnv: 'TELEGRAM_TOKEN_TENNIS',  sport: 'tennis' }
{ dmTokenEnv: 'TELEGRAM_TOKEN_FOOTBALL', sport: 'football' }
{ dmTokenEnv: process.env.TELEGRAM_TOKEN_VALORANT ? 'TELEGRAM_TOKEN_VALORANT' : 'TELEGRAM_TOKEN_CS', sport: 'valorant' }
```

**Issue**:
- `TELEGRAM_TOKEN_ESPORTS` compartilhado **LoL + Dota2** → 429 em um afeta outro.
- `TELEGRAM_TOKEN_CS` fallback Valorant — surtos VAL+CS broadcast burst mesmo token.
- Memory `bot.js:11178+11432+11801+...` confirma `_lolGateAd`/`_dotaGateAd`/etc check separados mas tokens combinam.

**Mitigation**: per-token cooldown `_tgCooldown` Map (token → epochMs) — quando token X tem 429, futuras LoL+Dota aguardam.

**Impact**: 429 cascade pode atrasar tips dispatch em concurrent sports.

**Fix**: split tokens 1:1 per-sport (user-side env).

---

### P1-6: Supabase service-role key usage em odds-aggregator-client

**File**: `lib/odds-aggregator-client.js:90-93, 910-933`

```js
function _supabaseServiceKey() {
  return (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
}
```

**Issue**:
- Service-role key bypass RLS → full read/write em Supabase project.
- Usado em endpoints admin pra ler `snapshots_debug` (RLS using(false)).
- 4 sites usam service key (`910`, `913`, `932`, `933`).
- Sem rotation procedure documented (memory `reference_pinnacle_key_rotation` cobre Pinnacle only).

**Impact**: se service key vazar via logs / Railway env exposed / git commit acidental → full DB access scraper BR.

**Fix**:
1. Rotate Supabase service-role key trimestralmente.
2. Audit access — confirm service key só em endpoints autenticados.

---

### P1-7: Pinnacle isInMaintenance() fix gap — markets endpoint não trata 503

**File**: `lib/pinnacle.js:50-91`

`_get()` detecta 401/403 (key expired) + 503 (maintenance flag global) ✅.

**Gap**: `fetchSportMatchOdds` **throws** quando maintenance ativo (`lib/pinnacle.js:228-234`):

```js
if (!matchups.length) {
  if (_pinnacleMaintenance) {
    const err = new Error('pinnacle_maintenance_503');
    err.code = 'PINNACLE_MAINTENANCE';
    throw err;
  }
  return [];
}
```

Bom — callers `feed-heartbeat.markFeedFailure` dispara. Mas `getMatchupMarkets` / `getMatchupHandicaps` / `getMatchupMoneylineByPeriod` retornam **null silent** quando 503 (não throw). Resultado: `/odds-markets` retorna `null markets` → scanMarkets pula → MT shadow zerado durante outage.

**Impact**: durante Pinnacle maintenance (raro mas existe — observed 2026-05-11), MT shadow stoppa coleta de research data → calib refit subsequente perde sample.

**Fix**: propagar `_pinnacleMaintenance` flag em `getMatchupMarkets` retorno (`{ maintenance: true }` shape).

---

### P1-8: BR scraper cron schedule não confirmado

**File**: `bot.js:30178+` (`_scraperHealthDmAt` Map)

Detector OK (`BR-SCRAPER-OUTAGE`):
- Threshold default `BR_SCRAPER_OUTAGE_MIN_PCT=0.5` (50% down).
- Exclude `bet365` default (broken by design).
- Cooldown 30min DM admin per aggregate event.
- GC limpa entries > 24h.

**Gap**: o **cron interval** que dispara esta function NÃO está claro em audit. Memory não cita. Procura por `runScraperHealth` / `setInterval.*scraperHealth` em bot.js retornou 0 hits diretos no batch.

**Impact**: se detector roda só on-demand (admin endpoint) ou em cron raro, outage agregada pode passar 6-12h sem DM admin.

**Fix**: confirmar cron schedule + setar SLA (recommend 15min).

---

### P1-9: Pinnacle Odds Upper Bound = 50 — sem per-sport tuning

**File**: `lib/pinnacle.js:135`

```js
const _upperBound = parseFloat(process.env.PINNACLE_ODDS_UPPER_BOUND || '50');
```

Anti-poisoning bound 50. Mas:
- LoL/CS: odds raramente > 10 (favoritos 1.05, underdogs 8-15). Bound 50 é frouxo.
- Tennis ATP: outsiders Wimbledon 1R podem chegar 30-40 (Nadal vs qualifier). 50 ok.
- MMA: heavy favorites underdog até 20-25. 50 ok.
- Snooker: longshots até 50+. Bound 50 talvez muito apertado.

**Impact**: cap único todos sports — não optimal. Risk: feed poisoning specific sport não detectado.

**Fix**: env hierarchy `<SPORT>_PINNACLE_ODDS_UPPER_BOUND` > `PINNACLE_ODDS_UPPER_BOUND` (default 50).

---

## P2 — Improvement

### P2-1: LoL cross-source check (gol.gg vs OE) sem PandaScore

**File**: `lib/lol-source-cross-check.js:71` comment

```js
// PS source: skipped (PS plan blocks per-game data)
// Cross-source só com gol.gg + OE por enquanto.
```

Cross-validation roda com 2 fontes — minSources default 2. Functional mas weaker (3 fontes seria ideal pra majority-vote).

**Fix**: monitor PS plan upgrade — when accessible, wire PS as third source.

---

### P2-2: HLTV proxy regex parser frágil — schema drift

**File**: `lib/hltv.js:300-400` (parseTopTeams)

Comments confirmam mudanças HLTV layout out/2025 (position wide-position extra, points wrapper span). Counter `hltv_fetch_fail` per cause exists. Mas regex em si frágil.

**Fix**: considerar puppeteer parse fallback quando regex fail >3 consecutive.

---

### P2-3: TheOdds API .catch silencia todos erros

**File**: `server.js:1659`

```js
return await cachedHttpGet(theOddsUrl, { provider: 'theodds', ttlMs })
  .catch(() => ({ status: 500, body: '[]' }));
```

`.catch(() => ...)` swallow all errors → consumers veem `{status:500, body:[]}` mas não fire markFeedFailure.

**Fix**: log WARN throttled + markFeedFailure.

---

### P2-4: Riot lolesports usado mas lib não tem header file dedicado

**Files**: 
- 4 hits `lolesports` em `bot.js`
- `lib/lol-*.js` NÃO tem `lol-lolesports.js` (libs são lol-markets, lol-model, lol-extra-markets, lol-kills-* etc)

Riot/lolesports logic está **inline em bot.js** (path 1+2 do `/live-gameids`). Não centralizado.

**Impact**: tech debt — P3 violator (similar logic duplicated cross-paths).

**Fix**: extract `lib/riot-lolesports.js` com getSchedule / getEventDetails / live-game.

---

### P2-5: Telegram `family: 4` IPv4 only — workaround sem cleanup

**File**: `bot.js:1748` (tgRequestOnce)

```js
family: 4, // força IPv4 — Railway tem problemas de conectividade IPv6 com Telegram
```

Comment indica Railway IPv6 issue. Sem health-check do path IPv6 (talvez já resolvido Railway-side). Sustained workaround dead-code se infra mudou.

**Fix**: anual audit — try `family: 0` (dual-stack) em endpoint admin shadow, compare success rate.

---

## Cross-sport regression — /odds endpoint coverage

**File**: `server.js:6326` (`/odds` endpoint)

**Memory** `f5697b3+2cc3d00`: VAL + CS branches adicionados 2026-05-25. Verificação:

- ✅ `dota2` branch: `server.js:5026-5060` (full path).
- ✅ `lol` branch: implicit fallback to esports cache `oddsCache.esports_pin_*` (`server.js:6489+`).
- ✅ `valorant` branch: `server.js:6398-6432` (commit `f5697b3+2cc3d00`).
- ✅ `cs`/`cs2` branch: `server.js:6434-6470` (idem).
- ❌ **`tennis`** branch: no explicit case. Cai em fallback genérico — mas tennis tem `_tennisPinnacleCache` separado.
- ❌ **`football`** branch: no explicit case.
- ❌ **`basket`** branch: no explicit case.
- ❌ **`mma`** branch: no explicit case.
- ❌ **`darts`** / **`snooker`** / **`tabletennis`** branches: none.

**Risk**: CLV capture tennis/football/basket/mma pode ter mesmo padrão de bug VAL/CS — cache dedicado não consultado. **Memory `project_audit_pendencies_2026_05_24` validation #1**: confirma CLV VAL coverage 6.4%→90%+ esperado pós-fix.

**Action**: audit `checkCLV` em `bot.js:30742+` para confirmar cada sport usa correct game param. Cross-sport verification pendente.

---

## Top 5 Findings (prioritized)

1. **P0-1 PandaScore sem rate limit/backoff** — `server.js:71-82`. Burst pode esgotar quota + 429/403 silent fail (`/valorant/games/{id}` confirmado plan-locked). **Fix curto**: throttleHost + retry exponential.

2. **P0-3 Sofascore proxy 403 cross-sport pending** — TENNIS-SYNC=0, MMA-DISCOVERY=0 atualmente. **User action**: rotate `SOFASCORE_IMPERSONATE` chrome146→safari260 OR firefox147. **Code-side**: implementar auto-rotation watchdog quando 3+ ciclos 403.

3. **P0-6 Telegram broadcast loop sem global 30 msg/s gate** — `bot.js:4015+`. Per-token cooldown reativo, mas global enforce missing. Risk: 429 cascade em surto multi-sport simultâneo. **Fix**: `throttleHost('telegram-${token}', 35)` em `tgRequest`.

4. **P1-2 TheOdds API quota tracking ausente** — `server.js:1654`. Sem leitura `X-Requests-Remaining` header → quota exhaustion silenciosa → MMA/Tennis fallback dies. **Fix**: extract header em cachedHttpGet + gauge + DM near-limit.

5. **Cross-sport `/odds` endpoint coverage gap** — VAL+CS fixed 2026-05-25, mas **tennis/football/basket/mma branches ausentes**. Mesmo padrão de bug possível em CLV capture per-sport. **Action**: audit `checkCLV` (bot.js:30742+) cross-sport.

---

## Pontos fortes detectados

- ✅ Pinnacle key rotation gauge wire (lib/pinnacle.js:56 + bot.js:1070) — DM admin dispara <2h.
- ✅ Per-host throttle (`throttleHost('sofascore', 200ms)`) — implementado 2026-05-14.
- ✅ TG403 persist disco — `tg403_blocked.json` boot-load.
- ✅ TG per-token cooldown 429 — Map cache, clamp 1-300s.
- ✅ ESPN soccer/basket PEN/AET regulamentar correction.
- ✅ HLTV granular counters `hltv_fetch_fail{reason}`.
- ✅ Sofascore proxy 4xx path-specific hint (proxy=upstream WAF / direct=CF).
- ✅ ADMIN_KEY timingSafeEqual (anti-timing attack).
- ✅ Pinnacle odds upper bound (anti-poisoning).
- ✅ Sofascore burst protection via global throttleHost (não per-lib).
- ✅ HLTV CF challenge detection body match + early break.
- ✅ HLTV retry backoff exponential + jitter ±20%.
- ✅ Cross-source LoL kill check (gol.gg vs OE) com majority-vote.
- ✅ TLS family:4 IPv4 only — Railway documented workaround.
- ✅ BR scraper outage detection com bet365 exclude (broken by design).
- ✅ Pinnacle virtual matchup classification (sets vs games) fix 2026-04-25.
- ✅ Aggregator BR slug normalization (valhecano→vallecano typo dedup).
