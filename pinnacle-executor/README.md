# pinnacle-executor

HTTP service que recebe POST `/place-bet` do bot SportsEdge e executa apostas reais na Pinnacle.com.

## Deploy no Railway (passo a passo)

### 1. Criar service no Railway

- Dashboard → New Project (ou existing) → New Service → Deploy from GitHub repo
- Selecionar o repo `SportsEdge-Bot` + Root Directory: `pinnacle-executor`
- OU use "Empty Service" + drag/drop a pasta inteira

### 2. Generate Domain

Settings → Networking → Generate Domain. Copiar URL (ex: `https://pinnacle-executor-production.up.railway.app`).

### 3. Setar Variables (Railway dashboard, Variables tab)

**OBRIGATÓRIO:**
```
PINNACLE_EXECUTOR_TOKEN=<gerar token: openssl rand -hex 32>
PINNACLE_EXECUTOR_MODE=mock                   # 'mock' pra primeiro teste; 'playwright' depois
```

**Para Playwright (real bets):**
```
PINNACLE_EXECUTOR_MODE=playwright
PINNACLE_USERNAME=<seu Customer ID Pinnacle>
PINNACLE_PASSWORD=<sua senha — USE RAILWAY SECRETS>
PINNACLE_BASE_URL=https://www.pinnacle.com/pt/
PINNACLE_EVENT_URL_TEMPLATE=https://www.pinnacle.com/pt/event/{event_id}
PLAYWRIGHT_HEADLESS=true
```

### 4. Validar deploy

```bash
curl https://<executor>.up.railway.app/healthz
# Resposta esperada: {"ok":true,"mode":"mock","port":3001,"ts":"..."}
```

### 5. Configurar bot principal (Railway main service)

```
PINNACLE_AUTO_BET_ENABLED=true
PINNACLE_AUTO_BET_DRY=false
PINNACLE_EXECUTOR_URL=https://<executor>.up.railway.app
PINNACLE_EXECUTOR_TOKEN=<MESMO TOKEN do executor>

# Caps conservadores iniciais:
PINNACLE_MAX_STAKE_BRL=5
PINNACLE_DAILY_CAP_BRL=20
PINNACLE_DAILY_CAP_COUNT=4
PINNACLE_HOURLY_CAP_COUNT=1
PINNACLE_MIN_EV_PCT=8
PINNACLE_MAX_SLIPPAGE_PCT=1.5
```

## Testing manual (sem bot)

```bash
TOKEN=<your token>
URL=https://<executor>.up.railway.app

# Health check
curl $URL/healthz

# Mock bet (modo mock)
curl -X POST $URL/place-bet \
  -H "Content-Type: application/json" \
  -H "x-executor-token: $TOKEN" \
  -d '{
    "event_id": "12345678",
    "market_id": "ML",
    "side": "team1",
    "stake_brl": 5,
    "expected_odd": 1.85,
    "max_slippage_pct": 2,
    "sport": "lol",
    "league": "test"
  }'
# Resposta esperada (mock):
# {"ok":true,"ticket_id":"MOCK-1716308400-7521","actual_odd":1.85,"stake_brl":5,"status":"placed"}
```

## Modos de operação

| Mode | Comportamento | Risk |
|------|---------------|------|
| `mock` | Fake tickets, sempre sucesso, latency simulada 0.6-1.6s | Zero |
| `playwright` | Chromium headless, login + bet real | Médio (real $) |
| `api` | Pinnacle Public API (contractual) | Não implementado |

## Troubleshooting

### `playwright init/login: ...`
- PINNACLE_USERNAME/PASSWORD não setadas OU credenciais inválidas
- Pinnacle UI changed → ajustar selectors em `index.js` `_ensureLoggedIn`

### `slippage X% > max Y%`
- Odd mudou entre tip emit e bet placement
- Aceitar slippage maior (PINNACLE_MAX_SLIPPAGE_PCT no bot) ou reduzir latency

### `playwright bet: Timeout waiting for selector`
- Pinnacle UI changed selectors. Logar HTML response, atualizar selector em `placeBetPlaywright`
- Screenshot saved at `/tmp/pinnacle-err-<ts>.png` (download via Railway shell)

### Headless detected by Cloudflare
- Set `PLAYWRIGHT_HEADLESS=false` (visual mode, mas requer Railway X server)
- OR usar real residential proxy (PROXY_URL env adicional)

## Logs operacionais

Railway → service → Logs:
```
[INFO] [BOOT] mode=playwright port=3001 token=set(64)
[INFO] [BOOT] listening :3001
[INFO] [BET-REQ] lol/ML/team1 stake=R$5 odd=1.85 event=12345678
[INFO] [PLAYWRIGHT] reusing storageState /tmp/pinnacle-session.json
[INFO] [BET-OK] ticket=12345-67890 odd=1.86 stake=R$5
```

## Limites e cuidados

⚠️ **Pinnacle ToS**: scripted/automated betting pode violar termos → account ban risk

⚠️ **Cloudflare detection**: anti-bot pode bloquear Playwright. Mitigation incluída (`--disable-blink-features=AutomationControlled`) mas não 100%

⚠️ **Sempre teste com mock antes de playwright + caps R$5 inicial**

⚠️ **Phase 3 backlog**: reconciliation cron (Pinnacle settle → bot result), Telegram approve flow
