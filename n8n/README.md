# n8n External Orchestration (opt-in)

n8n NÃO substitui os 51 crons in-process do bot.js. É uma camada **externa**
pra o que precisa rodar mesmo se o bot crashar.

## O que tem

`docker-compose.n8n.yml` (na raiz) — sobe n8n com SQLite embutido, expõe :5678.

`workflows/uptime-monitor.json` — probe `/health` a cada 5min, alerta Telegram
se status≠"ok" (capturaria os 32 reboots/24h em tempo real).

## Setup

```bash
# 1) Variáveis no .env (raiz)
echo "
N8N_USER=admin
N8N_PASSWORD=troca-isso
BOT_BASE_URL=https://sportsedge-bot-production.up.railway.app
TZ=America/Sao_Paulo
" >> .env

# 2) Sobe
docker compose -f docker-compose.n8n.yml up -d

# 3) Abre http://localhost:5678 → login → Settings → Import workflow
#    Importa n8n/workflows/uptime-monitor.json
#    Activate (toggle no canto superior direito)
```

`ADMIN_KEY` e `TELEGRAM_BOT_TOKEN` / `TELEGRAM_ADMIN_CHAT_ID` já existentes no
`.env` do bot são reusados pelo container (compose-file declara eles).

## Casos de uso bons pra n8n

- **Uptime probe**: 5min → /health → alerta se degraded (já implementado)
- **Cross-channel**: espelhar Telegram alerts em Discord/Slack
- **Daily digest**: chamar /agents/roi-analyst + /agents/post-fix-monitor + /agents/health-sentinel, agregar em 1 mensagem diária
- **External healing**: se /health degraded por >10min, chamar `/admin/...` pra ação corretiva
- **Webhook receiver**: receber callback de Pinnacle/PandaScore se eles oferecerem (em vez de polling)

## Casos onde NÃO usar n8n (mantém in-process)

- Tudo que toca `autoAnalysisMutex`, `pollFns`, `db` (better-sqlite3 in-process)
- Auto-healer (precisa de refs internas do bot.js)
- Settle sweeps, polling de odds, scanners (latência baixa importa)
- Anything que precisa rodar centenas de vezes por hora

## Pra produção (Railway/etc)

n8n pode rodar como sidecar Railway service ou em VPS separado. Settings:

- `N8N_HOST=n8n.seudominio.com`
- `WEBHOOK_URL=https://n8n.seudominio.com/`
- `BOT_BASE_URL=https://sportsedge-bot-production.up.railway.app`
- Auth básica → trocar por OAuth/SSO se múltiplos usuários
- Volume `n8n_data` em disco persistente (Railway volume ou VPS bind)
