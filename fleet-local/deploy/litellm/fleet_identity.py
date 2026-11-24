"""Pure helpers for lifting fleet identity (org/project/user/session UUIDs) out
of a LiteLLM request, shared by the flexprice callback and the metadata hook.

Why this reads preserved headers instead of relying on a pre-call hook mutating
`data`: this LiteLLM version snapshots `requester_metadata` (the original body
metadata + full request headers) at ingestion, BEFORE async_pre_call_hook runs,
and builds the standard logging payload from that snapshot plus the key auth.
Mutating data["metadata"]/data["user"] in the hook therefore never reaches the
logging object. The original headers survive at:
    slp["metadata"]["requester_metadata"]["headers"]   (full, incl. baggage)
    slp["metadata"]["requester_custom_headers"]        (subset)
so identity is recovered from there. Key/team auth identity takes precedence
when present (the real fleet uses per-org/team virtual keys carrying UUIDs).
"""

from urllib.parse import unquote

# baggage member -> canonical field
_BAGGAGE_KEYS = {
    "fleet_org_id": "org",
    "fleet_project_id": "project",
    "fleet_user_id": "user",
    "gen_ai.conversation.id": "session",
}


def headers_dict(raw) -> dict:
    out = {}
    if not raw:
        return out
    items = raw.items() if isinstance(raw, dict) else raw
    for k, v in items:
        out[str(k).lower()] = v
    return out


def parse_baggage(header: str) -> dict:
    out = {}
    for member in (header or "").split(","):
        member = member.strip()
        if not member or "=" not in member:
            continue
        key, _, val = member.partition("=")
        key = key.strip()
        val = val.split(";", 1)[0].strip()  # drop baggage properties
        field = _BAGGAGE_KEYS.get(key)
        if field and val:
            try:
                out[field] = unquote(val)
            except Exception:  # noqa: BLE001
                out[field] = val
    return out


def identity_from_headers(headers: dict) -> dict:
    bag = parse_baggage(headers.get("baggage", ""))
    return {
        "org": bag.get("org") or headers.get("x-fleet-org-id") or "",
        "project": bag.get("project") or headers.get("x-fleet-project-id") or "",
        "user": bag.get("user") or headers.get("x-fleet-user-id") or "",
        "session": bag.get("session") or "",
    }


def identity_from_slp(slp: dict) -> dict:
    meta = slp.get("metadata") or {}
    rm = meta.get("requester_metadata") or {}
    headers = {}
    if isinstance(rm, dict):
        headers.update(headers_dict(rm.get("headers")))
    headers.update(headers_dict(meta.get("requester_custom_headers")))
    ident = identity_from_headers(headers)

    # Key/team auth identity wins for org/project when present; the human end-user
    # comes from baggage/headers first (the master key and team keys alike carry a
    # generic "default_user_id" that must not mask the real caller).
    org = meta.get("user_api_key_org_id") or ident["org"] or meta.get("fleet_org_id") or ""
    project = meta.get("user_api_key_team_id") or ident["project"] or meta.get("fleet_project_id") or ""
    key_user = meta.get("user_api_key_user_id") or ""
    if key_user == "default_user_id":
        key_user = ""
    user = ident["user"] or key_user or meta.get("fleet_user_id") or ""
    if not user:
        slp_user = slp.get("user") or ""
        user = "" if slp_user == "default_user_id" else slp_user
    session = ident["session"] or meta.get("session_id") or ""
    return {"org": str(org), "project": str(project), "user": str(user), "session": str(session)}