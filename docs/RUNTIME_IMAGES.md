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
| `.github/workflows/build-runtime-images.yml` | Builds + pushes to ghcr on manifest change |
| `go/LICENSE.kagent` | Upstream Apache-2.0 license for the vendored code |

## Images and tags

`current: true` rows also get a `:latest` tag; every row gets its `:<version>` tag.

| Runtime | Image | Backed by |
| --- | --- | --- |
| claude | `ghcr.io/niravshah2705/symphony/claude-runtime` | `@anthropic-ai/claude-code` CLI (musl binary, sha256-pinned) |
| codex | `ghcr.io/niravshah2705/symphony/codex-runtime` | `openai/codex` `rust-v*` release (musl tarball, sha256-pinned) |
| deepagent | `ghcr.io/niravshah2705/symphony/deepagent-runtime` | PyPI `deepagents-code` (uv tool install) |
| deepseek | `ghcr.io/niravshah2705/symphony/deepseek-runtime` | npm `@deepseek-ai/dsh` (global install; glibc base for native deps) |

Each runtime ships **current + last 3 versions** (4 tags) in the CSV.

## Rotating versions (the normal workflow)

1. Edit `go/harness/runtime-images.csv`:
   - bump the `current: true` row's version to the new release (drop it to `false`
     if you want to keep the previous one),
   - shift the older versions down, keeping four rows per runtime,
   - for **claude/codex**, fill `amd64_sha256` / `arm64_sha256` (see below). For
     deepagent/deepseek the checksum columns stay empty (uv/npm resolve integrity).
2. Run the preflight:
   ```bash
   scripts/verify-runtime-images.sh          # checks every version still resolves
   scripts/verify-runtime-images.sh --hash    # also downloads and prints the CLI shas
   ```
   Use the `--hash` output to populate the claude/codex checksum columns.
3. Commit + merge. The `build-runtime-images` workflow triggers on the CSV change,
   cross-builds `linux/amd64` + `linux/arm64`, and pushes to ghcr.

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
- **deepseek uses a glibc base** (`node:22-slim`) because `dsh` pulls native node
  modules (`koffi`, `node-pty`) that don't build cleanly on the musl/alpine base
  the other three use.
- `npm install -g --allow-scripts=…` is kept verbatim; native-module postinstall
  steps run by default with npm.
