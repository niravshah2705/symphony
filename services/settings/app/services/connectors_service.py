"""Organization connector metadata and secret-free readiness."""
from __future__ import annotations

import uuid

from app.authz.principal import Principal
from app.core.database import Uow
from app.core.timeutils import utcnow
from app.models.connectors import CONNECTORS_DOC_ID, OrgConnectorConfig
from app.repositories.base import org_settings_col
from app.schemas.connectors import (
    ConnectorConfigResponse,
    ConnectorConfigUpdate,
    ConnectorReadiness,
    ConnectorReadinessResponse,
)


def _response(config: OrgConnectorConfig) -> ConnectorConfigResponse:
    return ConnectorConfigResponse(
        jira_origin=config.jira_origin,
        jira_email=config.jira_email,
        asana_workspace_id=config.asana_workspace_id,
    )


async def _get(session: Uow, org_id: uuid.UUID) -> OrgConnectorConfig:
    doc = await session.get(org_settings_col(org_id), CONNECTORS_DOC_ID)
    return (
        OrgConnectorConfig.from_doc(doc)
        if doc
        else OrgConnectorConfig.empty(str(org_id))
    )


async def get_org_connectors(
    session: Uow, principal: Principal
) -> ConnectorConfigResponse:
    return _response(await _get(session, principal.org_id))


async def set_org_connectors(
    session: Uow, principal: Principal, body: ConnectorConfigUpdate
) -> ConnectorConfigResponse:
    org_id = principal.org_id
    col = org_settings_col(org_id)

    async def update(txn):
        doc = await txn.get(col, CONNECTORS_DOC_ID)
        current = (
            OrgConnectorConfig.from_doc(doc)
            if doc
            else OrgConnectorConfig.empty(str(org_id))
        )
        updated = OrgConnectorConfig(
            scope_id=str(org_id),
            jira_origin=(
                body.jira_origin
                if body.jira_origin is not None
                else current.jira_origin
            ),
            jira_email=(
                body.jira_email if body.jira_email is not None else current.jira_email
            ),
            asana_workspace_id=(
                body.asana_workspace_id
                if body.asana_workspace_id is not None
                else current.asana_workspace_id
            ),
            created_at=current.created_at,
            updated_at=utcnow(),
        )
        txn.set(col, CONNECTORS_DOC_ID, updated.to_doc())
        return updated

    return _response(await session.db.run_transaction(update))


async def get_internal_egress_config(
    session: Uow, org_id: uuid.UUID
) -> ConnectorConfigResponse:
    return _response(await _get(session, org_id))


async def get_connector_readiness(
    session: Uow,
    principal: Principal,
    project_id: uuid.UUID | None = None,
) -> ConnectorReadinessResponse:
    from app.services import secrets_service

    org_id = principal.org_id
    config = await _get(session, org_id)
    credentials = await secrets_service.credential_readiness_for_org(
        session, org_id, project_id
    )

    linear = bool(credentials["linearApiKey"]["ready"])
    jira = bool(
        config.jira_origin
        and config.jira_email
        and credentials["jiraApiToken"]["ready"]
    )
    asana = bool(
        config.asana_workspace_id and credentials["asanaAccessToken"]["ready"]
    )
    return ConnectorReadinessResponse(
        connectors={
            "linear": ConnectorReadiness(
                configured=linear,
                routable=linear,
                supported=True,
                verified=False,
            ),
            # Credentials and routing metadata may be staged now, but product
            # work-item adapters do not yet implement Jira or Asana execution.
            "jira": ConnectorReadiness(
                configured=jira,
                routable=False,
                supported=False,
                verified=False,
            ),
            "asana": ConnectorReadiness(
                configured=asana,
                routable=False,
                supported=False,
                verified=False,
            ),
        }
    )
