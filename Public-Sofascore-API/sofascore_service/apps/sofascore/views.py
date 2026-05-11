import structlog
from curl_cffi.requests.exceptions import HTTPError
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework.exceptions import NotFound, APIException

from clients.sofascore_client import SofascoreClient

logger = structlog.get_logger(__name__)


class UpstreamError(APIException):
    """Preserve real upstream status (403/451/5xx) instead of masking as 404."""
    status_code = 502
    default_detail = "Sofascore upstream error"
    default_code = "upstream_error"

    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        super().__init__(detail=detail)


def _handle(view_label: str, fn, **log_ctx):
    try:
        return Response(fn().json())
    except HTTPError as e:
        upstream_status = getattr(getattr(e, "response", None), "status_code", None)
        logger.warning(
            f"sofascore_{view_label}_upstream_error",
            upstream_status=upstream_status,
            error=str(e),
            **log_ctx,
        )
        if upstream_status == 404:
            raise NotFound(f"{view_label}: not found upstream") from e
        raise UpstreamError(
            upstream_status or 502,
            f"{view_label}: upstream returned {upstream_status or 'error'}",
        ) from e
    except Exception as e:
        logger.error(f"sofascore_{view_label}_fetch_error", error=str(e), **log_ctx)
        raise UpstreamError(502, f"{view_label}: client error") from e


class SofascoreEventView(APIView):
    def get(self, request, event_id: str, *args, **kwargs):
        with SofascoreClient() as client:
            return _handle("event", lambda: client.get_event_details(event_id), event_id=event_id)


class SofascoreTeamView(APIView):
    def get(self, request, team_id: str, *args, **kwargs):
        with SofascoreClient() as client:
            return _handle("team", lambda: client.get_team(team_id), team_id=team_id)


class SofascoreScheduleView(APIView):
    def get(self, request, sport: str, date: str, *args, **kwargs):
        with SofascoreClient() as client:
            return _handle("schedule", lambda: client.get_scheduled_events(sport, date), sport=sport, date=date)


class SofascoreEventH2HView(APIView):
    def get(self, request, event_id: str, *args, **kwargs):
        with SofascoreClient() as client:
            return _handle("h2h", lambda: client.get_event_h2h(event_id), event_id=event_id)


class SofascoreTeamLastEventsView(APIView):
    def get(self, request, team_id: str, page: str = "0", *args, **kwargs):
        with SofascoreClient() as client:
            return _handle("team_last_events", lambda: client.get_team_last_events(team_id, page), team_id=team_id, page=page)


class SofascoreLiveEventsView(APIView):
    def get(self, request, sport: str, *args, **kwargs):
        with SofascoreClient() as client:
            return _handle("live", lambda: client.get_live_events(sport), sport=sport)


class SofascoreEventOddsView(APIView):
    def get(self, request, event_id: str, *args, **kwargs):
        with SofascoreClient() as client:
            return _handle("odds", lambda: client.get_event_odds(event_id), event_id=event_id)


class SofascoreEventStatisticsView(APIView):
    def get(self, request, event_id: str, *args, **kwargs):
        with SofascoreClient() as client:
            return _handle("statistics", lambda: client.get_event_statistics(event_id), event_id=event_id)
