# Auditoria INTEGRAÇÕES EXTERNAS + CLV — 2026-05-28

Escopo: Pinnacle, Sofascore proxy, PandaScore, ESPN, Riot, HLTV, theOddsApi, aggregator BR, DeepSeek AI, pipeline CLV capture.
Commit: `fb9f42e`. Investigação only — nenhum código alterado.

Resumo executivo: o feed/integração que mais custa edge agora é **CLV Valorant (3.5%, P1)** — não é o branch `/odds` que está quebrado (foi corrigido em 25/05 e funciona), é **mismatch estrutural de fonte**: matches vêm de PandaScore mas a única fonte de odds/CLV é Pinnacle, que não carrega VCT/Challengers. theOddsApi `disabled` e DeepSeek `0 calls` são **kill switches intencionais (env), não bugs**. Sofascore proxy está 403 (recorrente, ESPN cobre). CS/basket CLV baixo por motivos distintos (live capture 0% + basket sem branch Pinnacle no `/odds`).

---

### [SEV: P1] Valorant CLV 3.5% — mismatch estrutural de fonte (matches PandaScore × odds só Pinnacle)
- **Onde**: `server.js:6799-6824` (branch `/odds?game=valorant`), `server.js:3984-4022` (`getPinnacleValorantMatches`), `server.js:7348-7408` (scan `/valorant-matches`), `bot.js:31118-31122` (checkCLV branch valorant).
- **Evidência**: clv_coverage.json — valorant n=115, n_with_clv=**4** (3.5%), gap_pre=**110/115** (todas pré-match), n_live=0. Pré-fix (memory 25/05) era 6.4% → **piorou para 3.5%**, ou seja o fix do branch `/odds` NÃO resolveu. server.js:7407-7408 loga `logSourceSilent('valorant','pinnacle', 'Pinnacle Valorant retornou 0 odds com N live PS — sem anchor sharp')`. feed_health.json **não tem entry pinnacle/valorant** (existem pinnacle/cs, /dota2, /lol, /tennis, /basket, /mma, /darts — mas valorant ausente).
- **Causa raiz**: `/valorant-matches` monta a lista a partir do **PandaScore** (`liveFromPs`, server.js:7385-7391). A ÚNICA fonte de odds para Valorant é **Pinnacle sport_id 12** (`fetchSportMatchOdds(12,...)`). Pinnacle não carrega a maioria dos jogos VCT Americas/Challengers que o PandaScore traz → `_valorantPinnacleCache` vazio ou sem team-name match → `/odds?game=valorant` retorna "odds não encontradas" → `clvOdds` fica null → CLV NULL. checkCLV (bot.js:31118) e o branch `/odds` (server.js:6799) estão **corretos**; o problema é upstream: Pinnacle simplesmente não tem o jogo. Diferença vs CS: CS tem PandaScore + HLTV + Pinnacle; VAL tem PandaScore (matches, live 403 p/ stats) + só Pinnacle (odds esparsas). Diferença vs LoL/Dota: Pinnacle cobre bem LoL/Dota.
- **Impacto financeiro**: CLV é o sinal #1 de edge. Com 3.5% de cobertura, Valorant é efetivamente **cego** — não dá pra medir se VCT Americas (clv_leak: 4 tips, profit +4.94, avg_clv -10.58%) tem edge real ou leak. Memory cita VCT Americas shadow ROI +48% n=21, mas sem CLV não há como validar/sharpen. Valorant é majoritariamente shadow (VALORANT_SHADOW + override VALORANT_REAL_LEAGUES="Champions Tour: Americas"), então o $$$ direto hoje é pequeno, mas **bloqueia a decisão de promover VAL pra real** (research universe cego).
- **Fix proposto** (NÃO aplicado — escolher 1):
  1. Adicionar fonte de odds secundária para CLV Valorant. O `/odds` dota2 branch já consulta SX.Bet + TheOddsAPI em paralelo (server.js:6725-6764). Espelhar isso no branch valorant: quando `_valorantPinnacleCache` não tem o match, cair em SX.Bet (se `SXBET_ENABLED` cobre Valorant) ou TheOddsAPI (`esports`/valorant key). Mesmo close de bookie macio é melhor que CLV NULL.
  2. Se Pinnacle genuinamente não tem VCT → usar o **odd de abertura da própria tip como close terminal** (mesmo mecanismo já existente em bot.js:31000-31006 `/admin/set-tip-clv terminal:true` após match passar), em vez de deixar NULL eternamente. Isso ao menos marca clv_pct=0 e tira do gap.
  3. Adicionar `markFeedSuccess('pinnacle','valorant', pinMatches.length)` + `markFeedFailure` no scan (server.js:7406, espelhando cs:3835) pra **visibilidade**: hoje o feed-health não consegue nem ver que VAL Pinnacle está vazio.
