"""Application configuration loaded from environment variables.

All secrets and environment-specific values come from the environment (never
hardcoded), per security.md. Validation happens at startup so the service fails
fast on misconfiguration.

Persistence is Google Cloud Firestore (native mode), namespaced under
`settings_service` so it shares a project's Firestore without colliding with the
org service. Auth is hybrid: the service's own local JWT plus an external OIDC
IdP validated via JWKS. Point the IdP settings at Firebase to accept the
platform's Firebase ID tokens (iss=https://securetoken.google.com/<project>,
aud=<project>).
"""
from __future__ import annotations

from functools import lru_cache

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Google's public JWKS for Firebase / Identity Platform ID tokens (RS256).
FIREBASE_JWKS_URL = (
    "https://www.googleapis.com/service_accounts/v1/jwk/"
    "securetoken@system.gserviceaccount.com"
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # Application
    app_env: str = "local"
    debug: bool = False

    # --- Firestore ---
    gcp_project_id: str = ""
    firestore_database: str = "(default)"
    firestore_namespace: str = "settings_service"

    # Local JWT — >=32 bytes recommended for HS256 (RFC 7518 3.2)
    jwt_secret: str = Field(min_length=32)
    jwt_issuer: str = "settings-service"
    jwt_audience: str = "settings-service-api"
    jwt_algorithm: str = "HS256"
    access_token_ttl_minutes: int = 15

    # --- External IdP (OIDC/OAuth2) ---
    idp_enabled: bool = False
    idp_issuer: str = ""
    idp_jwks_url: str = ""
    idp_audience: str = ""
    # Convenience: derive the Firebase issuer/jwks/audience from a project id.
    idp_firebase_project: str = ""

    # --- Item universe ---
    # Plugins are operator-configurable; harness/tools/skills are fixed catalogs
    # (see app/domain/universe.py). Comma-separated list.
    settings_plugins_catalog: str = "security,langsmith-tracing,playwright,ecc"

    # Rate limiting
    auth_rate_limit: str = "60/minute"

    @model_validator(mode="after")
    def _derive_and_validate(self) -> "Settings":
        # Firebase convenience: fill issuer/jwks/audience from the project id.
        if self.idp_enabled and self.idp_firebase_project:
            project = self.idp_firebase_project
            self.idp_issuer = self.idp_issuer or f"https://securetoken.google.com/{project}"
            self.idp_jwks_url = self.idp_jwks_url or FIREBASE_JWKS_URL
            self.idp_audience = self.idp_audience or project
        if self.idp_enabled and not (self.idp_issuer and self.idp_jwks_url and self.idp_audience):
            raise ValueError(
                "IDP_ENABLED=true requires IDP_ISSUER + IDP_JWKS_URL + IDP_AUDIENCE "
                "(or IDP_FIREBASE_PROJECT to derive them)"
            )
        return self

    def plugins_catalog(self) -> list[str]:
        """Parsed, de-duplicated plugin ids for the `plugins` settings domain."""
        seen: dict[str, None] = {}
        for raw in self.settings_plugins_catalog.split(","):
            item = raw.strip()
            if item:
                seen.setdefault(item, None)
        return list(seen.keys())


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings instance."""
    return Settings()  # type: ignore[call-arg]
