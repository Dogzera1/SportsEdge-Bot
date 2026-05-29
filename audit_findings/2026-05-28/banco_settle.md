# Auditoria BANCO / SETTLE / INFRA — 2026-05-28

Domínio: settlement pipeline, DB health, memória/OOM, queries. Commit prod `fb9f42e`.
Investigação só-leitura (sem edição/POST). Cruzado com L4/L6 do FINDINGS_SO_FAR.

---

## RESUMO EXECUTIVO

- **`app=degraded` é FALSO ALARME** — não é restart, não é OOM, não é DB. É `lastAnalysisAt=null` no processo `server` (server.js:8499). Não há custo financeiro, mas mascara alertas reais.
- **"20 reboots/24h" NÃO é crashloop** — são redeploys Railway (SIGTERM, crash_count=0). Último crash real foi 2026-05-21 (7 dias atrás). 0 intervalos <120s.
- **1 OOM real** (13.7h atrás, 06:01, rss=380MB) — foi **container/cgroup kill** (`last_near_heap_limit=NULL` → NÃO foi exaustão de heap V8). Off-heap nativo ~200MB amplificado pelo DB de 387MB (56% bloat).
- **DB bloat 219MB (56%)** — causa: `auto_vacuum=NONE` (default, nunca setado) + DELETEs de retenção que liberam páginas mas nunca devolvem ao FS. Reclaimable só via VACUUM.
- **Settle stuck = majoritariamente data-coverage gap, NÃO bug de código.** Dos 186 pending não-arquivados: ~99 tennis (doubles/Challenger/ITF que ESPN não cobre) + 31 dota2/cs MAP (precisam per-map data). São quase todos `is_shadow=1` → custo é P2 (sinal de calib perdido), não ROI real. **A exceção real-money: 4 tips football `agg_*` TOTAL (is_shadow=0)** stuck por match_id mismatch.

---

### [SEV: P1] `app=degraded` permanente por `lastAnalysisAt=null` no processo server
- **Onde**: server.js:829 (`let lastAnalysisAt = null`), :8238 (`stale`), :8257 (alert gate), :8499 (`status`), :8768 (único setter via `POST /record-analysis`)
- **Evidência**:
  - `status = !dbOk ? 'error' : (alerts.some(critical) ? 'degraded' : (stale ? 'degraded' : 'ok'))` (8499)
  - `stale = !lastAnalysisAt || (Date.now() - new Date(lastAnalysisAt).getTime() > 2h)` (8238) → **se `lastAnalysisAt===null`, `stale=true` sempre**
  - O alert `analysis_stale` só é empurrado se `(stale && lastAnalysisAt)` (8257) → quando `null`, `stale=true` MAS `alerts=[]`. Bate exatamente com o sintoma observado (degraded + alerts vazio + lastAnalysis=null).
  - Único setter: `POST /record-analysis` (8768). `lastAnalysisAt` é módulo-level no **server.js**; o loop de análise roda no **bot.js**. Se o bot não faz `POST /record-analysis` (ou parou de fazer), o server fica degraded eternamente independente da saúde real.
  - Cross-check: bot.js só lista `/record-analysis` em `ADMIN_POST_PATHS` (allowlist, bot.js:2084) — **nenhum caller `serverPost('/record-analysis')` foi encontrado em bot.js**. Logo o gauge nunca é alimentado em prod → degraded estrutural.
- **Impacto financeiro**: zero direto, mas **alto risco operacional**: `/health` é consumido por monitor externo e pelo bot (alerts polling). "degraded" cravado = sino que toca sempre = ninguém olha = OOM/settle-leak reais passam despercebidos (boy-who-cried-wolf). L4/L6 ficaram latentes por causa disso.
- **Causa raiz**: gauge `lastAnalysisAt` mora no server mas só pode ser setado por um POST que o bot nunca dispara. Provável regressão (endpoint existe, caller sumiu) OU nunca foi cabeado após split bot/server.
- **Fix proposto** (NÃO aplicar): (a) cabear `serverPost('/record-analysis')` no fim de cada ciclo de scan do bot; OU (b) trocar a fonte de `stale` por algo que o server SABE localmente (ex: `lastEsportsOddsUpdate` que já existe em server.js, ou heartbeat de cron). Opção (b) é mais robusta (não depende de cross-process POST). Confirmar com humano qual semântica "analysis" representa.
- **Cross-sport**: N/A (infra global).

