---
description: Analisa logs Railway (paste ou path) procurando padrões anômalos
---

Logs Railway com 1000+ linhas escondem regressões silenciosas. Pede ao user pra colar (ou path) e analisa.

## Input esperado

User cola o conteúdo (ou path local tipo `~/Downloads/logs.<id>.log`). Se nada passado, peça:

> Cole o log Railway (Dashboard → service → Deployments → Logs → download) ou passe o path local.

## O que procurar

**Erros recorrentes (mesma stack >3×):**
- `[ERROR]` ou stack trace repetido
- `[WARN]` que virou rotina por horas/dias (sinal de bug ignorado)
- `Uncaught` / `UnhandledPromiseRejection`

**Padrões anômalos:**
- **Tip emit silent**: sport sem `[AUTO-X]` log por >X horas (X tipicamente 24h tier1, 72h tier3)
- **Cron stale**: `_wrapCron` log mostrando count=0 últimas N execuções
- **Pinnacle outage**: `Pinnacle Dota 2: 0 (de N esports markets...)` repetido
- **Sofascore 403/proxy fail**: já temos visibility (commit a1eef8a) — se ver `path=proxy status=X` documente
- **DB-SLOW**: lib/market-tips-shadow.js:1397 documentou benign — só flag se ver >1000ms ou em path quente novo
- **Healer thrashing**: `[AUTO-HEALER FIX poll_silent_X]` toda iteração sem mudança de estado (cooldown 30min adicionado em a1eef8a)
- **SETTLE-TENNIS stuck**: `pending=N no_match=N db_fail=N` sem progresso por horas (commit 1a6c04a deu visibility)
- **BR-SCRAPER-OUTAGE**: degradação % casas down — repo separado, operacional

**Sintomas financeiros:**
- `[ALERT]` `sport_silent_X` >24h tier1, >72h outros — bot não está pricing
- Tips com `is_shadow=0` falhando recorrente (tip emit→error path) 
- DM admin TG403 sem auto-unsub
- Bankroll drift / discrepância `current_banca` vs `profit_reais` aggregate

**Duplicação:**
- Mesma linha de log no MESMO timestamp = race condition (inflight dedup ausente; commit 6621e72 fixou /dota-matches /cs-matches /valorant-matches)
- `match_id` aparecendo 2× em logs `[AUTO-X]` separados por <1s

**Operações em degradação:**
- Latência crescente (compara primeiros 10min vs últimos 10min do log)
- `_memCritical` flag setado → defer crons
- HTTP request timeout aumentando

**Discrepâncias suspeitas (dinheiro):**
- Aposta `[AUTO-X] DM enviado` sem `[CLV] Registrado` em <12h subsequente (CLV capture failing)
- `[SETTLE]` recorrente para mesmo `match_id` (re-settle = bug)
- `profit_units` no log diferente de stake×(odd-1) ou -stake

## Padrão de output

Não dê resumo genérico. Use formato:

```
P0 (financial-affecting):
  - [LINHA N] sport_silent_lol >24h — modelo desativado ou scanner travado
  - [LINHA M] tip 1234 emitida 2× no mesmo segundo (race em /lol-matches?)

P1 (operational degraded):
  - [LINHA X] Sofa proxy status=500 path=proxy — Django service unhealthy
  - [LINHA Y] DOTA2 0 odds Pinnacle 4 ciclos consecutivos — outage upstream

P2 (info / known patterns):
  - SETTLE-TENNIS stuck=34 (mesmas 2 tips por 25min) — name mismatch ESPN, ver commit a1eef8a
```

Sempre cite linha exata. Ignore log lines repetidas como noise se já documentadas (Pinnacle Dota outage = operational).

## Casos históricos pra reconhecer

Memory tem padrões recorrentes — consulta `~/.claude/projects/.../memory/MEMORY.md` se útil.

- Tennis db_fail recorrente → name mismatch Sackmann/ESPN, vide commit a1eef8a
- Dota silent →Pinnacle outage operacional
- AGGREGATOR enriched flapping 0↔47 → resolvido em commit 705d826
- Football trained=false Brasileirão → predict league_key não bate, vide bot.js:18663 + lib/football-poisson-trained.js _TEAM_ALIASES
