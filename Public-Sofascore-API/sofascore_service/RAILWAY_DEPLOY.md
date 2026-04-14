# Deploy Sofascore Proxy no Railway

Substitui o tunnel ngrok (`start-ngrok.bat`) por um domínio Railway permanente.

## Por que deploy separado?

O bot principal (`lol betting/server.js` + `bot.js`) já ocupa um service Railway. O proxy Sofascore é um **projeto Python/Django independente** que precisa rodar `curl_cffi` (bypass Cloudflare TLS fingerprint) — algo que não roda no Node.js do bot principal. Então vira um **segundo service** no mesmo projeto Railway.

## Arquivos novos (não-invasivos)

Criei 3 arquivos dentro de `Public-Sofascore-API/sofascore_service/` sem mexer nos existentes:

| Arquivo | Propósito |
|---|---|
| `config/settings/railway.py` | Settings minimal (SQLite, sem Redis/Celery, sem SSL_REDIRECT) |
| `Dockerfile.railway` | Single-stage, usa `$PORT`, migra DB no boot |
| `railway.toml` | Config de build/deploy + healthcheck `/healthz` |

Os arquivos originais (`Dockerfile`, `docker-compose.prod.yml`, `config/settings/production.py`) ficam intactos para outros cenários de deploy.

## Passo a passo

### 1. Criar novo service no Railway

No mesmo projeto Railway onde o bot roda:

1. `+ New` → `Deploy from GitHub Repo`
2. Selecione o repo `lol betting` (ou onde quer que este código esteja)
3. **Settings → Root Directory** → preencha: `Public-Sofascore-API/sofascore_service`
4. Railway detecta automaticamente o `railway.toml` e o `Dockerfile.railway`

### 2. Gerar SECRET_KEY

No terminal local:
```bash
python -c "import secrets; print(secrets.token_urlsafe(50))"
```
Copie o output.

### 3. Env vars no painel Railway (service do proxy)

```
SECRET_KEY=<cole o valor gerado acima>
```

**Opcionais** (use defaults na maioria dos casos):
```
# ALLOWED_HOSTS=custom-domain.com             # default aceita *.up.railway.app
# CORS_ALLOW_ALL_ORIGINS=false                # default true (permite qualquer origem)
# CORS_ALLOWED_ORIGINS=https://bot.up.railway.app  # só se CORS_ALLOW_ALL_ORIGINS=false
# DATABASE_URL=<postgres-url>                 # se quiser Postgres em vez de SQLite
```

### 4. Deploy

Railway detecta e builda automaticamente. Primeiro build ~3-4min. Após sucesso:

- Settings → Generate Domain → cria URL tipo `sofascore-proxy-production.up.railway.app`
- Copie essa URL

### 5. Conectar ao bot principal

No service do **bot principal** (não do proxy), adicione:
```
SOFASCORE_PROXY_BASE=https://sofascore-proxy-production.up.railway.app/api/v1/sofascore
```

(Substituindo pela URL real do passo 4.)

Remove (se existir) qualquer referência a ngrok:
```
# SOFASCORE_DIRECT=true   # pode remover — o proxy via Railway é superior
```

Redeploy do bot principal. Log deve mostrar agora:
```
[SOFA-DARTS] eventos: total=171 live=3 upcoming=168 → aceitos=12
[AUTO-MMA] Sofascore event 16005141: ...
```

Sem mais dependência de ngrok.

## Testar manualmente

```bash
# Health check
curl https://sofascore-proxy-production.up.railway.app/healthz

# Proxy Sofascore (darts live)
curl "https://sofascore-proxy-production.up.railway.app/api/v1/sofascore/sport/darts/live/"

# Event specific
curl "https://sofascore-proxy-production.up.railway.app/api/v1/sofascore/event/16007434/"
```

## Custo

Railway free tier inclui 500h/mês + $5 crédito. O proxy Sofascore:
- Boot: ~15s
- RAM em idle: ~80MB
- CPU: praticamente zero (só I/O)
- Tráfego: baixíssimo (só o bot principal chama)

Deve caber no free tier com folga.

## Troubleshooting

### Build falha com "requirements.txt not found"
O `Dockerfile.railway` usa `pyproject.toml`, não requirements. Confirme que o root directory do service Railway é `Public-Sofascore-API/sofascore_service`.

### 500 na primeira request
SQLite pode demorar a criar tabelas no primeiro request. Normalmente migrate roda no boot mas se der erro, acesse logs do service e verifique. `migrate --noinput` deve rodar antes do gunicorn.

### "DisallowedHost"
`railway.py` aceita `*.up.railway.app` por default. Se você usar domínio custom, adicione ao `ALLOWED_HOSTS` env var.

### curl_cffi fails (403 Sofascore)
O `curl_cffi` precisa do `libssl`/`libcrypto`. O `python:3.12-slim` já inclui. Se quebrar, mude a base image para `python:3.12` (sem -slim) — adiciona ~50MB mas tem tudo.