- **Cross-sport**: Mesma classe afeta **CS parcialmente** (gap_pre=63/106; CS tem HLTV como backup mas ML CLV depende de Pinnacle). LoL/Dota OK (Pinnacle cobre). **Basket** tem problema relacionado mas diferente (ver finding abaixo). O fix #3 (heartbeat) deve ser aplicado cross-sport (valorant é o único sem markFeedSuccess pinnacle).

---

### [SEV: P1] CS + basket CLV ~40% — live capture 0% + basket sem anchor Pinnacle no `/odds`
- **Onde**: CS — `bot.js:31113-31117` (branch cs `/odds?game=cs`) + `server.js:6830-6853`; basket — `bot.js:31133-31150` (checkCLV basket usa cache `/basket-matches`, NÃO `/odds`). Não existe branch `gameParam === 'basket'` em `/odds` (server.js).
- **Evidência**: clv_coverage.json — cs n=112 cov=38.4% (gap_pre=63, gap_live=6, **live_capture 0/6**); basket n=92 cov=43.5% (gap_pre=41, gap_fast=10, live_capture 0/1). clv_leak.json: basket avg_clv **+34.68%** (n=40) — outlier altíssimo sugere captura tardia/errada (open vs close muito distante), não edge real.
- **Causa raiz**:
  - CS live: 6 tips live, 0 com CLV. O `/odds?game=cs` só lê `_csPinnacleCache` (pré-match); para live, Pinnacle CS pode dropar a linha mid-map e o branch não tem path live dedicado. gap_pre=63 → mesma raiz do Valorant (Pinnacle CS sem o jogo; server.js:7318-7319 loga "Pinnacle CS 0 odds sem anchor sharp").
  - basket: gap_fast=10 (jogo começou <Xmin após emit, sem tempo de capturar close) + basket depende 100% do cache `/basket-matches` (Pinnacle+TheOdds merged). Com **THE_ODDS_DISABLED=true** (ver finding abaixo), basket perdeu metade da fonte de odds → cache mais raso → menos matches com odds → CLV miss. O avg_clv +34.68% é red flag de captura ruim (provavelmente pegando open como "close").
- **Impacto financeiro**: basket real ROI -53% (n=3, baseline) — sem CLV confiável não dá pra distinguir leak de variância. CS real +7.4% (n=27) é o 2º melhor sport; CLV 38% subestima a capacidade de detectar deterioração de edge ao vivo.
- **Fix proposto**: (a) basket avg_clv +34.68% — investigar se a captura está pegando odd de momento errado (validar janela near vs far em bot.js:30989); (b) reativar fonte de odds basket se THE_ODDS_DISABLED foi setado sem querer cobrir basket (basket não tem outra fonte além de Pinnacle+TheOdds); (c) CS/VAL live: considerar path live no `/odds` cs/valorant (force refetch) como LoL/Dota têm.
- **Cross-sport**: gap_pre Pinnacle-dependente compartilhado cs/valorant. gap_fast (basket 10, dota2 3, lol 5) é genérico: tips emitidas perto do start não têm tempo de capturar close — candidato a baixar `CLV_CAPTURE_INTERVAL_MS` só perto do match OU capturar close no settle.

---

