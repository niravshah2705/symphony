"""Port of services/gateway/src/routes/settings.omlx.test.js.

Drives PUT /api/settings/llm-preset for the oMLX local preset through a real
FastAPI app, asserting `/v1` host normalization and that the API key is stored
but only ever surfaced as masked has/masked fields.
"""

import copy
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ai_fleet import store
from ai_fleet.services.common import register_exception_handlers
from ai_fleet.services.gateway.routes import settings as settings_route


def _app():
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(settings_route.router, prefix="/api/settings")
    return app


@pytest.fixture
def store_double(monkeypatch):
    base = copy.deepcopy(store.DEFAULT_STORE["settings"])
    box = {
        "state": {
            **base,
            "localLlmProvider": "omlx",
            "localLlmPresetId": "omlx-gpt-oss-20b",
            "omlxHost": "http://127.0.0.1:8000",
            "omlxApiKey": "",
        }
    }
    patches = []

    def fake_get_settings():
        return box["state"]

    def fake_patch_settings(patch):
        patches.append(patch)
        box["state"] = {**box["state"], **patch}
        return box["state"]

    monkeypatch.setattr(store, "get_settings", fake_get_settings)
    monkeypatch.setattr(store, "patch_settings", fake_patch_settings)
    return box, patches


def test_omlx_preset_normalizes_v1_and_exposes_only_masked_api_key_state(store_double):
    box, patches = store_double
    client = TestClient(_app())
    api_key = "omlx-local-secret-value"
    selection = {"role": "local", "provider": "omlx", "presetId": "omlx-gpt-oss-20b"}

    saved = client.put(
        "/api/settings/llm-preset",
        json={**selection, "overrides": {"host": "http://127.0.0.1:9000/v1/", "apiKey": api_key}},
    )

    assert saved.status_code == 200
    assert patches[0]["omlxHost"] == "http://127.0.0.1:9000"
    assert patches[0]["omlxApiKey"] == api_key
    assert box["state"]["omlxHost"] == "http://127.0.0.1:9000"
    assert box["state"]["omlxApiKey"] == api_key

    saved_body = saved.json()
    assert saved_body["omlxHost"] == "http://127.0.0.1:9000"
    assert saved_body["hasOmlxApiKey"] is True
    assert saved_body["maskedOmlxApiKey"] == "omlx••••alue"
    assert "omlxApiKey" not in saved_body
    assert api_key not in json.dumps(saved_body)

    cleared = client.put(
        "/api/settings/llm-preset",
        json={**selection, "overrides": {"clearApiKey": True}},
    )

    assert cleared.status_code == 200
    assert patches[1]["omlxApiKey"] == ""
    assert box["state"]["omlxApiKey"] == ""

    cleared_body = cleared.json()
    assert cleared_body["hasOmlxApiKey"] is False
    assert cleared_body["maskedOmlxApiKey"] == ""
    assert "omlxApiKey" not in cleared_body
    assert api_key not in json.dumps(cleared_body)
