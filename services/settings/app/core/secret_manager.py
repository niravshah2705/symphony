"""Read a Google Secret Manager secret version over REST, using ADC.

The settings service must NOT pin a rotating platform credential into its
process environment: Cloud Run injects env vars only at container start, so an
hourly-rotated credential mounted that way would be served stale (and rejected
as expired) for days. For those keys we read the *latest* secret version on
demand and let the caller memoise it briefly (see
``app.services.secrets_service``).

Authentication reuses Application Default Credentials — the same ``google-auth``
library this service already depends on and uses for Cloud Run ID tokens in
``app.auth.org_context`` — so the container's own service account is used with
no new SDK. The ``google-cloud-secret-manager`` client (and its gRPC stack) is
deliberately not added for a single read; the plain REST endpoint over the
already-present ``requests`` transport is enough.
"""
from __future__ import annotations

import asyncio
import base64

from app.core.config import get_settings

_ACCESS_URL = (
    "https://secretmanager.googleapis.com/v1"
    "/projects/{project}/secrets/{secret}/versions/{version}:access"
)
# cloud-platform is the scope Secret Manager's REST API accepts for an ADC-
# authenticated service account holding secretmanager.secretAccessor.
_SCOPES = ("https://www.googleapis.com/auth/cloud-platform",)
DEFAULT_TIMEOUT_SECONDS = 5.0


class SecretManagerError(RuntimeError):
    """A Secret Manager read failed: no project, bad credentials, HTTP error or
    malformed payload. The message never carries the secret value."""


def _access_sync(
    project_id: str, secret_id: str, version: str, timeout: float
) -> str:
    # Imported lazily so the test suite (which fakes ``access_latest``) needs no
    # GCP libraries, mirroring the lazy google.cloud imports in crypto/kms.py.
    import google.auth
    from google.auth.transport.requests import AuthorizedSession

    try:
        credentials, _ = google.auth.default(scopes=_SCOPES)
    except Exception as exc:  # never surface the underlying exception text
        raise SecretManagerError(
            "could not load application default credentials"
        ) from exc

    session = AuthorizedSession(credentials)
    url = _ACCESS_URL.format(project=project_id, secret=secret_id, version=version)
    try:
        response = session.get(url, timeout=timeout)
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        # Do NOT include response text/body: it holds the secret payload.
        raise SecretManagerError("secret version access failed") from exc

    # Secret Manager returns the payload base64-encoded under payload.data.
    data = ((payload or {}).get("payload") or {}).get("data") or ""
    try:
        return base64.b64decode(data).decode("utf-8").strip()
    except Exception as exc:
        raise SecretManagerError("secret payload was not valid base64 text") from exc


async def access_latest(
    secret_id: str,
    *,
    version: str = "latest",
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> str:
    """Return the plaintext of a secret's ``latest`` version.

    Raises ``SecretManagerError`` on any failure; callers decide whether to fail
    closed or degrade. Runs the blocking requests call off the event loop.
    """
    project_id = get_settings().gcp_project_id
    if not project_id:
        raise SecretManagerError("GCP_PROJECT_ID is not configured")
    return await asyncio.to_thread(_access_sync, project_id, secret_id, version, timeout)
