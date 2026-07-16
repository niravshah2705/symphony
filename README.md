# AI Fleet

A simple Node.js UI (branded **AI Fleet**) to manage Linear projects:

> **New here?** Start with the [Developer Onboarding guide](docs/DEVELOPER_ONBOARDING.md)
> — prerequisites, start commands, first-run config, and the code map.

- **Projects** — project list + a **milestone planning view** (timeline of milestones with issues grouped under each).
- **Board** — Linear issues shown as a Kanban **board** by workflow state, with drag-and-drop to move issues between columns.
- **Business** — a Business tab where each business is backed by a Linear project in the background. **OTA** is pre-seeded as the initial business.
- **Agent** — a **business-owner planning deep agent** (Ollama, LM Studio, Codex, or Claude + web search) enriches projects **carrying any of the chosen labels** (default `AI`): it checks business viability (unfit → `aifail`), writes a business plan — **MVB** (Minimal Viable Business) first, then business metrics, branding, and beyond — creates milestones, tasks, and dependencies, and marks the project **`aidone`** once issues exist. Interrupted projects **resume on restart** (missing issues get created). Projects are **discovered and processed on a configurable 5/10/15-minute schedule**.
- **Code-writer agent** — a second deep agent that works a **single Linear ticket end-to-end** inside an **isolated git clone**: it implements the change, keeps one **`## Workpad`** comment as the source of truth, and drives the ticket through its state machine to a **pull request** (stamped with a configurable label). A board monitor polls active-state tickets and dispatches runs up to a concurrency cap. See [Code-writer agent](#code-writer-agent) below.
- **Settings** — a tidy page of **collapsible sections**: **API Keys & Connection** (Linear + LangSmith key/host/project/tracing), **Deep Agent LLM** (provider, model, and model-aware reasoning dropdowns for each route, with collapsed parameter customization), **Assume Role**, and **Deep Agent** (enrich labels, schedule cadence, parallelism, caps, toggles). All secrets are validated/stored **server-side** (never exposed to the browser).

## Demo

AI Fleet in action — from creating a business to shipping merged PRs:

**1. Create a business** — each business is backed by a Linear project.

![Create a business](docs/demo-1-create-business.gif)

**2. The planning deep agent runs** — viability check and web research, then milestones, tasks, and dependencies.

![Planning agent enriches the project](docs/demo-2-agent-plan.gif)

**3. Issues land on the board** — AI-generated issues grouped by workflow state.

![Issues board](docs/demo-3-issues-board.gif)

**4. The code-writer agent ships PRs** — each ticket driven end-to-end to a merged pull request.

![Merged pull requests](docs/demo-4-merged-prs.gif)

## Settings

Collapsible sections:

1. **API Keys & Connection** — the Linear and LangSmith keys together, plus the LangSmith **host/endpoint**, project, and tracing toggle. One **Save keys** button; the Linear key is validated on save and connection status is shown.
2. **Deep Agent LLM** — choose **Provider**, **Model**, and **Reasoning** for each route. The **Local / XS** route offers Ollama and LM Studio; the **Hosted / planner + larger tasks** route offers OpenAI and Anthropic. Selecting a model atomically applies its recommended context, output, sampling, and provider-native reasoning defaults. Expand **Customize parameters** to change supported numeric values later.
   - **Ollama / LM Studio (local)** — no API key is required. The page renders immediately, discovers loaded models asynchronously, and offers a refresh action. LM Studio's configured context must match the context used when loading the model, and its output budget is capped at half that context so prompt and output fit together.
   - **OpenAI / Codex OAuth** — **Sign in with ChatGPT** using OAuth 2.0 Authorization Code + PKCE. The model list is refreshed from the signed-in Codex account with a bundled current fallback. Reasoning choices are model-specific: for example, GPT-5.6 Sol and Terra expose Low through Ultra, while GPT-5.5 exposes Low through Extra high. `ultra` is sent only to the ChatGPT/Codex backend.
   - **Anthropic / Claude OAuth** — **Sign in with Claude**, approve in the opened tab, then paste the returned `code#state`. Available models are queried from Anthropic with bundled fallbacks, and only each model's advertised adaptive-thinking effort values are shown.

The committed source of truth is [`packages/shared/src/agent/llm-presets.json`](packages/shared/src/agent/llm-presets.json). It separates model limits from request defaults and records the exact reasoning adapter used by each provider.
3. **Assume Role** — pick a workspace member (validated server-side). The assumed role owns enriched projects and is shown in the **top toolbar**.
4. **Deep Agent** — **enrich labels** (multi-select dropdown of your Linear project labels), **scheduler cadence** (5 / 10 / 15 minutes), parallelism, and per-run/milestone/issue caps, plus toggles.

## Agent tab (project enrichment)

- **Auto Enrichment** — open projects (no lead) carrying any selected label are **picked up automatically** on the schedule. The Agent tab shows a read-only preview of what the next run will process and a **Run now** button; there is no manual project list. Assume a role in **Settings** first (the section is disabled and server-enforced until then). For each project the deep agent:
  - generates a validated plan (description + milestones + dates + issues + dependencies) under **LangSmith tracing**;
  - the server deterministically applies it to Linear using your **existing Linear token**: assign lead, update description, create milestones (start date preserved in the milestone note, target date = stop date), create issues per milestone, and create `blocks` dependencies.
- **Enrichment Jobs** — live status (pending → running → done/error), a per-job **Trace** link into LangSmith, and per-job/finished cleanup.

### How the deep agent works (business-owner planner)

The agent plans **as a business owner**, not a software PM — it does **not** produce a software development lifecycle. It is built on `deepagents` (LangGraph), provider-specific LangChain clients for Ollama, LM Studio, OpenAI, and Anthropic, plus keyless **web search** (DuckDuckGo); tracing uses the `langsmith` SDK. Steps, all traced and recorded on the job:

1. **Viability gate** — web-researches the domain and decides whether the project is a business product that can be delivered as a software-driven solution. **If not viable**, it appends a note to the project description and switches the project's label to **`aifail`** (removing the enrich label, so it isn't retried) — no milestones are created.
2. **Business plan** — if viable, it web-researches each phase and drafts business milestones in order:
   - **MVB — Minimal Viable Business** (first): the smallest workable product; tasks are the essential **features** to launch.
   - **Business Metrics**: the KPIs to instrument (acquisition, activation, retention, revenue).
   - **Branding**: brand identity & presence.
   - then further business milestones (Go-to-Market, Monetization, Growth).
   Every **milestone** gets a measurable **evaluation criterion** (success/exit criteria, appended to the milestone description as `**Evaluation criteria:** …`), and every **feature/issue** gets an **acceptance criterion** (definition of done, appended to the issue description as `**Acceptance criteria:** …`). Resume runs add these to existing milestones too.
