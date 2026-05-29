# Audit: Settle + Dispatch + DM Cross-Sport Profundo (2026-05-25)

Escopo: lifecycle pricing → emit → DM → settle → archive. Cobertura cross-sport (LoL, Dota2, CS, Valorant, Tennis, Football, Basket, MMA, Darts, Snooker, TableTennis). Foco: `_isShadowDispatch`, ghost real bet case mismatch, settle paths, match-id resolver, auto-archive, dispatch race, DM admin.

---

## Sumário (<500 palavras)

O sistema tem **três layers** de gating DM bem desenhados (`_isShadowDispatch` para ML inline, `_mtTryRecordAndShouldDm`/`allowDm` para MT, e inline `tipResp.isShadow===0 && autoShadowed!==1` para AI), todos protegendo contra dispatch de tips shadow para Telegram real. A cobertura de `_isShadowDispatch` (bot.js:5901) está **completa para ML em 13 paths sport×market** (LoL ML/HA/Up, Dota ML+map, MMA, Tennis, Football, TT, CS ML, Valorant ML, Darts, Snooker, Basket). Não há typos detectados além do já corrigido em commit 8ae941e.

O grande achado da auditoria é o **GAP DE `resolveAlias`**: o resolver de aggregator-BR `agg_*` (lib/match-id-resolver.js, mig 126) está integrado em apenas **2 sites** (`/football-result` linha 8809 e o sweep settle ML linha 4797). Os endpoints `/cs-result`, `/valorant-result`, `/dota-result`, `/ps-result`, `/basket-result`, `/darts-result`, `/snooker-result`, `/dota-map-result`, `/match-result`, e o `/settle` POST principal **omitem** o resolver. Pior: o **MT propagator (lib/mt-result-propagator.js, 316 linhas) não usa `resolveAlias` em lugar algum** — tips MT real com `match_id LIKE 'agg_*::mt::*'` nunca casam `match_results`. Reflexo do bug de namespace mismatch documentado em memory `project_shadow_stuck_root_cause_2026_05_23`.

Segundo achado crítico: **NÃO existe endpoint `/tabletennis-result`** no server.js. TT tem `/tabletennis-matches` (emit) mas a settle pipeline cai no fallback else→`/match-result?game=lol` que é wrong. TT tips depende exclusivamente de `AUTO_VOID_STUCK_AUTO` voidando depois de 36h (`VOID_STUCK_H_TABLETENNIS`? Não consta — usa default). Resultado: **TT tips reais NUNCA settle como win/loss** — sempre void.

Terceiro: o **`/settle` POST principal** (server.js:34218) trata apenas ML, bloqueando MT com `::mt::` (correto), mas **não chama `resolveAlias` no lookup direto** de `match_id` — qualquer tip ML com `agg_*` cai em fuzzy fallback que pode wrong-match em jogos repetidos (Wolves vs Brentford D1+D7).

Quarto: o **case-mismatch fix de market_type (commit a657c29)** está completo em bot.js:6873 (load lowercase) + server.js:22485 (write lowercase). Não há outros pares write/load com case mismatch detectado.

Quinto: o **MT path (`recordMarketTipAsRegular` bot.js:7126)** confia em `MT_DM_REAL_ONLY=true` (default) para gatear DM via `_gate.allowDm`. Se admin desligar via env (`MT_DM_REAL_ONLY=false` legacy), MT pode dispatch DM mesmo de tips shadow — proteção apenas single-layer (sem `_isShadowDispatch` defense-in-depth como ML tem).

Sexto: thresholds `AUTO_VOID_STUCK_H` defaults uniformes em 36h cross-sport, mas `NON_ML_AUTOARCHIVE` em 168h (7d). Inconsistência intencional (commit 30f5add memory) mas custou 28 zombies restored em 2026-05-23.

Sétimo: `notifySettledTips` (bot.js:5292) cobre `win/loss/void/push` cross-sport com message builder unificado (`lib/settle-message-builder.js`). Sem dedup explícito (relies on `settle_notified_at` UPDATE). 50 tip cap por ciclo + 3d lookback. **OK.**

