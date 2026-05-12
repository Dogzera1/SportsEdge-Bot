---
description: Pentest mindset — como um atacante quebraria nosso bot?
---

Pedido neutro = resposta neutra. Pedido adversarial = investigação real.

Analise `$1` (arquivo/path, default = repo inteiro com foco em path crítico: bot.js + server.js + lib/market-tip-processor + lib/market-tips-shadow + scripts/calibrate-*).

## Cenário

> Você é um pentester contratado, um ex-funcionário rancoroso, OU a casa de aposta tentando me banir / explorar / drenar o bot. Como você quebraria esse sistema?

Liste **10 ataques/cenários** rankeados por probabilidade (mais provável → menos provável). Para cada:
- **Vetor**: arquivo:linha + descrição em 1 frase
- **Impacto financeiro estimado**: range R$ ou % bankroll
- **Mitigação atual**: o que já protege (env, guard, audit) — pode ser "nenhuma"
- **Fix sugerido**: 1 frase

## Foco em surface area conhecida

**Casa hostil:**
- Latência artificial em odds → CLV falsificado, bot acha que tem edge
- Odds rapidamente revertidas pós-emit → captura close em movimento (bot acha skill, é só timing)
- Conta flagada → odds piores que mercado, bot não percebe
- Cashout / void retroativo manipulado → cobra ROI da nossa banca sem aposta perdedora real

**Provedor de dados hostil:**
- Pinnacle / Sofascore com data envenenada (placar errado por horas) → bot settla loss correto como win → emit duplica
- match_results com winner trocado → reverse all subsequent tips
- ESPN feed lag → bot emite tip em jogo já finalizado

**Concorrente / scraper:**
- Detectar nossa atividade no Pinnacle Guest API → rate limit nosso IP especifically
- Floodar nossa endpoint admin com requests pra OOM

**Insider / supply chain:**
- npm package poisoning (3 deps prod: @duckdb/node-api, better-sqlite3, dotenv)
- Comprometer Railway env (ADMIN_KEY, DEEPSEEK_KEY) via dashboard
- Pull request malicioso adicionando env opt-out que default false silencia leak guard
- DM admin Telegram spoofado tentando reset bankroll

**Race / state corruption:**
- Race em emit dual-cron (commit 6621e72 fixou /dota /cs /valorant — outros endpoints podem ter)
- mutex_stale entre cycles antigos + novos (commit em auto-healer)
- Restart durante settle → tip pending sem result, AUTO_VOID_STUCK void errado

**Math exploits (próprio bot):**
- Kelly cap bypass via composto: tier×trust×autotune×clv todos máximos → stake explode
- EV inflado por bug em bestOdd selection (odds API errada vs Pinnacle real)
- Tip duplicate quando match_id varia entre sources (cs2 vs csgo vs cs)
- CLV calibration tirando edge real (já temos kill switch)

**Banimento por casa BR:**
- Pattern detection: mesmo perfil aposta 50 tips/dia em mercados softs → fingerprint behavioral
- Stake fixo arredondado padrão → casa identifica bot
- DCA timing previsível em horários certinhos → fingerprint

## Output

```
1. [PROB 9/10 | R$5k-20k] match_id collision esports — cs2 vs cs vs csgo sport name (mig 098 consolidou cs2→cs em market_tips_shadow mas tips table tem orphans pré-consolidate). Bot pode duplicar emit.
   Mitigação: parcial via ML_MARKETS dedup. Fix: trigger dedup cross-sport-key.

2. [PROB 8/10 | -2% ROI sustentado] Pinnacle line move pós-emit explora CLV...
   ...
```

Para cada item top-3, sugira **teste prático** que validaria o ataque (curl, query SQL, log analysis). Não implemente — só descreva.

## Bonus prompt alternativo (post-mortem retrospective)

Se o user passar `$1 = postmortem` em vez de path:

> Imagine que esse bot rodou por 6 meses sem parar e agora apresenta um bug que custou R$50.000. Qual é o bug mais provável baseado nesse código? Liste 5 hipóteses ranqueadas por probabilidade, citando arquivo:linha específico.
