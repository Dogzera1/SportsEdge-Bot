# Auditoria ADVERSARIAL / Segurança — 2026-05-28

Commit deployed: `fb9f42e`. Foco: pentest mindset (ex-funcionário / casa hostil / scraper / insider / race / math exploit). **Não explorei destrutivamente prod** (classifier bloqueou probe POST /record-tip — correto). Findings via análise estática de código + 1 probe GET read-only (`/admin/env-audit`).

## Resumo executivo

A camada de auth admin (`requireAdmin`/`isAdminRequest`, server.js:4230-4607) é **robusta e bem-feita**: timing-safe compare (`_adminKeyEq`), lockout per-IP com exempção loopback, IP allowlist, CSRF em cookie-session, rejeição de `?key=` em paths destrutivos, WAF HexStrike (scanner UA + honeypots + attack patterns), security headers. `security_status.json` `defenses_active` confere com o código. **Auto-bet** (lib/pinnacle-auto-bet.js) tem 7 gates reais + kill switch default OFF + idempotency. **Telegram** `handleAdmin` (bot.js:12418) valida `ADMIN_IDS.has(chatId)` antes de qualquer comando.

**O furo NÃO está na auth admin — está em endpoints IPC state-changing que NÃO usam `requireAdmin` porque o bot os chama via loopback.** O codebase já tem o padrão correto (`if (!isLoopback && !isAdminRequest(req)) → 403`, server.js:8688 e 36327), mas `/settle`, `/record-tip` (token opt-in), `/match-result` e família NÃO o aplicam. Eles estão **abertos a qualquer requisição da internet** no URL público Railway.

---

### [SEV: P0] `/settle` — settle de tips com `winner` arbitrário, SEM auth → corrompe bankroll
- **Onde**: server.js:35063 (`if (p === '/settle' && req.method === 'POST')`)
- **Evidência**: O handler abre direto em `_readPostBody` — **não há `requireAdmin`, nem token, nem rate-limit, nem check loopback**. Lê `{ matchId, winner, ... }` do BODY do atacante (35076), faz `SELECT * FROM tips WHERE match_id IN (?,?) AND result IS NULL` (35125), name-match contra o `winner` fornecido, e escreve:
  - `stmts.settleTipById.run(result, tip.id)` (35260)
  - `UPDATE tips SET stake_reais=?, profit_reais=? WHERE id=?` (35280)
  - `stmts.updateBankroll.run(nova, sport)` **dentro da transaction** (35319)
  Únicos guards: matchId com `::mt::` é bloqueado (35094) e markets non-ML são rejeitados (defesa MT-propagator). **ML tips reais ficam 100% settláveis por qualquer um.**
- **Impacto financeiro**: ALTO. Atacante que conhece `match_id`+nome do time de uma tip pending real pode:
  (a) settlar como `win` → credita `profit_reais` na banca sem aposta vencedora real (infla banca/ROI);
  (b) settlar winning tip como `loss` → debita banca;
  (c) corromper ROI/CLV histórico em massa. Range: toda a banca real exposta (hoje ~R$172 stake 30d, mas escala com banca). É exatamente o cenário do prompt "cobra ROI da nossa banca sem aposta perdedora real" / "match_results com winner trocado → reverse tips".
- **Causa raiz**: `/settle` é chamado pelo bot via loopback (settle cron) e nunca recebeu gate de auth quando o servidor passou a ser público. Comentários internos (35105) discutem lógica de shadow/MT mas nenhum menciona auth — esquecido.
- **Fix proposto**: adicionar no topo do handler o MESMO padrão já usado em server.js:8688:
  `const isLoopback = _isLoopbackIp(getClientIp(req)); if (!isLoopback && !isAdminRequest(req)) { sendJson(res,{ok:false,error:'forbidden'},403); return; }`
  Isso preserva o caller loopback (bot) e bloqueia internet. NÃO aplicar — requer pre-flight (toca settle/bankroll path, fluxo financeiro crítico per CLAUDE.md).