Oitavo: `_settleRunning` mutex (bot.js:4712) previne overlap multi-cron. **OK.**

---

## Top 5 P0

### P0-1 — TableTennis NÃO tem settle endpoint (TT tips são todas void após 36h)

**Localização:** server.js (sem `/tabletennis-result` em todo o arquivo — confirmed via grep).

**Evidência:**
- bot.js:5119-5180 routing: `if (sport === 'football') endpoint = /football-result... else if (sport === 'darts')... else if (sport === 'snooker')... else if (sport === 'cs')... else if (sport === 'valorant')... else if (sport === 'basket')... else { /* default: lol/dota fallbacks */ }`
- TT cai no `else` → tenta `/match-result?game=lol` que falha sempre.
- `_settleCompletedTipsInner` (bot.js:4730) itera `Object.keys(SPORTS)`, então TT é incluído na settle loop mas SEM endpoint.
- TT é emitido (bot.js:22500-22517) — tips real são gravadas em `tips` table com `is_shadow=0`.
- Sem endpoint resolved → AUTO_VOID_STUCK voida em 36h (bot.js:26623+ default VOID_STUCK_H_TABLETENNIS=36 — não setado no map em bot.js:26627).

**Impacto:** todas tips reais TT são marcadas `void` ao invés de `win/loss`. Bankroll TT nunca acumula P/L real. Stats `/tips-history?sport=tabletennis` mostram 100% void. Memória recente confirma feed-heartbeat TT polling mas nunca settle.

**Fix sugerido:** criar `/tabletennis-result` em server.js mirror `/darts-result` (Sofascore singles), OR explicitamente skipar TT em settle loop com `continue` + comment "TT settle não implementado".

---

### P0-2 — `resolveAlias` AUSENTE em 8 endpoints de result + MT propagator

**Localização cross-sport:**
- server.js:8399 `/ps-result` (LoL PandaScore)
- server.js:8459 `/dota-result` (Dota2 PandaScore)
- server.js:6829 `/dota-map-result` (Dota2 map-level)
- server.js:8668 `/cs-result` (CS via `resolveEsportsResult`)
- server.js:8683 `/valorant-result` (Val via `resolveEsportsResult`)
- server.js:8699 `/darts-result` (Sofascore)
- server.js:8720 `/snooker-result` (Sofascore)
- server.js:9133 `/basket-result` (ESPN/Odds)
- server.js:34218 `/settle` POST main route — direct match_id lookup sem alias
- lib/mt-result-propagator.js (316 linhas) — `propagateMtResultToTips` faz lookup por `participant1/2 norm + market_type + sport` SEM resolver agg_* aliases

**Evidência:**
- lib/match-id-resolver.js:111 `function resolveAlias(db, matchId, game)` — pass-through pra non-agg, fuzzy team+date pra agg_*.
- `grep resolveAlias` retorna apenas 2 callers: server.js:4797 (sweep ML) + server.js:8809 (`/football-result`).
- Aggregator BR (repo separado `agregador-odds`) emite tips com `match_id = 'agg_<team1-slug>-vs-<team2-slug>-YYYYMMDD::mt::market::side::lnTAG'`.
- match_results popula com `espn_basket_<id>`, `sofa_<id>`, `api_<id>`, `dota2_ps_<id>`, `tennis_pin_<id>` etc.
- Direct lookup `WHERE match_id = ? AND game = ?` nunca casa pra tips agg_*.

**Impacto cross-sport:** todas tips do aggregator BR (football vence, mas outros sports não) com agg_* IDs nunca settle por direct match. Caem em fuzzy fallback ±4d que tem risco wrong-match documented (Wolves D1 vs D7 playoffs). MT tips MT do aggregator nunca settle PORQUE propagator não resolve agg_* → ficam pending até NON_ML_AUTOARCHIVE 168h archived sem result.

**Fix sugerido:** wrappear cada endpoint result em `const canonicalMid = matchId ? resolveAlias(db, matchId, game) : null;` antes do SELECT, **mais importante** patch propagator pra resolver shadow_row → canonical antes de query tips.

---

### P0-3 — MT path single-layer shadow gate (sem `_isShadowDispatch` defense-in-depth)

