# DECISIONS LOG — SportsEdge Bot

Registro cronológico de decisões significativas. Toda mudança de comportamento de negócio, gate, threshold, ou arquitetura entra aqui.

**Formato:**
```
## YYYY-MM-DD — Título
**Motivo:** por quê foi necessária
**Antes:** estado anterior
**Agora:** estado novo
**Reversão:** como reverter se quiser voltar
**Status:** ✅ aplicado | 🧪 experimental (Xd janela) | ⚠️ provisório (revisar em Xd)
```

---

## 2026-04-17 — Tip parser: IA fornece apenas P, sistema calcula EV
**Motivo:** IA tinha taxa alta de erro aritmético (`EV = P × odd − 1`). Mesmo modelo P bom, EV inconsistente fazia tip ser rejeitada por gate antigo.
**Antes:** prompt pedia `TIP_ML:[time]@[odd]|EV:[%]|P:[%]|STAKE:Yu|CONF:Z`
**Agora:** prompt pede `TIP_ML:[time]@[odd]|P:[%]|STAKE:Yu|CONF:Z` — sistema calcula EV downstream
**Reversão:** prompts em bot.js (4 locais) + `_parseTipMl` aceita ambos formatos (backward compat)
**Status:** ✅ aplicado em LoL/Dota/MMA/Tennis/Football/CS/Val/Darts/Snooker/TT

## 2026-04-17 — `_validateTipPvsModel` em todos os bots
**Motivo:** IA às vezes ignora P do modelo determinístico e chuta P diferente. Modelo é source of truth (calibrado por Elo/histórico).
**Antes:** validava só consistência aritmética IA (EV vs P×odd) — `_validateTipEvP`
**Agora:** valida P_IA vs P_modelo com tolerância 8pp; se diverge → rejeita
**Reversão:** remover gates `_validateTipPvsModel` em bot.js (8 chamadas)
**Status:** ✅ aplicado

## 2026-04-17 — Sharp divergence gate (Pinnacle/Betfair anchor)
**Motivo:** edges +20% em mercados sharp (Pinnacle ATP, EPL, Major CS) são quase sempre erro do modelo, não edge real. Apostar com Kelly inflado em edge fictício = ruína matemática.
**Antes:** sem gate vs Pinnacle — modelo decidia sozinho
**Agora:** se odds vêm de Pinnacle/Betfair E |modelP − impliedP_dejuiced| > cap → rejeita
**Caps por sport:** MMA/Football 10pp | CS/Tennis/Val 12pp | LoL/Dota/Darts/Snooker 15pp | TT 20pp
**Reversão:** setar cap=99 nas envs `<SPORT>_MAX_DIVERGENCE_PP=99`
**Status:** ✅ aplicado em todos os 9 sports

## 2026-04-17 — Pinnacle prioritário no `/odds` (LoL/Dota)
**Motivo:** antes pegávamos a melhor odd (line shopping) — geralmente SX.Bet acima de Pinnacle. Calcular EV em cima do book menos sharp inflava edge artificialmente.
**Antes:** `/odds?game=lol` retornava best price, Pinnacle ia como `_sharp` reference
**Agora:** Pinnacle = primary; SX.Bet/TheOddsAPI vão como `_alternative`
**Reversão:** server.js `/odds` LoL+Dota — voltar pra `reduce` por preço
**Status:** ✅ aplicado. DM mostra ambos pra usuário escolher.

## 2026-04-17 — IA universal (CS/Val/Darts/Snooker/TT)
**Motivo:** sports sem IA dependiam só do modelo Elo/HLTV. IA serve de "segunda opinião" pra capturar contexto qualitativo (lineup, news, momentum).
**Antes:** LoL/Dota/MMA/Tennis/Football tinham IA. Outros 5 não.
**Agora:** todos os 9 sports tem IA via `_aiSecondOpinion` helper
**Toggle:** `<SPORT>_USE_AI=true` (default) | `false` desativa
**Reversão:** setar todos `*_USE_AI=false`
**Status:** ✅ aplicado

