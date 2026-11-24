"""LiteLLM callback that lifts fleet identity (org/project/user/session UUIDs)
from the request's W3C baggage + x-fleet-* headers into the standard logging
payload, so per-user/per-project cost and trace attribution survive even though
kagent sends no body `user`/`litellm_metadata`.

Two facts about this LiteLLM version drive the design (see fleet_identity.py):
  * async_pre_call_hook mutations of `data` do NOT reach the logging payload —
    the proxy snapshots requester_metadata at ingestion, before the hook runs.
  * the original headers survive in slp.metadata.requester_metadata.headers, so
    identity is recovered from there in async_log_success_event, which runs
    BEFORE the langfuse callback. We stamp the shared logging object in place:
        metadata.user_api_key_end_user_id -> langfuse userId
        metadata.session_id               -> langfuse sessionId
        metadata.fleet_org_id/project_id  -> flexprice + langfuse metadata
    The vendored flexprice_callback reads the same preserved headers directly.

Register the instance in config.yaml:
    litellm_settings:
      callbacks: [flexprice_callback.flexprice_logger, fleet_metadata.fleet_hook, langfuse]
"""

import logging

from litellm.integrations.custom_logger import CustomLogger

from fleet_identity import identity_from_slp

logger = logging.getLogger("fleet_metadata")


def _stamp(kwargs: dict) -> None:
    slp = kwargs.get("standard_logging_object")
    if not isinstance(slp, dict):
        return
    ident = identity_from_slp(slp)
    org, project, user, session = ident["org"], ident["project"], ident["user"], ident["session"]
    if not (org or project or user or session):
        return
    meta = slp.get("metadata")
    if not isinstance(meta, dict):
        meta = {}
        slp["metadata"] = meta
    if user and not meta.get("user_api_key_end_user_id"):
        meta["user_api_key_end_user_id"] = user
    if session:
        meta["session_id"] = session
    if org:
        meta["fleet_org_id"] = org
    if project:
        meta["fleet_project_id"] = project
    if user:
        meta["fleet_user_id"] = user
        slp["user"] = user
    # Langfuse reads sessionId from litellm_params["metadata"] (langfuse.py:483),
    # a different dict than slp.metadata, so stamp it there too.
    lp = kwargs.get("litellm_params")
    if isinstance(lp, dict):
        lp_meta = lp.get("metadata")
        if not isinstance(lp_meta, dict):
            lp_meta = {}
            lp["metadata"] = lp_meta
        if session:
            lp_meta["session_id"] = session
        if org:
            lp_meta["fleet_org_id"] = org
        if project:
            lp_meta["fleet_project_id"] = project


class FleetMetadataHook(CustomLogger):
    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        _stamp(kwargs)

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        _stamp(kwargs)


fleet_hook = FleetMetadataHook()