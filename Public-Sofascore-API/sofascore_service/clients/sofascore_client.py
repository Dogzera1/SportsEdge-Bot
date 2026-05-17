import os
import structlog
from curl_cffi import requests

logger = structlog.get_logger(__name__)

# 2026-05-16: bumped chrome131→chrome146. chrome131 / chrome124 ambos blocked
# (ImpersonateError em prod). Quando próximo bloqueio acontecer, bump pra mais
# novo da lista curl_cffi (chrome146 é o latest stable, depois há chrome*_android,
# safari, firefox alternatives).
DEFAULT_IMPERSONATE = "chrome146"
DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
DEFAULT_TIMEOUT = 12

# Targets válidos curl_cffi (manter alinhado com venv impersonate.py). Lista
# usada pra fallback gracioso em caso de env value typo / target removido em
# upgrade da lib. Não-exaustivo — só os comumente usados pra Sofascore bypass.
_VALID_IMPERSONATE = {
    "chrome99", "chrome100", "chrome101", "chrome104", "chrome107", "chrome110",
    "chrome116", "chrome119", "chrome120", "chrome123", "chrome124", "chrome131",
    "chrome133a", "chrome136", "chrome142", "chrome145", "chrome146",
    "chrome", "chrome_android",
    "safari153", "safari155", "safari170", "safari180", "safari184", "safari260",
    "safari", "safari_ios",
    "firefox133", "firefox135", "firefox144", "firefox147", "firefox",
}

def _build_proxies():
    proxy = os.environ.get("SOFASCORE_PROXY_URL", "").strip()
    if not proxy:
        return None
    return {"http": proxy, "https": proxy}

def _resolve_impersonate(path_category: str = None):
    # 2026-05-17 (memory project_mma_sofascore_discovery_2026_05_16): per-path
    # impersonate overrides (chrome124 football, safari260 MMA, chrome146 tennis).
    # Cloudflare WAF rules variam per path. Permite SOFASCORE_IMPERSONATE_<CATEGORY>
    # override antes do global SOFASCORE_IMPERSONATE.
    if path_category:
        env_key = f"SOFASCORE_IMPERSONATE_{path_category.upper()}"
        per_path = os.environ.get(env_key, "").strip()
        if per_path:
            if per_path in _VALID_IMPERSONATE:
                return per_path
            logger.warning(
                "sofascore_impersonate_per_path_invalid",
                env_key=env_key,
                env_value=per_path,
                fallback="global",
            )
    raw = os.environ.get("SOFASCORE_IMPERSONATE", DEFAULT_IMPERSONATE).strip() or DEFAULT_IMPERSONATE
    if raw not in _VALID_IMPERSONATE:
        logger.warning(
            "sofascore_impersonate_invalid_env",
            env_value=raw,
            fallback=DEFAULT_IMPERSONATE,
            note="SOFASCORE_IMPERSONATE value not in known valid set — using default",
        )
        return DEFAULT_IMPERSONATE
    return raw

def _category_from_url(url: str) -> str:
    # 2026-05-17: extrai categoria da URL pra match SOFASCORE_IMPERSONATE_<CAT> env.
    # Pattern URL: https://api.sofascore.com/api/v1/sport/{sport}/... OR
    #              /api/v1/sport/{sport}/scheduled-events/... OR
    #              /schedule/{sport}/{date}/ (proxy own format)
    if not url:
        return None
    lower = url.lower()
    # Order matters: mma before football (mma fights vs football)
    for cat in ("mma", "tennis", "football", "basketball", "ice-hockey", "esports"):
        if f"/sport/{cat}/" in lower or f"/schedule/{cat}/" in lower or f"/{cat}/" in lower:
            return cat
    return None

class SofascoreClient:
    """A client to interact with the Sofascore API using WAF bypass."""

    BASE_URL = "https://api.sofascore.com/api/v1"

    def __init__(self):
        # 2026-05-17: impersonate resolved lazy per request (path-aware).
        # Manté default session impersonate como fallback global pra calls
        # sem URL pattern conhecido. Per-path sessions são created on-demand
        # e cached em _sessions_by_category.
        default_impersonate = _resolve_impersonate()
        try:
            timeout = int(os.environ.get("SOFASCORE_TIMEOUT", DEFAULT_TIMEOUT))
        except (TypeError, ValueError):
            timeout = DEFAULT_TIMEOUT
        self._timeout = timeout
        self._impersonate = default_impersonate
        self._proxies = _build_proxies()
        self._sessions_by_category = {}
        # Session padrão (compat com callers que não usam _get).
        self.session = self._build_session(default_impersonate)

    def _build_session(self, impersonate: str):
        return requests.Session(
            impersonate=impersonate,
            headers={
                "Origin": "https://www.sofascore.com",
                "Referer": "https://www.sofascore.com/",
                "User-Agent": DEFAULT_UA,
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "en-US,en;q=0.9",
            }
        )

    def _get_session(self, category: str = None):
        if not category:
            return self.session
        if category not in self._sessions_by_category:
            self._sessions_by_category[category] = self._build_session(_resolve_impersonate(category))
        return self._sessions_by_category[category]

    def _get(self, url: str):
        kwargs = {"timeout": self._timeout}
        if self._proxies:
            kwargs["proxies"] = self._proxies
        category = _category_from_url(url)
        session = self._get_session(category)
        response = session.get(url, **kwargs)
        response.raise_for_status()
        return response

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        pass

    def get_scheduled_events(self, sport: str, date: str):
        return self._get(f"{self.BASE_URL}/sport/{sport}/scheduled-events/{date}")

    def get_event_details(self, event_id: str):
        return self._get(f"{self.BASE_URL}/event/{event_id}")

    def get_team(self, team_id: str):
        return self._get(f"{self.BASE_URL}/team/{team_id}")

    def get_event_h2h(self, event_id: str):
        return self._get(f"{self.BASE_URL}/event/{event_id}/h2h")

    def get_team_last_events(self, team_id: str, page: int = 0):
        return self._get(f"{self.BASE_URL}/team/{team_id}/events/last/{page}")

    def get_live_events(self, sport: str):
        return self._get(f"{self.BASE_URL}/sport/{sport}/events/live")

    def get_event_odds(self, event_id: str):
        return self._get(f"{self.BASE_URL}/event/{event_id}/odds/1/all")

    def get_event_statistics(self, event_id: str):
        return self._get(f"{self.BASE_URL}/event/{event_id}/statistics")