### [SEV: P2] theOddsApi disabled=true — kill switch INTENCIONAL (env THE_ODDS_DISABLED), não bug
- **Onde**: `lib/utils.js:909-911` (`oddsApiDisabled()` lê `THE_ODDS_DISABLED`), `lib/utils.js:952-957` (`oddsApiQuotaStatus` retorna `disabled`), health.json `theOddsApi.quota.disabled=true used=0 cap=15000`.
- **Evidência**: `oddsApiDisabled() = String(process.env.THE_ODDS_DISABLED||'').toLowerCase()==='true'`. cap=15000 → `THE_ODDS_MONTHLY_BUDGET=15000` setado (plano pago, lib/utils.js:894). used=0 confirma que NADA chama theOddsApi este mês. keyConfigured=true (key existe).
- **Causa raiz**: usuário setou `THE_ODDS_DISABLED=true` explicitamente (economia de quota / decisão operacional). Não é bug. `oddsApiAllowed`/`oddsApiPeek` retornam false → todos os fetches theOddsApi são pulados.
- **Impacto financeiro**: theOddsApi é fonte de **line-shopping/fallback** para: dota2 (`/odds` candidate, server.js:6761), MMA+boxing scores (server.js:8325, 38325), tennis scores (`TENNIS_USE_THE_ODDS`), e **basket** (merge no `/basket-matches`). Com ela off, dota2 perde 1 alternativa (mas tem SX.Bet+Pinnacle), e **basket fica só com Pinnacle** → contribui pro CLV basket 43% acima. Pinnacle (sharp anchor) continua intacto, então o impacto em edge é baixo-médio, concentrado em basket.
- **Fix proposto**: confirmar com usuário se o disable foi intencional. Se sim, documentar. Se basket é prioridade, considerar `THE_ODDS_DISABLED` não cobrir basket (mas não há toggle per-sport hoje — seria feature nova, evitar P3). Nenhuma ação automática.
- **Cross-sport**: afeta basket (mais), dota2/mma/tennis/boxing (fallback). Esports core (LoL/CS/VAL) usa Pinnacle+PandaScore, não theOddsApi.

---

### [SEV: P2] DeepSeek 0 calls em maio — AI_DISABLED=true INTENCIONAL, tracking OK
- **Onde**: `bot.js:250` (`_AI_DISABLED` lido no boot), `bot.js:546` (early-exit `AI_DISABLED==='true'`), `server.js:37885,37894-37905` (kill switch no `/claude`), `server.js:37407` (increment `deepseek` SEMPRE), health.json `deepseekAi.calls=0 cost_usd=0 cap_usd=10 blocked=false`.
- **Evidência**: O bug de tracking antigo (path lol-explain não incrementava) foi **corrigido** em commit f649bea (server.js:37403-37408: "Increment SEMPRE, tokens só em sucesso"). Quando `AI_DISABLED=true`, `/claude` retorna `{blocked:true, content:[{text:''}]}` ANTES de chamar DeepSeek e incrementa `deepseek_blocked_by_kill_switch` (server.js:37898) em vez de `deepseek`. Logo calls=0 reflete fielmente: ou AI_DISABLED está on (memory project_audit_session_2026_05_23_pm pendência: "AI_DISABLED delete"), ou há 0 callers. Comentário server.js:37873-37876 explica a decisão: "modelos ML/Markov maduros, IA virou advisory cosmético, desligar economiza custo+latency".
- **Causa raiz**: kill switch deliberado. Tracking NÃO está quebrado. A visibilidade está correta (calls=0 é verdade).
- **Impacto financeiro**: AI era advisory-only (override cosmético) — ML/Markov é o motor primário de pricing. Desligar **economiza** ~$X/mês + 1-5s latência/match em live. Edge perdido: mínimo a nulo (modelos calibrados per-sport carregam a decisão). Caso histórico contra IA: tennis shadow ROI -24.6% por EV halucinado (Ben Shelton EV=468%, memory ai_audit). Manter off é prudente.
- **Fix proposto**: nenhum. Se quiser AI advisory de volta em sport específico, usar `<SPORT>_AI_ENABLED=true` (override existente, server.js:37878) sem ligar global. Confirmar com usuário se AI_DISABLED deve ser permanente (memory tinha como pendência "delete" — ambíguo).
- **Cross-sport**: kill switch é global; overrides per-sport existem (MMA_AI_ENABLED etc).