---

### [SEV: P1] DB bloat 219MB/387MB (56%) — `auto_vacuum=NONE`, sem VACUUM/incremental nunca
- **Onde**: lib/database.js:24-67 (bloco de PRAGMAs no boot). Nenhuma linha `auto_vacuum`. Grep `auto_vacuum|incremental_vacuum` em todo `*.js` = **zero ocorrências** (só `VACUUM` manual em scripts/backup-db.js e endpoint admin).
- **Evidência**: db_stats `freelist_pages=56140` de `page_count=99301` (4KB/page) → **219.3MB reclaimáveis**. DB cresceu 145MB→387.9MB (2.6x). Retenção roda DELETEs (bot.js:26521 `runAuditTablesRetention`, lib/db-retention.js) mas SQLite com `auto_vacuum=NONE` **NÃO devolve páginas ao FS** — só marca como freelist (reuso interno). Páginas freelist contam pro tamanho do arquivo → mais páginas residentes em RSS → amplifica pressão de memória (L4).
- **Impacto financeiro**: indireto mas material — arquivo 387MB num cap de 512MB deixa só ~125MB de folga pro runtime Node de 2 processos (~260MB cada RSS). É o que torna o OOM container-kill possível. Bloat → OOM → restart → settle/scan interrompidos.
- **Causa raiz**: histórico de DELETEs grandes (match_result_sources, ml_gate_rejected_audit, market_tips_shadow 45d, dota_live_snapshots, super_odd_events, bookmaker_delta_samples) sem reclaim. `auto_vacuum` nunca foi habilitado (não pode ser ligado retroativamente sem 1 VACUUM full).
- **Fix proposto** (NÃO aplicar — decisão de humano, mexe em DB):
  - **VACUUM full é ARRISCADO no Railway 512MB**: precisa ~388MB de espaço temp livre no `/data` + abre 2ª cópia. Em disco pode caber (Railway volume costuma ter folga), mas pico de I/O + lock exclusivo bloqueia writes por segundos-minutos. **Fazer em janela de baixo tráfego, com backup antes (scripts/backup-db.js já faz `VACUUM INTO`).**
  - **Alternativa mais segura**: habilitar `PRAGMA auto_vacuum=INCREMENTAL` (requer 1 VACUUM full inicial pra mudar o modo, depois reclaim é incremental) + cron chamando `PRAGMA incremental_vacuum(N)` em lotes pequenos guardado por `isMemCritical()`. Reclama gradualmente sem lock longo.
  - **Imediato sem risco**: o endpoint `/admin/match-result-sources-cleanup?apply=1&vacuum=1` já existe; rodar fora-de-pico recupera o maior contribuinte (match_results sources). Mas isso faz VACUUM full também — mesmo caveat.
  - Recomendação: backup → VACUUM full 1x em janela → setar `auto_vacuum=INCREMENTAL` → cron incremental_vacuum semanal guardado. Validar `freelist` cair via `/admin/db-stats`.
- **Cross-sport**: N/A (DB global).

---

### [SEV: P1] Retenção das tabelas GRANDES não cobre os maiores ofensores
- **Onde**: bot.js:26546-26553 (`runAuditTablesRetention` targets) + lib/db-retention.js:13-20 (TABLES) + lib/database.js:594 (cleanOldOdds 14d) / :684 (cleanOldSynced 60d)
- **Evidência**: As tabelas que dominam o DB **não têm retenção**:
  - `match_results` 229.612 rows — **sem cleanup** (só DELETE seletivo football por league em server.js:30701/30824). É a maior tabela e cresce monotônico.
  - `oracleselixir_players` 153.010, `tennis_match_stats` 115.006, `oracleselixir_games` 30.602 — datasets de referência (re-sync sobrescreve, mas crescem).
  - `dota_live_snapshots` 12.277, `super_odd_events` 3.317, `bookmaker_delta_samples` 6.449, `book_bug_events` 1.839, `velocity_events`, `arb_events` 1.075 — telemetria live **sem retenção** (não estão em `db-retention.TABLES` nem em `runAuditTablesRetention.targets`).
  - O que TEM retenção (tip_factor_log 109 rows, mt_auto_promote_log 20, bankroll_drift_log 4) são tabelas minúsculas — a retenção criada hoje (`5eb06fa`) mira nas tabelas erradas pro objetivo de bloat.
