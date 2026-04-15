"""
hltv-proxy — pass-through pra HLTV.org via curl_cffi (bypass CF TLS fingerprint).

Rotas:
  GET /healthz                  — status + cache size
  GET /<qualquer-path>          — pass-through HTML/JSON (cache 60s)
  GET /api/matches              — matches upcoming+live parseados (JSON)
  GET /api/scorebot/<match_id>  — snapshot N segundos do scorebot WebSocket

Uso pelo bot:
  HLTV_PROXY_BASE=https://hltv-proxy-production.up.railway.app

Cache 60s em memória p/ evitar martelar HLTV.
"""
import asyncio
import os
import re
import time
from collections import OrderedDict
from typing import Optional

from bs4 import BeautifulSoup
from curl_cffi import requests as cf_requests
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse, PlainTextResponse
import socketio

app = FastAPI(title="HLTV Proxy")

UPSTREAM = "https://www.hltv.org"
CACHE_TTL = int(os.environ.get("CACHE_TTL_SECONDS", "60"))
CACHE_MAX = int(os.environ.get("CACHE_MAX_ENTRIES", "200"))
TIMEOUT = int(os.environ.get("UPSTREAM_TIMEOUT_SECONDS", "20"))
SCOREBOT_SNAPSHOT_MAX = int(os.environ.get("SCOREBOT_SNAPSHOT_MAX_SECONDS", "20"))

_cache: "OrderedDict[str, tuple[float, int, str, str]]" = OrderedDict()

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.hltv.org/",
}


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


def _fetch_hltv(path: str, qs: str = "") -> tuple[int, str, str]:
    """Fetch síncrono via curl_cffi. Retorna (status, body, content-type)."""
    url = f"{UPSTREAM}{path}" + (f"?{qs}" if qs else "")
    r = cf_requests.get(url, impersonate="chrome124", timeout=TIMEOUT, headers=HEADERS)
    ctype = r.headers.get("content-type", "text/html; charset=utf-8")
    return r.status_code, r.text, ctype


@app.get("/healthz", response_class=PlainTextResponse)
def healthz():
    return f"ok cache={len(_cache)}"


# ──────────────────────────────────────────────────────
# /api/matches — JSON parseado de upcoming/live matches
# ──────────────────────────────────────────────────────
@app.get("/api/matches")
def api_matches():
    """
    Retorna lista estruturada dos matches upcoming+live em HLTV.
    Útil pro bot resolver team1/team2 → HLTV match_id pra depois ler scorebot.
    """
    cache_key = "__api_matches__"
    cached = _cache_get(cache_key)
    if cached:
        status, body, _ = cached
        if status == 200:
            import json
            return JSONResponse(content=json.loads(body), headers={"X-Proxy-Cache": "HIT"})

    try:
        status, html, _ = _fetch_hltv("/matches")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"upstream error: {e}")

    if status != 200 or not html:
        raise HTTPException(status_code=status or 502, detail="failed to fetch /matches")

    soup = BeautifulSoup(html, "html.parser")
    matches = []

    # HLTV layout: matches live em <div class="liveMatch">, upcoming em <div class="upcomingMatch">
    # Links com /matches/{id}/{slug}
    for a in soup.select('a.match[href^="/matches/"], a.upcomingMatch[href^="/matches/"], a.liveMatch-container[href^="/matches/"], div.liveMatch a[href^="/matches/"], div.upcomingMatch a[href^="/matches/"]'):
        href = a.get("href", "")
        m = re.match(r"^/matches/(\d+)/", href)
        if not m:
            continue
        match_id = int(m.group(1))
        # Tenta extrair times
        teams = [t.get_text(strip=True) for t in a.select(".matchTeamName, .team, .matchTeam .team")]
        teams = [t for t in teams if t and t.lower() != "tbd"][:2]
        # Horário (timestamp unix em ms) de data-unix attr
        ts_el = a.select_one("[data-unix]") or a.select_one(".matchTime")
        unix_ms = None
        if ts_el and ts_el.get("data-unix"):
            try:
                unix_ms = int(ts_el["data-unix"])
            except Exception:
                pass
        event_el = a.select_one(".matchEvent, .event-logo, .matchEventName")
        event_name = event_el.get_text(strip=True) if event_el else None
        is_live = "liveMatch" in (a.get("class") or []) or bool(a.select_one(".matchLive, .live"))
        matches.append({
            "matchId": match_id,
            "teams": teams,
            "startUnixMs": unix_ms,
            "event": event_name,
            "live": is_live,
            "url": f"{UPSTREAM}{href}",
        })

    # Fallback regex caso seletores mudem
    if not matches:
        for m in re.finditer(r'href="(/matches/(\d+)/[^"]+)"', html):
            matches.append({
                "matchId": int(m.group(2)),
                "teams": [],
                "startUnixMs": None,
                "event": None,
                "live": False,
                "url": f"{UPSTREAM}{m.group(1)}",
            })
        # dedupe
        seen = set()
        matches = [x for x in matches if not (x["matchId"] in seen or seen.add(x["matchId"]))]

    import json
    payload = json.dumps({"matches": matches, "count": len(matches)})
    _cache_put(cache_key, 200, payload, "application/json")
    return JSONResponse(content={"matches": matches, "count": len(matches)},
                        headers={"X-Proxy-Cache": "MISS"})


