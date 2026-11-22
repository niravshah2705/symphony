#!/usr/bin/env bash
# Setup step 6 — Substrate (ATE) control plane in ate-system.
# Two-part, helm-first with one unavoidable exception:
#  1. ../../flexprice/docs/install-substrate-local.sh (kept as the canonical
#     installer — NOT reimplemented here): substrate-crds chart, then the
#     ate-setup bootstrap (signer CA pools + podcertificate-controller +
#     actor-id pools + postgres + egress mitm), then the DB roles/secrets, then
#     the substrate chart itself. The bootstrap cannot be a helm step: the
#     chart's workloads mount PodCertificateRequest volumes from custom signers
#     only ate-setup can create (and kubectl-ate v1.0.1 still probes a dead
#     v1beta1 API on k8s 1.37 — the script explains).
#  2. fleet overlay deploy/substrate/values-kind.yaml (bootstrapOwners = kagent
#     controller SA, router ingress allowlist, kagent namespacePolicy, preview
#     gates) via helm upgrade --reuse-values --force-conflicts. Tenant org-*
#     entries are appended later by the BFF onboarding gate, per org.
# Prereqs: docker + the step-1 cluster, go >= 1.24, and a substrate checkout at
# SUBSTRATE_SRC (default ~/git/ate/substrate; the installer fetches tag v1.0.1
# into a worktree itself).
set -euo pipefail
SD="$(cd "$(dirname "$0")" && pwd)"; cd "$SD/../.."
source "$SD/_common.sh"
ROOT=..

command -v go >/dev/null || die "go >= 1.24 is required for the ate-setup bootstrap"
# kagent ns must exist before the overlay names its service account as a
# bootstrap owner (the chart validates the reference).
kc create namespace kagent --dry-run=client -o yaml | kc apply -f -

# Pre-pin the CRD chart at 1.0.1: the installer runs `helm upgrade --install`
# WITHOUT --version, which on a fresh cluster would pull the latest chart (CRD
# skew against the v1.0.1 images). Once the release exists at 1.0.1, the
# installer's own upgrade keeps the installed version.
helm upgrade --install substrate-crds oci://ghcr.io/kagent-dev/substrate/helm/substrate-crds \
  --version 1.0.1 --namespace ate-system --create-namespace --kube-context "$CTX" --wait

# NOTE the VERSION quirk: the installer interpolates refs/tags/v$VERSION and
# image tags from the same variable, so it must receive the BARE number.
# The installer also adopts the bootstrap's un-owned NetworkPolicies into the
# substrate release before its own chart install (see step 5 there / T-15.7).
CONTEXT="$CTX" VERSION=1.0.1 bash "$ROOT/flexprice/docs/install-substrate-local.sh"

helm upgrade --install substrate oci://ghcr.io/kagent-dev/substrate/helm/substrate \
  --version 1.0.1 --namespace ate-system --kube-context "$CTX" \
  --reuse-values --force-conflicts --take-ownership -f deploy/substrate/values-kind.yaml \
  --wait --timeout 15m

kc get clustertrustbundles -o name | grep -q podcert.ate.dev && say "trust bundles published" \
  || die "podcert trust bundles missing — substrate bootstrap did not finish"
kc -n ate-system rollout status deploy/ate-api-server --timeout=5m
say "STEP6 OK — substrate 1.0.1 ready (atenet-egress carries the GoldenEgressPolicy: see T-08)"
