---
description: Audita compliance P1 — toda decisão considera granularidade (sport/tier/league/market/side/bucket)
---

Princípio P1: ROI overall esconde leaks tier-specific (caso tennis ATP Challenger 2026-05-07: shadow ROI -2.3% overall mas Challenger sozinho -12.6%). Toda análise/decisão deve quebrar por granularidade.

Auditar `$1` (arquivo/path, default = diff atual) procurando análises monoblock que ignoram granularidade.

## O que procurar

**Decision monoblock:**
1. Query/lógica que agrupa só por `sport` sem `tier`, `league`, `market`, `side`, ou `bucket de odd`
2. Threshold hardcoded por sport sem hierarquia env `<SPORT>_<PARAM>_<TIER>` > `<SPORT>_<PARAM>` > default
3. Refit calib usando sample agregado sem split per-tier
4. Dashboard/admin endpoint com KPI overall sem breakdown granular disponível
5. Bucket guard sem `bucket de odd` (1.4-1.6 / 1.6-2.0 / 2.0-2.5 / 2.5-4.0 / >4.0)

**Falta tier-aware schema:**
6. Schema JSON (calib, model params) sem level `[tier]` quando aplicável (tennis Markov v2 é o padrão)
7. Env opt-in hardcoded único quando deveria ser per-tier (LOL_MOMENTUM_TIER1/TIER2/OTHER pattern)

**Sample insuficiente sem fallback:**
8. Auto-decision baseada em `n<20` por tier sem fallback pra default
9. Sem `min_n` env por componente

## Dimensões obrigatórias

Toda decisão deve considerar:
- **Sport** (lol/cs/dota/valorant/tennis/football/basket/mma/darts/snooker/tt)
- **Tier** within sport (Slam/Masters/250-500/Challenger/ITF; tier1/tier2/other; top5/UEFA/BR; etc)
- **League** (CBLOL ≠ LFL mesmo ambos tier2)
- **Market** (ML, handicap, totals, kills, etc)
- **Side** (over/under, home/away, team1/team2, draw)
- **Bucket de odd**
- **Confidence** (ALTA/MÉDIA/BAIXA)
- **Período/regime** (split 2026-04-22, regime tag)
- **Bo3 vs Bo5** quando aplicável

## Anti-patterns conhecidos (CLAUDE.md)

- ❌ "Tennis ROI -2% → bloquear tennis MT global"
- ❌ "LoL UNDER 2.5 ruim → desativar UNDER 2.5 todo"
- ❌ "Calib monolítica para todos os sports/tiers"
- ❌ Refit modelo só com sample agregado

## Patterns esperados

- ✅ Schema v2 tier-aware (`markets.X.tiers[tier].bins`)
- ✅ Env hierarchy `<SPORT>_<PARAM>_<TIER>` > `<SPORT>_<PARAM>` > default
- ✅ Endpoint admin permite filtro por tier/league/bucket
- ✅ Sample insuficiente → fallback default (não decidir)

## Status conhecido

- Tennis Markov calib v2 tier-aware ✅
- LoL/CS/Dota/Val momentum tier-aware ✅
- `/admin/shadow-tier-divergence` ✅
- MT leak guards side+tier+league ✅
- EV calibration per (sport, bucket) ✅
- ⚠️ 3 tier classifiers paralelos não unificados — flag se ver código novo que cria 4º

## Output

```
lib/foo.js:88 — auto-disable usa ROI overall lol/total sem split por tier (P1 viola; CBLOL ≠ LFL)
server.js:5500 — endpoint /admin/x retorna agregado sem param tier/league pra audit granular
```

Ordene: decisão financeira >> schema >> dashboard.
