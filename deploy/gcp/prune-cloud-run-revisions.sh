#!/usr/bin/env bash
# Keep a three-revision rollback window for every Cloud Run service in one
# deployment region. Cloud Run has no configurable revision-retention count, so
# each supported deploy path invokes this after a successful Terraform apply.
readonly CLOUD_RUN_REVISIONS_TO_KEEP=3

usage() {
  echo "usage: $0 <project-id> <region>" >&2
}

revision_names() { # <project-id> <region> <service>
  gcloud run revisions list \
    --project="$1" \
    --region="$2" \
    --service="$3" \
    --sort-by='~metadata.creationTimestamp' \
    --format='value(metadata.name)'
}

protected_revision_names() { # <project-id> <region> <service>
  local latest traffic revision
  if ! latest="$(gcloud run services describe "$3" \
    --project="$1" \
    --region="$2" \
    --format='value(status.latestCreatedRevisionName,status.latestReadyRevisionName)')"; then
    echo "ERROR: unable to read latest revisions for Cloud Run service $3" >&2
    return 1
  fi
  if ! traffic="$(gcloud run services describe "$3" \
    --project="$1" \
    --region="$2" \
    --flatten='status.traffic[]' \
    --format='value(status.traffic.revisionName)')"; then
    echo "ERROR: unable to read traffic revisions for Cloud Run service $3" >&2
    return 1
  fi

  # Revision resource names never contain shell whitespace. Splitting gcloud's
  # tab/newline projections here normalizes both scalar and flattened output.
  for revision in $latest $traffic; do
    printf '%s\n' "$revision"
  done
}

prune_service_revisions() { # <project-id> <region> <service>
  local project_id="$1"
  local region="$2"
  local service="$3"
  local output protected_output protected revision index
  local revisions=()

  if ! output="$(revision_names "$project_id" "$region" "$service")"; then
    echo "ERROR: unable to list revisions for Cloud Run service ${service}" >&2
    return 1
  fi
  while IFS= read -r revision; do
    [ -n "$revision" ] && revisions[${#revisions[@]}]="$revision"
  done <<< "$output"

  if ((${#revisions[@]} > CLOUD_RUN_REVISIONS_TO_KEEP)); then
    if ! protected_output="$(protected_revision_names "$project_id" "$region" "$service")"; then
      return 1
    fi
    # Refuse the whole service before deleting anything when an older revision
    # is still latest, a traffic target, or tagged. Cleanup never rewrites
    # traffic/tag policy implicitly.
    for ((index = CLOUD_RUN_REVISIONS_TO_KEEP; index < ${#revisions[@]}; index++)); do
      revision="${revisions[$index]}"
      while IFS= read -r protected; do
        [ -z "$protected" ] && continue
        if [ "${revision##*/}" = "${protected##*/}" ]; then
          echo "ERROR: unable to retain only ${CLOUD_RUN_REVISIONS_TO_KEEP} revisions for ${service}; older revision ${revision} is latest, receives traffic, or has a traffic tag" >&2
          return 1
        fi
      done <<< "$protected_output"
    done
  fi

  # The list is newest-first. Walk backward so destructive operations run from
  # the oldest candidate toward the three-revision rollback boundary.
  for ((index = ${#revisions[@]} - 1; index >= CLOUD_RUN_REVISIONS_TO_KEEP; index--)); do
    revision="${revisions[$index]}"
    echo "Deleting stale Cloud Run revision ${revision} (${service})"
    if ! gcloud run revisions delete "$revision" \
      --project="$project_id" \
      --region="$region" \
      --quiet \
      --no-async; then
      echo "ERROR: unable to delete ${revision}; it may still receive traffic or be protected" >&2
      return 1
    fi
  done

  revisions=()
  if ! output="$(revision_names "$project_id" "$region" "$service")"; then
    echo "ERROR: unable to verify revisions for Cloud Run service ${service}" >&2
    return 1
  fi
  while IFS= read -r revision; do
    [ -n "$revision" ] && revisions[${#revisions[@]}]="$revision"
  done <<< "$output"
  if ((${#revisions[@]} > CLOUD_RUN_REVISIONS_TO_KEEP)); then
    echo "ERROR: Cloud Run service ${service} still has ${#revisions[@]} revisions; expected at most ${CLOUD_RUN_REVISIONS_TO_KEEP}" >&2
    return 1
  fi

  echo "Cloud Run service ${service}: retained ${#revisions[@]} revision(s)"
}

main() {
  if [ "$#" -ne 2 ] || [ -z "$1" ] || [ -z "$2" ]; then
    usage
    return 64
  fi
  command -v gcloud >/dev/null 2>&1 || {
    echo "ERROR: gcloud is required to prune Cloud Run revisions" >&2
    return 127
  }

  local project_id="$1"
  local region="$2"
  local output service
  local service_count=0

  if ! output="$(gcloud run services list \
    --project="$project_id" \
    --region="$region" \
    --format='value(metadata.name)')"; then
    echo "ERROR: unable to list Cloud Run services in ${project_id}/${region}" >&2
    return 1
  fi
  while IFS= read -r service; do
    [ -z "$service" ] && continue
    if ! prune_service_revisions "$project_id" "$region" "$service"; then
      return 1
    fi
    service_count=$((service_count + 1))
  done <<< "$output"
  echo "Cloud Run revision retention complete: ${service_count} service(s), newest ${CLOUD_RUN_REVISIONS_TO_KEEP} retained"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  main "$@"
fi
