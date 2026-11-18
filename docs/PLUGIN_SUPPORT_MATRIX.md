# Pluggable agent-skill packs across harnesses

Third-party agent-skill packs ship as **Agent Plugins 1.0.0** bundles (or, for a
single-skill upstream, as a **standalone skill artifact**) published to GHCR and
mounted read-only into a kagent `AgentTemplate`. This document is the support
matrix — which pack is available on which CLI, at which version — plus the three
kagent limits that decide the shape of that matrix, and the commands that keep
its numbers honest.

The generated matrix itself is
[`deploy/kagent/plugin-support.csv`](../deploy/kagent/plugin-support.csv); this
file explains it. Nothing here is hand-maintained except the prose: the CSV, the
per-pack manifests and the published digests are generated from the catalogs, and
CI fails on drift.

Progress against the matrix is tracked in Linear as the milestone **"Pluggable
plugins for all harnesses"** on the project *Substrate tenant console phased
rollout* — one issue per pack, plus the pipeline, catalog, store-mirror,
documentation and test issues, and the two follow-ups that decide which blanks
can ever stop being blank (the `byo` runtime images, and live activation).

## The matrix

Cell = the version the pack is published at on that CLI. Blank = **not
available**, not "not filled in yet" — the reason is one of the three limits
below, and it is recorded in the catalog so the blank is derived rather than
typed.