# ──────────────────────────────────────────────────────
# /api/scorebot/<match_id> — snapshot do WS scorebot
# ──────────────────────────────────────────────────────
def _extract_scorebot_config(html: str) -> Optional[dict]:
    """
    Extrai da página de match:
      - data-scorebot-url (pode ser "url1,url2,url3" — usamos o último)
      - list-id / match-id pra emitir readyForMatch
    """
    soup = BeautifulSoup(html, "html.parser")
    el = soup.select_one("#scoreboardElement")
    if not el:
        # fallback regex
        m = re.search(r'data-scorebot-url="([^"]+)"', html)
        if not m:
            return None
        urls = m.group(1).split(",")
        list_id_m = re.search(r'data-scorebot-list-id="(\d+)"', html)
        match_id_m = re.search(r'data-scorebot-id="(\d+)"', html)
        return {
            "urls": [u.strip() for u in urls if u.strip()],
            "listId": int(list_id_m.group(1)) if list_id_m else None,
            "matchId": int(match_id_m.group(1)) if match_id_m else None,
        }
    urls_raw = el.get("data-scorebot-url") or ""
    urls = [u.strip() for u in urls_raw.split(",") if u.strip()]
    list_id = el.get("data-scorebot-list-id")
    match_id = el.get("data-scorebot-id")
    return {
        "urls": urls,
        "listId": int(list_id) if list_id and list_id.isdigit() else None,
        "matchId": int(match_id) if match_id and match_id.isdigit() else None,
    }


async def _collect_scoreboard(ws_url: str, list_id: int, match_id: int, seconds: int) -> dict:
    """Conecta no Socket.IO scorebot, emite readyForMatch, coleta scoreboard por `seconds`."""
    sio = socketio.AsyncClient(reconnection=False, logger=False, engineio_logger=False)
    snapshot: dict = {"scoreboard": None, "log": [], "connected": False, "timedOut": False}

    @sio.event
    async def connect():
        snapshot["connected"] = True
        await sio.emit("readyForMatch", {"token": "", "listId": list_id or match_id})

    @sio.on("scoreboard")
    async def on_scoreboard(data):
        snapshot["scoreboard"] = data

    @sio.on("log")
    async def on_log(data):
        if isinstance(snapshot["log"], list):
            snapshot["log"].append(data)
            if len(snapshot["log"]) > 40:
                snapshot["log"] = snapshot["log"][-40:]

    try:
        await asyncio.wait_for(sio.connect(ws_url, transports=["websocket"]), timeout=10)
    except Exception as e:
        return {"error": f"connect failed: {e}", **snapshot}

    try:
        await asyncio.sleep(seconds)
    finally:
        try: await sio.disconnect()
        except Exception: pass

    if not snapshot["scoreboard"] and snapshot["connected"]:
        snapshot["timedOut"] = True
    return snapshot


@app.get("/api/scorebot/{match_id}")
async def api_scorebot(match_id: int, snapshot: int = 10):
    """Conecta no scorebot do match e devolve último scoreboard."""
    if snapshot < 2 or snapshot > SCOREBOT_SNAPSHOT_MAX:
        raise HTTPException(400, f"snapshot must be 2..{SCOREBOT_SNAPSHOT_MAX}s")

    # 1) Fetch página do match pra extrair WS URL + list_id
    try:
        status, html, _ = _fetch_hltv(f"/matches/{match_id}/_")
    except Exception as e:
        raise HTTPException(502, f"fetch match page failed: {e}")
    if status != 200 or not html:
        raise HTTPException(status or 502, "match page not available")

    cfg = _extract_scorebot_config(html)
    if not cfg or not cfg.get("urls"):
        return JSONResponse({"error": "scorebot config not found (match may not be live)", "matchId": match_id}, status_code=404)

    # 2) Tenta cada URL até uma conectar
    last_err = None
    for ws_url in cfg["urls"]:
        # Normaliza scheme
        if ws_url.startswith("//"):
            ws_url = "https:" + ws_url
        if not ws_url.startswith(("http://", "https://", "ws://", "wss://")):
            ws_url = "https://" + ws_url
        try:
            data = await _collect_scoreboard(
                ws_url,
                cfg.get("listId") or match_id,
                cfg.get("matchId") or match_id,
                seconds=snapshot,
            )
            if data.get("scoreboard") or data.get("connected"):
                return JSONResponse({
                    "matchId": match_id,
                    "listId": cfg.get("listId"),
                    "wsUrl": ws_url,
                    "snapshotSeconds": snapshot,
                    **data,
                })
            last_err = data.get("error")
        except Exception as e:
            last_err = str(e)

    return JSONResponse({"error": last_err or "all WS URLs failed", "urls": cfg["urls"]}, status_code=502)


# ──────────────────────────────────────────────────────
# Pass-through — QUALQUER outro path
# ──────────────────────────────────────────────────────
@app.get("/{path:path}")
def proxy(path: str, request: Request):
    if path.startswith("api/"):
        raise HTTPException(404, "unknown api route")
    qs = request.url.query
    full = f"/{path}" + (f"?{qs}" if qs else "")
    cached = _cache_get(full)
    if cached:
        status, body, ctype = cached
        return Response(content=body, status_code=status, media_type=ctype,
                        headers={"X-Proxy-Cache": "HIT"})
    try:
        status, body, ctype = _fetch_hltv(f"/{path}", qs)
    except Exception as e:
        raise HTTPException(502, f"upstream error: {e}")
    if status == 200 and body:
        _cache_put(full, status, body, ctype)
    return Response(content=body, status_code=status, media_type=ctype,
                    headers={"X-Proxy-Cache": "MISS"})
