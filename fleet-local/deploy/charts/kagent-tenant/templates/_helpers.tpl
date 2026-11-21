{{/*
Namespace for every object. Empty falls back to the release namespace.
*/}}
{{- define "kagent-tenant.namespace" -}}
{{- .Values.namespace | default .Release.Namespace -}}
{{- end -}}

{{/*
Prefixed object name. Usage:
  {{ include "kagent-tenant.objectName" (dict "root" $ "kind" "model" "name" .name) }}
The kind segment keeps a tenant's ModelConfigs, Harnesses, templates and Agents
distinguishable in a shared namespace, where `kubectl get agents` alone would
otherwise show a wall of <tenant>-<something>.
*/}}
{{- define "kagent-tenant.objectName" -}}
{{- printf "%s-%s-%s" .root.Values.tenant.id .kind .name -}}
{{- end -}}

{{/*
Common labels. kagent.dev/tenant mirrors the placement-label scheme the kagent
chart uses for WorkerPool discovery (kagent.dev/worker-pool-name / -namespace).
*/}}
{{- define "kagent-tenant.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version }}
app.kubernetes.io/name: {{ .root.Chart.Name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
app.kubernetes.io/part-of: kagent
kagent.dev/tenant: {{ .root.Values.tenant.id }}
kagent.dev/tenant-namespace: {{ include "kagent-tenant.namespace" .root }}
{{- with .root.Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/*
Tenant ids are used twice over: as a Kubernetes name prefix (RFC1123 label) and
as a Substrate snapshot path segment. Take the stricter intersection so an id
that renders today does not fail at the first snapshot tomorrow.
*/}}
{{- define "kagent-tenant.validateTenantId" -}}
{{- if not (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" .Values.tenant.id) }}
  {{- fail (printf "tenant.id %q must be an RFC1123 label: lowercase alphanumerics and '-', no leading or trailing '-'" .Values.tenant.id) }}
{{- end }}
{{- if eq .Values.tenant.id "atespaces" }}
  {{- fail "tenant.id must not be \"atespaces\"; Substrate reserves that segment for the actor address space under a snapshot root" }}
{{- end }}
{{- end -}}

{{/*
Snapshot root: scheme must match the backend, and every path segment must pass
Substrate's own validation (internal/resources/validate.go) or the Harness is
rejected at apply time with a message that does not name the field.
*/}}
{{- define "kagent-tenant.validateSnapshotRoot" -}}
{{- $root := trimSuffix "/" .Values.tenant.snapshotRoot }}
{{- if not (regexMatch "^(s3|gs)://[^[:space:]]+$" $root) }}
  {{- fail (printf "tenant.snapshotRoot %q must be \"s3://…\" for an S3-compatible store (RustFS on kind) or \"gs://…\" for GCS, with no spaces" .Values.tenant.snapshotRoot) }}
{{- end }}
{{- $path := regexReplaceAll "^[a-z0-9]+://" $root "" }}
{{- range $segment := splitList "/" $path }}
{{- if and (ne $segment "") (not (regexMatch "^[A-Za-z0-9_-]+$" $segment)) }}
    {{- fail (printf "tenant.snapshotRoot segment %q is illegal: only [A-Za-z0-9_-] are allowed (no dots, no spaces, no %%)" $segment) }}
{{- end }}
{{- if eq $segment "atespaces" }}
    {{- fail (printf "tenant.snapshotRoot %q must not contain the reserved segment \"atespaces\"" .Values.tenant.snapshotRoot) }}
{{- end }}
{{- end }}
{{- end -}}

{{/*
Referential integrity. These are the mistakes that produce a Ready-looking Agent
whose Harness never resolves: a typo in template/harness/model is silently
permitted by the API and only surfaces as a stalled reconcile.
*/}}
{{- define "kagent-tenant.validateRefs" -}}
{{/*
Names first: a missing name would otherwise surface as a Go type error out of
printf, or as an object literally named "acme-model-", which is worse — it
applies cleanly and then never resolves.
*/}}
{{- $lists := dict "models" "model" "harnesses" "harness" "templates" "template" "agents" "agent" }}
{{- range $list, $kind := $lists }}
{{- $seen := dict }}
{{- range $entry := index $.Values $list }}
{{- if not $entry.name }}
  {{- fail (printf "%s entry %s has no name; every entry needs one to build the <tenant>-%s-<name> object name" $list (toYaml $entry | trunc 60 | trim) $kind) }}
{{- end }}
{{- if hasKey $seen $entry.name }}
  {{- fail (printf "duplicate %s name %q: two entries would render the same object %s-%s-%s" $kind $entry.name $.Values.tenant.id $kind $entry.name) }}
{{- end }}
{{- $_ := set $seen $entry.name "" }}
{{- end }}
{{- end }}
{{- $models := dict }}
{{- range $m := .Values.models }}{{ $_ := set $models $m.name "" }}{{ end }}
{{- $harnesses := dict }}
{{- range $h := .Values.harnesses }}{{ $_ := set $harnesses $h.name "" }}{{ end }}
{{- $templates := dict }}
{{- range $t := .Values.templates }}{{ $_ := set $templates $t.name "" }}{{ end }}
{{- range $t := .Values.templates }}
{{- if and $t.modelConfig (not (hasKey $models $t.modelConfig)) }}
  {{- fail (printf "templates[%q].modelConfig %q names no entry in models" $t.name $t.modelConfig) }}
{{- end }}
{{- end }}
{{- range $h := .Values.harnesses }}
{{- if not (has $h.type (list "kagent" "codex" "claude" "byo")) }}
  {{- fail (printf "harnesses[%q].type %q must be one of kagent|codex|claude|byo (the Harness CRD enforces ExactlyOneOf)" $h.name $h.type) }}
{{- end }}
{{- if and (eq $h.type "byo") (or (not $h.image) (not $h.command)) }}
  {{- fail (printf "harnesses[%q]: a byo Harness requires both workload.image, pinned by @sha256 digest, and workload.command" $h.name) }}
{{- end }}
{{- if and (or (eq $h.type "codex") (eq $h.type "claude")) (or $h.command $h.args) }}
  {{- fail (printf "harnesses[%q]: a %s Harness accepts neither workload.command nor workload.args" $h.name $h.type) }}
{{- end }}
{{- if eq $h.type "claude" }}
{{- if and $h.image (not (regexMatch "@sha256:[a-f0-9]{64}$" $h.image)) }}
  {{- fail (printf "harnesses[%q].image %q must be pinned by @sha256 digest — the Harness CRD rejects tags" $h.name $h.image) }}
{{- end }}
{{- range $e := $h.env | default list }}
{{- if hasPrefix "ANTHROPIC_" $e.name }}
  {{- fail (printf "harnesses[%q].env sets %q — ANTHROPIC_* vars are Claude-runtime-owned and the controller marks every Agent on the Harness Compatible=False; supply base URL/model/key via an Anthropic-provider ModelConfig instead" $h.name $e.name) }}
{{- end }}
{{- end }}
{{- end }}
{{- if eq $h.type "codex" }}
{{- if and $h.image (not (regexMatch "@sha256:[a-f0-9]{64}$" $h.image)) }}
  {{- fail (printf "harnesses[%q].image %q must be pinned by @sha256 digest — the Harness CRD rejects tags; leave it empty to run the release-bundled codex-harness image" $h.name $h.image) }}
{{- end }}
{{- range $e := $h.env | default list }}
{{- if or (hasPrefix "OPENAI_" $e.name) (hasPrefix "CODEX_" $e.name) (hasPrefix "AWS_" $e.name) }}
  {{- fail (printf "harnesses[%q].env sets %q — OPENAI_*/CODEX_*/AWS_* credential vars are compiled by the Codex adapter from the ModelConfig and the controller marks every Agent on the Harness Compatible=False (\"conflicts with Codex's compiled configuration\")" $h.name $e.name) }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}
{{- range $a := .Values.agents }}
{{- if not (hasKey $templates $a.template) }}
  {{- fail (printf "agents[%q].template %q names no entry in templates" $a.name $a.template) }}
{{- end }}
{{- if not (hasKey $harnesses $a.harness) }}
  {{- fail (printf "agents[%q].harness %q names no entry in harnesses" $a.name $a.harness) }}
{{- end }}
{{- end }}
{{- end -}}

{{/*
One entry point so every template file cannot forget to check.
*/}}
{{- define "kagent-tenant.validate" -}}
{{- include "kagent-tenant.validateTenantId" . }}
{{- include "kagent-tenant.validateSnapshotRoot" . }}
{{- include "kagent-tenant.validateRefs" . }}
{{- end -}}