3. The selected provider emits the plan using its configured structured-output or prompt-driven JSON mode; it is validated with Zod and clamped. The **server performs all Linear writes** (deterministic guardrail).

**Label lifecycle & resume.** A project is *managed* while it carries the enrich label (default `AI`). On completion its label is switched (replacing the enrich label, so it drops out of discovery):
- **`aidone`** — once the project's issues have been created.
- **`aifail`** — when the viability check fails.

If a run is interrupted after milestones are created but before issues (crash/restart), the project keeps the enrich label. On the next tick — and **immediately on restart** — the agent **reviews the existing milestones and creates the missing issues** (researching tasks per milestone), then marks the project `aidone`. Milestones that already have issues are left untouched (no duplicates).

- **Local-first (Ollama or LM Studio):** run a tool-capable model locally and choose its preset. Nothing is sent to a hosted LLM for locally routed XS tasks. Ollama receives `think`; compatible LM Studio GPT-OSS runtimes receive `reasoning_effort`.
- **Codex (OpenAI) provider:** the same deep-agent pipeline runs against OpenAI (`@langchain/openai` → `ChatOpenAI`) when the hosted preset is Codex, authenticated by the OAuth flow above. The ChatGPT backend uses Responses-format JSON and reasoning effort; tokens are refreshed on demand before each run.
- **Claude (Anthropic) provider:** the same pipeline runs against Anthropic (`@langchain/anthropic` → `ChatAnthropic`) when the active provider is **Claude**, authenticated by the Claude OAuth flow above (subscription bearer token + `anthropic-beta` header). Tokens are refreshed on demand before each run.
- **Web search** runs **in parallel**: the deep agent's `web_search` tool takes an array of queries and fans them out concurrently, and the per-phase / per-milestone research searches are issued together (`webSearchMany` → `Promise.all`). Results are untrusted and fenced as data in prompts (prompt-injection defense), like Linear content.