---

### [SEV: P2] Sofascore proxy + direct ambos 403 (CF block) — recorrente, ESPN cobre
- **Onde**: sofa_health.json — proxy status=**403** (victorious-expression Railway), direct status=**403** (api.sofascore.com, CF block). `server.js:10402,15033` (SOFASCORE_DIRECT gate), `lib/sofascore-football.js:143` (path-specific 403 diag).
- **Evidência**: sofa_health.json diagnosis: "FALHA — proxy 403. Verifique deployment Public-Sofascore-API no Railway. Bot está caindo em direct (CF block)". metrics: `sofascore_fail|path=proxy,status=403:1`, `path=direct,status=403:2`. Memory project_sofascore_proxy_pendency_2026_05_25 já documenta isso (TENNIS-SYNC/MMA-DISCOVERY afetados, ESPN fallback OK).
- **Causa raiz**: o serviço proxy Django (Public-Sofascore-API) está bloqueado/parado E o impersonate (curl_cffi chrome) sofreu drift de fingerprint → Cloudflare 403. ESPN é o único source de stats football/tennis funcionando.
- **Impacto financeiro**: Sofascore alimenta stats football/tennis/darts/MMA-discovery. ESPN cobre football finals + tennis. Impacto: features de stats menos ricas (não bloqueia tips), MMA discovery degradado. Visibilidade EXISTE (sofa_watchdog DM 60min, endpoint /admin/sofa-health). Não sangra dinheiro direto.
- **Fix proposto** (user-action, fora de código): restart serviço Public-Sofascore-API no Railway + rotacionar `SOFASCORE_IMPERSONATE_*` (memory sugere safari260 ou firefox147). Já documentado em memory. Bot já tem fallback ESPN + visibilidade — não é P0/P1.
- **Cross-sport**: football/tennis/darts/mma usam Sofascore. ESPN cobre football/tennis; darts/mma degradam.

---

### [SEV: MELHORIA] scraper-health endpoint retorna houses=[] vazio (visibilidade), aggregator BR funcional
- **Onde**: `server.js:20988` (`fetchScraperHealth().catch(() => ({ houses: [] }))`), `lib/odds-aggregator-client.js:881`.
- **Evidência**: scraper_health.json `{ok:true, houses:[]}` — vazio. MAS aggregator_status.json mostra `cached:16` matches reais (Juventude×América, PSG×Arsenal, Flamengo×Coritiba com over_under_multi de betnacional/esportes-da-sorte). Cron `runScraperHealthCron` (bot.js) requer `SUPABASE_URL + SUPABASE_ANON_KEY`.
- **Causa raiz**: `fetchScraperHealth()` lançou exceção (capturada pelo `.catch(()=>({houses:[]}))`) — provavelmente Supabase health-table query falhou OU SUPABASE_* não setado no service que serve o endpoint. O aggregator de **odds** funciona (16 cached); só o **health-check dedicado** falha. Visibilidade, não outage de dados.
- **Impacto financeiro**: nenhum direto — odds BR estão chegando (line shopping casas funciona). Perde-se só o monitoramento de quais casas estão down (BR-SCRAPER-OUTAGE detection).
- **Fix proposto**: confirmar SUPABASE_URL/ANON_KEY no service; logar o erro real do `fetchScraperHealth` (hoje silenciado pelo catch). Baixa prioridade.
- **Cross-sport**: aggregator BR é football-only (casas BR).

---

