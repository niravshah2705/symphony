# Native harness runtime images

This repo builds and publishes four **native agent-harness runtime images** to
`ghcr.io`, modeled on [kagent](https://github.com/kagent-dev/kagent)'s
`go/harness/` (vendored at commit `29aaacdb`, module retitled to
`github.com/niravshah2705/symphony/go`). Each image runs a small Go adapter that
launches the vendor CLI as a subprocess, translates its output into the shared
Harness runtime event model, and serves it over a private A2A endpoint.

These images are **standalone artifacts**. They are *not* wired into the fleet's
own `deploy/gcp/Dockerfile.coder` or the GCP Artifact Registry pipeline — that is
intentional. Integrating them behind `substratePlannerImage` /
`harness-catalog.json` is a separate effort.

## Layout

| Path | What |
| --- | --- |
| `go/` | Vendored kagent Go module (shared `harness/runtime`, `claude`, `codex`, plus internal deps under `adk/`, `core/`, `pkg/`, `api/`) |
| `go/harness/deepagent/` | New port — runs the `deepagents-code` CLI (installed via `uv`) |
| `go/harness/deepseek/` | New port — runs the `dsh` CLI (installed via `npm -g`) |
| `go/harness/runtime-images.csv` | **Version manifest** — the source of truth for what gets built |
| `go/harness/<runtime>/Dockerfile` | Per-runtime multi-stage image build |
| `scripts/verify-runtime-images.sh` | CSV preflight (resolvability + checksum report) |
| `.github/workflows/build-runtime-images.yml` | Publishes to ghcr from `main`; a PR run only validates the rows |
| `go/LICENSE.kagent` | Upstream Apache-2.0 license for the vendored code |

## Images and tags

`current: true` rows also get a `:latest` tag; every row gets its `:<version>` tag.

| Runtime | Image | Backed by |
| --- | --- | --- |
| claude | `ghcr.io/niravshah2705/symphony/claude-runtime` | `@anthropic-ai/claude-code` CLI (musl binary, sha256-pinned) |
| codex | `ghcr.io/niravshah2705/symphony/codex-runtime` | `openai/codex` `rust-v*` release (musl tarball, sha256-pinned) |
| deepagent | `ghcr.io/niravshah2705/symphony/deepagent-runtime` | PyPI `deepagents-code` (uv tool install; glibc base — see below) |
| deepseek | `ghcr.io/niravshah2705/symphony/deepseek-runtime` | npm `@deepseek-ai/dsh` (global install; glibc base for native deps) |

Each runtime ships **current + last 3 versions** (4 tags) in the CSV.

`current` is a *tagging* flag, so a rotation moves two rows: the new current row
(builds `:<version>` + `:latest`) and the demoted one (its `current` flipped to
`false`). Both are rebuilt — republishing the demoted row without `:latest` is
the cheap way to keep `:latest` pointing at exactly one digest, and two builds
beats sixteen.

## What gets rebuilt

| Change | Rows published |
| --- | --- |
| `runtime-images.csv` on a PR | none — the run resolves, preflights and reports the rows it *would* publish |
| `runtime-images.csv` merged to `main` | only rows whose version, checksums or `current` moved |
| a `Dockerfile` or the workflow itself | the whole manifest (16) — the recipe changed for every image |
| anything else on `main` | nothing (the workflow does not trigger) |
| `workflow_dispatch`, `rebuild: all` | the whole manifest, or one runtime if `runtime` is set |
| `workflow_dispatch`, `rebuild: changed` | rows that moved versus the previous commit |

Two consequences worth knowing:

- **Only `main` publishes.** A branch push no longer builds and pushes images, so
  a PR does not consume ~30 minutes of runner time or repoint a tag that the
  merged branch is about to change.
- **A Go adapter change rebuilds nothing by itself.** The manifest drives the
  matrix, and the adapter is not a manifest row — after landing one, run
  `workflow_dispatch` with `rebuild: all`. The buildx cache is scoped per runtime
  (`scope=runtime-<name>`), so that run reuses the compiled adapter layer rather
  than starting cold, and a version rotation reuses it too.

## Rotating versions (the normal workflow)

1. Edit `go/harness/runtime-images.csv`:
   - bump the `current: true` row's version to the new release (drop it to `false`
     if you want to keep the previous one),
   - shift the older versions down, keeping four rows per runtime,
   - for **claude/codex**, fill `amd64_sha256` / `arm64_sha256` (see below). For
     deepagent/deepseek the checksum columns stay empty (uv/npm resolve integrity).