## Code-writer agent

A second deep agent (a focused equivalent of OpenAI Symphony, built on `deepagents`
instead of Codex) works a **single Linear ticket end-to-end** inside an **isolated
git clone** and drives it to a pull request. It reuses the same LLM provider chosen
in **Deep Agent LLM** (local Ollama/LM Studio or hosted Codex/Claude, routed by issue label).

- **One attempt per ticket** (`packages/shared/src/agent/coder.js`) — the agent runs in an
  isolated workspace (a per-ticket clone under `CODER_WORKSPACE_ROOT`). It has
  filesystem + shell tools (rooted at the clone), an injected **`linear_graphql`**
  tool (the raw Linear token stays server-side — the agent never sees it), and a
  set of **skills** (`linear`, `commit`, `push`, `pull`, `land`) loaded from
  `packages/shared/src/agent/skills/`. Its system prompt is the **workflow** (ticket state
  machine + a single `## Workpad` comment as the source of truth).
- **Board monitor** (`packages/shared/src/agent/coder-orchestrator.js`) — on a fixed cadence it
  polls the tracker for tickets in an **active state**
  (`Todo, In Progress, Merging, Rework` by default) and dispatches a code-writer
  run per ticket, up to a global concurrency cap. State is in-memory and re-derived
  from the tracker on restart (single-writer model: a ticket is never dispatched
  twice concurrently). It does **not** start automatically — start it via the API.

### Configuring the code-writer

All values are env-overridable (`CODER_*`, see `packages/shared/src/config.js`):

| Env var | Default | Purpose |
| ------- | ------- | ------- |
| `CODER_REPO_URL` | *(empty)* | Repository the agent clones per ticket (**required**). |
| `CODER_WORKSPACE_ROOT` | `~/code/techmavins-workspaces` | Where isolated clones live. |
| `CODER_ACTIVE_STATES` | `Todo,In Progress,Merging,Rework` | Ticket states the monitor acts on. |
| `CODER_TERMINAL_STATES` | `Done,Closed,Cancelled,Canceled,Duplicate` | States left alone. |
| `CODER_MAX_TURNS` | `40` | `deepagents` recursion budget per run. |
| `CODER_MAX_CONCURRENT` | `3` | Max tickets worked concurrently. |
| `CODER_POLL_INTERVAL_MS` | `15000` | Board-monitor poll cadence. |
| `CODER_SHELL_TIMEOUT_SEC` | `600` | Shell command timeout in the workspace. |
| `CODER_PR_LABEL` | `techmavins` | Label stamped on the agent's PRs. |

### Running the code-writer

```bash
# status + in-flight tickets
curl http://localhost:4000/api/coder

# run the code-writer on ONE ticket (async — watch the logs / Linear Workpad)
curl -X POST http://localhost:4000/api/coder/run \
  -H 'content-type: application/json' -d '{"issueId":"<issue-uuid>"}'

# start / stop the board monitor
curl -X POST http://localhost:4000/api/coder/monitor \
  -H 'content-type: application/json' -d '{"action":"start"}'
```

Progress is reported to the server logs (`data/app.log`) and to the ticket's
`## Workpad` comment in Linear.

## Security notes

