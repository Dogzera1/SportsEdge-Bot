# Roadmap — Calibração tennis bucket-de-odd-aware (ação #8 do plano causal 2026-06-09)

## Problema (causa C2)
A calib tennis v2 é tier-aware (`markets.X.tiers[tier].bins`) mas NÃO segmenta por
bucket de odd. Evidência persistente de mis-calibração concentrada por bucket:
- HG bucket 2.0-2.5: −36,7% (audit 06-08); HG away 2.5-4.0: −23,8% n179 (edge-map 06-10)
- totalGames: ambos os sides do bucket 2.0-2.5 POSITIVOS (+17% cada, n~216) = a linha
  está sistematicamente deslocada nesse range — um shift de prob que calib por tier
  não captura (mistura buckets com vieses opostos e cancela o sinal).
- ML shadow 7d por bucket: 1.6-2.5 positivo / 1.4-1.6 e 4.0+ muito negativos —
  padrão favorito-longshot clássico (devig/overconfidence dependente de odd).

## Design proposto (v3)
1. **Schema**: `markets.<MKT>.tiers[<tier>].odd_buckets[<bucket>].bins` com buckets
   canônicos `1.4-1.6 | 1.6-2.0 | 2.0-2.5 | 2.5-4.0 | 4.0+` (mesmos do leak-guard/P1).
2. **Fallback hierárquico** (P1): célula (tier×bucket) com n<40 → cai pra tier (v2);
   tier com n<40 → global (v1). NUNCA decidir em célula rala.
3. **Refit**: estender o cron drift-triggered existente (tennis-markov-calib) — mesma
   janela/holdout (FROZEN_HOLDOUT_DAYS=60 respeitado), só muda o groupBy. Shadow data
   alimenta refit (P2-ok: calib = causa).
4. **Serving**: lookup bucket do tip odd no momento do pricing; custo O(1).
5. **Validação antes de aplicar**: A/B shadow ≥14d (v2 serving vs v3 shadow-eval) via
   `/admin/tennis-calib-meta` + Brier/RPS por célula; aplicar só se v3 não-pior global
   E melhor nos buckets-leak. Rollback = flag de versão no schema (manter v2 ao lado).
6. **Guard-rails**: env `TENNIS_CALIB_BUCKET_AWARE=true` (opt-in, default off);
   mig só se precisar persistência nova (provável NÃO — calib vive em JSON /data).

## Custos/risco
- Memória do refit: +5 buckets × tiers — bins pequenos, negligível.
- Risco real = sample splitting: 5×5 células; mitigado pelo fallback n<40.
- NÃO tocar: edge-shrink (holdout refutou), EV≥20% real (+4,4%), motor ALTA.

## Sequência
1. (pré) RAM 1GB no Railway — refits/treinos sem risco de OOM-kill.
2. Implementar schema+refit atrás da flag OFF (1 sessão, ~150 LoC em lib/tennis-markov-calib).
3. Rodar refit 1×, A/B shadow 14d, decidir por células.
Dono da decisão final de ligar: user (money-path).
