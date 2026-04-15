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
UPSTREAM_1XBET = "https://1xbet.com"
CACHE_TTL = int(os.environ.get("CACHE_TTL_SECONDS", "300"))  # 5min — CF-friendly
CACHE_MAX = int(os.environ.get("CACHE_MAX_ENTRIES", "500"))
TIMEOUT = int(os.environ.get("UPSTREAM_TIMEOUT_SECONDS", "20"))
SCOREBOT_SNAPSHOT_MAX = int(os.environ.get("SCOREBOT_SNAPSHOT_MAX_SECONDS", "20"))
RETRY_BACKOFF_BASE = float(os.environ.get("RETRY_BACKOFF_BASE", "0.6"))  # segundos entre fingerprints

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


IMPERSONATE_CHAIN = ["chrome136", "chrome131", "chrome124", "safari18_0", "chrome120"]

# Sessões persistentes por fingerprint — mantêm cookies CF (cf_clearance etc).
# Quando um fingerprint resolve o CF challenge, o clearance cookie vale pras próximas requests,
# reduzindo drasticamente 403s intermitentes.
_sessions: "dict[str, object]" = {}

def _get_session(impersonate: str):
    sess = _sessions.get(impersonate)
    if sess is None:
        sess = cf_requests.Session()
        _sessions[impersonate] = sess
    return sess

# Fingerprint que conseguiu 200 mais recentemente — tentar primeiro
_last_good_impersonate: str = ""

def _ordered_chain() -> list[str]:
    if _last_good_impersonate and _last_good_impersonate in IMPERSONATE_CHAIN:
        return [_last_good_impersonate] + [x for x in IMPERSONATE_CHAIN if x != _last_good_impersonate]
    return list(IMPERSONATE_CHAIN)

def _fetch_url(url: str, extra_headers: dict | None = None) -> tuple[int, str, str]:
    """Fetch genérico via curl_cffi com sessões persistentes + rotate fingerprints."""
    global _last_good_impersonate
    last_status = 0
    last_body = ""
    last_ctype = "text/html"
    for idx, impersonate in enumerate(_ordered_chain()):
        if idx > 0:
            time.sleep(RETRY_BACKOFF_BASE * idx)
        try:
            sess = _get_session(impersonate)
            hdrs = dict(HEADERS)
            if extra_headers:
                hdrs.update(extra_headers)
            r = sess.get(url, impersonate=impersonate, timeout=TIMEOUT, headers=hdrs)
        except Exception:
            continue
        last_status = r.status_code
        last_body = r.text
        last_ctype = r.headers.get("content-type", "text/html; charset=utf-8")
        if r.status_code == 200 and last_body and "Just a moment" not in last_body:
            _last_good_impersonate = impersonate
            return last_status, last_body, last_ctype
    return last_status, last_body, last_ctype


def _fetch_hltv(path: str, qs: str = "") -> tuple[int, str, str]:
    url = f"{UPSTREAM}{path}" + (f"?{qs}" if qs else "")
    return _fetch_url(url)


