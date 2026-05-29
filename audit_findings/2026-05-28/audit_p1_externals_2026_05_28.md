# Audit P1 granularidade + Integrações externas — 2026-05-28

Auditor sênior. Evidência via grep cross-codebase + memory de sessões prévias.
Severidade: P0 = sangra dinheiro / dispatch quebra agora; P1 = leak silencioso ou observability cega; P2 = tech debt / refactor.

---

## PARTE A — P1 Granularidade

### A.P0 — Bloqueadores agudos

**A.P0-1 — LoL TOTAL calib bins 0.25 width (5× o threshold P1)**
Evidência: `node lib/lol-mt-calib.json` → `.markets.total bins=5 maxW=0.250` e `.markets.total.sides.under bins=5 maxW=0.250`. CLAUDE.md P1 exige width <0.10. Bin de 0.25 implica 25 pp colapsam num único p_model → projeção de calibração praticamente constante dentro do bin = leak documentado em memory `project_lol_total_calib_bin_pendency_2026_05_25` (ROI -61.86%, bleeding parado via permanent-add manual).
Ação: refit com `maxBinWidth=0.10` OU interpolação inter-bin. Hoje só está “tapado” por entry manual `lol|total||` no disable list.
Arquivo: `lib/lol-mt-calib.json` (todos os 5 bins do markets.total). Refit script: `scripts/fit-lol-mt-calibration.js` (verificar flag de binning).

**A.P0-2 — Tennis HG POS_home leak granular sem cut enforced**
Evidência: memory `project_tennis_hg_audit_2026_05_25` + audit 2026-05-26 (sessão atual files): POS_home dir LEAK -32.8% n=4 + POS (any side) -22.9% n=9. NEG_away EDGE +37.6% n=12 confirmado. R1 (Kelly POS_HOME=0.5 / NEG_AWAY=1.3) só foi parcialmente aplicado e bloqueado por P2 classifier — vide memory `project_pendencies_status_2026_05_28`.
Ação: confirmar Railway envs `KELLY_TENNIS_HG_POS_HOME=0.5` e `KELLY_TENNIS_HG_NEG_AWAY=1.30` ativos em produção via `/admin/env-audit`. Hierarquia em `bot.js:6266` (KELLY_TENNIS_HG_<DIR>_<SIDE> > _HG_<CONF> > _<CONF>).

### A.P1 — Granularidade insuficiente

**A.P1-1 — Calib v2 tier-aware ausente em 3 sports**
Evidência: memory `project_tennis_calib_cron_bug_2026_05_21`. Status atual:
- ✅ Tennis (atp_main.formats.bo5 n=45) — `lib/tennis-mt-calib.json`
- ✅ LoL (n=135) com tiers — `lib/lol-mt-calib.json`  (mas A.P0-1 = bins largos)
- ✅ CS (n=45, NOVO) — `lib/cs-mt-calib.json`
- ❌ Dota2 (n=15), Valorant (n=10), MMA, Football: usam global monolítico
Ação: aguardar sample crescer; documentar `min_format_n=10` threshold em comment de cron.
Arquivo: `lib/dota2-mt-calib.json`, `lib/valorant-mt-calib.json` (se existirem) — verificar refit script.

**A.P1-2 — Tier classifier P3 tech debt persistente**
Evidência: 3 implementations vivas:
- `lib/tier-classifier.js` (canonical string — atp_main/tier1/etc) — commit `7f9dcc9`
- `lib/league-tier.js` (numeric 1/2/3 — Kelly mult, leak guard)
- `lib/esports-runtime-features.js` `leagueTier` (numeração invertida, conversão consciente em esports-segment-gate)
CLAUDE.md P3 status já assume isso como "tech debt menor" mas semantics divergentes seguem expostas (1/2/3 numeric vs string vs invertido). Já documentado em sessões anteriores. Não fix arquitetural pendente, só visibility.

**A.P1-3 — `lib/league-rollup.js` modificado uncommitted**
Evidência: `git status` no início mostra `M lib/league-rollup.js`. Touch granular não revisado. Risco P1: rollup é hot path de breakdown `/admin/*-by-league`.
Ação: revisar diff + commit OR revert.

**A.P1-4 — Env hierarchy fallback monolítico em alguns paths**
Evidência: `bot.js:6266` (Kelly handicap games) tem hierarquia completa direção×side. Mas KELLY genérico per-sport (ex `KELLY_<SPORT>_<MARKET>_<CONF>`) não cobre `<TIER>` em todos caminhos. Memory `project_kelly_recommendations_2026_05_23` cita LoL inversion (ALTA=0.2 < MEDIA=0.5) ainda pendente.
Ação: user fix `KELLY_LOL_ALTA` (≥KELLY_LOL_MEDIA), e adicionar `_TIER1`/`_TIER2` overrides onde audit indicar gap (basket NBA vs regional, mma UFC vs LFA).