**Localização:** bot.js:7505 `_mtTryRecordAndShouldDm` + 13 callers (linhas 11222, 11405, 17474, 19924, 21428, 21520, 22120, 22916, 23049, 23952, 24058, 25264, 25350).

**Evidência:**
- ML paths usam **2 layers**: `_isShadowDispatch(rec, sport)` checks `autoShadowed || isShadow || isBucketShadowed`.
- MT paths usam **1 layer**: `_gate.allowDm` que retorna `{allowDm: false}` apenas se `MT_DM_REAL_ONLY=true` (default) AND record-tip falhou OR sport não promove.
- Se admin acidentalmente seta `MT_DM_REAL_ONLY=false` (legacy comportamento), MT shadow tip via `_autoRouteToShadow` server-side pode dispatch DM. Helper não consulta `rec.autoShadowed` nem `rec.isShadow`.
- Caso real do passado: HANJIN tip 4327 case mismatch (commit a657c29) era MT path — escape mecanismo nesse layer já provou possível.

**Impacto:** se env legacy ON, tips MT shadow podem ir pra Telegram users reais → bankroll mismatch. Probabilidade baixa atual (default seguro) mas fragilidade arquitetural.

**Fix sugerido:** adicionar `if (_isShadowDispatch(rec, sport)) return { allowDm: false }` no início de `_mtTryRecordAndShouldDm` após `recordMarketTipAsRegular` retornar — paralelo com ML.

---

### P0-4 — `/settle` POST principal sem resolveAlias + sem case-tolerance no winner name

**Localização:** server.js:34218.

**Evidência:**
- `_settleCompletedTipsInner` (bot.js) chama `serverPost('/settle', { matchId: tip.match_id, winner: res.winner, ... }, sport)` (linha 4887/4916/4936 tennis, 4775 mma, 5234 default).
- `/settle` faz `db.prepare("SELECT * FROM tips WHERE match_id = ? ...")` (server.js:34218+).
- Tips com `match_id = 'agg_river-plate-vs-flamengo-20260525'` nunca casam matches via direct query.
- Apenas football tem fallback em `_settleCompletedTipsInner` que usa `tip.participant1` direto pra fuzzy norm.

**Impacto:** ML tips reais do aggregator BR (football é o sport principal) cross-sport caem em fallback fuzzy — risco wrong-match em jogos repetidos.

**Fix sugerido:** server.js:34218 `/settle` POST → adicionar early `const canonicalMid = require('./lib/match-id-resolver').resolveAlias(db, matchId, sport==='esports'?'lol':sport)` antes de UPDATE.

---

### P0-5 — Tennis `/admin/tennis-mt-force-settle-tip` settle bug em event_name regex (Doubles/Challenger stuck)

**Localização:** server.js:10580+ `/admin/tennis-force-settle-tip` + bot.js:4818-4944 settle path tennis.

**Evidência:**
- Memory `[Tennis settle stuck=43 main_tour Doubles + Challenger event_name regex]` confirmado.
- bot.js:4818 `lib/tennis-mt-settle` lazy-load + `_voidHours` env `TENNIS_CHALLENGER_DOUBLES_VOID_HOURS=24` (default).
- bot.js:4986 `TENNIS_AUTO_VOID_CHALLENGER_DOUBLES_DISABLED=true` opt-out.
- ESPN doesn't index Challenger/Doubles → tips ficam stuck → autovoid silencioso após 24h → win real pode virar void (perde profit).

**Impacto:** real $ — Tennis HG audit (memory project_tennis_hg_audit_2026_05_25) ROI +21.5% n=82 14d. Cada Challenger/Doubles win mal-voidado custa 21.5% da stake média.

**Fix sugerido:** integrar Sackmann fallback pra Challenger/Doubles antes do autovoid OU aumentar `TENNIS_CHALLENGER_DOUBLES_VOID_HOURS` pra 96h enquanto Sackmann sync.

---

## P1 (fragile but functional)

### P1-1 — `_isShadowDispatch` cobertura cross-sport OK mas inline AI patterns divergem

