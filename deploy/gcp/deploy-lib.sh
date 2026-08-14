#!/usr/bin/env bash

# Shared, sourceable helpers for deploy.sh. This file intentionally performs no
# work at load time so unit tests can exercise the fail-closed image resolver.

built_service() {
  printf '%s' "$DEPLOY_SERVICES_JSON" | jq -e --arg id "$1" 'any(.[]; .id == $id)' >/dev/null
}

release_tag() {
  if [[ ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
    echo "Refusing non-immutable image tag from $2" >&2
    return 1
  fi
  printf '%s\n' "$1"
}

live_tag() {
  local image tag
  if ! image="$(gcloud run services describe "$1" \
    --project "$GCP_PROJECT_ID" --region "$GCP_REGION" \
    --format='value(spec.template.spec.containers[0].image)')"; then
    echo "Unable to resolve immutable live image tag for $1" >&2
    return 1
  fi
  tag="${image##*:}"
  if [ -z "$image" ] || [ -z "$tag" ] || [ "$tag" = "$image" ]; then
    echo "Unable to resolve immutable live image tag for $1" >&2
    return 1
  fi
  release_tag "$tag" "live Cloud Run service $1"
}

resolve_tag() {
  if built_service "$1"; then
    release_tag "$DEPLOY_SHA" "current repository revision"
  else
    live_tag "$2"
  fi
}

resolve_optional_tag() {
  if built_service "$1"; then
    release_tag "$DEPLOY_SHA" "current repository revision"
    return
  fi
  case "$3" in
    true) live_tag "$2" ;;
    false) release_tag "$DEPLOY_SHA" "disabled optional service $2" ;;
    *)
      echo "Invalid enablement flag for optional service $2: $3" >&2
      return 1
      ;;
  esac
}

write_tag() {
  local output_name="$1" tag
  shift
  if ! tag="$("$@")"; then
    echo "Unable to resolve image tag output $output_name" >&2
    return 1
  fi
  printf '%s=%s\n' "$output_name" "$tag"
}

write_all_tags() {
  write_tag gateway resolve_tag gateway "${GATEWAY_SERVICE_NAME:-gateway}"
  write_tag planner resolve_tag planner planner
  write_tag coder resolve_tag coder coder-control
  write_tag orchestrator resolve_optional_tag orchestrator pipeline-orchestrator "$PIPELINE_ORCHESTRATOR_ENABLED"
  write_tag tester resolve_optional_tag tester pipeline-tester "$PIPELINE_ORCHESTRATOR_ENABLED"
  write_tag deployer resolve_optional_tag deployer pipeline-deployer "$PIPELINE_ORCHESTRATOR_ENABLED"
  write_tag provisioner resolve_optional_tag provisioner provisioner "$PROVISIONING_ENABLED"
  write_tag proxy resolve_tag proxy proxy
  write_tag org resolve_tag org org-service
  write_tag settings resolve_tag settings settings-service
  write_tag email resolve_tag email email-service
}