- **Cross-sport (P5)**: AFETA TODOS os sports — `/settle` é genérico (`sport = parsed.query.sport`). lol/cs/dota2/valorant/tennis/football/basket/mma/darts/snooker/tt todos settláveis por esse path.

---

### [SEV: P0] `/record-tip` — token gate é OPT-IN, quase certamente OFF em prod → injeção de tips arbitrárias
- **Onde**: server.js:28911-28926
- **Evidência**: O gate só dispara `if (/^(1|true|yes)$/.test(process.env.RECORD_TIP_TOKEN_REQUIRED))` (28919). Se a env não estiver setada, o handler **prossegue sem qualquer auth** (apenas cap de body 64KB). Sinal forte de que está OFF: `security_status.json` `defenses_active` lista 13 defesas mas **NÃO inclui `record_tip_token`**; o audit_log mostra `/record-tip success:true` só de `127.0.0.1` (o bot). Memory confirma: "record-tip já foi unauth P0" e o fix foi opt-in pendente de rollout (`RECORD_TIP_TOKEN_REQUIRED=true` nunca flippado).
- **Impacto financeiro**: ALTO se OFF. Atacante POSTa tips "reais" (is_shadow=0) arbitrárias no URL público → poluem banca/ROI/dispatch, disparam DM Telegram falsos, e — se auto-bet algum dia ligar — viram apostas reais. Mesmo com auto-bet OFF, corrompe contabilidade e pode mascarar/forjar leaks.
- **Causa raiz**: rollout em 2 fases nunca concluído (deploy fix → set token → flip REQUIRED=true). Ficou na fase 1.
- **Fix proposto**: (1) confirmar em prod via env read-only se `RECORD_TIP_TOKEN_REQUIRED` está set; (2) se não, mesmo padrão loopback-or-admin do `/settle` (bot chama via loopback, então loopback-only já basta e não exige distribuir token); OU concluir o rollout do token. NÃO aplicar.
- **Cross-sport (P5)**: genérico — todos os sports gravam via `/record-tip`.

---

### [SEV: P1] `/match-result`, `/ps-result`, `/dota-result`, `/cs-result`, `/valorant-result`, `/darts-result`, `/snooker-result` — escrevem match_results SEM auth (só rate-limit)
- **Onde**: server.js:8773 (`/match-result`), 8812 (`/ps-result`), 8878 (`/dota-result`), +família; gate único `_matchResultRateLimit` (server.js:1702, 60/min/IP, sem auth)
- **Evidência**: nenhum tem `requireAdmin`/token. **MAS** todos resolvem o `winner` **server-side a partir do feed upstream confiável** (Riot ESPN getSchedule 8786 / PandaScore `/matches/{id}` 8828 / HLTV / VLR). O atacante controla apenas o `matchId` query param, NÃO o winner. Guard `state==='completed'` / `status==='finished'` (8789, 8838) impede settle de jogo em andamento. `upsertMatchResult` usa OR IGNORE first-write-wins na maioria dos paths.
- **Impacto financeiro**: BAIXO-MÉDIO. Não permite winner arbitrário (≠ `/settle`). Vetores residuais: (a) DoS/cache thrash chamando lookups (rate-limited 60/min); (b) forçar gravação precoce de um resultado real legítimo; (c) enumeração de matchIds existentes. Sem roubo direto.
- **Causa raiz**: endpoints IPC bot→server expostos publicamente sem gate; assumiu-se que winner server-side era proteção suficiente (parcialmente verdade).
- **Fix proposto**: aplicar loopback-or-admin gate (padrão 8688) por consistência defense-in-depth. Baixa urgência vs P0s.
- **Cross-sport (P5)**: família inteira de endpoints `*-result` afetada (todos os sports com settle via feed externo). `/football-result` (9229) é **read-only** (só SELECT em match_results, não escreve) → não-vetor.