@app.get("/healthz", response_class=PlainTextResponse)
def healthz():
    return (f"ok cache={len(_cache)} sessions={len(_sessions)} "
            f"last_good={_last_good_impersonate or '-'} ttl={CACHE_TTL}s")


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

    # Enriquece teams vazios extraindo do slug do URL: /matches/<id>/<t1>-vs-<t2>-<event>
    for m in matches:
        if m.get("teams") and len(m["teams"]) >= 2:
            continue
        slug_m = re.match(r"^/matches/\d+/(.+)$", m["url"].replace(UPSTREAM, ""))
        if not slug_m:
            continue
        slug = slug_m.group(1)
        # Divide no "-vs-"
        if "-vs-" not in slug:
            continue
        t1_raw, rest = slug.split("-vs-", 1)
        # Heurística: o event tem palavras em comum com m.event se já temos
        # Senão, simplificação: pega até onde aparece o tournament-like palavras chave
        # Mais robusto: normaliza team1 e caça team2 até os "delimitadores" (numbers, year)
        # Abordagem prática: split de rest por "-" e tenta várias fronteiras
        t2_raw = rest
        if m.get("event"):
            # Remove event do final
            ev_slug = re.sub(r"\s+", "-", m["event"].lower().strip())
            if ev_slug and ev_slug in rest.lower():
                idx = rest.lower().rfind(ev_slug)
                if idx > 0 and rest[idx - 1] == "-":
                    t2_raw = rest[: idx - 1]
        else:
            # Remove sufixos comuns: -iem-X, -esl-X, -major-X, -yyyy etc
            t2_raw = re.sub(r"-(iem|esl|blast|pgl|major|dreamhack|epicenter|relog|flashpoint|cct|elisa|gamers-club|eagle|eliga|master|masters|championship|series|open|invitational|finals|playoff|playoffs|cup|league|season|tour|qualifier|qualifiers|group|stage|bo1|bo3|bo5)[-a-z0-9]*$", "", rest, flags=re.I)
            # Remove ano final
            t2_raw = re.sub(r"-20\d{2}$", "", t2_raw)
        def _humanize(s):
            return re.sub(r"[-_]+", " ", s).strip().title()
        m["teams"] = [_humanize(t1_raw), _humanize(t2_raw)]

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
# /bookies/1xbet/table-tennis — odds TT 1x2 via 1xBet guest
# ──────────────────────────────────────────────────────
@app.get("/bookies/1xbet/table-tennis")
def bookie_1xbet_tt(live: int = 0, count: int = 200):
    """
    Scrape odds TT do 1xBet. Se live=1, usa LiveFeed; senão LineFeed (pre-match).
    sports=10 é Table Tennis (confirmado via GetSportsZip).
    """
    cache_key = f"__1xbet_tt_{live}_{count}__"
    cached = _cache_get(cache_key)
    if cached:
        status, body, _ = cached
        if status == 200:
            import json
            return JSONResponse(content=json.loads(body), headers={"X-Proxy-Cache": "HIT"})

    feed = "LiveFeed" if live else "LineFeed"
    url = (
        f"{UPSTREAM_1XBET}/service-api/{feed}/Get1x2_VZip"
        f"?sports=10&count={count}&lng=en&mode=4&country=76&partner=51"
        f"&getEmpty=true&noFilterBlockEvent=true"
    )
    try:
        status, body, _ = _fetch_url(url, extra_headers={
            "Referer": f"{UPSTREAM_1XBET}/en/line/table-tennis",
            "Accept": "application/json",
        })
    except Exception as e:
        raise HTTPException(502, f"upstream error: {e}")

    if status != 200:
        raise HTTPException(status or 502, f"1xbet returned {status}")

    import json
    try:
        raw = json.loads(body) if body else {}
    except Exception:
        raise HTTPException(502, "1xbet returned non-json")

    if not raw.get("Success"):
        raise HTTPException(502, f"1xbet not success: {raw.get('Error')}")

    events = raw.get("Value") or []
    out = []
    for ev in events:
        # 1xBet schema (campos principais):
        #   I = match id, L = league name, O1/O2 = team names,
        #   S = start timestamp (unix), E = odds array
        # Cada item em E tem T (tipo: 1=home, 3=away, 2=draw), C (coeficiente)
        odds1 = odds2 = None
        for o in (ev.get("E") or []):
            if o.get("T") == 1 and odds1 is None:
                odds1 = o.get("C")
            elif o.get("T") == 3 and odds2 is None:
                odds2 = o.get("C")
        if not odds1 or not odds2:
            continue
        start_iso = None
        try:
            if ev.get("S"):
                from datetime import datetime, timezone
                start_iso = datetime.fromtimestamp(ev["S"], tz=timezone.utc).isoformat()
        except Exception:
            pass
        out.append({
            "matchId": ev.get("I"),
            "team1": ev.get("O1"),
            "team2": ev.get("O2"),
            "league": ev.get("L"),
            "startTime": start_iso,
            "startUnix": ev.get("S"),
            "odds": {"t1": float(odds1), "t2": float(odds2)},
            "live": bool(live),
        })

    payload = {"matches": out, "count": len(out), "rawCount": len(events)}
    import json as _json
    _cache_put(cache_key, 200, _json.dumps(payload), "application/json")
    return JSONResponse(payload, headers={"X-Proxy-Cache": "MISS"})


# ──────────────────────────────────────────────────────
# Pass-through — QUALQUER outro path
# ──────────────────────────────────────────────────────
@app.get("/{path:path}")
def proxy(path: str, request: Request):
    if path.startswith(("api/", "bookies/")):
        raise HTTPException(404, "unknown route")
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
    is_cf_challenge = (status == 200 and len(body) < 8000 and
                       ("Just a moment" in body or "challenge-error-text" in body or "cf-browser-verification" in body))
    if status == 200 and body and not is_cf_challenge:
        _cache_put(full, status, body, ctype)
    if is_cf_challenge:
        return Response(content='{"error":"cloudflare_challenge","advice":"try again"}',
                        status_code=503, media_type="application/json")
    return Response(content=body, status_code=status, media_type=ctype,
                    headers={"X-Proxy-Cache": "MISS"})
