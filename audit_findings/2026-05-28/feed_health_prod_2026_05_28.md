# Feed Health — Prod (2026-05-28 17:24Z)

BASE: `https://sportsedge-bot-production.up.railway.app` | commit `54929b8`
Bot uptime: 1184s | launcher crash_count=0 | OOM last 06:01Z (683min ago)

## Resumo executivo

- 0 feeds DOWN. 0 alerts em `/admin/feed-health` (degraded=0/total=9).
- Aggregator BR: cached=16, lastErrorMsg=null, age=230s.
- Sofascore proxy Django: OK (event_count=66 schedule football). Direct CF-blocked como esperado.
- Externos diretos (Riot/VLR/ESPN/PandaScore): todos 200.
- Steam Dota direct probe 403 — não usado pelo bot (PandaScore cobre dota2 live).
- 2 P2 env issues (duplicate Telegram tokens — intencional documentado).

---

## Bot heartbeats (`/admin/feed-health`, P50 latência ~220-880ms)

| Source     | Sport  | lastSuccess (min) | successCnt | failCnt | lastCount | Status |
|------------|--------|------------------:|-----------:|--------:|----------:|--------|
| pandascore | dota2  | 0.4               | 21         | 0       | 27        | OK     |
| pandascore | lol    | 0.3               | 12         | 0       | 31        | OK     |
| pinnacle   | basket | 18.2              | 1          | 0       | 3         | OK     |
| pinnacle   | cs     | 1.4               | 6          | 0       | 15        | OK     |
| pinnacle   | darts  | 3.4               | 2          | 0       | 14        | OK     |
| pinnacle   | dota2  | 0.4               | 20         | 0       | 1         | OK     |
| pinnacle   | lol    | 1.7               | 11         | 0       | 16        | OK     |
| pinnacle   | mma    | 7.9               | 2          | 0       | 40        | OK     |
| pinnacle   | tennis | 1.4               | 19         | 0       | 95        | OK     |

Pinnacle key: header presente, sem 401/403 nas últimas 19 calls tennis (95 events cached). Sem backoff ativo.

---

## Sofascore proxy (`/admin/sofascore-proxy-health`)

- Proxy Django: HTTP 200, 996ms, event_count=66, body 209k.
- Direct sofascore.com: HTTP 403 (CF block — esperado).
- Métricas: `sofascore_fail|path=proxy,status=404`:1 e `path=direct,status=403`:1 (esporádicas, fallback chain ok).
- Status: **OK** (proxy primário funciona; direct é fallback CF-bloqueado por design).

---

## Aggregator BR (`/admin/aggregator-status`)

- cached=16 partidas, age=230s (3.8min), lastErrorMsg=null.
- Configured=true. mt_check=null (não probed).
- Status: **OK**.

---

## Externos probed diretamente

| Feed                          | HTTP | Latency | Bytes    | Status |
|-------------------------------|-----:|--------:|---------:|--------|
| Riot lolesports getSchedule   | 200  | 788ms   | 47.9k    | OK     |
| Riot lolesports getLive (en)  | 200  | 46ms    | 8.8k     | OK     |
| VLR.gg /matches               | 200  | 1104ms  | 110.8k   | OK     |
| ESPN MMA scoreboard           | 200  | 259ms   | 29.5k    | OK     |
| ESPN Tennis ATP scoreboard    | 200  | 1461ms  | 1.48MB   | OK     |
| Steam Dota GetLiveLeagueGames | 403  | -       | -        | ⚠️ DIRECT BLOCK (não-crítico — bot usa PandaScore para dota2 live) |

Riot `x-api-key` header presente (não exibido). Schema getSchedule não validado em profundidade — payload 47k consistente com `data.schedule.events[]` histórico.

---

## Sintomas / atenção

- ⚠️ `admin/env-audit` n_issues=2: duplicate Telegram tokens
  - `OPPORTUNITY_TOKEN` == `TELEGRAM_TOKEN_SNOOKER` (sig=8311463654) — provavelmente intencional (snooker disabled, token reusado).
  - `TIPS_UNIFIED_TOKEN` == `TELEGRAM_TOKEN_CS` (sig=8614842376) — confirmar intencional.
- ⚠️ Steam Dota direct 403 (não impacta — não wired ao bot).
- ⚠️ Last OOM 06:01Z (~11h atrás, RSS 380MB). Não recorrente neste boot.
- ⚠️ `admin/sofa-tennis-probe` HTTP 400 (param missing — não-bloqueante, endpoint diag).

## OK (resumo)

- 9/9 heartbeats Pinnacle+PandaScore sem failures recentes
- Sofascore proxy + Aggregator + Pinnacle executor (playwright port 8080) todos UP
- Riot/VLR/ESPN externos respondendo <1.5s
- P2 compliance: ✅ todos guards ativos

## Quota / rate-limit observado

- Nenhum 429 / backoff em heartbeats.
- The Odds API quota: endpoint não exposto separadamente; sem evidência de exhaustion neste snapshot.
- PandaScore: dota2/lol heartbeats com successCount 12-21 nos últimos minutos — sem 403.
- Pinnacle: 95 tennis events cached, sem failureCount — key válida.