**A.P1-5 — Leak guards granularidade já cobre side+tier+league mas threshold tier=20**
Evidência: bot.js leak guard função: `N_CUTOFF_LEAGUE=10`, `N_CUTOFF_SIDE = max(15, N_CUTOFF/2)`, `N_CUTOFF_TIER=20`. Granularidade boa.
Risco P1: bucket de odd NÃO está como dimensão própria do leak guard cross-sport (apenas `runMtBucketGuardCycle` separado). Cross-product `tier × side × bucket` não roda em single pass — leaks concentrados em bucket-side específicos podem não disparar.
Ação: avaliar `MT_LEAK_BUCKET_SIDED` env futura (não criar sem confirmar P3 redundância com bucketGuardCycle).

### A.P2 — Tech debt

**A.P2-1 — `_classifyStuckTier` (bot.js:4188) parallel a tier-classifier**
Comment indica propósito distinto (settle log only). OK manter, mas adicionar header `// distinto de lib/tier-classifier — settle audit only`.

**A.P2-2 — 3 endpoints by-league sem disclaimer "research-only"**
`/admin/mt-shadow-by-league`, `/admin/ml-shadow-by-league`, `/admin/shadow-tier-divergence` mostram dados shadow. P2 compliance memory cita 3 endpoints sem disclaimer no payload — anti-pattern de leitura humana causando decisão errada.
Ação: adicionar campo `_note: "research-only — não usar para auto-disable"` no JSON response.

**A.P2-3 — `/admin/cross-significance` hierarquia já cobre agg/by_side/by_dir/by_dir_side/by_tier**
Status: ✅ implementado (commit `8ca372c`). Verificar se Fase 2 (persist+cron+DM) shipou — memory cita pendente.

---

## PARTE B — Integrações externas

### B.P0 — Bloqueadores agudos

**B.P0-1 — Sofascore proxy 403 persistente cross-sport**
Evidência: memory `project_sofascore_proxy_pendency_2026_05_25`. Proxy + direct retornam 403 (CF). Impersonate atual `safari260` em chain `lib/sofascore-football.js:145` + proxy core `_VALID_IMPERSONATE` set. Affects TENNIS-SYNC + MMA-DISCOVERY + DARTS + TABLE-TENNIS. ESPN fallback ativo só pra football/mma — tennis/darts/tt **sem fallback equivalente** = blind feed.
Fail-open hoje: `sofa_watchdog` DM admin, mas pipeline não trava. Risco: tennis tips dependem de Sofa pra player stats / surface / fatigue.
Ação USER: rotate `SOFASCORE_IMPERSONATE` → `firefox147` ou `chrome146`. Restart `Public-Sofascore-API` service. Documentado em memory.

