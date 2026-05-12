---
description: Audita integrações externas (Pinnacle/Sofascore/PandaScore/ESPN/Riot/HLTV/Telegram/Supabase)
---

Bot consome 8+ fontes externas. Falha em qualquer uma sem timeout/retry/visibility = path silencioso que esconde leak.

Auditar `$1` (default = diff atual) procurando problemas em integrações.

## O que procurar

**HTTP requests:**
1. `httpGet`/`cachedHttpGet`/`fetch` sem timeout explícito (default 60s ou env)
2. `axios`/`fetch` sem retry com backoff exponencial em endpoint crítico (Pinnacle/ESPN/PandaScore live)
3. Response sem validar schema (`if (!r?.someField)`)
4. Parse JSON sem try-catch (deveria usar `safeParse(body, default)`)
5. `r.status !== 200` retornando null silencioso sem log (especialmente proxy Sofascore — vide commit 705d826)

**Rate limits & throttle:**
6. Loop sobre N items chamando API sem `Promise.all` cap OR sleep entre calls (Pinnacle Guest soft-limits @ 60/s)
7. Falta `_lastReqMs` throttle per provider (Sofascore tem `_SOFA_MIN_GAP_MS=200`)
8. Webshare proxy chamado sem cooldown em 429/402 (bandwidthlimit)

**Provider-specific:**
9. **Pinnacle Guest API**: chamada sem fallback pra Lolesports/PandaScore quando sport-specific endpoint retorna 0 (outage check)
10. **Sofascore proxy** (Django curl_cffi chrome131): sem fallback pra `SOFASCORE_DIRECT=true` E sem log de status non-200
11. **PandaScore**: bearer token via `PANDASCORE_TOKEN` env — flag se hardcoded
12. **ESPN**: sem retry em 429/503; usar `cachedHttpGet` com TTL apropriado
13. **HLTV proxy** (`hltv-proxy/`): scoreboard CS live — sem timeout = scanner CS trava
14. **Riot**: getSchedule/getLive — sem fallback PandaScore para LPL live status
15. **Sackmann tennis CSV**: GitHub 404 esperado pós-Jan/2025, fallback ESPN
16. **Telegram**: `tgRequest` sem dedup `match_id` per recipient — DM duplicado risco
17. **Supabase aggregator**: `enrichEsportsMatches`/`enrichMatches` sem timeout + retry, e cache TTL respeitado

**Anti-bot bypass (scraper repo agregador-odds):**
- Não auditar aqui — repo separado em `sa-east-1`. Use `feed-medic` agent.

**Selectors frágeis (scraping):**
18. CSS/XPath baseado em classe gerada (`._abc123`) ou `nth-child(N)` profundo
19. Selector que assume estrutura DOM exata sem fallback

**Login/sessão:**
20. Sessão de scraper sem refresh quando expira (`SESSION_EXPIRED` em log = login não foi refreshado)
21. Captcha/2FA "creative bypass" — flag pra discussão (memory cita não tentar workaround)

## Status conhecido (memory)

- ✅ Sofascore proxy chrome131+headers (fd427d8)
- ⚠️ Pinnacle Dota 0/168 markets — operacional, não bug
- ⚠️ BR-SCRAPER-OUTAGE 56% down — repo separado
- ⚠️ DOTA2 silent 72.4h — Pinnacle outage, healer cooldown protege
- ✅ Sofascore visibility full status (commit a1eef8a)

## Output

```
lib/foo.js:42 — getPinnacleDotaMatches sem fallback log quando 0 markets (silent path)
lib/x.js:88 — fetch sem timeout pra ESPN basket sync (Railway 60s default seria ok mas explícito é melhor)
```

Severity: live tip emit path >> sync cron >> dashboard endpoint.
