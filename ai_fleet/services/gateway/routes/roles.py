"""Roles routes (port of services/gateway/src/routes/roles.js).

Assume/drop a team member identity. The assumed id is validated server-side
against the real member list — a client-supplied identity is never trusted.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ai_fleet import store, linear
from ai_fleet.services.common import json_body

router = APIRouter()


def to_member(user):
    return {"id": user.get("id"), "name": user.get("displayName") or user.get("name"), "email": user.get("email")}


# GET /api/roles/members — assumable members (active org users).
@router.get("/members")
async def list_members():
    users = await linear.get_users(store.get_api_key())
    return {"members": [to_member(u) for u in users]}


# GET /api/roles/assumed — the currently assumed role.
@router.get("/assumed")
async def get_assumed():
    return {"assumedRole": store.get_assumed_role()}


# PUT /api/roles/assumed — assume a member. The id is validated server-side
# against the real member list (never trust a client-supplied identity).
@router.put("/assumed")
async def put_assumed(request: Request):
    body = await json_body(request)
    id = str(body["id"]) if body.get("id") else ""
    if not id:
        return JSONResponse(status_code=400, content={"error": "A member id is required."})

    users = await linear.get_users(store.get_api_key())
    match = next((u for u in users if u.get("id") == id), None)
    if not match:
        return JSONResponse(status_code=404, content={"error": "Member not found in this workspace."})

    assumed_role = to_member(match)
    store.set_assumed_role(assumed_role)
    return {"assumedRole": assumed_role}


# DELETE /api/roles/assumed — drop the assumed role.
@router.delete("/assumed")
async def delete_assumed():
    store.set_assumed_role(None)
    return {"assumedRole": None}