## 2026-04-17 — Tier-aware caps (CS, MMA)
**Motivo:** CS tier 2-3 (CCT, NODWIN, regional, academy) tem amostra ruim no Elo. MMA bookmaker non-sharp (BetOnline/FanDuel) infla EV.
**Antes:** mesmas regras pra todos os matches do sport.
**Agora:**
  - **CS** Tier 2+ (não-Major/IEM/ESL/EPL/BLAST): conf max MÉDIA, stake max 1u, EV mín 8%
  - **MMA** book non-sharp: conf rebaixada ALTA→MÉDIA, stake max 1u, EV mín 12%
**Reversão:** setar `CS_TIER2_*` e `MMA_*_NONSHARP` envs pra valores frouxos
**Status:** ✅ aplicado

## 2026-04-17 — LoL tier 2-3 EV cap >25% rejeita
**Motivo:** ROI -56% em 16 tips Prime League/LFL/Rift Legends — EV reportado 30-55% era inflated por modelo com small-sample em ligas obscuras.
**Antes:** sem cap — IA podia mandar EV 50%+ em qualquer liga
**Agora:** se liga não-premier (regex `lck|lec|lcs|lpl|msi|worlds|cblol|lla|pcs|lco|vcs`) E EV>25% → rejeita
**Reversão:** remover gate `Gate LoL tier2+` em bot.js (live + upcoming)
**Status:** ✅ aplicado. Aguardando 30d pra avaliar se reduziu bleed.

## 2026-04-17 — Schedulers independentes pra Valorant/CS
**Motivo:** runAutoAnalysis mutex travava 10+min com IA cap MMA, deixando Valorant invisível durante VCT live (perdeu Pcific vs Fnatic).
**Antes:** pollValorant + pollCs rodavam dentro do mutex `runAutoAnalysis` (a cada 6min, mas bloqueado quando MMA travava)
**Agora:** schedulers próprios (mesmo padrão Darts/Snooker): 90s live / 5min idle
**Reversão:** remover blocks `(function scheduleValorant)` e `(function scheduleCs)` em bot.js
**Status:** ✅ aplicado

## 2026-04-17 — Dota live cooldown adaptativo + Steam RT
**Motivo:** OpenDota tem delay nativo 3min (anti-cheat). Steam Realtime API reduz pra ~15s.
**Antes:** cooldown fixo 3min, poll 2min, TTL Pinnacle 3min
**Agora:**
  - cooldown 90s se `STEAM_WEBAPI_KEY` setada / 3min sem
  - poll live 60s com Steam RT / 2min sem
  - TTL Pinnacle live 45s / 3min idle
  - Gate stale: rejeita se gameTime <8min mas match começou >15min atrás
**Reversão:** remover `STEAM_WEBAPI_KEY` ou setar cooldowns hardcoded
**Status:** ✅ aplicado, Steam RT firing confirmado em produção

## 2026-04-17 — VLR.gg regex fix
**Motivo:** VLR mudou ordem dos atributos `class`/`href` no HTML. Regex antigo casava 0 matches → toda partida live Valorant ficava `vlrLive=null` → gate `VAL_LIVE_MIN_EV_NO_VLR=8` aplicado em tudo, derrubando tips.
**Antes:** regex assumia `class` antes de `href`
**Agora:** lookahead independente de ordem + parser ajustado pra `<span class="flag">`
**Reversão:** lib/vlr.js linhas 185+ — voltar pro padrão antigo
**Status:** ✅ aplicado, `/debug-vlr` confirmado

## 2026-04-17 — Tennis: re-validação odds antes do DM
**Motivo:** odds tennis live mexem 30-50% em poucos minutos. Tip de Faria/Safiullin foi enviada com odd 3.04 mas mercado tava 1.87 quando user recebeu.
**Antes:** odd da tip era a do momento da análise; sem re-check
**Agora:** antes do DM, re-fetch /tennis-matches; se odd da pick caiu >12% → aborta tip
**Reversão:** remover bloco "Re-validação de odds AO VIVO" em bot.js (~6635-6657)
**Status:** ✅ aplicado

