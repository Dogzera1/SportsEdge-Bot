# CONTEXTO COMPARTILHADO — Auditoria completa 2026-05-28

> Você é um agente de auditoria. **Investigue e REPORTE — NÃO edite código, NÃO aplique fixes, NÃO rode endpoints POST que mudem estado.** Mudanças financeiras/schema exigem pre-flight + confirmação do humano (CLAUDE.md). Seu trabalho: achar bugs/leaks/melhorias e propor fix (sem aplicar).

## Objetivo da sessão
User pediu: "auditoria completa procurando falhas/bugs/leaks **+ melhorias** para transformar o sistema de leaks em lucrativo". Foque em **impacto financeiro real**. Não invente requisitos. Granularidade primeiro (P1).

## Sistema
Bot de apostas multi-sport (SportsEdge-Bot). Node.js. `bot.js` (26k linhas) + `server.js` (32k) + `lib/*.js` (148 libs). SQLite better-sqlite3. Deploy Railway (512MB RAM cap). Sports: lol, cs, dota2, valorant, tennis, football, basket, mma, darts, snooker, tabletennis.

## Prod
- URL: `https://sportsedge-bot-production.up.railway.app`
- Admin key (query `?key=` ou header `x-admin-key`): `14725836`
- Commit deployed: `fb9f42e`
- **IMPORTANTE — acesso HTTP:** Node `fetch()` FALHA neste ambiente Windows (undici/TLS). Use **PowerShell** `Invoke-WebRequest -Uri <url> -Headers @{'x-admin-key'='14725836'} -UseBasicParsing -TimeoutSec 50` OU `curl.exe -s`. NUNCA `node -e "fetch(...)"`.

## Baseline já coletada (JSONs em `.tmp_audit/baseline_2026_05_28/`)
Arquivos disponíveis (leia com node/Read, NÃO re-baixe): `health.json p2_status.json risk_metrics.json env_audit.json cron_status.json overfeaturing.json holdout.json disable_list.json sportdetail_<sport>.json byleague_<sport>.json byev_<sport>.json analytics_<sport>.json readiness_real.json readiness_shadow.json`

## Estado atual (resumo)
- **app=degraded**; `bot_boot_count_24h=20` (20 reboots/24h!); `db_size_mb=387.9` (local é 145MB — cresceu 2.6x; Railway 512MB cap → suspeita memory pressure/OOM); `lastAnalysis=null`.
- **ROI real 30d** (tips is_shadow=0, settled): overall **+0.99%** (R$1.70 / R$172.5 stake, quase breakeven).
  - tennis **+10.3%** (n=141) — EDGE, carrega o sistema
  - cs **+7.4%** (n=27) — edge leve
  - dota2 +5.3% (n=9, small), valorant **+1.3% mas Sharpe -0.23** (n=11 — 1 outlier mascara leak), football +39.5% (n=4 small)
  - basket **-53%** (n=3 small), **lol -28.4%** (n=21) — LEAK
  - mma/darts/snooker/tt: n=0 settled real
- **shadow stuck 24h**: tennis 63, mma 35, football 17, cs 13, dota2 8 (~140 tips shadow sem settle há +24h)
- crons: 100 total, error_count=0, 2 stale (mt_calib_validation 74min, bot:basket poll) — benignos
- auto-leak-guards dormant (auto_roi_leak/auto_clv_leak/auto_bucket = 0 triggers 30d)
- disable-list: 10 entries (basket/cs/dota2 total/over manual; lol TOTAL/under manual; lol loss_streak)
- P2 compliance ✅, frozen_holdout=60d ✅, env-audit 2 issues (duplicate tokens, provável intencional)
- DB local `sportsedge.db` está STALE (21/05) — para ROI atual use endpoints, não o sqlite local.

## Princípios do projeto (CLAUDE.md) — respeite
- **P1 Granularidade**: nunca trate sport como bloco. Breakdown por tier/league/market/side/odd-bucket/confidence/Bo3-Bo5. ROI overall esconde leak tier.
- **P2 Shadow=causa, Real=sintoma**: shadow tips (is_shadow=1) são research-only → alimentam calib/refit/report, NUNCA disparam block/disable/cap em real. Sintoma só trata com real (is_shadow=0 AND archived=0).
- **P3 Anti-overfeaturing**: grep antes de propor feature nova; 1.039 envs + 84 crons já existem.
- **P4 Otimização contínua**: reporte dead code, queries lentas, helpers redundantes, envs mortas.
- **P5 Cross-sport**: bug num sport → cheque se os outros compartilham (libs/envs/crons genéricos propagam).
- Limites SAGRADOS (não sugira alterar sem flag): MAX_KELLY_FRAC=0.10, KELLY_AUTO_TUNE_CEILING=1.50, MT_MIN_ODD=1.40, MT_EV_CAP_PCT=50.

## Output esperado
Salve seus findings em `audit_findings/2026-05-28/<SEU_DOMINIO>.md` (crie o arquivo). Formato por finding:
```
### [SEV: P0|P1|P2|MELHORIA] <título curto>
- **Onde**: arquivo:linha (ou endpoint/tabela)
- **Evidência**: <dado concreto: query result, código citado, número de ROI>
- **Impacto financeiro**: <quanto custa em ROI/risco, ou edge não capturado>
- **Causa raiz**: <por quê>
- **Fix proposto**: <o que fazer — NÃO aplique>
- **Cross-sport**: <afeta outros sports? quais?>
```
Priorize por impacto financeiro. P0=sangra dinheiro agora / risco financeiro grave. P1=leak confirmado ou bug sério. P2=menor. MELHORIA=edge não explorado / otimização.
No FINAL do seu relatório de retorno (a mensagem que me devolve), liste os TOP 5 findings em 1 linha cada com severidade, para eu priorizar a síntese.
