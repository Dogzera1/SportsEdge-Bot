import structlog
from curl_cffi import requests

logger = structlog.get_logger(__name__)

class SofascoreClient:
    """A client to interact with the Sofascore API using WAF bypass."""
    
    BASE_URL = "https://api.sofascore.com/api/v1"

    def __init__(self):
        self.session = requests.Session(
            impersonate="chrome110",
            headers={
                "Origin": "https://www.sofascore.com",
                "Referer": "https://www.sofascore.com/",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
            }
        )

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        pass

    def get_scheduled_events(self, sport: str, date: str):
        url = f"{self.BASE_URL}/sport/{sport}/scheduled-events/{date}"
        response = self.session.get(url, timeout=10)
        response.raise_for_status()
        return response

    def get_event_details(self, event_id: str):
        url = f"{self.BASE_URL}/event/{event_id}"
        response = self.session.get(url, timeout=10)
        response.raise_for_status()
        return response

    def get_team(self, team_id: str):
        url = f"{self.BASE_URL}/team/{team_id}"
        response = self.session.get(url, timeout=10)
        response.raise_for_status()
        return response

    def get_event_h2h(self, event_id: str):
        url = f"{self.BASE_URL}/event/{event_id}/h2h"
        response = self.session.get(url, timeout=10)
        response.raise_for_status()
        return response

    def get_team_last_events(self, team_id: str, page: int = 0):
        url = f"{self.BASE_URL}/team/{team_id}/events/last/{page}"
        response = self.session.get(url, timeout=10)
        response.raise_for_status()
        return response

    def get_live_events(self, sport: str):
        url = f"{self.BASE_URL}/sport/{sport}/events/live"
        response = self.session.get(url, timeout=10)
        response.raise_for_status()
        return response

    def get_event_odds(self, event_id: str):
        url = f"{self.BASE_URL}/event/{event_id}/odds/1/all"
        response = self.session.get(url, timeout=10)
        response.raise_for_status()
        return response

    def get_event_statistics(self, event_id: str):
        url = f"{self.BASE_URL}/event/{event_id}/statistics"
        response = self.session.get(url, timeout=10)
        response.raise_for_status()
        return response
