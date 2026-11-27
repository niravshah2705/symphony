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
| plugin | [egm](https://github.com/google/elephant-goldfish-model) | | 0.1.1 | 0.1.1 | | |
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
else in the matrix is `declared`. `egm` is `declared` *and* carries a
`limitations` entry in each filled cell — its skills mount and read correctly,
but the isolated reviewer session the workflow dispatches is not a capability
either native engine has yet ([why that is a limit, not a gap](#a-packs-skills-are-not-always-the-whole-pack)).

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
so the rule is an assertion rather than a comment. Because most published bases
are Alpine while the recorded lines are Debian-shaped, the same object also
carries `requirements.dockerfileAlpine[]`; a consumer picks one by the base's
package family and **refuses** rather than emitting `apt-get` onto an Alpine
image (`fleet-local/apps/control-plane/src/bundle/plugins.ts:requirementLines`).
`fleet-local/scripts/bundle/sync-plugin-catalog.mjs` mirrors both arrays into that
workspace's generated catalog, so the builder needs no checkout of this repo.

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

## A pack's skills are not always the whole pack

The bundle a `FROM scratch` image carries is `plugin.json` + `skills/` (+
`mcp.json`), which assumes each `SKILL.md` is self-contained. Review-and-design
packs break that assumption: all seven of `egm`'s skills cite files outside
`skills/` from the plugin root — four dispatch a reviewer prompt in `agents/`,
three score against standards in `resources/document_standards/`, and every one
points at an adaptation guide in `docs/*.md`. Mount `skills/` alone and the skill
fails at the step that reads the missing file, which is a long way from the
pack's `bundle.env`.

`PLUGIN_EXTRA_PATHS` is how a pack declares those companions: space-separated,
**upstream-relative** dirs or files, copied to the bundle root beside `skills/`.
Four rules make the input safe enough to reach a published image:

- an entry may not name `skills`, `plugin.json` or `mcp.json` — the composer
  authors those at the root, and an upstream root `plugin.json` would silently
  replace the manifest kagent reads;
- absolute, `..`, leading `.`/`-` and anything outside `[a-zA-Z0-9._/-]` are
  refused **before** the pin is fetched, so a bad spec leaves no partial tree;
- depth is preserved (`docs/codex.md` lands at `bundle/docs/codex.md`, not at
  the root) and extras are counted against kagent's entry and byte caps;
- a symlink or a secret-shaped basename inside a declared path fails the compose
  — the plain copy applies no deny list otherwise.

Then the gate that proves the feature: "copied" is not "reachable", so every
`SKILL.md` reference under a declared root must resolve inside the bundle. A
reference the pack did *not* declare is logged rather than failed, because the
same string can mean the user's own workspace — EGM's `docs/designs/<feature>.md`
is its project output directory, and the 296 KB of the upstream's own design
notes under that path are deliberately not shipped. The pack composes to 7
skills, 88 entries and 400 KB.

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
| `deploy/kagent/select-published-rows.py` | decides which rows a merge republishes, for both tracks |
| `deploy/kagent/pack-inputs.sh`, `skill-inputs.sh` | resolve one CSV row + `bundle.env` into composer inputs; local builds and CI both source them |
| `deploy/kagent/ecc-plugin/compose-bundle.sh` | fetch the pin, apply the skills allowlist + overlay + the pack's declared root files, author root `plugin.json`/`mcp.json`, then check the bundle against kagent's caps |
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
   whether it ships an `.mcp.json`, **and which files outside `skills/` its
   `SKILL.md` files read** — `grep -rnoE '(\.\./\.\./|^[a-z_]+/)[A-Za-z0-9._/-]+'
   skills/*/SKILL.md` at the clone. A pack that cites siblings is not
   self-contained and needs `PLUGIN_EXTRA_PATHS` (step 3).
2. Add the row to `plugins.csv` (or `skills.csv`) with the **full 40-hex** pin and
   `version_source`; keep `current: true` on exactly one row per pack.
3. Create `deploy/kagent/<pack>/` with `bundle.env` (upstream skill path,
   allowlist file, overlay dir, `mcp.json`, version source, and the
   upstream-relative `PLUGIN_EXTRA_PATHS` for any root-level companions) and
   `skills.txt`, plus `Dockerfile.<pack>-plugin` (`FROM scratch` + OCI labels).
4. Add the catalog record: versions list, icon, skills with `enabled` flags,
   `requirements` (`appliedTo` a harness runtime image), `promptAppend`, and the
   `harnesses` cells with `status`/`engine`/`blockedOn`. `status` describes what
   the mounted bundle *does* on that CLI, so a pack whose workflow needs a
   capability the engine lacks (isolated child agent sessions, hooks, commands)
   stays `declared` with the gap in that cell's `limitations[]` — the skills
   really mount, and `unsupported` would blank a cell that works and demand a
   `blockedOn` that is not a missing artifact. Keep `promptAppend` free of any
   promise the limitations contradict.
5. Commit `public/icons/plugins/<pack>.svg` — an original geometric mark, never
   fetched from the vendor's site.
6. `npm run plugins:seed && npm run plugins:manifests && npm run plugins:check &&
   npm run plugins:manifests:check`, then `bash deploy/kagent/test-pack.sh <pack>
   --quick`.
7. Open the PR: the plan job validates every row and **dry-composes** each
   selected bundle into the runner temp (no build, no push), so a bad allowlist
   name or a `PLUGIN_EXTRA_PATHS` entry absent upstream fails as a red PR
   instead of a failed merge build with an unstamped digest. The merge to main
   publishes the rows whose bytes moved, stamps the digest into the catalog, and
   regenerates the manifests. See [Publishing](#publishing-only-the-rows-whose-bytes-moved).

## Publishing: only the rows whose bytes moved

A bundle build is **not byte-reproducible**: multi-arch, `provenance: mode=max`
and the SBOM attach new timestamps on every run. So rebuilding a pack whose
inputs did not change would push new bytes under a tag that already names them,
and the stamp job would then rewrite that pack's committed manifest with a digest
no source change produced — every manifest of churn for a one-line CSV edit, and
no way to tell a real content change from a re-run. Both publish workflows
therefore select rows through `deploy/kagent/select-published-rows.py`, which
answers one question per merge: *which packs' bytes are different now?*

| the diff shows | selected | why |
|---|---|---|
| a PR run, or no usable baseline commit | **every row** | a PR publishes nothing, so the diff would only weaken the run that has to catch a bad row |
| a row whose fields differ (pin, version, `version_source`, image, `current`) | that row | the row *is* the input set: `pack-inputs.sh` reads nothing else from the CSV |
| a file inside `deploy/kagent/<pack>/` | that pack | `bundle.env`, `skills.txt`, `overlay/`, `mcp.json` and the `Dockerfile` all reach the bytes |
| a composer, `pack-inputs.sh`/`skill-inputs.sh`, a local builder, the selector, or the workflow itself | **every row** on that track | it changes the recipe for all of them at once |
| the other track's manifest or pack directory | nothing | two tracks publish different images from different inputs |
| `docs/`, `public/`, `packages/`, `scripts/`, `.githooks/`, `*.test.js`, `plugin-support.csv` | nothing | inert: the composers take every input from the environment the resolvers build, never from a catalog — `plugin-bundle.test.js` asserts that stays true |
| anything unrecognized | **every row** | under-building leaves a manifest naming bytes no recipe ever produced; over-building costs one workflow run |

Three consequences worth knowing before you debug a "why didn't it publish":

- **A skipped build skips its stamp.** The stamp job reads the
  `plugin-oci-ref-<pack>.txt` artifacts, and an unselected pack produces none, so
  its committed manifest keeps the digest that was actually published.
- **A moved branch does not lose a stamp.** A publish takes minutes, so another
  PR can reach `main` between the run's checkout and the stamp job's push — and
  the images are already in the registry by then, with the tags moved and the
  digests recorded nowhere. The stamp commit is *derived* output, so the retry
  re-derives it rather than replaying it: reset onto the new tip, re-run
  `stamp-plugin-digest.js` and `gen-kagent-manifests.js` against the `oci-refs`
  artifacts this run built, commit, and push again (bounded at 5 attempts, never
  `--force`). Replaying the diff was the flaw — two publishes of the same row
  rewrite the same catalog line and the same generated manifest, so the rebase
  conflicted and a human had to pick a winner while both runs' bytes sat in the
  registry; re-deriving lets the newer publish own the pin and leaves every other
  row's stamp intact. One case it still refuses: `plugins.csv` itself moved,
  because those digests belong to a row no longer current — re-dispatch with
  `rebuild: all`. `deploy/kagent/stamp-push-race.test.js` runs that block,
  verbatim from the workflow, against a throwaway origin for each outcome.
- **`workflow_dispatch` has `rebuild: all`** for the case the diff cannot see — a
  newer upstream image under the buildx layer, or a selector fix you want applied
  to every pack at once.
- **The first merge after this rule landed republished everything,** on purpose:
  the selector is itself a recipe file.

`build-plugin-image.sh` / `build-skill-image.sh` are unaffected — they take one
pack name and always build it.

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
node --test deploy/kagent/                                   # bundle + selection rules
# Replay a merge's row selection without pushing anything:
git diff --name-only HEAD~1 HEAD > /tmp/paths.txt
git show HEAD~1:deploy/kagent/plugins.csv > /tmp/base.csv
python3 deploy/kagent/select-published-rows.py --track plugin --mode changed \
  --manifest deploy/kagent/plugins.csv --base-csv /tmp/base.csv --paths /tmp/paths.txt \
  --selected /tmp/selected.txt
```

## Not in this track yet

- **`byo` runtime images.** The destination those strings point at is now part
  real: `go/harness/` holds ten per-CLI Dockerfiles,
  [`go/harness/runtime-images.csv`](../go/harness/runtime-images.csv) pins their
  versions and `build-runtime-images.yml` publishes them. **A build now does
  consume `requirements.dockerfile[]`** — the fleet-local bundle wizard renders
  those lines onto the selected base and pushes the result to Artifact Registry
  (`fleet-local/docs/SETUP-ENVIRONMENT.md` step 12). Still open is the dispatch
  half: the paths some records name (`go/harness/codex-sdk/`, `go/harness/dsh/`)
  are not among those ten, and only the `claude`/`codex`/`byo` cells have a chart
  engine, so a bundle built on the six experimental runtimes is an image without
  an in-cluster runner yet. Tracked as the runtime-image issue.
- **Isolated child agent sessions.** A pack whose workflow dispatches a fresh
  reviewer into a session of its own — EGM's `agents/*.md` prompts — mounts the
  prompts but cannot run them that way. The root manifest we author carries a
  `skills` key and nothing else, no engine reads an `agents/` directory, and
  both native engines record Subagents as `◑` (shared local only / shared
  agents, no child-approval) in
  [`HARNESS_CAPABILITY_MATRIX.md`](./HARNESS_CAPABILITY_MATRIX.md). EGM is the
  first pack where that cell is a functional limit rather than a
  nice-to-have, so it ships `declared` with the gap in each cell's
  `limitations[]`, and its `promptAppend` tells the agent to run the review
  in-context and label it as such rather than imply fresh eyes.
- **Live activation.** Nothing outside the generators and the store mirror reads
  these catalogs yet: a bundle reaches an agent because an operator applies the
  pack's four-CR set, not because a loader resolved it at run time. Wiring the
  designer and the planner to the catalog records (icon, skills, `promptAppend`)
  is the follow-up this track sets up but does not perform.
- **The harness-rootfs registry.** `sync-harness-registry.yml` still resolves
  only ECC and `artifact-builder.js` skips other marketplaces; that npm/SDK
  attach format is a separate pipeline from the Agent Plugins 1.0.0 bundles
  described here.
