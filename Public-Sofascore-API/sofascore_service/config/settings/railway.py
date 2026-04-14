"""
Railway deployment settings — minimal overlay sobre base.py.

Diferenças vs production.py:
- Sem PostgreSQL obrigatório (SQLite basta para proxy passthrough)
- Sem Redis/Celery (não usamos tasks assíncronas no proxy)
- Sem SSL_REDIRECT hardcoded (Railway já faz terminação HTTPS no edge)
- ALLOWED_HOSTS aceita wildcard *.up.railway.app + healthcheck local

Uso: DJANGO_SETTINGS_MODULE=config.settings.railway
"""

from .base import *  # noqa: F401, F403

DEBUG = False

# SECRET_KEY obrigatório via env (Railway secret)
SECRET_KEY = env("SECRET_KEY", default="railway-change-me-via-env")  # noqa: F405

# Railway deploy domain + permite health checks locais
# env var ALLOWED_HOSTS pode sobrescrever com lista customizada
_default_hosts = [
    ".up.railway.app",      # todos os subdomínios Railway
    ".railway.app",
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
]
ALLOWED_HOSTS = env.list("ALLOWED_HOSTS", default=_default_hosts)  # noqa: F405

# HTTPS — Railway terminates SSL no edge, não redireciona manualmente
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = False  # Railway já faz
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True

# Database — SQLite é suficiente (proxy não persiste dados reais)
# Override via DATABASE_URL se quiser Postgres
DATABASES = {
    "default": env.db("DATABASE_URL", default="sqlite:///db.sqlite3"),  # noqa: F405
}

# Cache — in-memory local (sem Redis)
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
    }
}

# CORS — aberto por default para permitir chamadas do bot Node
# Restrinja via CORS_ALLOWED_ORIGINS se tiver domínio fixo
CORS_ALLOW_ALL_ORIGINS = env.bool("CORS_ALLOW_ALL_ORIGINS", default=True)  # noqa: F405
CORS_ALLOWED_ORIGINS = env.list("CORS_ALLOWED_ORIGINS", default=[])  # noqa: F405

# Static files (whitenoise já está no base MIDDLEWARE)
STATICFILES_STORAGE = "whitenoise.storage.CompressedManifestStaticFilesStorage"
