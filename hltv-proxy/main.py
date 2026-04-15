"""
hltv-proxy — pass-through proxy para HLTV.org via curl_cffi (bypass CF TLS fingerprint).

Endpoints:
  GET /healthz          → 200 OK
  GET /<qualquer-path>  → repassa pra https://www.hltv.org/<path> e devolve HTML/JSON

Uso pelo bot:
  HLTV_PROXY_BASE=https://hltv-proxy-production.up.railway.app

  → o bot chama HLTV_PROXY_BASE + /team/123/slug
  → o proxy devolve o HTML real da hltv.org

Cache: 60s em memória pra evitar martelar HLTV em consultas repetidas.
"""
import os
import time
from collections import OrderedDict
from typing import Optional

from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.responses import PlainTextResponse
from curl_cffi import requests as cf_requests

app = FastAPI(title="HLTV Proxy")

UPSTREAM = "https://www.hltv.org"
CACHE_TTL = int(os.environ.get("CACHE_TTL_SECONDS", "60"))
CACHE_MAX = int(os.environ.get("CACHE_MAX_ENTRIES", "200"))
TIMEOUT = int(os.environ.get("UPSTREAM_TIMEOUT_SECONDS", "20"))

_cache: "OrderedDict[str, tuple[float, int, str, str]]" = OrderedDict()


def _cache_get(key: str) -> Optional[tuple[int, str, str]]:
    entry = _cache.get(key)
    if not entry:
        return None
    ts, status, body, ctype = entry
    if time.time() - ts > CACHE_TTL:
        _cache.pop(key, None)
        return None
    _cache.move_to_end(key)
    return status, body, ctype


def _cache_put(key: str, status: int, body: str, ctype: str):
    _cache[key] = (time.time(), status, body, ctype)
    _cache.move_to_end(key)
    while len(_cache) > CACHE_MAX:
        _cache.popitem(last=False)


@app.get("/healthz", response_class=PlainTextResponse)
def healthz():
    return f"ok cache={len(_cache)}"


@app.get("/{path:path}")
def proxy(path: str, request: Request):
    qs = request.url.query
    full = f"/{path}" + (f"?{qs}" if qs else "")
    cache_key = full

    cached = _cache_get(cache_key)
    if cached:
        status, body, ctype = cached
        return Response(content=body, status_code=status,
                        media_type=ctype,
                        headers={"X-Proxy-Cache": "HIT"})

    target = f"{UPSTREAM}{full}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.hltv.org/",
    }
    try:
        r = cf_requests.get(target, impersonate="chrome131", timeout=TIMEOUT, headers=headers)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"upstream error: {e}")

    body = r.text
    status = r.status_code
    ctype = r.headers.get("content-type", "text/html; charset=utf-8")

    if status == 200 and body:
        _cache_put(cache_key, status, body, ctype)

    return Response(content=body, status_code=status,
                    media_type=ctype,
                    headers={"X-Proxy-Cache": "MISS"})