## 2026-04-17 — Auto-Healer + Health Sentinel (12 fixes)
**Motivo:** problemas operacionais (mutex stuck, polls silent, cache vazio, AI backoff travado) eram invisíveis até user reclamar.
**Antes:** dependia de admin notar e investigar manualmente
**Agora:** Health Sentinel (cron 5min) detecta anomalies, Auto-Healer aplica fixes registrados, DM admin com cooldown 30min/anomaly_id
**Reversão:** `AUTO_HEALER_ENABLED=false`
**Status:** 🧪 experimental — primeiros 14d pra ver se gera valor real ou só ruído

## 2026-04-17 — Heartbeat tracking direto (substitui grep no log buffer)
**Motivo:** poll_silent flag falsa-positiva crônica — log buffer (5000 entries) evictava logs em sistema busy, sentinel concluía "poll silent" mesmo com poll rodando.
**Antes:** sentinel usava regex em `slice(-3000)` do log buffer
**Agora:** `markPollHeartbeat(name)` em cada poll loop + `getPollHeartbeats()` Map in-memory. Sentinel lê direto.
**Reversão:** voltar sentinel pra grep do buffer (lib/dashboard.js)
**Status:** ✅ aplicado

## 2026-04-17 — Pre-Match Final Check: cutoff 90min pra match-missing
**Motivo:** primeira versão flagava tip de 4-5h atrás como "cancelamento" (mas match já tinha jogado, settlement era o pendente).
**Antes:** cutoff 6h (depois 24h, depois 48h em iterações)
**Agora:** cutoff 90min — tempo médio de duração de match LoL Bo1
**Reversão:** lib/agents-extended.js — mudar `sentAgeMin > 90` pra valor maior
**Status:** ⚠️ provisório (revisar em 14d) — pode ser que matches Bo3+ ou tennis grand slam violem assumption

## 2026-04-17 — Bankroll DM mostra inicial+atual+pico
**Motivo:** DM "Banca total: R$916.06" sem referencial inicial impedia avaliar performance.
**Antes:** `Banca total: R$X (DD Y%)`
**Agora:** `Inicial: R$900 → Atual: R$916.06 (+R$16 | +1.78%) | Pico: R$937 | DD: 2.25%`
**Reversão:** bot.js `runBankrollGuardianCycle` — voltar template antigo
**Status:** ✅ aplicado

## 2026-04-17 — Auto-Shadow CLV-based + Bankroll Guardian DD-based
**Motivo:** sem proteção, sport com edge negativo persistente continua emitindo tips até admin notar manualmente. Bankroll pode crashar.
**Comportamento:**
  - Auto-Shadow CLV: cron 6h, CLV<-1% em n≥30 → flippa shadowMode=true, restore se CLV recuperar ≥0
  - Bankroll Guardian: cron 1h, DD≥10% alerta, ≥15% auto-shadow temp 1h, ≥25% (não implementado) bloquearia
**Toggle:** `AUTO_SHADOW_NEGATIVE_CLV=true`
**Reversão:** `AUTO_SHADOW_NEGATIVE_CLV=false`
**Status:** 🧪 experimental — confirmado rodando, 0 flips até agora (sport com n≥30 é só tennis com CLV +0.39%)

## 2026-04-17 — News Monitor (RSS scan)
**Motivo:** roster changes / lesões / cancelamentos são edge real. Casas de aposta levam 5-30min pra precificar. Janela de oportunidade existe.
**Antes:** apenas Google News rasoidiomático no prompt da IA durante análise
**Agora:** cron 15min varre 7 RSS sources (HLTV, Sherdog, MMA Fighting, Tennis.com, Google News esports/dota/vct), filtra por keywords críticas, cruza com tips pendentes, DM se afetar
**Toggle:** sem toggle ainda — sempre roda
**Status:** 🧪 experimental — esperado 70% falso positivo, 5-10% acerto útil. Avaliar em 30d.

