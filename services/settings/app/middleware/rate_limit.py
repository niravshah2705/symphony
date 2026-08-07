"""Shared rate limiter (keyed by client IP).

The settings service has no unauthenticated auth endpoints, but it keeps the
same SlowAPI wiring as the org service so a global per-IP cap can be applied and
the deployment surface stays identical.
"""
from __future__ import annotations

from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)
