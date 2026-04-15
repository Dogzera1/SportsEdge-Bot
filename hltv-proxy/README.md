# HLTV Proxy

Proxy minimalista para `www.hltv.org` que usa `curl_cffi` (impersona Chrome) para passar pelo Cloudflare.

Deploy idêntico ao Sofascore proxy: serviço separado no Railway.

## Deploy no Railway

1. **+ New** → **Deploy from GitHub Repo** → mesmo repo `lol betting`
2. **Settings → Root Directory** → `hltv-proxy`
3. Railway detecta `railway.toml` + `Dockerfile` automaticamente
4. Build leva ~2-3 min (curl_cffi compila wheels nativos)
5. **Settings → Generate Domain** → copia URL (ex: `https://hltv-proxy-production.up.railway.app`)

### Sem env vars obrigatórias

Opcionais:
- `CACHE_TTL_SECONDS` (default `60`) — tempo de cache em memória
- `CACHE_MAX_ENTRIES` (default `200`)
- `UPSTREAM_TIMEOUT_SECONDS` (default `20`)

## Conectar ao bot principal

No service do **bot principal**:
```
HLTV_PROXY_BASE=https://hltv-proxy-production.up.railway.app
HLTV_ENRICH_CS=true
```

(Não precisa do `/api/v1/...` no fim — o proxy é pass-through direto.)

## Validar

```
curl https://hltv-proxy-production.up.railway.app/healthz
# → ok cache=0

curl -s https://hltv-proxy-production.up.railway.app/ranking/teams | head -c 200
# → HTML da página de rankings
```

Se aparecer "Just a moment..." (Cloudflare challenge), `curl_cffi` precisa de update — geralmente trocar `impersonate="chrome131"` pra versão mais nova em `main.py`.

## Por que não usar o Sofascore proxy?

O Sofascore proxy expõe rotas específicas (`/api/v1/sofascore/schedule/...`), não é pass-through. Aqui faço pass-through direto pra qualquer caminho HLTV.