## 2026-04-17 — Push handling correto no /roi
**Motivo:** push (refund) era contado como `-stake` em profit_reais, corrompia ROI agregado.
**Antes:** `profit = result === 'win' ? stake*(odds-1) : -stake;` (push virava -stake)
**Agora:** `profit = result === 'push' ? 0 : (result === 'win' ? stake*(odds-1) : -stake);`
Brier também exclui push.
**Status:** ✅ aplicado

## 2026-04-17 — Índices SQL adicionados
**Motivo:** `/roi` query escaneava table inteira. Em DB com 10k+ tips, 800ms.
**Antes:** índices: `tips(sport, result)`, `tips(match_id)`
**Agora:** + `tips(sport, result, settled_at)`, `tips(match_id, sport)`, `tips(sport, sent_at)`
**Status:** ✅ aplicado

---

# DECISÕES PROVISÓRIAS / EM CONSTRUÇÃO

Itens que precisam revisão em janela específica:

| Item | Provisório até | Revisar | Motivo |
|---|---|---|---|
| Pre-Match cutoff 90min | 2026-05-01 | Pode falhar pra Bo3+ longos ou tennis Slam | Validar com tipos de match longos no log |
| Auto-Healer (12 fixes) | 2026-05-15 | Tem fix que nunca dispara? Algum gera ruído? | Audit: fixes aplicados / falsos positivos / problemas reais que escaparam |
| News Monitor | 2026-05-15 | Acerto útil >5%? Spam ratio aceitável? | Manualmente classificar 30 alerts: úteis vs ruído |
| Auto-Shadow CLV cutoff -1% | 2026-05-15 | Cutoff certo? Recovery 0% sufficient? | Ver quantos sports flipparam, % falso positivo |
| Sharp divergence caps por sport | 2026-05-15 | Caps muito frouxos/apertados? | Backtest com caps diferentes |
| LoL tier 2-3 EV cap 25% | 2026-05-30 | ROI tier 2-3 melhorou? | Comparar /roi-matrix antes/depois |
| Bankroll Guardian thresholds 10/15/25% | 2026-05-30 | DD threshold certos? | Sem dados ainda — sistema novo |
| Tier classification regex (todos sports) | Continuamente | Novas ligas surgem | Adicionar regex quando appears |
| Workflow `daily_health` cron 8h BRT | 2026-05-15 | Horário OK? Daily report útil? | User feedback |
| `STEAM_WEBAPI_KEY` setada | Já confirmado | — | Steam RT firing confirmado |

---

# DECISÕES PENDENTES (não implementadas, mas debatidas)

| Item | Status | Próxima ação |
|---|---|---|
| Tipster Aggregator agent | ❌ rejeitado | Não vale (95% scams, confirmation bias) |
| Backtest expandido com gates atuais | 📋 backlog | Melhorar `scripts/backtest.js` pra simular gates novos |
| Cost tracking dashboard | 📋 implementando | Endpoint `/cost-summary` + card |
| Comando admin `/banca esports 50` | 📋 backlog | Esperar dados pra decidir se faz sentido |
| Live Storm Manager (priorização real) | 📋 backlog | Hoje só detecta + sugere; não age |
| Refatorar pollMma pra scheduler independente | 📋 backlog | Mutex stuck por MMA é causa #1 de poll silent |
| /agents/health-sentinel mostrar history (charts) | 📋 backlog | Hoje só snapshot |
| Tip emergency: incluir line move histórico | 📋 backlog | Pra tip ativa, mostrar gráfico de odds desde envio |

---

# REGRA DE ATUALIZAÇÃO

**Toda mudança de comportamento de negócio (gates, thresholds, cooldowns, novas regras) deve adicionar entrada aqui antes do commit.**

Mudanças puramente operacionais (refactor, bug fix de UI) podem ficar só no commit message.
