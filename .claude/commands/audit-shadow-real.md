---
description: Audita compliance P2 (shadow=causa, real=sintoma) em código novo ou existente
---

Princípio P2 do CLAUDE.md: **shadow tips são research-only, NÃO podem triggar auto-disable/block/cap/throttle em real**. Real = sintoma, tratado só com `is_shadow=0` + `archived=0` evidence.

Auditar **diff atual** (ou caminho passado como `$1`) procurando violações P2.

## O que procurar

**Auto-decision lendo shadow:**
1. Query em `market_tips_shadow` SEM filter `is_shadow=0` adjacente em JOIN com `tips`
2. Cron/endpoint que decide block/disable/cap baseado em ROI/CLV/win_rate calculado de `market_tips_shadow`
3. Funções tipo `*LeakGuard*`, `*AutoDisable*`, `*KellyTune*`, `*TrustScore*` lendo shadow sem env opt-out `*_REAL_ONLY=true`
4. `lib/ev-calibration` / `lib/league-trust` / `lib/mt-auto-promote` mexendo decisão de stake real com source shadow

**Falta env hierarchy:**
5. Falta env `<COMPONENT>_REAL_ONLY=true` (default) com opt-out documentado
6. Code path real-only sem comentário citando bug histórico ou referência ao P2

**Endpoints informacionais misleading:**
7. Endpoint `/admin/*-shadow-*` que retorna shadow data sem `disclaimer: "shadow data is research-only..."` na response
8. Endpoint `/admin/*-by-league` que mistura `tips.is_shadow=0` + `market_tips_shadow` no mesmo agregado sem flag

**JOIN pattern canônico (CLAUDE.md):**

Toda auto-decision cross-sport deve usar:
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

Flag onde JOIN não bate esse padrão.

## Exceções permitidas (NÃO flagar)

- Calibration refit usando shadow (universo correto pra refit — só não pode auto-disable)
- Reports/digests humanos pra revisão (admin endpoint que mostra shadow, OK se tem disclaimer)
- A/B comparison (shadow vs shadow filtered)
- Pre-promote evaluation quando sport ainda não tem real volume (caso documentado)
- Detecção de drift de modelo gerando WARN para humano (não auto-action)

## Status conhecido (CLAUDE.md/MEMORY)

8/8 violators resolvidos em waves 1-3 (commits 2026-05-06 a 2026-05-07). Próximos achados são regressões. Cita commit hash do violator se identificar regressão.

## Output

```
lib/foo.js:42 — leakGuard agrega ev_pct de market_tips_shadow sem JOIN com tips is_shadow=0 (P2 wave 2 corrigiu pattern similar em ev-calibration commit c618bd9)
server.js:1234 — /admin/mt-shadow-by-bucket retorna shadow data sem disclaimer "research-only"
```

Ordene por: auto-decision real >> informacional misleading >> falta documentação.
