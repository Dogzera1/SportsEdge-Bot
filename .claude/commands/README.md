# Slash commands — auditoria recorrente

Comandos custom adaptados ao stack SportsEdge-Bot (Node + SQLite + multi-sport). Roda em segundos, sem precisar pedir auditoria genérica.

## Rotina recomendada

| Frequência | Comando | Objetivo |
|---|---|---|
| **A cada commit que toca dinheiro** | `/audit-dinheiro` | Kelly/EV/stake/bankroll bugs |
| **A cada commit cross-cutting** | `/audit-shadow-real` | P2 compliance (shadow ≠ decision real) |
| **Semanal** | `/audit-logs` (cola log Railway) | Padrões anômalos / regressões silenciosas |
| **Antes de promote sport→real** | `/audit-granularidade` | P1 — overall ROI esconde leak tier |
| **Quando mexer em fetch/Pinnacle/Sofa** | `/audit-externos` | timeout/retry/rate-limit |
| **Quando adicionar migration ou query nova** | `/audit-banco` | OLAP em hot path, Railway 512MB cap |
| **Mensal / pré-release** | `/audit-adversarial` | Pentest mindset |

## Antes do Claude — ferramentas que JÁ existem no projeto

```bash
# Validar syntax (CLAUDE.md "Comandos do projeto")
node -c bot.js && node -c server.js

# Audit já implementados (endpoints admin)
KEY="<admin_key>"
BASE="https://sportsedge-bot-production.up.railway.app"

curl -s -H "x-admin-key: $KEY" "$BASE/admin/p2-status"             # P2 compliance summary
curl -s -H "x-admin-key: $KEY" "$BASE/admin/env-audit"             # whitespace/typos/inversion gotchas
curl -s -H "x-admin-key: $KEY" "$BASE/admin/cron-status"           # cron ages + stale flags
curl -s -H "x-admin-key: $KEY" "$BASE/admin/overfeaturing-audit"   # P3 dead/dormant features
curl -s -H "x-admin-key: $KEY" "$BASE/admin/risk-metrics?days=30"  # Sharpe, Kelly efficiency, calib gap
curl -s -H "x-admin-key: $KEY" "$BASE/admin/mt-shadow-audit?sport=X&days=30&apply=0"  # settle math validation
curl -s -H "x-admin-key: $KEY" "$BASE/admin/holdout-status"        # overfitting protection
curl -s -H "x-admin-key: $KEY" "$BASE/admin/analytics?sport=X"     # variance/Brier/cohort
```

Roda esses ANTES de chamar slash command. O slash command foca em coisa que endpoint não cobre (path novo / commit recente / log inspection).

## Pre-commit hook (.githooks/)

Hook fast-gate (1-2s) versionado em `.githooks/pre-commit`. Ver `.githooks/README.md` pra ativação.

Ativação (1× por máquina):
```bash
git config core.hooksPath .githooks
```

Hard gates: syntax error, DELETE FROM tips, limite SAGRADO alterado. Soft warnings: catch silent, console.*, var, TODO/FIXME, env não-documentada. Escape: `--no-verify`.

Pra revisão profunda (AI-powered), use os slash commands acima.

## Não adicionar sem autorização

- **devDependencies novas** (eslint/knip/depcheck/jest) — `package.json` é sagrado, requer autorização explícita pelo CLAUDE.md
- **Test suite** — não existe atualmente; adicionar é decisão de produto

## Property-based testing (futuro)

Se algum dia adicionar test suite, candidate principal é `fast-check` em `lib/market-tip-processor.js`:

```js
import fc from 'fast-check';
test('EV nunca explode', () => {
  fc.assert(fc.property(
    fc.float({ min: 1.01, max: 100 }),
    fc.float({ min: 0.01, max: 0.99 }),
    (odd, prob) => {
      const ev = calcularEv(odd, prob);
      return Number.isFinite(ev);
    }
  ));
});
```

Não implementar agora — só quando estiver pronto pra ter test pipeline.

## Reconciliação (futuro)

Mais alto-ROI item da lista do user:
- Compara `tips` que o bot acha que mandou × DM Telegram que casa BR aparece
- Compara `current_banca` interno × saldo real Bet365/KTO/Betano
- Compara settle interno × resultado oficial ESPN/Sackmann

Hoje cobertura parcial:
- ✅ `tip_settlement_audit` (mig 073) loga toda mudança de result
- ✅ `/admin/mt-shadow-audit` valida settle math vs match_results
- ❌ Comparação interno×casa BR — não temos integração com histórico das casas
- ❌ Bankroll reconciliation noturna — não implementado

Implementar se decidir pôr stake real significativo.

## Diff contra estável

Tag git stable releases:

```bash
git tag -a estavel-2026-05-04 -m "1 semana rodando ok"
git push origin estavel-2026-05-04

# Quando aparecer comportamento estranho:
git diff estavel-2026-05-04 HEAD -- bot.js server.js lib/
```

Aí pede ao Claude:

> Compare o diff entre tag `estavel-2026-05-04` e HEAD. Identifique mudanças que poderiam causar [sintoma observado]. Rankeie por probabilidade.

Bug novo quase sempre é regressão. Diff é mais eficiente que auditar tudo.