- **Role assumption is enforced server-side** — enrich endpoints return `403` without an assumed role; the assumed member id is validated against the real workspace member list.
- **Secrets stay on the server** — Linear/LangSmith keys and **Codex/Claude OAuth tokens** live only in `data/store.json`, are masked in API responses, and are never sent to the browser. Ollama needs no key.
- **Codex OAuth** — Authorization Code + **PKCE (S256, never `plain`)**; a cryptographically-random, server-issued, **single-use** `state` guards the callback against CSRF/replay; the `redirect_uri` is server-derived and reused exact-match in the code exchange; **refresh tokens rotate** on use. Provider endpoint URLs + client id are trusted server-side config and are **not** accepted from request bodies. Browser-settable preset overrides are allowlisted, normalized, and model-family checked.
- **Claude OAuth** — the same Authorization Code + **PKCE (S256)** guarantees: a single-use, server-issued `state` is echoed back inside the pasted `code#state` and matched against a login we issued (CSRF/replay guard); provider URLs, client id, and scope are trusted server-side config (env-overridable via `CLAUDE_OAUTH_*`) and are **not** taken from the browser. Tokens are stored server-side, refreshed automatically, and sent as `Authorization: Bearer` with the `anthropic-beta: oauth-2025-04-20` header (never `x-api-key`).
- **Local inference hosts** — operator-configured settings are restricted to `http`/`https`, normalized on save, and never accepted from an agent inference call. This is a local single-user tool, so localhost is the intended target.
- **Prompt-injection defenses** — Linear-sourced project text is fenced in a `<project_context>` block and treated strictly as data; LLM output is schema-validated and clamped (milestone/issue caps, date ordering, dependency indices re-checked before any write).
- **Runaway guards** — bounded output via `num_predict`, bounded agent recursion, a per-tick project cap, and the configurable cadence throttle processing.

## Architecture

- See [Architecture Diagram](docs/ARCHITECTURE_DIAGRAM.md) for the visual system
  map covering preset-routed local and hosted inference, Linear ticket management,
  DeepAgent skills, and Linear/GitHub integrations.

The app is an **npm-workspaces monorepo** decomposed into **three isolated
services over one shared library**. Each service is an independently runnable
Express process with its own port and HTTP surface; all business logic lives in
a single shared package (`@ai-fleet/shared`) so nothing is copied per service.

- **`packages/shared`** (`@ai-fleet/shared`) — the single source of truth:
  config, JSON store, Linear GraphQL client, logger/util, and the whole
  deep-agent runtime (framework, tools, skills, LLM router, planner + coder
  modules). Imported by every service; never duplicated.
- **`services/gateway`** (`@ai-fleet/gateway`, default port 4000) — the only
  browser-facing origin. Serves the SPA, owns the user-facing REST API
  (settings, projects, issues, businesses, roles) and the OAuth flows, and
  **reverse-proxies** `/api/agent/*` → planner and `/api/coder/*` → coder.
- **`services/planner`** (`@ai-fleet/planner`, default port 4010) — the isolated
  software-design planner (deep agent + enrichment scheduler); exposes `/api/agent`.
- **`services/coder`** (`@ai-fleet/coder`, default port 4020) — the isolated
  code-writer (board monitor + single-ticket runner); exposes `/api/coder`.
- **Frontend** (`public/`) — a dependency-free vanilla-JS single-page app (ES
  modules) served by the gateway. It calls same-origin `/api/*` and is unaware
  of the split (the gateway proxies agent calls to the agent services).

