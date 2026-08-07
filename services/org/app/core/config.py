"""Application configuration loaded from environment variables.

All secrets and environment-specific values come from the environment (never
hardcoded), per security.md. Validation happens at startup so the service fails
fast on misconfiguration.
"""
from __future__ import annotations

from functools import lru_cache

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # Application
    app_env: str = "local"
    debug: bool = False

    # Database
    database_url: str = "postgresql+asyncpg://org:org@localhost:5432/orgdb"

    # Local JWT — >=32 bytes recommended for HS256 (RFC 7518 3.2)
    jwt_secret: str = Field(min_length=32)
    jwt_issuer: str = "org-service"
    jwt_audience: str = "org-service-api"
    jwt_algorithm: str = "HS256"
    access_token_ttl_minutes: int = 15
    refresh_token_ttl_days: int = 14
    email_verification_ttl_minutes: int = 60

    # External IdP (OIDC/OAuth2)
    idp_enabled: bool = False
    idp_issuer: str = ""
    idp_jwks_url: str = ""
    idp_audience: str = ""

    # Platform super-admin bootstrap
    superadmin_email: str = ""
    superadmin_password: str = ""

    # Rate limiting
    auth_rate_limit: str = "10/minute"

    @model_validator(mode="after")
    def _validate_idp(self) -> "Settings":
        if self.idp_enabled and not (self.idp_issuer and self.idp_jwks_url and self.idp_audience):
            raise ValueError(
                "IDP_ENABLED=true requires IDP_ISSUER, IDP_JWKS_URL and IDP_AUDIENCE"
            )
        return self


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings instance."""
    return Settings()  # type: ignore[call-arg]
