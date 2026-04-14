from django.urls import path

from apps.sofascore.views import (
    SofascoreEventH2HView,
    SofascoreEventView,
    SofascoreScheduleView,
    SofascoreTeamLastEventsView,
    SofascoreTeamView,
    SofascoreLiveEventsView,
    SofascoreEventOddsView,
    SofascoreEventStatisticsView,
)

app_name = "sofascore"

urlpatterns = [
    path("event/<str:event_id>/", SofascoreEventView.as_view(), name="event-detail"),
    path("event/<str:event_id>/h2h/", SofascoreEventH2HView.as_view(), name="event-h2h"),
    path("event/<str:event_id>/odds/", SofascoreEventOddsView.as_view(), name="event-odds"),
    path("event/<str:event_id>/statistics/", SofascoreEventStatisticsView.as_view(), name="event-stats"),
    path("team/<str:team_id>/", SofascoreTeamView.as_view(), name="team-detail"),
    path("team/<str:team_id>/events/last/<str:page>", SofascoreTeamLastEventsView.as_view(), name="team-last-events"),
    path("team/<str:team_id>/events/last/<str:page>/", SofascoreTeamLastEventsView.as_view(), name="team-last-events-slash"),
    path("schedule/<str:sport>/<str:date>/", SofascoreScheduleView.as_view(), name="schedule-detail"),
    path("sport/<str:sport>/live/", SofascoreLiveEventsView.as_view(), name="sport-live"),
]
