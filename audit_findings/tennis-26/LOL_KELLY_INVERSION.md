# LoL Kelly inversion — diagnóstico 2026-05-26

## Hipótese (memory)
- `KELLY_LOL_ALTA=0.2`
- `KELLY_LOL_MEDIA=0.5`
- ALTA recebe stake MENOR que MEDIA = inversion (ALTA deveria ser mais agressivo).

## Hierarquia Kelly (bot.js:6278-6315)

```
1. KELLY_<SPORT>_<MARKET>_<CONF>  (cap 0.50)
2. KELLY_<SPORT>_<CONF>           (cap 0.50)  ← onde inversion vive
3. KELLY_<CONF>                    (cap 0.50)
4. Auto-tune state
5. _KELLY_DEFAULTS = { ALTA: 0.25, MEDIA: 0.167, BAIXA: 0.10 } × _KELLY_SPORT_MULT[lol]=1.0
```

Default deveria ser ALTA=0.25 > MEDIA=0.167. Override invertido = ALTA < MEDIA.

## Evidência indireta (3 tips LoL TOTAL comparáveis)

| Tip | Sent | Conf | EV | Odd | Stake | Implied f_base × kelly_<conf>_mult |
|---|---|---|---|---|---|---|
| #4215 | 23/05 21:25 | **ALTA** | 15.98% | 1.781 | **0.5u** | 0.2046 × 0.2 = **0.041** |
| #4313 | 24/05 22:07 | MEDIA | 10.46% | 1.781 | 0.5u | 0.1296 × 0.5 = 0.065 (capped at floor) |
| #3840 | 20/05 10:06 | MEDIA | 9.68% | 1.775 | **1.0u** | 0.1249 × 0.5 = **0.062** |

ALTA com EV maior recebendo stake MENOR que MEDIA com EV menor — invertido vs default Kelly (ALTA=0.25 > MEDIA=0.167).

Se defaults estivessem ativos:
- ALTA EV 15.98%: 0.2046 × 0.25 = 0.051
- MEDIA EV 9.68%: 0.1249 × 0.167 = 0.021

Default daria ALTA > MEDIA (correto). Observado ALTA < MEDIA → confirma override invertido em prod.

## Impacto LoL real

- 7d real: n=14 ROI **-49.9%** (sport-detail)
- 30d real: n=20 ROI -44.2%
- Most losses: TOTAL UNDER maps (5 of 8 TOTAL settled) + 2/3 ML losses ALTA

**Fix do meu commit `4a33fb5`** retroativamente ativa enforcement de `lol|TOTAL|under` (estava em case mismatch UPPERCASE). TOTAL UNDER LoL não fira mais.

Restam ML losses (n=10 W=2 L=5 ROI -23.1%) — independente de Kelly inversion, sinal de leak modelo ML em geral.

## User action recomendada (Railway dashboard)

Opção A — restaurar defaults (conservador):
```
DELETE KELLY_LOL_ALTA  (volta pra 0.25 default)
DELETE KELLY_LOL_MEDIA (volta pra 0.167 default)
```

Opção B — manter cut MEDIA, restaurar ALTA:
```
KELLY_LOL_ALTA=0.25   (era 0.2)
KELLY_LOL_MEDIA=0.10  (era 0.5 — cortar mais que default)
```

Opção C — cut total LoL (dado ROI -50%):
```
LOL_SHADOW=true  (flippa LoL pra shadow-only até audit granular ML)
```

Recomendo Opção C imediato (proteção bankroll) + audit LoL ML granular antes de reativar.

## P5 cross-sport
Same hierarchy aplica a todos sports. Não há outros sports onde memory documente inversão explícita. Mas user-action: validar cross-sport via Railway dashboard.