---

### [SEV: P1] `/admin/upsert-match-result` aceita winner arbitrário e NÃO está em `_DESTRUCTIVE_PATHS` → aceita `?key=`
- **Onde**: server.js:21935; lista destrutiva server.js:4325
- **Evidência**: É `requireAdmin`-gated (21936) — bom. Aceita `{team1, team2, winner}` arbitrários do body e faz `upsertMatchResult.run(...)` (21952) → grava winner escolhido em match_results → settle path lê e settla tips contra ele. MAS NÃO consta no regex `_DESTRUCTIVE_PATHS`, então aceita auth via `?key=` query (não força header). Se a admin key vazar em log/URL/Referer, um `<img src="prod/admin/upsert-match-result?key=...">` não funciona (é POST), mas qualquer GET-leak da key permite o ataque via CLI.
- **Impacto financeiro**: MÉDIO. Requer a admin key (8 dígitos). Combinado com ausência de lockout efetivo contra a própria key vazada, permite poisoning de winner → corrompe settle. Este é o "match_results com winner trocado" COM auth.
- **Causa raiz**: endpoint adicionado em 2026-05-13 (MMA settle) e esquecido na lista destrutiva expandida em 2026-05-14.
- **Fix proposto**: adicionar `/admin/upsert-match-result` ao regex `_DESTRUCTIVE_PATHS` (server.js:4325) → força header x-admin-key, mata o vetor `?key=` em URL. Mesma classe: revisar se `kelly-mult-set`, `set-tip-clv`, `mt-disable` (este já está) cobrem todos os state-changing.
- **Cross-sport (P5)**: genérico (`game` é param) — todos os sports.

---

### [SEV: P1] Brute-force da admin key de 8 dígitos: lockout NÃO conta falhas de ranges privados/CGNAT
- **Onde**: server.js:4452-4491 (`_isLoopbackIp`, `_isAdminLocked`, `_recordAdminFail`)
- **Evidência**: lockout config = 10 falhas / 15min / lock 30min (confirmado em security_status.json). MAS `_recordAdminFail` faz `if (_isLoopbackIp(ip)) return` (4473) e `_isLoopbackIp` inclui **todo 10.x, 192.168.x, 172.16-31.x e Railway CGNAT 100.64.0.0/10** (4454-4458). Como o tráfego do URL público Railway chega via proxy interno, o `getClientIp` retorna o IP real do cliente SE `_isTrustedProxy` (server.js:4149) — então clientes externos NÃO são tratados como loopback (bom). Risco real: se o deploy mudar e o XFF não for confiável, ou se o atacante conseguir origem num range privado, lockout é totalmente bypassed. Key de 10^8 sem lockout = brute-forçável (a ~60 req/min do `ADMIN_RATE_LIMIT_PER_MIN`, 10^8 é inviável em tempo curto, mas o rate-limit é per-IP e distribuível).
- **Impacto financeiro**: BAIXO-MÉDIO (defense-in-depth). User ACEITA key curta (memory). O risco é a interação rate-limit-per-IP + lockout-isenta-private permitir brute distribuído.
- **Causa raiz**: a isenção loopback (necessária pro IPC bot, fix 2026-05-20 que parou auto-lock do bot) é larga demais — cobre todo RFC1918 + CGNAT, não só 127/::1.
- **Fix proposto**: estreitar a isenção de lockout APENAS para `127.0.0.1/::1/::ffff:127.` (loopback verdadeiro), não todo RFC1918. O IPC bot→server é 127.0.0.1; os 100.64.x do audit_log são o proxy Railway, não o bot. Validar que bot não usa 10.x antes. NÃO aplicar sem pre-flight (risco de auto-lock do IPC).
- **Cross-sport**: N/A (infra).

---