- **Impacto financeiro**: indireto (bloat → OOM, vide finding anterior). `dota_live_snapshots` (12k) e `super_odd_events`/`bookmaker_delta_samples` são candidatos óbvios a retenção 30-60d.
- **Causa raiz**: retenção foi desenhada pra "log tables sem cleanup" mas escolheu as de menor volume; as grandes (match_results, snapshots live) ficaram de fora.
- **Fix proposto** (NÃO aplicar): adicionar `dota_live_snapshots` (col `ts`/`captured_at` — verificar), `super_odd_events`, `bookmaker_delta_samples`, `book_bug_events`, `velocity_events`, `arb_events`, `stale_line_events` ao `runAuditTablesRetention.targets` com defaults 30-60d + env override. `match_results`: NÃO deletar cego (settle depende dele); avaliar retenção só de rows >180d com `resolved_at` antigo, mas isso quebra fuzzy-match de tips antigas — discutir com humano. **P3 nota**: db-retention.js (nova lib) e runAuditTablesRetention (bot.js) são DOIS sistemas de retenção paralelos com listas de tabelas disjuntas — consolidar (P3/P4).
- **Cross-sport**: tabelas são cross-sport; retenção beneficia todos.

---

### [SEV: P1] Zombies real-money: 4 football `agg_*` TOTAL arquivados sem settle (match_id mismatch)
- **Onde**: settle path football — bot.js:5167 (`/football-result?matchId=agg_*`) + server.js:4832 `runSettleSweep` Tentativa-1 (match_id exato) + lib/match-id-resolver.js `resolveAlias`. Auto-archive: server.js:40047 `archiveOrphanNonML` (non-ML >48h).
- **Evidência**: pending_tips_diag zombies (archived=1 + result NULL + >24h):
  - #3595 / #3811 `agg_palmeiras-vs-chapecoense-20260531` TOTAL — **match em 31/05 (FUTURO)** = arquivamento PREMATURO de tip válida (bug: non-ML auto-archive a 48h não respeita match futuro).
  - #3908 `agg_sao-paulo-sp-vs-botafogo-20260523` (PASSADO 23/05), #3913 `agg_coritiba-vs-bahia-20260525` (PASSADO) TOTAL — match aconteceu, **nunca settlou** → arquivado com result NULL = ROI real perdido.
  - match_id `agg_*` (aggregator BR) nunca bate `match_results` canonicalizado (API-Football/Sofascore namespace). `resolveAlias` (server.js:4888) deveria resolver via score≥0.80 + janela, mas football TOTAL é MT (`::mt::` não aplicável aqui pois é `agg_*` sem `::mt::`)... na verdade são market_type=TOTAL → `runSettleSweep` HARD-SKIP em :4877 (`!ML_MARKETS.has(_mkt)`). Football OVER/UNDER tem handler no bot loop (bot.js:5152) mas depende de `/football-result` resolver o `agg_*` → se resolveAlias falha, fica pending → auto-archive 48h → zombie.
