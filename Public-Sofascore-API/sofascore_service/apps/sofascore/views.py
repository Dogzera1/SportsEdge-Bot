import structlog
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework.exceptions import NotFound

from clients.sofascore_client import SofascoreClient

logger = structlog.get_logger(__name__)

class SofascoreEventView(APIView):
    def get(self, request, event_id: str, *args, **kwargs):
        try:
            with SofascoreClient() as client:
                response = client.get_event_details(event_id)
                return Response(response.json())
        except Exception as e:
            logger.error("sofascore_event_fetch_error", event_id=event_id, error=str(e))
            raise NotFound("Event not found or Sofascore API unreachable") from e

class SofascoreTeamView(APIView):
    def get(self, request, team_id: str, *args, **kwargs):
        try:
            with SofascoreClient() as client:
                response = client.get_team(team_id)
                return Response(response.json())
        except Exception as e:
            logger.error("sofascore_team_fetch_error", team_id=team_id, error=str(e))
            raise NotFound("Team not found or Sofascore API unreachable") from e

class SofascoreScheduleView(APIView):
    def get(self, request, sport: str, date: str, *args, **kwargs):
        try:
            with SofascoreClient() as client:
                response = client.get_scheduled_events(sport, date)
                return Response(response.json())
        except Exception as e:
            logger.error("sofascore_schedule_fetch_error", sport=sport, date=date, error=str(e))
            raise NotFound(f"Schedule for {sport} on {date} not found") from e

class SofascoreEventH2HView(APIView):
    def get(self, request, event_id: str, *args, **kwargs):
        try:
            with SofascoreClient() as client:
                response = client.get_event_h2h(event_id)
                return Response(response.json())
        except Exception as e:
            logger.error("sofascore_event_h2h_fetch_error", event_id=event_id, error=str(e))
            raise NotFound("H2H not found or Sofascore API unreachable") from e

class SofascoreTeamLastEventsView(APIView):
    def get(self, request, team_id: str, page: str = "0", *args, **kwargs):
        try:
            with SofascoreClient() as client:
                response = client.get_team_last_events(team_id, page)
                return Response(response.json())
        except Exception as e:
            logger.error("sofascore_team_last_events_fetch_error", team_id=team_id, page=page, error=str(e))
            raise NotFound("Team events not found or Sofascore API unreachable") from e

class SofascoreLiveEventsView(APIView):
    def get(self, request, sport: str, *args, **kwargs):
        try:
            with SofascoreClient() as client:
                response = client.get_live_events(sport)
                return Response(response.json())
        except Exception as e:
            logger.error("sofascore_live_fetch_error", sport=sport, error=str(e))
            raise NotFound(f"Live events for {sport} not found") from e

class SofascoreEventOddsView(APIView):
    def get(self, request, event_id: str, *args, **kwargs):
        try:
            with SofascoreClient() as client:
                response = client.get_event_odds(event_id)
                return Response(response.json())
        except Exception as e:
            logger.error("sofascore_odds_fetch_error", event_id=event_id, error=str(e))
            raise NotFound("Odds not found or Sofascore API unreachable") from e

class SofascoreEventStatisticsView(APIView):
    def get(self, request, event_id: str, *args, **kwargs):
        try:
            with SofascoreClient() as client:
                response = client.get_event_statistics(event_id)
                return Response(response.json())
        except Exception as e:
            logger.error("sofascore_stats_fetch_error", event_id=event_id, error=str(e))
            raise NotFound("Statistics not found or Sofascore API unreachable") from e