```
packages/shared/
  index.js              barrel (CONFIG, store, linear, log, util)
  src/
    config.js           constants + paths (repo-root data/public) + SERVICES topology + OAuth/CODER config
    store.js            JSON-file store (settings, businesses, assumed role, agent config, jobs)
    linear.js           Linear GraphQL client (queries/mutations)
    logger.js  util.js  stdout + data/app.log logger · asyncHandler/JSON error/maskKey
    agent/
      framework.js        workflow-driven deep-agent runner (skills + tools + backend)
      workflows/          planning.workflow.js · coding.workflow.js (declarative)
      schema.js plan.js apply.js scheduler.js search.js   ← planner
      coder.js coder-orchestrator.js workspace.js openswe.js  ← code-writer
      tools.js mcp.js safe-read.js   built-in tools (web_search, linear_graphql) + optional MCP
      llm.js llm-presets.json model-presets.js model-discovery.js lmstudio-context.js  ← LLM router + catalog
      oauth.js pkce.js claude-oauth.js trace-annotations.js
      skills/           software-planning · web-research · linear · commit · push · pull · land (SKILL.md each)
services/
  gateway/src/   index.js · proxy.js · routes/ (settings, projects, issues, businesses, roles, codex, claude)
  planner/src/   index.js (boots scheduler) · routes/agent.js
  coder/src/     index.js (boots board monitor) · routes/coder.js
scripts/
  start-all.js          boot all three services from one terminal (prefixed output)
  models-label-group.js one-off: create the Linear "Models" label group
public/
  index.html · styles.css · js/ (app.js router · api.js · dom.js · state.js · views/)
```

## Run

```bash
npm install        # installs all workspaces

npm start          # boots gateway (:4000) + planner (:4010) + coder (:4020)
# or: npm run dev  # same, each service under node --watch

# run a single service (e.g. only the gateway):
npm run start:gateway   # or start:planner / start:coder
```

Ports are env-overridable: `PORT` (gateway), `PLANNER_PORT`, `CODER_SERVICE_PORT`.
To run services on different hosts, point the gateway at them with `PLANNER_URL`
and `CODER_URL`. The shared `data/store.json` location can be overridden with
`AI_FLEET_DATA_DIR`.