- **Impacto financeiro**: REAL (is_shadow=0). 2 tips passadas com outcome conhecido nunca contabilizadas. Em volume football real baixo (n=4 settled 30d, ROI +39.5%), cada tip não-settled distorce o ROI medido e o bankroll guardian.
- **Causa raiz**: (1) `resolveAlias` não consegue casar `agg_*` slug↔match_results pra esses jogos (BR aggregator namespace); (2) `archiveOrphanNonML` arquiva a 48h ANTES do settle resolver E sem checar se match é futuro (#3595/#3811 são 31/05).
- **Fix proposto** (NÃO aplicar): (a) `archiveOrphanNonML` deve pular tips cujo match (embedded date no `agg_*` slug OU `match_end_at`) ainda é futuro — espelhar o guard de `/void-old-pending` (server.js:28847 já usa `match_end_at`); (b) investigar por que `resolveAlias` não casa esses 2 jogos passados (pode ser que match_results não tenha a row API-Football → data coverage, aí é gap de fonte, não código). Recuperação: re-settle manual via `/admin/pending-tips-diag?apply=void-zombies` é destrutivo (void); melhor `/reopen-tip` + re-sync football + force-settle.
- **Cross-sport**: `archiveOrphanNonML` é genérico cross-sport → o guard de "match futuro" beneficia todos os sports com tips MT pré-match (tennis HG, esports MAP). Os dota2/cs MAP zombies (#3256+, 10+6) têm a mesma classe (arquivados sem settle por falta de per-map data) mas são is_shadow=1 (sem custo real).

---

### [SEV: P1] Nenhum guard `isMemCritical()` em server.js (24 usos só no bot)
- **Onde**: server.js inteiro. Grep `isMemCritical` = 24 hits, **todos em bot.js, zero em server.js**.
- **Evidência**: o processo `server` (rss 261MB) serve `/health`, todos os endpoints `/admin/*` OLAP (mt-shadow-by-league, shadow-readiness, refit-calib, cross-significance), e roda `runSettleSweep` (40032, 30min) + `settleFactorLogs`/`recalcWeights` (weekly) + `db_retention` (40970). Nenhum checa memória antes de query agregada grande. O bot já tem o padrão (`if (isMemCritical()) return`); o server não.
- **Impacto financeiro**: indireto. Em pico de memória (DB bloat + bot já alto), um refit/OLAP no server pode ser o empurrão final pro container-kill (o OOM de 06:01). Server e bot somam ~520MB RSS hoje em idle — margem zero.
- **Causa raiz**: `isMemCritical()` foi adicionado como helper do bot (bot.js:2074, lê `lib/mem-shared.isAnyProcessCritical()` cross-process). O server nunca importou/usou apesar de `mem-shared` ser cross-process (existe justamente pra isso).
- **Fix proposto** (NÃO aplicar): importar `mem-shared.isAnyProcessCritical()` no server e guardar (a) `runSettleSweep` cycle, (b) refit/calib endpoints OLAP, (c) os DELETEs de retenção que já rodam no server. Mínimo: guardar o settle_sweep_cycle e o db_retention. Baixo risco (idempotentes — perder 1 ciclo é OK).
- **Cross-sport**: N/A (infra).

---

### [SEV: P2] `runAutoVoidStuck` roda só 1×/dia numa janela de 1h (UTC=3) — frágil com redeploys
- **Onde**: bot.js:26849-26911 (`runAutoVoidStuck`), gate em :26855-26857.
- **Evidência**: `if (_lastStuckVoidDay === today) return;` + `if (now.getUTCHours() !== hourUtc) return;` (hourUtc default 3). O cron roda a cada 15min (26912) mas só EXECUTA se a hora UTC for exatamente 3 E ainda não rodou hoje. `_lastStuckVoidDay` é estado in-memory → **reset a cada redeploy**. Com 20 redeploys/24h, se um deploy cair durante a janela 03:00-03:59 UTC pode re-executar; se nenhum bot estiver "vivo e na hora certa" durante 03:xx, o void não roda naquele dia. Tips shadow stuck (tennis 36h threshold, mas void real só a 14d via SHADOW_VOID_DAYS) acumulam.
- **Impacto financeiro**: baixo (P2). Tips shadow voidadas tarde = bloat menor + sinal calib perdido. Não afeta ROI real diretamente.
- **Causa raiz**: janela de 1h + estado in-memory volátil num ambiente que redeploya muito. Padrão "roda na hora X" é frágil quando uptime médio < 24h.
- **Fix proposto** (NÃO aplicar): trocar o gate de "hora exata" por "rodou nas últimas 20-24h?" persistido em `settings` (não in-memory), permitindo recuperar após redeploy independente da hora. OU baixar pra qualquer hora com cooldown persistido. P3: `runAutoVoidStuck` (bot) e `/void-old-pending` (server) e cleanups em `settleShadowTips` (lib) são 3 caminhos de void com thresholds espelhados manualmente (`ZOMBIE_THRESHOLDS_H` vs `thresholdsH` vs `SHADOW_VOID_DAYS`) — drift risk.
- **Cross-sport**: afeta todos os sports (itera `thresholdsH` cross-sport).

---

### [SEV: MELHORIA] Settle stuck é 95% data-coverage gap (tennis doubles/Challenger), não bug
- **Onde**: bot.js:4825-4866 (tennis settle, classificador de tier `_classifyStuckTier`) + lib/market-tips-shadow.js:1065 (fallback last-name tennis).
- **Evidência**: dos 186 pending não-arquivados, sample (30 mais antigos, 259-345h): 27 is_shadow=1 / 3 is_shadow=0. Dominado por **doubles** ("Doumbia/Reboul vs Granollers/Zeballos") e Challenger/ITF/Quali. ESPN scoreboard (única fonte tennis ativa — Sackmann CSV 404, Sofascore 403 vide memory) **não cobre doubles/Challenger/ITF** → `match_results` nunca recebe a row → name-match não acha candidato → tip fica pending até void 14d. by_market: ML=153 (tennis singles+doubles), MAP1/2/3=43 (dota2/cs precisam per-map data não disponível em final_score).
- **Impacto financeiro**: P2 (são is_shadow=1). O custo é **sinal de calibração perdido** — exatamente o tema L3 (calib gap -20pp sistêmico). Se essas 99 tennis shadow nunca settlam, o refit de calib tennis perde ~99 outcomes reais. Mitigação: já existem `/admin/tennis-sources-diag` + force-settle endpoints.
- **Causa raiz**: cobertura de fontes (ESPN não tem doubles/Challenger; Sofascore 403; Sackmann 404). NÃO é match_id mismatch pra esses (o fuzzy last-name funcionaria SE a row existisse).
- **Fix proposto** (NÃO aplicar): (a) confirmar Sofascore proxy (memory `sofascore_proxy_pendency` — restart + rotate impersonate) restauraria cobertura doubles/Challenger; (b) considerar não emitir shadow tips pra ligas/formatos sabidamente sem fonte de settle (doubles, ITF) — reduz pending bloat e ruído. Mas isso é decisão de produto. (c) baixar `SHADOW_VOID_DAYS` tennis pra 7d evita acúmulo (custo: void mais cedo o que poderia settlar se fonte voltasse).
- **Cross-sport**: tennis-específico no detalhe; o padrão "shadow stuck por fonte ausente" também afeta mma (Sherdog/Sofascore) e parte do football (agg_*).

---

### [SEV: MELHORIA] Off-heap RSS ~200MB amplificado por malloc fragmentation + DB grande
- **Onde**: lib/database.js:58-61 (cache 8MB, mmap 0 — já otimizado). Processo Node nativo.
- **Evidência**: OOM 06:01 rss=380MB, heap_total=155MB, external=12MB, array_buffers=10MB → ~203MB nativo não-V8. `last_near_heap_limit=NULL` confirma que V8 heap NUNCA chegou perto do limite (228MB) → o kill foi do container por RSS total, não por heap. Com mmap=0 e cache=8MB, a contribuição direta do better-sqlite3 deveria ser pequena; o restante é glibc malloc arena fragmentation (típico em processos long-running com muitos prepared statements + churn de buffers) + páginas do arquivo de 387MB tocadas em queries.
- **Impacto financeiro**: indireto (causa do único OOM). Não é heap leak (heap idle 34-69MB, saudável).
- **Causa raiz**: combinação de (a) DB bloated 387MB (mais páginas pra tocar), (b) malloc glibc não devolve memória ao OS facilmente, (c) 2 processos (~260MB cada) num cap de 512MB.
- **Fix proposto** (NÃO aplicar): (1) reduzir bloat (finding P1 VACUUM) é a maior alavanca — DB menor = menos RSS residente; (2) avaliar `MALLOC_ARENA_MAX=2` env no Railway (reduz fragmentação multi-arena do glibc, comum em Node — baixo risco, reversível); (3) heap idle está saudável → NÃO há leak de JS pra caçar. Foco em (1).
- **Cross-sport**: N/A.

---

## OUTRAS NOTAS (P4 / observações)

- **P3/P4 — retenção duplicada**: `lib/db-retention.js` (commit `5eb06fa` hoje) e `runAuditTablesRetention` (bot.js:26521) são dois sistemas de retenção com listas de tabelas disjuntas, ambos com `wal_checkpoint(TRUNCATE)` próprio. Consolidar numa só fonte (delegate).
- **P3 — 3 caminhos de void com thresholds espelhados à mão**: `ZOMBIE_THRESHOLDS_H` (lib/market-tips-shadow.js:906), `thresholdsH` (bot.js:26868), `SHADOW_VOID_DAYS` (server.js:28822). Drift risk — já houve casos de threshold só num lugar (CS faltando em ZOMBIE_THRESHOLDS_H, comentado em :903).
- **PRAGMAs OK**: cache_size=-8000 (8MB), mmap_size=0, synchronous=NORMAL, journal_mode=WAL, journal_size_limit=100MB, busy_timeout=5000, foreign_keys=ON. Tudo dentro do recomendado (lib/database.js:24-67). Nenhuma violação de cap. **Falta só `auto_vacuum`** (finding P1).
- **Índices tips OK**: cobertura forte (sport+result+sent_at, propagator p1/p2 norm, idx_tips_pending, idx_tips_realonly, idx_tips_match_end). Settle hot path bem indexado. Migrations sequenciais (schema_migrations 129 rows). Nenhum `ALTER TABLE` solto fora de migrations/index.js no path de settle.
- **Slow-query log ativo** (lib/database.js:74, DB_SLOW_QUERY_MS=100) — instrumentação presente; MT-GUARD 350-481ms é known-benign (skill).
- **boot loop = redeploy Railway**, não bug (confirmado: SIGTERM, crash_count=0, 0 intervalos <120s, último crash real 7d atrás). Bate com memory `project_audit_full_2026_05_21`.

---

## TOP 5 (1 linha cada)

1. **[P1]** `app=degraded` é falso — `lastAnalysisAt=null` (server.js:8499/:8768); bot nunca faz `POST /record-analysis` → degraded eterno mascara alertas reais.
2. **[P1]** DB bloat 219MB/387MB (56%) — `auto_vacuum=NONE` nunca setado (lib/database.js:24-67); DELETEs não devolvem páginas ao FS → amplifica OOM.
3. **[P1]** Retenção nova (`5eb06fa`) mira tabelas minúsculas; as grandes (match_results 229k, dota_live_snapshots 12k, super_odd_events/bookmaker_delta_samples) ficaram SEM retenção (bot.js:26546).
4. **[P1]** Zombies real-money: 4 football `agg_*` TOTAL (is_shadow=0) arquivados sem settle — 2 passados = ROI perdido, 2 futuros (31/05) = auto-archive prematuro (server.js:40047 não checa match futuro).
5. **[P1]** Zero `isMemCritical()` em server.js (24 no bot) — settle_sweep/refit OLAP no server sem guard de memória contribuem pro container-kill.

**Ação #1 ESTABILIZAR (parar OOM/restart):** reduzir o DB bloat — backup (`scripts/backup-db.js` já faz VACUUM INTO) → 1 VACUUM full em janela de baixo tráfego → setar `PRAGMA auto_vacuum=INCREMENTAL` + cron `incremental_vacuum` semanal guardado por `isMemCritical()`. Isso ataca a raiz do único OOM (387MB num cap 512MB). Complemento barato/reversível: env `MALLOC_ARENA_MAX=2`. (O "restart loop" em si é redeploy, não precisa fix.)

**Ação #1 DESTRAVAR SETTLE (recuperar ROI não medido):** corrigir `archiveOrphanNonML` (server.js:40047) pra NÃO arquivar tips MT cujo match ainda é futuro (espelhar guard `match_end_at` do `/void-old-pending` server.js:28847) — isso para o sangramento de tips real (#3595/#3811 football) sendo arquivadas antes de poderem settlar; e investigar por que `resolveAlias` (lib/match-id-resolver) não casa os `agg_*` BR passados (#3908/#3913) com match_results. Nota P2: o grosso do "stuck" (tennis doubles/Challenger shadow) é gap de fonte (ESPN/Sofascore), não bug — restaurar Sofascore proxy recupera sinal de calib, mas não é ROI real.
