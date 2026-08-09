"""Application configuration loaded from environment variables.

All secrets and environment-specific values come from the environment (never
hardcoded), per security.md. Validation happens at startup so the service fails
fast on misconfiguration.

Persistence is Google Cloud Firestore (native mode). Auth is hybrid: the
service's own local JWT plus an external OIDC IdP validated via JWKS. Point the
IdP settings at Firebase to accept the platform's Firebase ID tokens
(iss=https://securetoken.google.com/<project>, aud=<project>).
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
    # GCP project that owns the Firestore database. The client also honours the
    # FIRESTORE_EMULATOR_HOST env var automatically (used by tests / local dev).
    gcp_project_id: str = ""
    firestore_database: str = "(default)"
    # Collection namespace prefix so this service can share a project's Firestore
    # with other apps without colliding. Documents live under `<prefix>/...`.
    firestore_namespace: str = "org_service"

    # Local JWT — >=32 bytes recommended for HS256 (RFC 7518 3.2)
    jwt_secret: str = Field(min_length=32)
    jwt_issuer: str = "org-service"
    jwt_audience: str = "org-service-api"
    jwt_algorithm: str = "HS256"
    access_token_ttl_minutes: int = 15
    refresh_token_ttl_days: int = 14
    email_verification_ttl_minutes: int = 60

    # --- External IdP (OIDC/OAuth2) ---
    idp_enabled: bool = False
    idp_issuer: str = ""
    idp_jwks_url: str = ""
    idp_audience: str = ""
    # Convenience: when set, derive the Firebase issuer/jwks/audience so callers
    # only need IDP_ENABLED=true + IDP_FIREBASE_PROJECT=<project>.
    idp_firebase_project: str = ""

    # Platform super-admin bootstrap
    superadmin_email: str = ""
    superadmin_password: str = ""

    # Shared front-facing gateway URL returned by the deployment resolver
    # (GET /api/v1/me/deployment) for pseudo/org-less workspaces and any org
    # without a dedicated per-tenant stack. Empty locally (same-origin); set to
    # the shared gateway's Cloud Run URL in the cloud.
    shared_gateway_url: str = ""

    # --- Per-tenant provisioning (Phase 1, OFF by default) ---
    # When true, explicitly creating an org publishes a tenant-provision request
    # (the provisioner service consumes it and stands up a dedicated stack). OFF
    # keeps every org on the shared stack — no publish, no infra.
    provisioning_enabled: bool = False
    provisioning_topic: str = "tenant-provision-requests"
    # Shared secret guarding the S2S deployment write-back
    # (PATCH /api/v1/internal/orgs/{id}/deployments). The provisioner presents it
    # as X-Internal-Token. Unset => the write-back is refused (fail closed).
    internal_api_token: str = ""

    # Rate limiting
    auth_rate_limit: str = "10/minute"

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


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings instance."""
    return Settings()  # type: ignore[call-arg]
