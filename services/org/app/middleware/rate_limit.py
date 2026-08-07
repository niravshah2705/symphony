"""Shared rate limiter used to throttle authentication endpoints.

Brute-force / credential-stuffing protection on login, register and refresh
(api-security.md rule 9). Keyed by client IP.
"""
from __future__ import annotations

from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)