| kind | pack | kagent | codex | claude | opencode | dsh |
|---|---|---|---|---|---|---|
| plugin | [ecc](../deploy/kagent/ecc-plugin) | | 2.2.3 | 2.2.3 | | |
| plugin | [agent-skills](https://github.com/addyosmani/agent-skills) | | 0.6.16 | 0.6.16 | | |
| plugin | [superpowers](https://github.com/obra/superpowers) | | 7.0.2 | 7.0.2 | | |
| plugin | [spec-kit](https://github.com/github/spec-kit) | | 1.4.2 | 1.4.2 | | |
| plugin | [graphify](https://github.com/Graphify-Labs/graphify) | 0.9.112 | 0.9.112 | 0.9.112 | | |
| plugin | [code-review-graph](https://github.com/tirth8205/code-review-graph) | 2.4.0 | 2.4.0 | 2.4.0 | | |
| plugin | [hallmark](https://github.com/Nutlope/hallmark) | | 2.0.0 | 2.0.0 | | |
| skill | [security-audit](https://github.com/cloudflare/security-audit-skill) | c1c8a8c14710 | c1c8a8c14710 | c1c8a8c14710 | | |

(Columns `deepagent`, `antigravity`, `qodercli`, `pi`, `omp` are in the CSV and
are blank for every pack today; they are omitted here only so the table fits.)

Legend, from `STATUSES` in
[`plugin-catalog.js`](../packages/shared-core/src/agent/registry/plugin-catalog.js):

| status | meaning |
|---|---|
| `built` | bundle composed, published, digest stamped, and mounted successfully in-cluster |
| `bundled` | bundle composes and is pinned; the four-CR set has been applied at least once |
| `declared` | catalog record, bundle inputs and manifests exist; nothing published yet |
| `unsupported` | no cell value, and `blockedOn` names what would have to exist first |

`ecc` is `bundled` on codex because PR #307/#308 built and mounted it; everything
else in the matrix is `declared`.

## Three limits that decide the shape of the table

These are kagent's constraints, not local choices, and each one is why most of
the matrix is blank rather than nine columns wide.

**1. `Harness.spec` engine is an enum of four: `kagent | codex | claude | byo`.**
`antigravity`, `qodercli`, `opencode`, `pi`, `omp` and `dsh` are reachable only as
`byo` — a digest-pinned `workload.image` plus `command` (≤32 entries, ≤64 args).
A `byo` cell therefore needs a runtime image that installs that CLI, and this
repository does not build those yet: `code-review-graph`/`dsh` and
`hallmark`/`opencode` are `unsupported` with `blockedOn` naming the image.
`deepagent` has no kagent engine at all, so it stays blank for every pack.

**2. The plugin artifact is data, so software requirements do not belong in it.**
Both bundle Dockerfiles are `FROM scratch` + `COPY bundle/. /`: there is no shell
to run a `RUN` line in. A pack that needs a toolchain — Python for spec-kit,
graphify and code-review-graph, git plus node≥20 for security-audit — has its
`RUN`/`ENV` lines recorded in
[`plugin-catalog.json`](../packages/shared-core/src/agent/registry/plugin-catalog.json)
under `requirements.dockerfile[]` with `appliedTo` pointing at the **harness
runtime image**. The validator rejects an `appliedTo` that names a plugin image,
so the rule is an assertion rather than a comment.

**3. Plugin-declared `mcp.json` binds only on engine `kagent`.**
`graphify` and `code-review-graph` are primarily MCP servers; their value splits
across the row: skills on `codex`/`claude` (where the bundle's `plugin.json`
`mcp.json` is not read) and the MCP server only on `kagent`, which is why they
have a `kagent` cell and a `<pack>-kagent.yaml` manifest the other packs lack.
`agent-crset.js` refuses to render `mcp: true` on a non-`kagent` engine, so the
limitation cannot be encoded accidentally.

## Two tracks, because a single-skill upstream is not a plugin

| | plugin pack | standalone skill |
|---|---|---|
| manifest field | `AgentTemplate.spec.plugins[].source.oci` | `AgentTemplate.spec.skills[].{name,source.oci,source.path}` |
| root manifest | authored `plugin.json` (`$schema`, `name`, `version`, `"skills": "./skills/"`) | none — `SKILL.md` front matter is the manifest |
| enable list | explicit `skills:` allowlist, ≤50 (attaching does not enable) | none: the mounted directory **is** the skill |
| version | upstream release, read from `version_source` at the pin | **the pin**: `version == commit[0:12]` when the upstream states no version |
| publishing tag | `image:version` (+ `:latest` for the `current` row) | `image:version` only — a moving alias would be a second name for bytes no manifest names |
| CSV | `deploy/kagent/plugins.csv` | `deploy/kagent/skills.csv` |
| workflow | `build-plugin-images.yml` | `build-skill-images.yml` |
| catalog | `registry/plugin-catalog.json` | `registry/skill-catalog.json` |

`cloudflare/security-audit-skill` is the skill track: no releases, no tags, no
`plugin.json`, and 17 reference files beside `SKILL.md`. Its version cell is
`c1c8a8c14710`, the first twelve characters of the pin, because an unversioned
upstream has nothing else to say and the artifact label *is* the pin.

## One version number, checked in four places

The same string must appear as the upstream release at the pinned commit, the
`version` we author into `plugin.json`, the `plugins.csv`/`skills.csv` row that
CI builds, and every non-blank matrix cell. Enforcement, outermost first:

1. `scripts/verify-plugin-images.sh` fetches the pin and extracts the upstream
   version from the file named by `version_source` (`VERSION`, `package.json`,
   `pyproject.toml`, or `plugin.json`), then compares it with the row. Only ECC
   ships a `VERSION` file, which is why the column exists.
2. `scripts/verify-skill-artifacts.sh` is the skill-track equivalent: for an
   unversioned upstream there is no string to compare, so it asserts
   `<skill_path>/SKILL.md` exists at the pin and that its front-matter `name`
   equals the row — the mounted directory name *is* the skill name.
3. `plugin-catalog.js` / `skill-catalog.js` validate the record: pin is a full
   40-hex lowercase commit, `bundle.version == upstream.release`, and every
   filled cell equals the bundle version.
4. `scripts/seed-plugin-catalog.js --check` regenerates the matrix and compares
   it to the CSV on disk, and compares each catalog record to its
   `plugins.csv`/`skills.csv` row (repo, commit, version, `version_source`,
   image, Dockerfile). Drift fails in either direction.

Digests flow one way only: the CI build publishes, `scripts/stamp-plugin-digest.js`
writes `<image>@<digest>` into the **catalog**, and
`scripts/gen-kagent-manifests.js` regenerates every committed manifest from it.
A manifest is never edited by hand and never holds a kind-cluster digest —
`build-plugin-image.sh` / `build-skill-image.sh` stamp gitignored
`build/<pack>-<cli>.local.yaml` copies instead, so a developer build cannot flip
a reviewed file.

## Files

| path | role |
|---|---|
| `deploy/kagent/plugins.csv`, `skills.csv` | the publish manifests: pin, version, `version_source`, image, Dockerfile, `current` |
| `deploy/kagent/plugin-support.csv` | the generated matrix |
| `deploy/kagent/pack-inputs.sh`, `skill-inputs.sh` | resolve one CSV row + `bundle.env` into composer inputs; local builds and CI both source them |
| `deploy/kagent/ecc-plugin/compose-bundle.sh` | fetch the pin, apply the skills allowlist + overlay, author root `plugin.json`/`mcp.json` |
| `deploy/kagent/compose-skill-bundle.sh` | the skill-track equivalent: no `plugin.json`, no allowlist, entry-file and name checks |
| `deploy/kagent/build-plugin-image.sh`, `build-skill-image.sh`, `ecc-plugin/build-ecc-plugin-image.sh` | kind builders: compose → `docker build --platform <node arch>` → push → read back the digest → in-cluster pull probe → stamp `build/*.local.yaml` |
| `deploy/kagent/test-pack.sh` | the four mount layers for any (pack × CLI) from the catalogs; `--quick` skips the live turn, exit `0`/`1`/`2` |
| `deploy/kagent/<pack>/` | `bundle.env`, `skills.txt`, optional `overlay/` + `mcp.json`, `Dockerfile.<pack>-plugin`, `<pack>-<cli>.yaml` |
| `packages/shared-core/src/agent/registry/{plugin,skill}-catalog.{json,js}` | the reviewed source of truth and its validators |
| `packages/shared-core/src/agent/registry/agent-crset.js` | renders the four-CR set (`ModelConfig` → `Harness` → `AgentTemplate` → `Agent`) |
| `scripts/{verify-plugin-images.sh,verify-skill-artifacts.sh,stamp-plugin-digest.js,gen-kagent-manifests.js,seed-plugin-catalog.js}` | preflight, digest write-back, manifest + matrix generation |
| `public/icons/{plugins,skills}/*.svg` | committed same-origin marks; `pluginIconHref()` in `public/js/icons.js` computes the href |

## Adding a pack

1. Clone upstream at a candidate commit; confirm the layout (`skills/*/SKILL.md`,
   a single `skill.md`, `templates/commands/*.md`), where its version is stated,
   and whether it ships an `.mcp.json`.
2. Add the row to `plugins.csv` (or `skills.csv`) with the **full 40-hex** pin and
   `version_source`; keep `current: true` on exactly one row per pack.
3. Create `deploy/kagent/<pack>/` with `bundle.env` (upstream skill path,
   allowlist file, overlay dir, `mcp.json`, version source) and `skills.txt`, plus
   `Dockerfile.<pack>-plugin` (`FROM scratch` + OCI labels).
4. Add the catalog record: versions list, icon, skills with `enabled` flags,
   `requirements` (`appliedTo` a harness runtime image), `promptAppend`, and the
   `harnesses` cells with `status`/`engine`/`blockedOn`.
5. Commit `public/icons/plugins/<pack>.svg` — an original geometric mark, never
   fetched from the vendor's site.
6. `npm run plugins:seed && npm run plugins:manifests && npm run plugins:check &&
   npm run plugins:manifests:check`, then `bash deploy/kagent/test-pack.sh <pack>
   --quick`.
7. Open the PR: the plan job validates every row (no publish), the merge to main
   publishes, stamps the digest into the catalog, and regenerates the manifests.

## Commands

```bash
scripts/verify-plugin-images.sh                 # preflight every plugins.csv row
scripts/verify-skill-artifacts.sh               # preflight every skills.csv row
npm run plugins:seed                            # regenerate deploy/kagent/plugin-support.csv
npm run plugins:check                           # matrix + CSV vs catalogs, both directions
npm run plugins:manifests                       # regenerate every committed manifest
npm run plugins:manifests:check                 # fail on a manifest that drifted
npm run plugins:mirror                          # write the plugins collection (STORE_BACKEND=file for local)
bash deploy/kagent/build-plugin-image.sh graphify        # kind: pin → bundle → push → local stamp → probe
bash deploy/kagent/build-skill-image.sh security-audit   # same, skill track (no :latest)
bash deploy/kagent/test-pack.sh security-audit codex --quick
node --test packages/shared-core/src/agent/registry/ public/js/icons.test.mjs
```

## Not in this track yet

- **`byo` runtime images.** `go/harness/<cli>/Dockerfile` and
  `go/harness/runtime-images.csv` are the destination the catalog's
  `requirements.appliedTo` strings point at; that directory does not exist in
  this repository, so no `byo` cell is fillable and the requirement lines are
  reviewed text, not built. Tracked as the runtime-image issue.
- **Live activation.** Nothing outside the generators and the store mirror reads
  these catalogs yet: a bundle reaches an agent because an operator applies the
  pack's four-CR set, not because a loader resolved it at run time. Wiring the
  designer and the planner to the catalog records (icon, skills, `promptAppend`)
  is the follow-up this track sets up but does not perform.
- **The harness-rootfs registry.** `sync-harness-registry.yml` still resolves
  only ECC and `artifact-builder.js` skips other marketplaces; that npm/SDK
  attach format is a separate pipeline from the Agent Plugins 1.0.0 bundles
  described here.