Ai shadow dispatch (bot.js:10612) usa inline check `tipResp?.tipId && tipResp?.isShadow === 0 && tipResp?.autoShadowed !== 1` em vez de chamar `_isShadowDispatch`. Funcionalmente equivalente mas estilo divergente. Se semântica do helper mudar (ex: adicionar 3ª condição), AI escapa. **P3 refactor candidate**.

### P1-2 — Football `_isShadowDispatch(recFb, 'football')` recFb declaração correta após fix commit 8ae941e

bot.js:22200 usa `recFb` (não `rec`) corretamente. recFb declarado linha 22160. NÃO há typo. Mas é único caller com variável de nome diferente — frágil pra futuro contributor copiar pattern errado pra outro sport.

### P1-3 — `_settleRunning` mutex previne overlap mas notifySettledTips fora do mutex

bot.js:4720-4727 mutex protege `_settleCompletedTipsInner`, mas `notifySettledTips()` é chamado APÓS mutex release. 2 ciclos consecutivos rápidos podem dispatch DM duplicado se cron interval < TG retry. Mitigated by `settle_notified_at` UPDATE no SQL.

### P1-4 — `MT_LEAK_GUARD` reload assíncrono — case-insensitive já mitiga

Tip 4327 (HANJIN BRION lol|TOTAL|under) escapou pq scanner read in-memory Map populated by cron 1h. Fix em commit a657c29 lowercased on both write+load. Mas o intervalo entre HTTP write `/admin/mt-disable` e MT_LEAK_GUARD reload (até 1h) significa que disable manual pode demorar até 1h para efetivar — não há `reload-now` trigger no endpoint. **P2 melhoria**.

### P1-5 — DM admin sem dedup global (multiple cycles podem DM mesma issue 2× em <N min)

bot.js:8140-8175 `_isCycleMuted` é env-based (`MUTED_CYCLES=cycle1,cycle2` global). Não há message-content dedup. Risk-monitor + drift + healer + pipeline-digest podem todos DM admin em <10min se modelo degrada. Atualmente uso lista de admin IDs (set) e sendDM é throttled per-user mas mensagem de conteúdo idêntico pode ir 4× em 1h por cycles diferentes. **Não-bug mas noisy.**

### P1-6 — `AUTO_VOID_STUCK` 36h vs `NON_ML_AUTOARCHIVE` 168h — janela 132h onde MT tips ficam pending sem void

`NON_ML_AUTOARCHIVE` (server.js:39159+) só archived após 168h, mas `AUTO_VOID_STUCK` voida ML após 36h. **MT tips que falharam settle por agg_* gap (P0-2)** ficam pending 36-168h = 132h limbo. Cron `AUTO_VOID_STUCK` só processa `archived=0 + result IS NULL` mas não voida MT explicitly (`market_type IN ML_MARKETS_LIST` filter inclui só ML). Memory `[28 zombies restored commit 30f5add]` foi exatamente este pattern.

### P1-7 — DM 403 auto-unsub por path (groups corretamente skip) — OK

bot.js:749 `_safeUnsub` skipa grupos (chat_id <0). Persiste `_tg403BlockedThisSession` em disk (memory P1 audit 2026-05-15). Funciona bem.

### P1-8 — Tennis MT propagator settle correto via `lib/tennis-mt-settle` decodeMtMatchId

bot.js:4845-4940 carrega `tennis-mt-settle` lazy + decodifica `::mt::handicapGames::home::lnP5.5` etc. **OK** — handicap dir captured.

### P1-9 — Settle notify cobre void/push corretamente

bot.js:5300-5350 `_settleNotifyResultLabel` retorna emoji pra `win|loss|void|push`. SQL inclui todos 4 results. Query 50 tip cap / 3d lookback / `settle_notified_at IS NULL`. **OK.**

### P1-10 — Cross-sport bucket key conventions consistentes

cs2→cs (mig 074), dota→dota2 (legacy), tabletennis↔tt aliases em settle-notify pref map. Bem documentado.

---

## P2 (improvements)

### P2-1 — `_isShadowDispatch` poderia ser unified helper exportado de `lib/dispatch-gate.js`

