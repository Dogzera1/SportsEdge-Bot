"""Custom DRF exception handler.

Wraps DRF's default handler with structured logging. Without this file the
EXCEPTION_HANDLER setting in base.py:146 silently fails to import, leaving
every unhandled exception to fall through to Django's default 500 HTML page
instead of producing a proper JSON response with the correct status code
(e.g. UpstreamError's preserved upstream status).
"""

import structlog
from rest_framework.views import exception_handler

logger = structlog.get_logger(__name__)


def custom_exception_handler(exc, context):
    """Delegate to DRF default handler, then attach structured log entry.

    DRF's default handles APIException subclasses (UpstreamError, NotFound,
    PermissionDenied, etc.) and returns the proper Response. For non-API
    exceptions DRF returns None, which causes Django to render its default
    500 HTML — we log the failure for visibility but keep the same behavior.
    """
    response = exception_handler(exc, context)

    view = context.get("view")
    request = context.get("request")
    view_name = view.__class__.__name__ if view else None
    request_path = getattr(request, "path", None)

    if response is not None:
        logger.warning(
            "drf_handled_exception",
            view=view_name,
            path=request_path,
            status_code=response.status_code,
            exception_type=type(exc).__name__,
            error=str(exc),
        )
    else:
        # Non-API exception (e.g. raw Exception bubble in a view's outer scope
        # such as SofascoreClient() __init__). Without logging here these would
        # only show up as Django's `Server Error (500)` HTML — opaque to debug.
        logger.error(
            "unhandled_view_exception",
            view=view_name,
            path=request_path,
            exception_type=type(exc).__name__,
            error=str(exc),
            exc_info=True,
        )

    return response
