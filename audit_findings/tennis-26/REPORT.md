# Tennis red audit — 2026-05-26

## Veredito

**Tennis real 1d/3d red NÃO é primariamente sample noise** — driven por 5 tips que NÃO deveriam ter fireado (3 TG UNDER + 2 HG POS home), todas em markets já listados em `mt-disable-list` desde 2026-05-21.

**P0 BUG (enforcement gap)**: runtime-disable lookup quebrado. Entries existem no DB com market camelCase (`handicapGames`/`totalGames`), mas probe normaliza pra lowercase (`handicapgames`/`totalgames`) e SQLite `=` é case-sensitive → no match.

Removidas essas 5 tips "escapadas", tennis HG-only hoje = **+21.8% ROI** (n=9, healthy).

## Evidência

### Métricas reais (`shadow-readiness?source=real`)
| Janela | n | ROI | Win% | Expected | Calib gap |
|---|---|---|---|---|---|
| 1d | 13 | **-5.94%** | 38.5% | 56.3% | **-17.85pp** |
| 3d | 29 | **-7.54%** | 41.4% | 54.3% | **-12.96pp** |
| 7d | 85 | +6.19% | 49.4% | 56.7% | -7.29pp |

Gap convergente negativo nas 3 janelas, mas teste binomial bilateral não-significativo (p=0.21~0.31).

### Breakdown granular (3d real, n=29)
| Group | n | W/L | ROI | Calib gap |
|---|---|---|---|---|
| **HG NEG_away** (underdog cobre, lado away) | 12 | 8/4 | **+37.6%** | +1.5pp |
| HG NEG_ALTA | 14 | 9/5 | +27.9% | — |
| HG NEG_home | 5 | 1/4 | -57.2% | — |
| **HG POS_home** (favorito -X.5, leak documentado) | 4 | 1/3 | -32.8% | — |
| **HG POS** (qualquer side) | 9 | 3/6 | **-22.9%** | -14.5pp |
| **HG MÉDIA** (qualquer dir) | 6 | 1/5 | **-60.3%** | -32.2pp |
| **TG UNDER** | 3 | 0/3 | **-100%** | **-55.4pp** |

### As 5 tips que não deveriam ter sido emitidas (loss confirmado)

Todas com `mt-disable-list` entry ativa desde **2026-05-21T13:55Z** (4 dias antes da emissão).

| ID | Sent (UTC) | Market | Side | Match | EV | Result |
|---|---|---|---|---|---|---|
| 4386 | 25/05 16:53 | TG | under 18.5 | Ostapenko vs Seidel (RG R1) | 23.44% | loss |
| 4390 | 25/05 17:05 | TG | under 19.5 | Urhobo vs Boulter (WTA RG R1) | 17.35% | loss |
| 4395 | 25/05 18:07 | TG | under 19.5 | Guo vs Kessler (WTA RG R1) | 15.69% | loss |
| 4399 | 25/05 18:22 | HG | home -6.5 | Osorio vs Alexandrova (WTA RG R1) | 16.40% | loss |
| 4403 | 25/05 18:33 | HG | home -7.5 | Sabalenka vs Bouzas (WTA RG R1) | 19.11% | loss |

Soma: stake=2.50u, profit=**-2.50u**. Sem essas 5, tennis real 1d ficaria positivo.

### Root cause confirmado via `/admin/mt-promote-explain`

Probe `sport=tennis&market=handicapGames&side=home`:
```
MT_RUNTIME_DISABLE: pass=true (= não bloqueia)
detail: "nenhum match (probed tennis|handicapgames|home, tennis|handicapgames)"
```

`mt-disable-list` mostra:
```
tennis  handicapGames  home  updated=2026-05-21T13:55:18Z  manual
tennis  totalGames     under updated=2026-05-21T13:55:59Z  manual
```

Probe usa lowercase `handicapgames` mas DB tem `handicapGames` (camelCase) → SQLite `WHERE market=?` case-sensitive → no match → tip emitida.

### Calib bin collapse (P1 violation)

3 TG UNDER tips emitidas com `model_p_pick = 0.5536` **IDÊNTICO** (matches diferentes).
2 HG POS_home tips com `model_p_pick = 0.4529` **IDÊNTICO**.

Calib `wta_main.formats.bo3.sides.under` tem `nBins=2 nTotal=32` (memory `tennis_calib_v3_format_split_2026_05_25` já flag bins coarse). Mesma classe de bug que LoL TOTAL bin[0] 0.3-0.65 (memory `lol_total_calib_bin_pendency_2026_05_25`) — P5 cross-sport pattern.

## Hipóteses descartadas

| Hipótese | Status |
|---|---|
| Calib v3 (Bo3/Bo5) live 25/05 18:55Z derrubou HG | **REJEITADA** — HG 1d +21.8%, todas tips problemáticas pré-18:55Z |
| Sample noise puro (n=13) | **PARCIAL** — p=0.31 individual, mas 3 janelas convergentes + tips identificáveis = signal real |
| DF model overestimates | **N/A** — totalDoubleFaults já em disable-list desde 21/05, nenhuma tip DF nos últimos 3d |
| Settle bug | **REJEITADA** — `mt-shadow-audit 2d` retornou 47 mismatches mas todos `should_be=undefined` (placeholder, não real settle bug) |

## Recomendações user-action (P2 — sem auto-fix)

### P0 — corrigir enforcement (CRÍTICO)
- Não definir env. **Investigar e corrigir o lookup runtime-disable** em `lib/mt-preflight.js` (path RUNTIME, query `FROM market_tips_runtime_state WHERE market=?` em `:114`).
- Opções:
  1. Normalizar DB: backfill `UPDATE market_tips_runtime_state SET market=lower(market)` (sem `_`)
  2. Normalizar lookup: usar `WHERE lower(market) = ?` no SQL
  3. Re-criar disables com nome em lowercase concatenado (sem `_`)
- Cross-sport (P5): verificar se mesma classe de bug afeta lol/cs/dota/val/football/basket — todos esses sports têm disables em runtime list

### P1 — calib bin collapse (defer arquitetural)
- `wta_main.formats.bo3.sides.under` nBins=2 → predições colapsando para constante. Pendente refit com `maxBinWidth=0.10` ou suavização inter-bin (mesma estratégia que LoL TOTAL pendency).
- Não bloqueia user-action curto-prazo; é trabalho de modelagem.

### P2 — monitor 17 pending tips
Tips no risk-set (já fireram, podem reforçar leak se virarem loss):
- #4470 Medvedev -2.5 (HG POS, mid line) — alto risco se POS_home enforcement broken
- #4404 Zverev -7.5 (HG POS away) — POS dir
- #4466 Carabelli vs Rublev UNDER 36.5 (TG under ATP Bo5) — TG under, enforcement should block mas...
- #4408 Khachanov vs Trungelliti +4.5 NEG_away MÉDIA — NEG_MÉDIA 3d -100%

### Observação P2-compliant
Shadow signal já fechou o caso conceitualmente (memory `tennis_hg_audit_2026_05_25` registra POS_home shadow LEAK IC95). Real evidence (5 tips fireram em market disabled) é o sintoma — causa raiz é gate-enforcement bug, não calib.

## Não tomei nenhuma ação

Conforme P2 + CLAUDE.md (dinheiro/disables = autorização explícita):
- Não adicionei envs Kelly
- Não corrigi código de enforcement
- Não modifiquei disable-list

Aguardando direção do user.