Then open http://localhost:4000, go to **Settings**, and paste a Linear
**personal API key** (create one at https://linear.app/settings/api). The key is
validated against Linear before it is saved.

## Using it

1. **Settings** → save your Linear API key. The header shows connection status.
2. **Projects** → click a project to open its milestone planning timeline.
3. **Board** → pick a project; drag issue cards between state columns to update them in Linear.
4. **Business** → OTA is already there. Link it to an existing Linear project, or
   create a new project for it (choose a team). Add more businesses the same way;
   each maps to one Linear project. Use the **Planning** / **Board** buttons to jump
   straight to that business's project views.
5. **Settings** → in **Deep Agent LLM** pick one local preset and one hosted preset.
   Start Ollama or LM Studio for the local route; for Codex click **Sign in with
   ChatGPT**, or for Claude click **Sign in with Claude** and paste back the `code#state`.
   Recommended parameters are applied automatically; customization is optional.
   optionally add the LangSmith key +
   host in **API Keys**; in **Assume Role** pick a member (it appears in the
   toolbar); in **Deep Agent** choose **enrich labels** and cadence (5/10/15 min).
   Then the **Agent** tab enriches matching open projects automatically (or click
   **Run now**). Watch jobs and open their LangSmith **Trace**.

## Logs & traces

Every step is logged to **stdout and to `data/app.log`** (boot, scheduler ticks,
project discovery, and per-job steps: deep-agent pass → structured plan →
milestone/issue/dependency creation → done/error).

View the log:

```bash
# follow live
tail -f data/app.log

# last 50 lines
tail -n 50 data/app.log

# only one project / only errors
grep "Agoda" data/app.log
grep -E "WARN|ERROR" data/app.log
```

In the UI, each row in **Agent → Enrichment Jobs** has a **🧾 N** button that
expands the stored **step trace** for that job (timestamped, warnings/errors
highlighted). Steps persist in `data/store.json`, so you can review them later.
On restart, any job left mid-run is marked *interrupted* (and retried next tick)
rather than stuck in "running".

## API (backend)

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/api/settings` | Whether a key is set (masked) |
| PUT | `/api/settings` | Validate + save API key |
| DELETE | `/api/settings` | Remove key |
| GET | `/api/settings/llm-presets` | Shared local + hosted LLM preset JSON catalog |
| PUT | `/api/settings/llm-preset` | Atomically apply a role preset plus safe optional overrides |
| PUT | `/api/settings/llm-selection` | Select a provider/model or change only its validated reasoning effort |
| GET | `/api/settings/codex/models` | Discover signed-in Codex models (`?refresh=1` bypasses cache) |
| GET | `/api/settings/claude/models` | Discover signed-in Anthropic models (`?refresh=1` bypasses cache) |
| GET | `/api/projects` | List Linear projects |
| GET | `/api/projects/teams` | List teams (for new projects) |
| GET | `/api/projects/:id/milestones` | Milestone planning data |
| GET | `/api/issues/board/:projectId` | Issues grouped into board columns |
| PATCH | `/api/issues/:id/state` | Move an issue to another state |
| GET/POST/PUT/DELETE | `/api/businesses[...]` | Manage businesses ↔ project mapping |
| PUT | `/api/settings/llm` | Save Ollama config (host, model, num_ctx, num_predict) |
| PUT | `/api/settings/lmstudio` | Save legacy/custom LM Studio config |
| PUT | `/api/settings/langsmith` | Save LangSmith config (key masked) |
| GET/POST/DELETE | `/api/settings/codex[...]` | Codex provider status / model / sign-out (`/login`, `/exchange` for OAuth) |
| GET/POST/DELETE | `/api/settings/claude[...]` | Claude provider status / model / sign-out (`/login`, `/exchange`, `/test` for OAuth) |
| GET | `/api/agent/ollama-models` | Models installed on the configured Ollama host |
| GET | `/api/agent/lmstudio-models` | Models exposed by the configured LM Studio server |
| GET | `/api/roles/members` | Assumable workspace members |
| GET/PUT/DELETE | `/api/roles/assumed` | Get / assume (validated) / clear the role |
| GET/PUT | `/api/agent/config` | Agent config (labels, interval, parallelism, caps, model, toggles) |
| GET | `/api/agent/models` | Local model + interval (5/10/15) choices |
| GET | `/api/agent/labels` | Distinct Linear project labels (for the dropdown) |
| GET | `/api/agent/status` | Scheduler + readiness (LLM/tracing/role/labels/interval) |
| GET | `/api/agent/candidates` | Preview of labelled projects to be processed *(role required → 403)* |
| POST | `/api/agent/run-now` | Trigger a scheduler tick now (auto-discovers by label) |
| GET/DELETE | `/api/agent/jobs[...]` | Job history / cleanup |
| GET | `/api/coder` | Code-writer monitor status + in-flight tickets |
| POST | `/api/coder/run` | Run the code-writer on one ticket `{ issueId }` |
| POST | `/api/coder/monitor` | Start/stop the board monitor `{ action }` |

## Notes

- `data/` (contains your saved keys, assumed role, config, and jobs) is git-ignored.
- Board columns are derived from the workflow states present on the project's
  issues, ordered: triage → backlog → unstarted → started → completed → canceled.
- Linear project milestones only carry a target date, so each milestone's **start
  date is preserved in its description** (`Timeline: start → target`) and the target
  date is used as the stop date.
- The scheduler starts with the server and runs on the configured cadence
  (5/10/15 min), plus a one-off **resume pass a few seconds after restart**. Each
  tick it **auto-discovers** projects still carrying an enrich label and processes
  them — only once a role is assumed, the Linear key is set, and an LLM provider
  (Ollama / LM Studio / Codex / Claude) is fully configured. Completed projects become
  `aidone` / `aifail` (the label is replaced), so they drop out of discovery and
  are not re-processed.
- **An LLM provider is required** for enrichment and the code-writer. For **Ollama**
  or **LM Studio** (local): install it, run it, and load a tool-capable model — local inference is
  slower than a hosted API (expect tens of seconds per project depending on
  model/hardware). For **Codex**/**Claude**: complete the OAuth sign-in in Settings.