### [SEV: P2] Stored-XSS potencial no admin console via campos não-escapados (`innerHTML`)
- **Onde**: server.js admin HTML — múltiplos `document.getElementById(...).innerHTML = ... + valor + ...` (13722, 13774, 14057, 14117, 14190, 14229, etc.)
- **Evidência**: dashboards montam HTML por concatenação e injetam JSON do servidor + `e.message` via `innerHTML`. Campos como team names, league, tip_reason vêm de dados que (dado o P0 `/settle`/`/record-tip` unauth) um atacante pode injetar. Se um nome de time com `<img src=x onerror=...>` for gravado e depois renderizado no console admin sem escape, executa JS no contexto do admin (que tem cookie de sessão) → escalation.
- **Impacto financeiro**: BAIXO (requer admin abrir o console + atacante já ter injetado via outro furo). Chain com P0 acima.
- **Causa raiz**: render por string concat sem `textContent`/escape helper.
- **Fix proposto**: usar `textContent` para valores dinâmicos OU escapar `<>&"'` antes de interpolar em innerHTML. P4: criar helper `escHtml()` único em vez de espalhar. NÃO aplicar.
- **Cross-sport**: N/A (UI).

---

## Cenários adversariais rankeados (1 = mais provável)

1. **[PROB 9/10 | banca inteira] `/settle` unauth com winner arbitrário** (server.js:35063). Atacante settla tips reais como win/loss → corrompe `profit_reais`+bankroll. **ESTE é o que um atacante usaria pra mover/roubar dinheiro.** Mitigação atual: NENHUMA (só guard `::mt::`+non-ML). Fix: gate loopback-or-admin (padrão server.js:8688).
2. **[PROB 8/10 | contabilidade + tips falsas] `/record-tip` token OPT-IN provavelmente OFF** (server.js:28919). Injeção de tips arbitrárias. Mitigação: gate existe mas inativo (não está em defenses_active). Fix: flip `RECORD_TIP_TOKEN_REQUIRED=true` OU loopback-only.
3. **[PROB 6/10 | poisoning settle] `/admin/upsert-match-result` aceita `?key=`** fora de `_DESTRUCTIVE_PATHS` (server.js:21935 + 4325). Winner trocado se key vazar via URL/log. Mitigação: requireAdmin (parcial). Fix: adicionar ao regex destrutivo.
4. **[PROB 5/10 | -ROI / dados] `/match-result` família unauth** (server.js:8773+). Winner é server-side (baixo impacto), mas DoS/probe/early-write. Mitigação: rate-limit 60/min + winner server-side. Fix: gate loopback-or-admin.
5. **[PROB 4/10 | brute key] lockout isenta todo RFC1918+CGNAT** (server.js:4454). Brute distribuível se origem privada/proxy não confiável. Mitigação: timing-safe + rate-limit per-IP + lockout (parcial). Fix: estreitar isenção a 127/::1.
6. **[PROB 3/10] Stored-XSS admin console** (innerHTML) chain com #1/#2. Mitigação: nenhuma (concat). Fix: textContent/escape.
7. **[PROB 3/10 | casa hostil] line move pós-emit / CLV falsificado** — fora do escopo de código (casa controla feed). Mitigação parcial: kill switch CLV calib, multi-source quorum settle (commit e4a7fb5). Não é furo de código nosso.
8. **[PROB 2/10 | feed envenenado] Pinnacle/Sofascore winner errado por horas** → settle errado. Mitigação: mig 109 dual-source observability + quorum FASE 2. Real mas exógeno.
9. **[PROB 2/10 | supply chain] npm poisoning (better-sqlite3/dotenv/@duckdb)** — 3 deps prod. Mitigação: nenhuma trava de lockfile auditada aqui. Fora do código.
10. **[PROB 1/10] Telegram command/callback spoof** — MITIGADO: `handleAdmin` valida `ADMIN_IDS.has(chatId)` (bot.js:12418); callbacks destrutivos validam `ADMIN_IDS.has(userId)` (bot.js:16303). Sem furo encontrado.

