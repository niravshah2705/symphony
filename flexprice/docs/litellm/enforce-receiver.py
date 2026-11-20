"""Webhook receiver: FlexPrice spend alerts -> LiteLLM key budget enforcement.

Deploy next to the LiteLLM proxy (the only component that holds the master
key). Register its URL as a FlexPrice webhook destination for:

    subscription.spend.threshold_reached  (alert_settings on the org plan)

Payload (SpendAlertEvent, internal/webhook/dto/alert.go):
    {"event_type": "...", "alert_type": "...", "alert_status":
     "info"|"warning"|"in_alarm", "current_spend": "123.45",
     "threshold": "100", "triggered_at": "...",
     "subscription": {"id": "...", "customer_id": "...", ...}}

Key resolution: FlexPrice customer external_id is "litellm-org:<org_id>";
this receiver calls LiteLLM /team/list to find the org's team keys and
applies soft (max_budget) or hard (block) enforcement per policy.

Env:
    LITELLM_API_URL, LITELLM_MASTER_KEY
    FLEXPRICE_API_URL, FLEXPRICE_API_KEY        (customer lookup)
    ENFORCE_MODE = warn | soft | hard           (default soft)
    SOFT_HEADROOM_USD = extra budget granted on a warning (default 0)
    PORT (default 8090)

Standard library only, single-threaded; put behind your usual TLS/reverse
proxy in production. Every action is printed as one JSON audit line.
"""

import json
import os
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

LITELLM_API_URL = os.environ["LITELLM_API_URL"].rstrip("/")
LITELLM_MASTER_KEY = os.environ["LITELLM_MASTER_KEY"]
FLEXPRICE_API_URL = os.environ["FLEXPRICE_API_URL"].rstrip("/")
FLEXPRICE_API_KEY = os.environ["FLEXPRICE_API_KEY"]
ENFORCE_MODE = os.environ.get("ENFORCE_MODE", "soft")
SOFT_HEADROOM_USD = float(os.environ.get("SOFT_HEADROOM_USD", "0"))


def _post(url: str, payload: dict, headers: dict) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read() or b"{}")


def _litellm(path: str, payload: dict) -> dict:
    return _post(f"{LITELLM_API_URL}{path}", payload, {"Authorization": f"Bearer {LITELLM_MASTER_KEY}"})


def _fp_get(path: str) -> dict:
    req = urllib.request.Request(
        f"{FLEXPRICE_API_URL}{path}", headers={"x-api-key": FLEXPRICE_API_KEY}, method="GET"
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read() or b"{}")


def _audit(record: dict) -> None:
    print(json.dumps({"ts": __import__("time").strftime("%Y-%m-%dT%H:%M:%SZ", __import__("time").gmtime()), **record}), flush=True)


def handle(payload: dict) -> str:
    status = payload.get("alert_status")
    sub = payload.get("subscription") or {}
    customer_id = sub.get("customer_id") or payload.get("customer_id")
    if not customer_id:
        return "ignored: no customer"

    customer = _fp_get(f"/v1/customers/{customer_id}")
    external_id = (customer.get("external_id") or "").strip()
    if not external_id.startswith("litellm-org:"):
        return f"ignored: customer {customer_id} not a litellm org"
    org_id = external_id.split(":", 1)[1]

    teams = _litellm("/team/list", {"organization_ids": [org_id]})
    team_ids = [t.get("team_id") for t in teams if t.get("team_id")]
    keys_info = _litellm("/key/list", {"team_ids": team_ids}) if team_ids else {"keys": []}
    keys = [k for k in keys_info.get("keys", []) if k.get("key")]

    spend = float(payload.get("current_spend") or 0)
    budget_cap = float(payload.get("threshold") or 0) or spend

    if status == "in_alarm" and ENFORCE_MODE == "hard":
        for k in keys:
            _litellm("/key/block", {"key": k["key"]})
            _audit({"action": "block", "org": org_id, "key_alias": k.get("key_alias"), "spend": spend})
        return f"hard: blocked {len(keys)} keys for org {org_id}"

    if status in ("warning", "in_alarm") and ENFORCE_MODE in ("soft", "hard"):
        max_budget = max(budget_cap + SOFT_HEADROOM_USD - spend, 0)
        for k in keys:
            _litellm("/key/update", {"key": k["key"], "max_budget": max_budget})
            _audit({"action": "throttle", "org": org_id, "key_alias": k.get("key_alias"), "max_budget": max_budget})
        return f"soft: throttled {len(keys)} keys for org {org_id} (remaining ${max_budget:.2f})"

    _audit({"action": "notify-only", "org": org_id, "status": status, "spend": spend})
    return f"warn-only: status={status} org={org_id}"


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            result = handle(body)
            code, resp = 200, {"result": result}
        except Exception as exc:  # noqa: BLE001
            _audit({"action": "error", "detail": str(exc)})
            code, resp = 500, {"error": str(exc)}
        data = json.dumps(resp).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):  # keep stdout audit-only
        pass


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8090"))), Handler).serve_forever()