2. Run the preflight:
   ```bash
   scripts/verify-runtime-images.sh           # checks every version still resolves
   scripts/verify-runtime-images.sh --hash    # also downloads and prints the CLI shas
   ```
   Use the `--hash` output to populate the claude/codex checksum columns. CI runs
   the same check with `--selected <file>` limited to the rows it is about to
   publish, so a stale row in an unrelated runtime reports as a `WARN` instead of
   blocking your bump — but a stale row **in** the selection fails the run.
3. Commit + open a PR. The workflow resolves and validates those rows and posts
   the selection to the run summary, publishing nothing.
4. Merge. The `main` run rebuilds only the rows that moved and pushes them to ghcr
   (`linux/amd64` + `linux/arm64`).

## Checksum policy

- If a claude/codex row has **both** checksums, the image build verifies the
  download with `sha256sum -c` and fails on mismatch.
- If a checksum column is **empty**, the Dockerfile prints a warning and skips the
  integrity check (so CI never hard-fails on an unfilled row). Pin the shas as
  soon as you can — `verify-runtime-images.sh --hash` makes that a one-liner.

## Building locally

```bash
# single arch, quick check of one runtime at a pinned version
docker build -f go/harness/claude/Dockerfile \
  --build-arg RUNTIME_VERSION=2.1.326 --platform linux/amd64 \
  -t claude-runtime:local go

# multi-arch (needs buildx + qemu)
docker buildx build -f go/harness/deepagent/Dockerfile \
  --platform linux/amd64,linux/arm64 --build-arg RUNTIME_VERSION=0.2.9 \
  -t deepagent-runtime:local go
```

The build **context is `go/`** (the module root), not the repo root.

The entrypoint accepts `--check` to validate config + the pinned CLI version and
exit, e.g. `docker run --rm claude-runtime:local --check`.

## Notes / caveats

- **deepagent/deepseek drivers are a bounded passthrough.** `deepagents-code` and
  `dsh` have no confirmed machine-readable event protocol (unlike the
  stream-JSON Claude/Codex drivers), so the driver emits each stdout line as a
  text delta and maps the exit status to success/failure. Grow the drivers with
  real tool/usage events once the CLIs' streaming shape is confirmed.
- **deepagent and deepseek use glibc bases, alpine is not an option for them.**
  `deepagents-code` depends on `langgraph-checkpoint-sqlite` → `sqlite-vec`, which
  publishes manylinux/mac/win wheels and **no musl wheel**, so `uv tool install`
  cannot resolve on alpine in either architecture (`python:3.14-slim`, matching the
  CLI's own `>=3.14,<3.15` floor). `dsh` pulls native node modules (`koffi`,
  `node-pty`) that don't build cleanly on musl (`node:22-slim`). Only claude and
  codex stay on the musl base, because their vendors ship prebuilt musl binaries.
- `npm install -g --allow-scripts=…` is kept verbatim; native-module postinstall
  steps run by default with npm.
- **The manifest is data-only.** Every non-empty line after the header is a row,
  so a `# comment` becomes a row with an empty `dockerfile` and the plan job fails
  naming it (`row # …: is not a file`). Blank lines are fine; notes about a
  rotation belong in the PR, not the CSV.