**B.P0-2 — Aggregator BR `agg_<slug>` mismatch settle ainda parcial**
Evidência: `lib/match-id-resolver.js` existe (commit prévio P0 #1) mas memory `project_pendencies_status_2026_05_28` indica resolver não cobre 100% das fontes settle. server.js:9778 comment confirma "aggregator BR usa 'agg_<slug>' enquanto API-Football usa…". Tips com match_id agg_* podem virar zumbi se resolver não encontra mapping.
Ação: validar via `/admin/football-settle-diag` recente (memory cita endpoint criado `b73de03`).

### B.P1 — Observability / fallback gaps

**B.P1-1 — Valorant zero live stats granular**
Evidência: memory `project_valorant_live_stats_gap_2026_05_23`. PandaScore `/valorant/games/{id}` 403 plan-gated. Live tips dependem de gate EV≥8% sem contexto (vs LoL Riot livestats, Dota Steam RT, CS HLTV scoreboard).
Fail-closed atual: VAL ML real ROI -42% memory `project_pendencies_status_2026_05_28` (CLV VCT Americas). User decision: `VALORANT_SHADOW=true` cogitado.
Ação: ou subscribe PandaScore plan superior OU cabear VLR.gg scoreboard live (já existe `lib/vlr.js` regex `match-item` em /matches, mas não tem live score parse).

**B.P1-2 — Pinnacle key rotation manual**
Evidência: memory `reference_pinnacle_key_rotation`. Sem cron de health-check key expiry — só DM `pinnacle-key-expired` quando dispara. Risco P1: 1ª request 401 com key expirada = silent miss em ciclo de odds.
Ação: cron 4h `/admin/pinnacle-key-check` (probe simple endpoint, DM se 401). Schema drift = guard fail-open (skip update, log WARN).
Arquivo: `lib/pinnacle*.js` (verificar timeout — não foi confirmado retry policy uniforme).

**B.P1-3 — HLTV proxy: bulk sync diário falta confiabilidade**
Evidência: memory `project_mt_handlers_phase2_2026_05_21`. /results scrape retorna empty/blocked (`019bfa8`). Backoff exponencial agora `700ms→2s→5s + jitter 20%` (`lib/hltv.js` ou proxy main.py). Plan B = `scripts/sync-hltv-results.js` cron.
Status: cron documentado mas não validado em prod recente. Risco: cs2 settle handicap_rounds_mapN depende de hltv_* rows em match_results.
Ação: validar via `/admin/sync-hltv-results` endpoint manual + DM count rows fetched/dia. (server.js:12368-12372).

**B.P1-4 — VLR.gg breaker noteFail sem distinção HTTP status**
Evidência: `lib/vlr.js` `_cachedGet`: `if (!r || r.status !== 200) { _vlrNoteFail(); return null; }`. Trata 4xx (regex stale / removed) igual 5xx (transient). Threshold 4 fails → 15min cooldown. Em VLR.gg downtime real, breaker abre desnecessariamente em fault permanente (CF block) que precisa de fix de regex, não de retry.
Ação: separar `_vlrNoteFail(reason)` com cooldown 60min pra 5xx vs 5min pra 4xx. Bug confirmado em memory grep "VLR _vlrBreaker noteFail unconditional - bug".

**B.P1-5 — Riot lolesports Path 1 + Path 2 fallback chain OK mas sem timeout explícito uniforme**
Evidência: server.js:5511-5565. Path 1 (matchId direto) → Path 2 (team name varre schedule zh-CN+en-US). LOG WARN `riot-livestats Path 1 retornou 0 games`. Funcional.
Risco P1: cada path faz fetch sem confirmar AbortController. Se Riot getSchedule for lento (>30s), bloqueia poll cycle. Ação: validar `signal` em fetch (memory diz "fetch-timeouts" não totalmente uniforme).

**B.P1-6 — DeepSeek api_usage tracking FIXED (commit f649bea) mas budget cap ainda não validado**
Evidência: commit move increment up em `/claude` e `/lol-explain`. Counter funcional agora. Mas `AI_MONTHLY_BUDGET_USD` cap nunca disparou em prod até essa fix — sem dado histórico.
Ação: smoke test em staging — set cap artificialmente baixo, validar cap trigger DM.

**B.P1-7 — Telegram multi-token: idempotency em DM dispatch**
Evidência: bot.js:4054 `dm_dispatched_at` (mig 121) wire em 13 paths (`88e333c`). Cobertura aparenta completa cross-sport (LoL/CS/Dota/Val/Tennis/Football/MMA/Basket).
Risco P1 residual: AI dispatch (memory cita bot.js:10678) tinha `dmTokenEnv` direto antes — verificar se path `_runAiShadow` envia DM gateado por `dm_dispatched_at`. Memory `project_emission_audit_2026_05_26` cita fix `17c1179` mas restrito a `isBucketShadowed` (não dispatch idempotency).
Ação: query 7d `SELECT COUNT(*) FROM tips WHERE dm_dispatched_at IS NOT NULL GROUP BY sport` pra confirmar populate cross-sport.

### B.P2 — Tech debt observability

**B.P2-1 — ESPN MMA + Sofascore MMA dedup por team-name pair (bot.js:15240)**
Funcional, com `MMA_SOFASCORE_FEED_DISABLED` opt-out. OK. Dedup `NFD normalize` é frágil pra fighters com acento/apelido variável (ex Khabib/Хабиб). Caso edge — não fix agora.

**B.P2-2 — API-Football slug match: timeout 60s em `lib/api-football.js:77`**
`req.on('timeout', () => req.destroy(new Error('api-football timeout')))`. Explícito ✅. Schema validation ausente — retorna `_source: 'api-football'` cru. Risco P2 se API-Football mudar campo `fixture.id` → silent break.

**B.P2-3 — Aggregator BR slug encoding edge cases**
`lib/match-id-resolver.js:77`: `agg_<slug1>-vs-<slug2>-<YYYYMMDD>[::<extras>]`. Names com hífen (ex "Coritiba-PR") podem colidir com separator. Memory cita pattern testado em football. Não confirmado para tennis (player names com sobrenomes compostos).

**B.P2-4 — Steam Dota live: 2 endpoints sem health check**
server.js:5796 (GetLiveLeagueGames) + 5961 (GetRealtimeStats). Memory `project_audit_session_2026_05_23_pm` cita STEAM_WEBAPI_KEY set mas fallback OpenDota agg ativo — Steam RT sem dados pra match X. Logging existente (`steam-rt` source). Sem cron health-check key expiry.

**B.P2-5 — PandaScore backoff `psBackoff` (memory cita)**
LoL/Dota2/Val PandaScore plan-aware. 403 valorant games handled. Schema validation parcial — `live.supported` checked, mas mudanças de payload schema sem validation.

---

## Cross-sport check (P5)

- **A.P0-1 LoL calib bin width**: cross-check CS/Dota/Val/MMA mt-calib bin widths.
  Memory `lib/cs-mt-calib.json` foi criado novo recente — provavelmente bins padrão default. Validar via mesmo script de A.P0-1.
- **A.P1-4 Kelly env inversão**: cross-check cs/dota2/valorant/tennis/football se ALTA<MEDIA accidental.
- **B.P0-1 Sofascore 403**: já cross-sport (5 feeds dependentes documentados).
- **B.P1-3 HLTV bulk sync**: equivalência conceitual = Riot bulk sync (não existe), Steam dota bulk sync (não existe) — ambos OK pq feed live cobre.

---

## Resumo executivo (priorização user-action)

| Rank | Item | Severity | Esforço | Quem |
|---|---|---|---|---|
| 1 | A.P0-1 refit LoL TOTAL calib maxBinWidth=0.10 | P0 | M (refit script flag + redeploy) | dev |
| 2 | A.P0-2 confirmar KELLY_TENNIS_HG_POS_HOME=0.5 + NEG_AWAY=1.30 ativos | P0 | XS (env audit) | user |
| 3 | B.P0-1 rotate SOFASCORE_IMPERSONATE → firefox147 | P0 | XS (env + restart proxy) | user |
| 4 | B.P0-2 validar agg_ resolver football-settle-diag | P0 | S (endpoint check) | dev/user |
| 5 | A.P1-3 review/commit lib/league-rollup.js modificado | P1 | XS | dev |
| 6 | A.P1-4 fix KELLY_LOL_ALTA<MEDIA inversão | P1 | XS (env) | user |
| 7 | B.P1-2 cron Pinnacle key health-check 4h | P1 | S (cron novo + DM) | dev |
| 8 | B.P1-4 VLR breaker distinguir 4xx vs 5xx | P1 | S | dev |
| 9 | A.P2-2 disclaimer "research-only" em 3 endpoints shadow | P2 | XS | dev |
| 10 | B.P1-1 cabear VLR.gg live score parse pra Valorant | P1 | L (novo cron + regex) | dev |

---

## Arquivos referenciados

- `lib/lol-mt-calib.json` — bins 0.25 width (refit needed)
- `lib/tier-classifier.js` — canonical string classifier
- `lib/league-tier.js` — numeric 1/2/3 (Kelly mult, leak guard)
- `lib/esports-runtime-features.js` — leagueTier paralelo invertido
- `lib/league-rollup.js` — uncommitted modification (verificar diff)
- `lib/match-id-resolver.js` — agg_* slug resolver
- `lib/sofascore-football.js:144-149` — impersonate guidance
- `lib/hltv-results-sync.js` — bulk sync cron Plan B
- `lib/hltv.js:46-64` — proxy gating
- `lib/vlr.js:177-198` — breaker threshold + noteFail (4xx/5xx undistinguished)
- `lib/api-football.js:59-77` — timeout 60s explicit
- `lib/cross-significance.js` — Fase 1 CSA (Fase 2/3 pendente)
- `bot.js:6266` — Kelly hierarchy KELLY_TENNIS_HG_<DIR>_<SIDE>
- `bot.js:6137-6145` — Path 1/2 league blocklist
- `bot.js:4188` — _classifyStuckTier (settle log only)
- `bot.js:15240-15269` — Sofascore MMA merge dedup
- `bot.js:10725-10797` — TELEGRAM_TOKEN_<SPORT> wire
- `bot.js:22874-22883` — HLTV scoreboard visibility logSourceSilent
- `server.js:5511-5565` — Riot Path 1/2 fallback
- `server.js:5796,5961` — Steam Dota endpoints
- `server.js:12368-12372` — /admin/sync-hltv-results
- `server.js:17981-18002` — /admin/hltv-diag
- `server.js:24683-25161` — admin by-league endpoints
- `server.js:24862-24874` — /admin/shadow-tier-divergence
- `server.js:14665-14852` — /admin/cross-significance + history