Função inline bot.js:5901 (5 linhas), chamada em 13 sites. Move pra lib/ pra evitar future divergence.

### P2-2 — `_mtTryRecordAndShouldDm` deveria delegar pra `_isShadowDispatch` (consistência)

Adicionar `if (_isShadowDispatch(record, sport)) return { allowDm: false }` antes do `dmRealOnly` block — defense in depth.

### P2-3 — Zombie scan cron automation (atualmente manual via `/admin/zombie-scan?apply_restore=1`)

server.js:10230+ endpoint manual. Memory `[28 zombies restored 2026-05-23]` foi triggered manualmente. Cron daily seria útil mas P3 risk overfeaturing — atual humano-in-loop é OK pra now.

### P2-4 — Tennis Doubles/Challenger Sackmann sync cron (avoid 24h autovoid)

Sackmann CSV é fonte oficial WTA/ATP Doubles. Currently sync semi-manual via `/sync-tennis-espn-results?force=1` no settle path bot.js:4751. Cron daily `/sync-tennis-sackmann` pra preencher gaps Challenger/Doubles antes do `TENNIS_AUTO_VOID_CHALLENGER_DOUBLES` cron.

### P2-5 — `/match-result?game=lol` fallback do `_settleCompletedTipsInner` para sports não mapeados (TT/MMA/etc)

bot.js:5174-5180 default else: `endpoint = isPanda ? /ps-result : /match-result?game=lol`. Hardcoded `game=lol` é wrong pra TT/MMA. Adicionar map ou whitelist sports suportados, e log WARN claro.

### P2-6 — DM admin global dedup por content hash (5-min window)

Adicionar Set<sha1(message), ts> bot.js — TTL 5min. Previne pipeline-digest + drift-monitor + healer DM mesma issue 3× em 1min.

### P2-7 — Match-id resolver não usado em MT propagator — wire critical

lib/mt-result-propagator.js linha ~150 lookup `participant1/participant2` norm contra `tips` table. Add `const canonical = resolveAlias(db, shadowRow.match_id, shadowRow.sport)` antes do lookup pattern + use canonical em vez de shadowRow.match_id em `sidePattern`. Cobre agg_* shadow tips.

### P2-8 — Bot tip emit cross-sport dispatch race (mesma tip emitted 2× em <1s)

Memory P2 `[/record-tip race condition]` documented commit dedup via UNIQUE constraint mig 102. Race ainda existe entre `recentDupe SELECT` (server.js:24097) e INSERT — caught by UNIQUE constraint mas 409 retorna 'race_dedup_unique'. Não há rate-limit explicit ao client. **Defensive sufficient.**

---

## Conclusão

- **`_isShadowDispatch` ML coverage**: 13/13 inline paths cobertos cross-sport. ✅
- **MT shadow gate**: single-layer via MT_DM_REAL_ONLY. Defesa-em-profundidade ausente. ⚠️
- **AI shadow gate**: inline pattern equivalente. ✅
- **Settle endpoints**: 8 dos 10 carecem `resolveAlias` — root cause de zombies recorrentes cross-sport. 🚨
- **MT propagator**: sem resolveAlias — aggregator BR MT tips nunca settle. 🚨
- **TableTennis**: settle endpoint INEXISTENTE — todas tips void. 🚨
- **Case-mismatch ghost bet (a657c29)**: fix aplicado corretamente, sem outros write/load gaps detectados. ✅
- **Auto-archive thresholds**: 36h ML / 168h non-ML cross-sport consistente, mas zombies emergem na janela 132h. ⚠️
- **DM admin reliability**: rate-limit per-user OK, content-dedup ausente, cycle-mute env-based. ⚠️
- **CLV capture**: VAL+CS fix commit f5697b3 OK, propagation cross-sport pendente.
- **Multi-token Telegram**: cobertura validada via grep — 7 tokens por sport, fallback ESPORTS sólido.

**Próxima sessão prioridade:** wire `resolveAlias` no MT propagator + criar `/tabletennis-result` endpoint + adicionar defense-in-depth shadow gate no MT path. Cross-sport check completo realizado per CLAUDE.md P5.
