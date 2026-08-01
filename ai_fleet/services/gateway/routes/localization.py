"""Localization routes (port of services/gateway/src/routes/localization.js).

Mounted by the gateway at /api/locale. Exposes BCP-47 language suggestions
(browser hints + coarse IP geolocation, never echoing the address) and a
privacy-filtered translation passthrough.

The JS module is a ``createLocalizationRouter(options)`` factory whose only knobs
are the geolocation seams (for tests); this port inlines those defaults into a
plain module-level ``router`` and keeps the two pure helpers so they can be unit
tested without an HTTP layer.

The ``ai_fleet.agent.localization`` module is imported at top but may still be
landing; the import is guarded so this route (and its tests, which inject fakes)
load regardless.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from ai_fleet import store
from ai_fleet.services.common import json_body

try:  # The agent module lands shortly; tests inject a fake in the meantime.
    from ai_fleet.agent import localization
except Exception:  # pragma: no cover
    localization = None  # type: ignore[assignment]

router = APIRouter()


def _query_languages(value):
    """Normalize the ``languages`` query param to a list of strings."""
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str)]
    return [value] if isinstance(value, str) else []


async def suggestions_for_request(req, geolocate=None, geolocate_current=None):
    """Build the privacy-filtered GET /suggestions payload without requiring an
    HTTP request object — mirrors the JS helper of the same name.

    The address is used transiently for lookup only. ``normalize_geo_result``
    allowlists countryCode/region and prevents any provider echo (ip, lat/long)
    from reaching the browser.
    """
    geolocate = geolocate or localization.locate_ip
    geolocate_current = geolocate_current or localization.locate_current_ip

    browser_languages = localization.parse_language_hints(
        _query_languages((req.get("query") or {}).get("languages")),
        (req.get("headers") or {}).get("accept-language"),
    )
    ip = localization.request_ip(req)
    location = None
    if ip and localization.is_public_ip(ip):
        try:
            location = localization.normalize_geo_result(await geolocate(ip))
        except Exception:
            location = None
    else:
        # On localhost the browser address is loopback, so use the server's
        # public egress location. Only the allowlisted country/region are kept.
        try:
            location = localization.normalize_geo_result(await geolocate_current())
        except Exception:
            location = None
    return localization.language_suggestions(
        browser_languages=browser_languages,
        country_code=location.get("countryCode") if location else None,
        region=location.get("region") if location else None,
    )


async def translation_for_body(body, settings_provider=None, translator=None):
    """Forward only locale, texts, and server settings to the translator."""
    settings_provider = settings_provider or store.get_settings
    translator = translator or localization.translate_texts
    if body is None or not isinstance(body, dict):
        raise localization.LocalizationError("A JSON request body is required.")
    return await translator(
        {
            "locale": body.get("locale"),
            "texts": body.get("texts"),
            "settings": settings_provider(),
        }
    )


# GET /api/locale/suggestions?languages=gu-IN,en-US
@router.get("/suggestions")
async def get_suggestions(request: Request):
    host = request.client.host if request.client else None
    req = {
        "query": {"languages": request.query_params.getlist("languages")},
        "headers": {
            "accept-language": request.headers.get("accept-language"),
            "x-forwarded-for": request.headers.get("x-forwarded-for"),
        },
        "ip": host,
        "socket": {"remoteAddress": host},
    }
    return await suggestions_for_request(req)


# POST /api/locale/translate { locale: "gu-IN", texts: ["Agent", "Settings"] }
@router.post("/translate")
async def post_translate(request: Request):
    body = await json_body(request)
    return await translation_for_body(body)