---

## Testes práticos (top-3) — DESCRIÇÃO, não executados (proibido explorar prod destrutivamente)

**#1 `/settle` unauth** — em DB CÓPIA local (nunca prod), subir server com tip pending real conhecida e:
```
curl -s -X POST "http://127.0.0.1:PORT/settle?sport=lol" -H 'Content-Type: application/json' \
  -d '{"matchId":"<match_id_da_tip>","winner":"<nome_time_da_tip>"}'
```
Se retornar `{ok:true, settled:1}` sem header de auth → confirma. Depois `SELECT result, profit_reais FROM tips WHERE match_id=...` deve mostrar a tip settled e bankroll mudado. (Validação read-only equivalente em prod: NÃO fazer — é write. Em vez disso, confirmar por leitura de código, já feito.)

**#2 `/record-tip` token OFF** — leitura read-only do env em prod (não-destrutivo): confirmar se `RECORD_TIP_TOKEN_REQUIRED` está set. Como o `/admin/env-audit` não ecoa valores arbitrários, usar Railway dashboard OU adicionar (futuramente) ao `/admin/p2-status` um campo `record_tip_token_active`. Teste de exploit (só em cópia local): `curl -X POST localhost:PORT/record-tip -d '{...tip...}'` sem header → se grava, gate OFF.

**#3 `/admin/upsert-match-result` via `?key=`** — confirmar que aceita query key (vetor de leak):
```
curl -s "http://127.0.0.1:PORT/admin/upsert-match-result?key=14725836" -X POST \
  -d '{"match_id":"test","game":"lol","team1":"A","team2":"B","winner":"A"}'
```
Se `ok:true` (em vez de `query.key REJECTED em destructive path`) → confirma que está fora da lista destrutiva. (Read-only: comparar com `/admin/mt-disable?key=...` POST que DEVE retornar rejeição por estar na lista.)

---

## Defesas verificadas como SÓLIDAS (não-findings, registro)
- `_adminKeyEq` timing-safe (server.js:4230) ✅ — length check + `crypto.timingSafeEqual`.
- `_isDestructive` + rejeição `?key=` em paths destrutivos (server.js:4271, 4325) ✅ — cobre reset/wipe/force-sync-bankroll/void-tips-batch/mt-* etc.
- `getClientIp` só confia XFF de `_isTrustedProxy` (server.js:4149) ✅ — XFF spoof de loopback bloqueado.
- CSRF em mutations cookie-session (server.js:4300-4315) ✅.
- HexStrike WAF: scanner-UA blocklist + 64 honeypots + 16 attack patterns + 24h ban (server.js:4341-4421) ✅.
- Auto-bet 7 gates + kill switch OFF + require_confirm enforced (lib/pinnacle-auto-bet.js:71,142) + idempotency via pinnacle_bet_id (linha 343) ✅.
- Telegram `handleAdmin` ADMIN_IDS gate (bot.js:12418) + callback admin gate (bot.js:16303) ✅.
- Secret leak: env-audit expõe só `slice(0,14)` signature, não token completo (server.js:14423) ✅; DEEPSEEK/PANDASCORE só presence-check, não ecoados.
- SQL injection: paths revisados usam prepared statements `?` (ex: 35125, 9250, 21952); nenhuma concatenação de input em SQL encontrada nos handlers críticos.

## P4 — otimizações detectadas (não aplicadas)
- `_isLoopbackIp` (4452) e `_isIpInAllowlist` (4513) duplicam a mesma lista de ranges privados — candidato a helper único.
- Padrão `loopback-or-admin` (8688, 36327) repetido inline — candidato a helper `requireLoopbackOrAdmin(req,res)` que cobriria `/settle`, `/record-tip`, `/match-result` família de uma vez (resolve P0+P1 com 1 helper).
