# adlc — AI Fleet CLI

A command-line client that drives the AI Fleet life cycle from a terminal:
**business → plan → issues → coder → PR**. It's a thin HTTP client to the
running **gateway** (the only client-facing origin), so it reuses the same
auth/RBAC, scheduler, and coder monitor as the web UI.

## Run

Boot the fleet first (`npm start` from the repo root), then:

```bash
npm run adlc -- status                 # via the root npm script
node packages/cli/bin/adlc.js status   # directly
npm install && adlc status             # after install links the `adlc` bin
```

## Commands

| Command | What it does |
|---|---|
| `adlc auth login` | Store an API token (see [Authentication](#authentication)) |
| `adlc auth status` / `logout` | Show / remove the stored token |
| `adlc status` | Gateway health + planner/coder readiness |
| `adlc business list \| create` | List / create businesses |
| `adlc role list \| assume <id> \| clear` | Manage the assumed role (required before planning) |
| `adlc candidates` | Preview projects the scheduler will enrich |
| `adlc plan <projectId>` | Enqueue planning, stream progress |
| `adlc code <issueId>` | Run the code-writer on one issue, stream progress |
| `adlc monitor start\|stop\|resume\|status` | Control the coder board monitor |
| `adlc jobs` | Enrichment/coder job history |
| `adlc run` | End-to-end: business → plan → coder |

Run `adlc <command> --help` for command-specific flags. Every command accepts
`--api <url>` and (where it prints structured data) `--json`.

## Authentication

Local dev (`AUTH_MODE=disabled`) needs no token. When the gateway runs in
**firebase** mode, obtain your Firebase ID token from the signed-in web UI, then:

```bash
adlc auth login --token-file ./token.txt   # recommended
cat token.txt | adlc auth login            # or pipe it on stdin
adlc auth login                            # or paste it (input hidden)
```

`login` verifies the token against `GET /api/auth/me` before saving (pass
`--no-verify` to skip). On success it writes `~/.adlc/credentials.json`
(**0600**, in a **0700** dir). After that, **every command automatically sends
the token** as `Authorization: Bearer` — plus the CLI version
(`User-Agent: adlc/<version>` and `X-Adlc-Version`).

> Firebase ID tokens are short-lived (~1h). When commands start returning
> `401`, the CLI hints you to re-run `adlc auth login`.

The token is read from env only during normal use — it is **never** accepted as
a command-line flag (so it can't leak into shell history or `ps`) and is masked
whenever displayed.

## Configuration & precedence

| Setting | Resolution (first wins) |
|---|---|
| Gateway URL | `--api` → `$ADLC_API_URL` → stored login `apiUrl` → `http://localhost:<gateway port>` |
| Token | `$ADLC_TOKEN` → stored login token → none |
| Credential dir | `$ADLC_HOME` → `~/.adlc` |

The default gateway port comes from the shared `CONFIG.SERVICES.gatewayPort`
(env `PORT`, default `4000`), so the CLI tracks the gateway's own configuration.

## Releasing

Releases are cut by GitHub Actions (`.github/workflows/cli-release.yml`), which
runs the unit tests, then packages and publishes a GitHub Release with three
assets:

- `adlc.js` — a **self-contained bundle** (esbuild); runs on any Node ≥18 with
  no `npm install` (`chmod +x adlc.js && ./adlc.js status`)
- `ai-fleet-cli-<version>.tgz` — the npm tarball (`bin/` + `src/`)
- `SHA256SUMS` — checksums for both

**Cut a release** either way:

```bash
# 1) push a version tag
git tag adlc-v1.0.0 && git push origin adlc-v1.0.0

# 2) or run it manually
gh workflow run "Release adlc CLI" -f version=1.0.0
```

The version must be semver (`MAJOR.MINOR.PATCH`); the tag form is `adlc-v<version>`.

**Test the pipeline locally** before tagging:

```bash
npm ci
node --test packages/cli/src/                        # unit tests
npm pack -w @ai-fleet/cli --dry-run                  # inspect tarball contents
npx --yes esbuild@0.24.2 packages/cli/bin/adlc.js \
  --bundle --platform=node --target=node18 --format=cjs --outfile=dist/adlc.js
node dist/adlc.js --help                             # bundle smoke test
```