### [SEV: MELHORIA] Pinnacle key hardcoded (pública) com override env — OK por design, sem rotation automática
- **Onde**: `lib/pinnacle.js:19` + `lib/pinnacle-snooker.js:18` — `API_KEY = process.env.PINNACLE_API_KEY || 'CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R'`.
- **Evidência**: feed_health.json — todos os Pinnacle sports OK agora (lastSuccessMin <10, failureCount=0). Watchdog existe (bot.js:1090-1121, gauge `pinnacle_key_expired{status=401|403}` + DM `pinnacle-key-expired` cron 30min). Key é a pública do frontend pinnacle.com (não secret).
- **Causa raiz**: design intencional — key pública embutida + override `PINNACLE_API_KEY` quando rotaciona. Watchdog detecta 401/403 e DM admin com procedure. Não há rotation AUTOMÁTICA (manual via memory reference_pinnacle_key_rotation).
- **Impacto financeiro**: Pinnacle é o sharp anchor de TODOS os sports. Se a key pública rotacionar e ninguém atualizar, pipeline de odds para (esports/tennis/football/mma/darts). Hoje OK. Risco latente, mitigado por watchdog+DM.
- **Fix proposto**: nenhum imediato. Manter watchdog. (Sport sem anchor Pinnacle: nenhum no momento — feed_health 9/9 sources OK, mas valorant não tem entry pinnacle = ver P1 #1.)
- **Cross-sport**: key compartilhada por todos. Rotation afeta todos simultaneamente.

---

### [SEV: MELHORIA] PandaScore Valorant live 403 (plan limit) — confirmado, único esport sem live stats granular
- **Onde**: memory project_valorant_live_stats_gap_2026_05_23 + scan VAL (bot.js:23828 pollValorant "fork de pollCs — sem HLTV scorebot").
- **Evidência**: feed_health.json — pandascore/lol e /dota2 OK (live stats), mas **não há pandascore/valorant nem pinnacle/valorant**. Memory: PandaScore plan 403 em `/valorant/games/{id}` + `live.supported=false`. LoL tem Riot livestats, Dota Steam/OpenDota, CS HLTV scorebot; Valorant não tem equivalente.
- **Causa raiz**: PandaScore plan não cobre Valorant live granular (403). Sem fonte alternativa de live stats VAL.
- **Impacto financeiro**: Valorant não emite tips live por mapa/round com stats (só pré-match Elo+Pinnacle). Combinado com CLV 3.5% (P1 #1), Valorant é o sport mais cego do sistema. Como VAL é majoritariamente shadow, impacto $$$ atual é contido.
- **Fix proposto**: nenhum em código (plan limit upstream). Aceitar VAL como pré-match-only OU avaliar fonte VAL live alternativa (thespike scraper já existe em lib/thespike-valorant-scraper.js mas é stats, não odds live).
- **Cross-sport**: só Valorant. LoL/Dota/CS têm live stats.

---

## Timeout / retry / rate-limit — estado geral (OK)
- httpGet/cachedHttpGet (lib/utils.js:507,654) têm timeout. Clients dedicados com timeout explícito: odds-aggregator-client 12-15s, dota-snapshot 5-8s, pandascore-cs-stats, api-football, football-data.
- 429 handling robusto: PandaScore backoff per-game (server.js:3016-3097, `_pandaLast429LogByGame`), OddsPapi backoff 2h (server.js:1966-1969), inflight dedup (`_pandaInflight`). http429ByProvider exposto em /health (vazio agora = sem 429 recentes).
- DeepSeek `/claude` retry maxAttempts:3 timeout 20s (server.js:37402).
- HLTV 403 → `_hltvCounter('http_403')` return null (lib/hltv.js:90). Pinnacle 401/403 → gauge + watchdog (lib/pinnacle.js:49-60).
- Sofascore tem gap 200ms anti-burst (lib/sofascore-football.js:93).
- Nenhum fetch crítico sem timeout encontrado.

## Notas P4 (otimização — não aplicar)
- `_valorantPinnacleCache`/`_csPinnacleCache` só warmam lazy (dentro de request `/odds`+`/odds-markets`) e no scan `/valorant-matches`/`/cs-matches`. Não há cron periódico dedicado — mas o scan poll já cobre. OK.
- Comentário server.js:6803 ("retorna [] se PINNACLE_VALORANT/PINNACLE_CS não set") é **enganoso** — `fetchSportMatchOdds(12)` não checa env per-sport; o [] vem de Pinnacle não ter o jogo. Atualizar comentário.
- markPollHeartbeat bare (sem dados matches/hadLive) em ~9 sports = tech debt de visibilidade (memory já nota; valorant foi fixado isolado 23/05).
