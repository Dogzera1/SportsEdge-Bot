import os
import structlog
from curl_cffi import requests

logger = structlog.get_logger(__name__)

DEFAULT_IMPERSONATE = "chrome131"
DEFAULT_TIMEOUT = 12

def _build_proxies():
    proxy = os.environ.get("SOFASCORE_PROXY_URL", "").strip()
    if not proxy:
        return None
    return {"http": proxy, "https": proxy}

class SofascoreClient:
    """A client to interact with the Sofascore API using WAF bypass."""

    BASE_URL = "https://api.sofascore.com/api/v1"

    def __init__(self):
        impersonate = os.environ.get("SOFASCORE_IMPERSONATE", DEFAULT_IMPERSONATE).strip() or DEFAULT_IMPERSONATE
        try:
            timeout = int(os.environ.get("SOFASCORE_TIMEOUT", DEFAULT_TIMEOUT))
        except (TypeError, ValueError):
            timeout = DEFAULT_TIMEOUT
        self._timeout = timeout
        self._proxies = _build_proxies()
        self.session = requests.Session(
            impersonate=impersonate,
            headers={
                "Origin": "https://www.sofascore.com",
                "Referer": "https://www.sofascore.com/",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "en-US,en;q=0.9",
            }
        )

    def _get(self, url: str):
        kwargs = {"timeout": self._timeout}
        if self._proxies:
            kwargs["proxies"] = self._proxies
        response = self.session.get(url, **kwargs)
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
