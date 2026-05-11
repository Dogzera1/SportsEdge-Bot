# Premissas arquiteturais — não podem ser violadas

Este arquivo lista os princípios fundamentais do projeto. **Toda análise, correção, refactor e nova feature deve respeitar essas regras.** Violações precisam de justificativa explícita do user (não decisão unilateral).

---

## Contexto do projeto

**Bot de apostas esportivas multi-sport (SportsEdge-Bot).**

- **Stack runtime**: Node.js 18+ (bot.js + server.js + lib/*.js) — sem TypeScript, sem framework HTTP (http nativo).
- **DB**: SQLite via better-sqlite3 (`sportsedge.db` ~155MB) + WAL mode.
- **Deploy**: Railway — 2 services:
  - Bot principal em `us-east4` (Virginia)
  - Scraper worker em `sa-east-1` (São Paulo) — repo separado `agregador-odds` (Python + Playwright)
- **Sports cobertos**: lol, cs, dota2, valorant, tennis, football, basket, mma, darts, snooker, tabletennis.
- **Fontes de odds**:
  - Pinnacle Guest API (esports/tennis/football/dota) — sharp anchor
  - Sofascore proxy (`Public-Sofascore-API/`) — football/tennis/darts stats
  - HLTV proxy (`hltv-proxy/`) — CS scoreboard live
  - PandaScore (esports backup)
  - Aggregator BR (`agregador-odds` repo) — line shopping casas BR
- **Telegram**: bots multi-token (`TELEGRAM_TOKEN_<SPORT>` per sport) + admin DM via `ADMIN_CHAT_IDS`.
- **Volume**: 26k linhas bot.js + 32k linhas server.js + 148 libs/*.js + **1.039 envs** + **84 crons**.

---

## P1 — Granularidade primeiro

**Regra:** Toda análise e correção deve considerar a granularidade adequada — não tratar o sport/sistema como bloco único quando há sub-partições com comportamento heterogêneo.

**Por quê:** Performance agregada esconde leaks/edges localizados. ROI overall +5% pode mascarar tier1 +15% / tier2 -8%. Calibração monolítica subajusta tier-specific (caso tennis ATP Challenger leak 2026-05-07: shadow ROI -2.3% overall, mas Challenger sozinho -12.6%; refit por tier necessário).

**Como aplicar — dimensões a considerar antes de qualquer decisão:**

1. **Sport** (lol/cs/dota/valorant/tennis/football/basket/mma/darts/snooker/tt) — não generalizar entre sports
2. **Tier** dentro do sport — esports (tier1/tier2/other), tennis (Slam/Masters/250-500/Challenger/ITF), football (top5/UEFA/BR/continental), basket (NBA/Euroleague/regional), mma (UFC/Bellator/regional)
3. **League** — tier sozinho às vezes não captura (CBLOL ≠ LFL apesar de ambos tier2)
4. **Market** — ML, handicap, totals (under/over), kills, MAP_WINNER, AH, BTTS, etc.
5. **Side** — over/under, home/away, team1/team2, draw — tratamentos podem ser direcionais
6. **Bucket de odd** — 1.4-1.6 / 1.6-2.0 / 2.0-2.5 / 2.5-4.0 / >4.0 — leaks tipicamente concentram em buckets
7. **Confidence** (ALTA/MÉDIA/BAIXA) — tratamento por tier de confidence
8. **Período/regime** — pré/live, pre-match/in-play, regimes históricos (split changes 2026-04-22)
9. **Bo3 vs Bo5** — formato muda matemática (totais, sweep prob)

**Anti-patterns (NÃO fazer):**
- ❌ "Tennis ROI -2% → bloquear tennis MT global"
- ❌ "LoL UNDER 2.5 ruim → desativar UNDER 2.5 todo"
- ❌ "Calib monolítica para todos os sports/tiers"
- ❌ Refit modelo só com sample agregado (sem split per-tier)
- ❌ Dashboard só com KPI overall, sem breakdown granular

**Patterns (fazer):**
- ✅ Por padrão buckets em qualquer análise (bucket × tier × side é mínimo)
- ✅ Schema v2 tier-aware (caso tennis Markov calib: `markets.X.tiers[tier].bins`)
- ✅ Env hierarchy: `<SPORT>_<PARAM>_<TIER>` > `<SPORT>_<PARAM>` > default
- ✅ Filtros em endpoints `/admin/*-by-league` / `/admin/shadow-tier-divergence` permitem audit per-granularidade
- ✅ Quando sample tier é insuficiente (n<20), fallback default (não decidir)

**Status atual no projeto:**
- ✅ Tennis Markov calib v2 (tier-aware) — schema implementado
- ✅ LoL momentum env tier-aware (LOL_MOMENTUM_TIER1/TIER2/OTHER)
- ✅ CS2/Dota/Val momentum tier-aware (commit 95cc4a0)
- ✅ Endpoint `/admin/shadow-tier-divergence` cross-sport
- ✅ MT leak guards com side+tier+league granularidade (mig 091)
- ✅ EV calibration data-driven per (sport, bucket)
- ⚠️ Tech debt: 3 tier classifiers paralelos não unificados (LoL inline / lib/league-tier numeric / endpoint inline)

---

## P2 — Shadow=causa, Real=sintoma

**Regra:** Análise de tips shadow é estritamente para entender CAUSA (calibração, regime change, model drift). Tratamento de SINTOMA (block, disable, cap, throttle) só pode ser triggered por dados de tips reais (`is_shadow=0`).

**Por quê:**
- Shadow é research universe — captura tips com EV ≥ 0% (shadowMinEv default 0)
- Real é dispatched universe — passou todos gates (EV ≥ minEv, oddOk, maxPerMatch, league trust, etc)
- Shadow ROI é estruturalmente menor que real ROI (low-EV bucket pesa shadow pra baixo)
- Auto-disable baseado em shadow → bloqueia coleta de research → feedback loop ruim
- Caso histórico: 69 markets bloqueados equivocadamente por leak guards lendo shadow direto (2026-05-06)

**Como aplicar:**

**Shadow data PODE alimentar:**
- ✅ Calibration refit (todas predições com outcomes reais — universo correto)
- ✅ Reports/digests pra humano analisar e decidir
- ✅ A/B comparison (shadow vs shadow filtered)
- ✅ Tier divergence audit (`/admin/shadow-tier-divergence`)
- ✅ Gate optimizer suggest-only mode
- ✅ Detecção de drift de modelo (warn → human review)
- ✅ Pre-promote evaluation quando sport ainda não tem real volume (caso football MT promote check)

**Shadow data NÃO PODE:**
- ❌ Auto-disable markets/sides/leagues
- ❌ Auto-set caps de odd/EV/Kelly
- ❌ Auto-flip sport para shadow-only mode
- ❌ Trigger alert "disable_recommended" sem human review
- ❌ Bloquear emissão de tips real

**Real data (`tips WHERE is_shadow=0 AND archived=0`) DEVE alimentar:**
- ✅ Leak guard (CLV/ROI auto-disable)
- ✅ Kelly auto-tune
- ✅ League trust score
- ✅ Bankroll Guardian flips
- ✅ Permanent disable list

**Pattern padrão para crons que decidem (cross-sport):**
```sql
INNER JOIN tips t ON
  t.sport = mts.sport
  AND UPPER(t.market_type) = UPPER(mts.market)
  AND COALESCE(t.is_shadow, 0) = 0
  AND (t.archived IS NULL OR t.archived = 0)
  AND t.result IN ('win','loss','void','push')
  AND ABS(julianday(COALESCE(t.sent_at, t.settled_at)) - julianday(mts.created_at)) < 14
  AND (norm participants matched both directions)
```

Use env opt-out `<COMPONENT>_REAL_ONLY=true` (default) para preservar comportamento.

**Status atual no projeto (2026-05-07):**
- ✅ 9/9 violators corrigidos. Wave 1 (5 originais, commits eeb8af8 e anteriores):
  - runMarketTipsLeakGuard (`MT_LEAK_REAL_ONLY`)
  - runMarketTipsRoiGuardSided (`MT_ROI_GUARD_REAL_ONLY`)
  - runMtBucketGuardCycle (`MT_BUCKET_GUARD_REAL_ONLY`)
  - /admin/mt-calib-validation auto-disable (`MT_VALIDATION_REAL_ONLY`)
  - computeKillsCalibration (`KILLS_CALIB_REAL_ONLY`)
- ✅ Wave 2 (re-audit "verifique se shadow está puro", commit c618bd9):
  - lib/ev-calibration (`EV_CALIB_REAL_ONLY` — flippado false→true; mult que multiplica stake real não pode ter shadow contaminando)
  - lib/league-trust (`LEAGUE_TRUST_REAL_ONLY` novo; trust ratio aplicado em stake real era misturado com market_tips_shadow)
  - lib/mt-auto-promote (`MT_AUTO_PROMOTE_REAL_ONLY` novo; PROMOTE shadow=ok/eval, REVERT/LEAGUE=real/sintoma)
- ✅ Wave 3 (commit cb016b7): readiness-learner snapshot+verify+holdout default flippado is_shadow=1→0
- ✅ Detectores P2-compliant adicionais:
  - lib/shadow-vs-real-drift (cron 24h) — early warning quando shadow ROI degrada e real ainda OK
  - lib/gate-attribution (cron weekly) — counterfactual: saved_loss vs lost_profit per gate
- ⚠️ Tech debt menor: ~3 endpoints informacionais display shadow data sem disclaimer "research-only" (mt-shadow-by-league é misleading — feedback prévio em memory)

**Quando flagrar shadow ROI ruim:**
1. Próximo passo é INVESTIGAR CAUSA — não bloquear
2. Hipóteses: model bias? data source? regime change? calibração desatualizada? sample pequeno?
3. Soluções na causa: refit calib, tier-aware schema, env override, model rollback
4. Bloqueio só se já houver real data confirmando o leak

---

## P3 — Anti-overfeaturing (cuidado com features redundantes)

**Regra:** Antes de adicionar feature/cron/env/endpoint nova, **verificar via grep se algo similar já existe**. Refactor/delegate preferível a paralelo. Overfeaturing amplifica variance, dilui edge real, e cria surface area enorme de bugs.

**Por quê:** Sistema atual tem 26k linhas bot.js + 32k linhas server.js + **1.039 envs únicas** + **84 crons**. Cada feature nova multiplica interações imprevisíveis. Cases reais:

- **3 tier classifiers paralelos** (bot.js inline + lib/league-tier + lib/esports-runtime-features) com semantics diferentes. Resultado: CBLOL classified como tier1 em bot.js mas tier2 em lib → Kelly mult inconsistente. Fix em commit `7f9dcc9` (delegate).
- **hour-gate manual adicionado em sessão de audit** (commit `fec26df`) era redundante com `TIME_OF_DAY_AUTO` já existente em server.js:23081 (auto, granular per market). Revertido em `f28587f`.
- **4 multipliers Kelly compostos** (clv × trust × auto-tune × tier) amplificam variance quando aplicados juntos. Mantidos pq usam proxy diferente, mas overlap monitored.

**Como aplicar antes de adicionar feature:**

1. **Grep extensivo**: nome similar + função similar + comment similar
   ```bash
   grep -rE "function.*<feature_name>|<feature_concept>" bot.js server.js lib/
   ```
2. **Verificar envs existentes**: `process.env\.[A-Z_]+` — pode já ter env pra esse use case
3. **Verificar crons existentes**: `setInterval.*_wrapCron|setTimeout` — frequência similar?
4. **Olhar memory** (`memory/MEMORY.md`): feature já foi tentada e descontinuada?
5. **Se feature similar existe**: delegate/extend em vez de paralelo

**Anti-patterns (NÃO fazer):**

- ❌ Adicionar feature sem grep prévio
- ❌ Reimplementar regex/lógica que já existe em lib helper
- ❌ Adicionar cron que duplica intent de cron existente
- ❌ Env opt-in nova quando env legacy similar já existe e nunca foi limpa
- ❌ Endpoint admin paralelo a endpoint existente (mesmo nome plural/singular)
- ❌ Defensive layers redundantes (4 disable sources com overlap)
- ❌ "Por garantia" implementations (vai adicionar safety mas amplifica complexity)

**Patterns (fazer):**

- ✅ Delegate pra fonte canônica (`lib/league-tier`, `lib/utils`)
- ✅ Marker `DORMANT` no header de arquivos a deletar (próxima sessão decide)
- ✅ Comment "differente de X porque Y" quando 2 features fazem coisas similares
- ✅ Sunset envs legacy via env audit (`/admin/env-audit`)
- ✅ Cron `runOverfeaturingAuditCycle` (semanal) detecta features dormentes
- ✅ Antes de mergear PR, perguntar "isso já existe?"

**Pegada de "feature que parece útil mas é overfeature":**

| Sintoma | Sinal |
|---|---|
| 2 features com nome similar | `*HOURS_BLOCKED` + `TIME_OF_DAY_AUTO` |
| Env opt-in que nunca foi setada em prod | Dead opt-in |
| Cron com `count=0` em 30d | Cron sem trigger |
| Disable source com `count=0` no `mt_disable_list` | Auto-detection nunca dispara |
| Multiplier que retorna `1.0` em 95% dos calls | No-op em majoria |
| Audit grep retorna 3+ implementações | Paralelismo, refactor candidate |

**Status atual (2026-05-11):**

- ✅ Tier classifier unificado (commit `7f9dcc9`)
- ✅ hour-gate revertido (commit `f28587f`)
- ⚠️ `lib/esports-runtime-features.leagueTier` ainda paralela (numeração invertida, conversão consciente em esports-segment-gate) — não unificada
- ⚠️ 5 disable sources mantidas — cada captura signal diferente
- ⚠️ 4 Kelly multipliers compostos — variance amplification monitored
- ⏳ Cron `runOverfeaturingAuditCycle` deployed pra alerta automático

**Auditoria periódica:** `/admin/overfeaturing-audit` endpoint + cron 7d DM admin se findings > threshold.

---

## P4 — Otimização contínua de código

**Regra:** Em toda task — bug fix, feature, refactor, audit — buscar ativamente oportunidades de otimização (consolidar, deletar dead code, simplificar). Não é "while I'm here" gratuito (vide princípios gerais), mas sim **scan deliberado durante o trabalho normal**.

**Por quê:** Sistema acumula entropy. 26k linhas bot.js + 32k server.js cresceram com camadas históricas. Sem pressão sistemática pra reduzir, codebase fica progressivamente mais difícil. P3 evita ADIÇÃO de overfeaturing; P4 reduz overfeaturing PRÉ-EXISTENTE. Cases:
- Cleanup 2026-05-11: `external/sportsbook-odds-scraper/` (1422 linhas) + `lib/hour-gate.js` + 7 tests ESPN órfãos = ~4350 linhas mortas removidas.
- `_leagueTier` paralelo em bot.js → delegate pra `lib/league-tier` (commit `7f9dcc9`).
- Refit defaults `days=90` quebrado pra shadow retention `45d` → ajustado.

**Como aplicar — durante qualquer task, scan lateral:**

1. **Grep relacionado**: ao tocar arquivo X, grep funções similares — pode ter copy-paste.
2. **Dead imports**: cada arquivo aberto, conferir se há `require()` não usado.
3. **Dead branches**: `if (x) {...}` com `x` sempre true/false em uso atual.
4. **Hot path queries**: query OLTP > 10ms = candidato a index OR cache.
5. **Configurabilidade morta**: env opt-in nunca setada em prod = hardcode + delete env.
6. **Comments desatualizados**: comment que descreve old behavior = delete.
7. **Helpers single-caller**: lib helper usado em só 1 lugar = inline (a não ser que abstraction tenha valor semântico).

**Anti-patterns (NÃO fazer):**

- ❌ Otimização que NÃO foi pedida E mistura intent com bug fix no mesmo commit (split commits).
- ❌ Refactor profundo sem authorization (vide "Anti-patterns código": refactor não-relacionado).
- ❌ Deletar arquivo grande sem grep imports + autorização (vide "Perguntar ANTES").
- ❌ Premature optimization (otimizar algo que não está medido como hot).
- ❌ Cosmetic optimization (renomear var sem motivo concreto).

**Patterns (fazer):**

- ✅ Ao tocar arquivo: **2 min scan** procurando dead code adjacente → ANOTE no fim da response (não conserte na mesma).
- ✅ Quando feature está sendo deprecada: marker `// @DORMANT YYYY-MM-DD` no header — próxima sessão decide deletar.
- ✅ Ao adicionar feature: incluir delete de feature obsoleta no MESMO commit (delete-as-you-go).
- ✅ Periodic audit via `/admin/overfeaturing-audit` + `/admin/feature-inventory`.
- ✅ Sempre que detectar 3+ implementações paralelas (P3 trigger), refactor pra delegate.
- ✅ Antes de fechar response: 1 frase "Otimizações detectadas (não aplicadas): X, Y" — registro pra próxima sessão.

**Pegada (sinais que algo pode otimizar):**

| Sintoma | Otimização candidata |
|---|---|
| Função > 100 linhas | Split em sub-functions |
| Query repetida em 3+ endpoints | Helper em lib/ |
| Try/catch envolvendo 30+ linhas | Catch narrow ao código que falha |
| Mesmo regex em 2+ arquivos | Const em lib/utils ou lib/regex.js |
| Env opt-in que nunca foi setada | Hardcode + delete env |
| Comment "// TODO" > 30d | Resolve agora ou delete |
| Test file pra função deletada | Delete teste órfão |
| Dependência npm com 1 import só | Re-implementar inline OR documenta justificativa |

**Cadência:**

- **Toda sessão**: scan lateral durante task normal, anotar findings no fim.
- **Semanal**: `/admin/feature-inventory` + `/admin/overfeaturing-audit` review.
- **Mensal**: sessão dedicada de cleanup quando findings acumulados ≥ 5.

**Documentação live:**

- `FEATURE_INVENTORY.md` — catálogo de features ativas (grep antes de adicionar similar).
- `COMMON_PITFALLS.md` — top cases de bugs reais (consulta antes de mexer em área similar).
- `/admin/feature-inventory` — snapshot live programático.

**Status atual (2026-05-11):**

- ✅ ~4350 linhas dead code removidas em sessão única
- ✅ Tier classifier unificado
- ✅ Hour-gate redundante revertido
- ✅ `FEATURE_INVENTORY.md` + `COMMON_PITFALLS.md` criados
- ✅ Endpoint `/admin/feature-inventory` exposto
- ⏳ Continuous scan em cada session

---

## Princípios gerais de execução

- **Faça o mínimo necessário.** Resolva o pedido, nada além. Não adicione "while I'm here" fixes.
- **Ambíguo → PERGUNTE antes de codar.** Não invente requisitos.
- **Editar > criar.** Prefira modificar arquivo existente a criar novo.
- **Não adicionar dependências npm sem avisar e justificar.** package.json é sagrado — toda nova lib precisa autorização explícita.
- **Não refatorar não-relacionado.** Mesmo vendo problema óbvio, anote no fim da resposta. Refactor mistura intentions e quebra blame.
- **Pre-flight obrigatório**: antes de editar >1 arquivo OU >50 linhas, descreva em 3-5 linhas o que vai fazer + arquivos. Espere confirmação.
- **Bugs não-relacionados achados durante o pedido**: ANOTE no final, não conserte na mesma resposta.

---

## Anti-patterns código (NÃO escrever)

- ❌ **`try/catch` genérico sem motivo concreto.** Catch só onde sabe-se o que pode falhar + como recuperar. Catch silencioso (`catch (_) {}`) é code smell, exceto em logging best-effort documentado.
- ❌ **Logging novo sem pedido explícito.** Use o helper `log('LEVEL', 'TAG', message)` existente. Não adicione `console.log` ou loggers paralelos.
- ❌ **Comentários óbvios** (`// incrementa i`). Comment = explicação do **WHY**, nunca do **WHAT**. Code já diz "what".
- ❌ **Classes/factories/abstrações com 1 implementação concreta** (vide P3). Achata via inline OR mantém só se há plano concreto pra 2ª impl em ≤30d.
- ❌ **Parâmetros configuráveis pra valores que nunca mudam.** `function foo(x = 5)` quando x é sempre 5 = ruído. Hardcode + comment explicando se for crítico.
- ❌ **Wrappers de wrappers.** Se a lib já faz, chama a lib direto. Camadas extra adicionam surface area de bugs.
- ❌ **TODO/FIXME no código.** Resolve agora ou não faz. Memory + commit message são history; código é estado atual.
- ❌ **Defensive sem motivo**: validar input que vem de outro código teu (não de boundary externa) é ruído. Trust internal contracts.
- ❌ **Re-emit do mesmo error em catch** sem agregar info: `catch (e) { throw e; }` é dead block.

---

## Antes de escrever código

1. **Pre-flight** (sempre): em 3-5 linhas, diga o que vai fazer + arquivos a tocar.
2. **Espere confirmação** se o pedido envolve **>1 arquivo** OU **>50 linhas** OU mexer em fluxo crítico (Kelly/stake/DB schema/credenciais).
3. **Bug não-relacionado encontrado**: ANOTE no fim da resposta com 1 linha + caminho/linha. Não conserte na mesma response.

---

## Dinheiro e apostas (CRÍTICO)

- **Toda mudança que afeta `stake`, `bankroll`, `kelly_fraction`, `EV` cálculo, ou emit de tip real** precisa:
  1. Pre-flight explícito (qual fórmula muda, quem chama)
  2. Confirmação user
  3. Teste se houver test runner OR validation manual via endpoint admin
- **Float vs Decimal em JS**: JS não tem Decimal nativo. Aceitamos `Number` mas:
  - Sempre `.toFixed(N)` ao apresentar (DM, log, response)
  - Sempre `Math.abs(a - b) < EPSILON` em comparações (não `a === b`)
  - Arredondamento na fronteira de output (não no meio do cálculo)
- **Erro em fluxo de aposta = NÃO APOSTA + LOG + DM admin.** Nunca silenciar com `catch (_) {}` em path de tip real.
- **Limites SAGRADOS — não alterar sem pedido explícito**:
  - `MAX_KELLY_FRAC = 0.10` (em lib/market-tip-processor.js)
  - `KELLY_AUTO_TUNE_CEILING` (cap mult auto-tune, default 1.50)
  - `KELLY_TIER_MULT_<SPORT>_<TIER>` (mult por tier, default em `_KELLY_TIER_MULT_DEFAULTS`)
  - `DAILY_TIP_LIMIT` per sport (cap diário)
  - `MT_MIN_ODD = 1.40` floor
  - `MT_EV_CAP_PCT = 50` ceiling
  - Permanent disable list (`MT_PERMANENT_DISABLE_LIST`)
- **Mock de Telegram/casa em teste.** Nunca rodar teste contra `ADMIN_CHAT_IDS` production OR DB production. Use DB cópia + token de dev (`TELEGRAM_TOKEN_TEST` se existir).
- **P2 estrito**: tratamento de sintoma (block/disable/cap) só dispara em real evidence (`is_shadow=0 AND archived=0`). Shadow alimenta refit/calib (research), nunca decisão.

---

## Scraping / integração com casas (repo agregador-odds separado)

- **Rate limit respeitado.** Cada casa tem `rate_limit_sec` em config. Se não souber o limite real, perguntar.
- **Selectors em config** (`LIGAS_<CASA>` dict em `scraper/src/casas/<casa>.py`), nunca hardcoded no meio da lógica de coleta.
- **Toda HTTP/Playwright request tem timeout explícito** (default 60s). Sem timeout = não merge.
- **Captcha/login/2FA: não tente "dar um jeito" criativo.** Perguntar — pode requerer proxy residencial OR mudança de approach.
- **Anti-bot bypass**: usar `tf-playwright-stealth` (importado como `from playwright_stealth import stealth_async`) + `Sec-Fetch-*` headers + webdriver flag removal. Documentado em `betano.py` / `betfair.py`.
- **Proxy**: `SCRAPER_PROXY_URL` env (Webshare residential BR). Validar quota Webshare antes de deploy (`X-Webshare-Reason: bandwidthlimit` = 402).

---

## Banco de dados (SQLite better-sqlite3)

- **Migrations sempre** via `migrations/index.js` (numeradas sequencialmente). Nada de `ALTER TABLE` manual em prod.
- **Toda query nova**: declare se é **OLTP** (path quente, indexada, ≤10ms) ou **OLAP** (admin endpoint / cron, relatório, pode demorar).
- **Soft delete only** pra tips: `archived=1`, não `DELETE`. Histórico preserva auditoria.
- **WHERE archived=0 AND is_shadow=0** = real-only canonical path. Use `EV_CALIB_REAL_ONLY=true` etc env opt-outs pra preservar.
- **Cuidado com OLAP em path quente**: Railway tem 512MB cap. Queries agregadas grandes em cron rodam em peaks de memória — `isMemCritical()` check antes.
- **WAL mode + cache_size cap**: `PRAGMA cache_size=-8000` (8MB cap) + `PRAGMA mmap_size=0`. Defaults Railway pós OOM fix (commit `8401ffe`).

---

## Testes

- **Teste só lógica de verdade.** Não testar getter/setter, não testar wrappers triviais.
- **1 teste = 1 comportamento.** Testes que verificam 8 coisas mascaram falhas.
- **Mocks elaborados = code smell** — provavelmente design errado. Refactor antes de testar.
- **Não rodar teste contra prod** — DB cópia + tokens dev only.

---

## Estilo (JavaScript)

- **Funções > 40 linhas**: candidate a split. Provavelmente faz coisa demais.
- **Arquivo > 1000 linhas**: split. Exceção: `bot.js` (26k) e `server.js` (32k) são legacy monoliths — split é refactor maior, mas novos arquivos devem respeitar limite.
- **Nomes descritivos**: `getKellyFraction()` > `kf()`. `recordMarketTipAsRegular()` > `record()`.
- **Linhas ≤ 120 chars** (não 100 — mais permissivo pra JS verboso).
- **`async/await` > `.then` chains**. Promise chaining é code smell pós-Node 14.
- **`const` > `let` > `var`**. `var` é proibido em código novo.
- **Module exports explícitos**: `module.exports = { fn1, fn2 }` no fim do arquivo. Não exports espalhados.
- **Helpers em lib/**: nada de copy-paste cross-file. Se 2+ lugares fazem mesma coisa, criar/usar helper em `lib/`.

---

## Comandos do projeto

```bash
# Validar syntax
node -c bot.js && node -c server.js

# Rodar bot localmente (precisa .env)
node bot.js

# Subir scraper worker localmente
cd "../agregador de odds + ferramentas/scraper"
$env:PLAYWRIGHT_MODE="headed"
python -m src capture-fixture <casa> --liga brasileirao-serie-a

# Health prod
KEY="<admin_key>"
BASE="https://sportsedge-bot-production.up.railway.app"
curl -s "$BASE/health"
curl -s -H "x-admin-key: $KEY" "$BASE/admin/p2-status"
curl -s -H "x-admin-key: $KEY" "$BASE/admin/risk-metrics?days=30"
curl -s -H "x-admin-key: $KEY" "$BASE/admin/overfeaturing-audit?days=30"

# Logs Railway: dashboard → service → Deployments → Logs
```

---

## Perguntar ANTES de fazer (não decisão unilateral)

- **Cálculo de stake / EV / Kelly fraction** — mudança em lógica financeira
- **Schema DB** — nova migration, alter table, novo índice
- **Credenciais / .env / Railway envs sensíveis** — TELEGRAM_TOKEN_*, ADMIN_KEY, DEEPSEEK_KEY, etc.
- **Nova biblioteca npm** — justifique alternativa nativa, lib leve preferida
- **Adicionar cron novo** — sempre verificar P3 (sistema já tem 84, surface area enorme)
- **Adicionar feature similar a algo existente** — vide P3, grep antes
- **Deletar arquivos tracked** — soft delete (`git rm`) requer autorização explícita pra >2 arquivos OR >200 linhas
- **Push pra `main`** — classifier exige autorização direta em alguns paths
- **Alterar limites SAGRADOS** (vide seção Dinheiro)

---

## Como adicionar premissas novas

Quando o user lembrar de outro princípio fundamental:
1. Adicione como `## P<n> — <título>` neste arquivo
2. Estruture com Regra / Por quê / Como aplicar / Anti-patterns / Patterns / Status
3. Atualize a memory `feedback_*.md` correspondente
4. Cross-reference em `memory/MEMORY.md` na seção "Princípios arquiteturais"

---

## Convenções para violações

Se em algum momento for necessário violar uma premissa (caso edge raro), o commit message deve:
1. Citar explicitamente qual premissa está violando (`P1`/`P2`)
2. Justificar por quê é exceção
3. Listar plano de retorno à conformidade (se aplicável)

Sem essa transparência, qualquer violação é code smell que precisa ser refactorada.

---

## Configurações operacionais recomendadas (Railway env)

Defaults que devem estar setados em prod além dos opt-ins padrão:

### Overfitting protection (auto-tunes)

```
FROZEN_HOLDOUT_DAYS=60
```

**Por quê:** auto-tunes (kelly_auto_tune, mt_auto_promote, gates_autotune, ev_calibration, learned_corrections, readiness_learner, leak/bucket guards) treinam em janela rolling 30-90d. Sem holdout, decisão "promote MT" / "tune kelly_mult" é tomada usando dados que serão re-avaliados pelos mesmos sistemas — overfitting estrutural. Defaults atuais com `FROZEN_HOLDOUT_DAYS=0` (OFF) deixam todos vulneráveis.

**Tradeoff:** auto-tunes ficam menos reativos (60d pra incorporar regime change novo). Aceitável vs churn em ruído. Override per-sistema disponível (`FROZEN_HOLDOUT_KELLY_DAYS=120` etc).

**Validação:** `GET /admin/holdout-status` (admin auth) retorna `{ default_days, per_system: {kelly: {days, cutoff_iso}, mt_auto_promote: {...}, ...} }`. Confirmar que `default_days >= 60` em prod.

**Single source of truth P2:** `GET /admin/p2-status` (admin auth) retorna config dos 11 envs P2 + frozen_holdout + lista de issues compliance. Use pra validação rápida antes de deploys ou quando suspeitar de regressão.

### Shadow vs real drift detection

```
SHADOW_VS_REAL_DRIFT_AUTO=true   # default já é true
```

P2-compliant: só DM admin, sem auto-action. Cron 24h às 8h local. Detecta modelo base degradando enquanto gates mascaram em real.

### Gate attribution counterfactual

```
GATE_ATTRIBUTION_AUTO=true       # default já é true
```

Cron seg 15h UTC. DM admin com top 5 gates por |saved_loss − lost_profit|. Identifica gates cortando edge.

### Readiness learner (opt-in OFF)

```
# READINESS_LEARNER_AUTO=true    # NÃO ativar sem 1-2 ciclos dry_run validados
```

Após Wave 3 fix (commit cb016b7) está P2-compliant — snapshot+verify+holdout usam `is_shadow=0`. Recomendação antes de ON: rodar `POST /admin/readiness-learner-run?dry_run=1&days=30` 1-2x e revisar `r.applied` + `r.verified`.

---

## Workflows operacionais comuns

### Disable manual de market problemático

Quando readiness-learner não pode agir (sample <minN=20) mas leak está confirmado em real:

```
POST /admin/mt-disable?sport=<sport>&market=<MARKET>&side=<over|under|team1|team2>&reason=<texto>&key=<KEY>
```

- `side` opcional: omita pra disable do market inteiro pra esse sport
- Persiste em `market_tips_runtime_state` source='manual'
- Bot.js refresh in-memory no próximo cron leak guard (1h) ou restart

**Restore manual:**
```
DELETE FROM market_tips_runtime_state WHERE sport=? AND market=? AND source='manual';
```
(via SQL direto até criar /admin/mt-restore endpoint)

### Audit per sport+market

Visibilidade interna pra investigar leak/edge:

```
GET /admin/mt-shadow-by-league?sport=<sport>&days=30&minN=5&key=<KEY>
GET /shadow-readiness?source=real&groupBy=sport_market&sport=<sport>&days=30&key=<KEY>
GET /admin/mt-shadow-by-ev?sport=<sport>&days=30&key=<KEY>
```

Inclui disclaimer "research-only" no payload (P2-compliant).

### Cap manual de stake per (sport, market, conf)

Hierarquia de override Kelly mult (mais específico ganha):
1. `KELLY_<SPORT>_<MARKET>_<CONF>` — ex: `KELLY_TENNIS_HANDICAP_GAMES_MEDIA=0.40`
2. `KELLY_<SPORT>_<CONF>` — ex: `KELLY_CS_BAIXA=0.30`
3. `KELLY_<CONF>` — ex: `KELLY_BAIXA=0.50`
4. Default kelly_mult per sport (gates_runtime_state)

Use pra leaks com sample <20 (abaixo do learner threshold).

### Promover sport/market manualmente

```
POST /admin/mt-block-league?sport=<sport>&market=<MARKET>&league=<league>&reason=<...>&key=<KEY>
POST /admin/mt-unblock-league?sport=<sport>&market=<MARKET>&league=<league>&key=<KEY>
```

### Validar compliance P2 antes de deploy

```
GET /admin/p2-status?key=<KEY>
```

`compliance_summary` deve ser `✅`. `version.commit_short` confirma deploy mais recente.

- NÃO adicione tratamento de erro especulativo. Só capture exceções que sabemos que acontecem.
- NÃO crie camadas de abstração (interfaces, factories, strategies) sem 2+ implementações reais.
- NÃO adicione configuração para valores que nunca mudaram.
- NÃO adicione logging novo sem pedido explícito.
- Antes de criar arquivo novo, verifique se cabe em um existente.
- Responda com o mínimo de código que resolve. Se houver dúvida, pergunte antes de codar.
