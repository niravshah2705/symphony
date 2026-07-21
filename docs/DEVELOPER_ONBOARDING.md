# AI Fleet — Developer Onboarding

Welcome! This guide gets a new developer from a fresh clone to a running app,
explains what the software does, and points you at the code you'll be working in.

> **What is this?** AI Fleet (repo `tech-symphony`) is a **single-user** tool with
> a dependency-free vanilla-JS single-page frontend, decomposed into **three
> isolated Node.js + Express services over one shared library** (an npm-workspaces
> monorepo — see §6). It manages **Linear** projects/issues **and** runs two AI
> "deep agents" against them, each living in its own service:
> 1. a **business-owner planner** that turns a labelled Linear project into a full
>    business plan (milestones + issues), and
> 2. a **code-writer** that works a Linear ticket end-to-end inside an isolated git
>    clone (branch → commit → push → PR), driven by the ticket's state machine.

---

## 1. Prerequisites

| Requirement | Notes |
| ----------- | ----- |
| **Node.js ≥ 18** | Repo is developed on Node 20. Check with `node -v`. |
| **A Linear account + personal API key** | Create one at <https://linear.app/settings/api>. Required for every feature. |
| **LLM routes** (for the agents only) | For full routing, configure one local preset (Ollama, LM Studio, or OMLX) and one hosted preset (OpenAI or Claude OAuth). Not needed just to browse projects/board. |
| **git** | Required by the **code-writer** agent (it clones and pushes). |
| **Ollama** (optional) | Only if you use the Ollama local route. Install from <https://ollama.com>, then `ollama pull gpt-oss:20b` (or another model offered by the preset dropdown). |
| **LM Studio** (optional) | Only if you use the LM Studio local provider (handy for models not in Ollama's catalog). Install from <https://lmstudio.ai>, load a **tool-capable** model, then start its server (Developer → Start Server, default `http://localhost:1234`). |
| **OMLX** (optional) | Only if you use the OMLX local provider. On an Apple Silicon Mac running macOS 15 or newer, install and start [OMLX](https://github.com/jundot/omlx) with a model or profile available; its default origin is `http://127.0.0.1:8000`. |

No database, no build step, no framework — the frontend is plain ES modules
served straight from `public/`.

---

## 2. Install & start (the commands)

```bash
# from the repo root: /Users/niravshah2705/git/reasearch/tech-symphony

npm install            # install ALL workspaces (one time)

npm start              # boot the whole fleet:
                       #   gateway  → http://localhost:4000  (SPA + API + proxy)
                       #   planner  → http://localhost:4010  (internal)
                       #   coder    → http://localhost:4020  (internal)
# or
npm run dev            # same, each service under node --watch

# run one service at a time (they share data/store.json):
npm run start:gateway  # or start:planner / start:coder

npm test               # run the whole suite (node --test) — tests live in packages/shared
```

Override ports with env vars — `PORT` (gateway), `PLANNER_PORT`, `CODER_SERVICE_PORT`:

```bash
PORT=5000 npm start    # gateway → http://localhost:5000
```

If the agent services run on other hosts, tell the gateway where with `PLANNER_URL`
and `CODER_URL`. Move the shared store with `AI_FLEET_DATA_DIR`.

Then open **<http://localhost:4000>** in a browser. On first launch you'll be
prompted to add a Linear API key before any view will load.

### What happens on boot
`npm start` runs `scripts/start-all.js`, which spawns the three service
processes with prefixed output:
- **gateway** (`services/gateway/src/index.js`) wires the user-facing routes,
  serves the SPA, and **reverse-proxies** `/api/agent/*` → planner and
  `/api/coder/*` → coder. It is the only browser-facing origin.
- **planner** (`services/planner/src/index.js`) mounts `/api/agent` and
  **starts the enrichment scheduler** (`scheduler.startScheduler()`), which also
  reconciles interrupted jobs.
- **coder** (`services/coder/src/index.js`) mounts `/api/coder` and **starts the
  board monitor** so `aiplanned` projects are picked up automatically (each poll
  self-guards on missing keys).

All three import the same `@ai-fleet/shared` library, so there is exactly one
copy of every module (config, store, Linear client, deep-agent runtime).

---

## 3. First-run configuration (Settings tab)

Everything is configured in the UI under **Settings** — no `.env` file is
required for normal use. Secrets are validated and stored **server-side** in
`data/store.json` and are never sent back to the browser.

1. **API Keys & Connection** → paste your **Linear personal API key**. It is
   validated against Linear on save; the header shows connection status.
   (Optional: add a **LangSmith** key + host to trace agent runs.)
2. **Task Models** → assign a model to each task role ("models as tasks"):
   **Thinking** (task planning — used by the planner), **Execution** (coder —
   used by the code-writer), and **Testing** (tool calling — reserved, not used
   yet). Each role picks any provider — local (Ollama / LM Studio / OMLX) or
   hosted (OpenAI / Anthropic). Selecting a preset applies its model,
   context/output budgets, sampling, JSON mode, and native reasoning control
   together. Expand **Customize parameters** only for an override; **Reset to
   recommended** restores the JSON catalog values.
   - **Local providers (Ollama / LM Studio / OMLX)** — detected compatible model
     ids can be mapped from the status row. Configure the local connection in its
     card (defaults: Ollama `:11434`, LM Studio `:1234`, OMLX
     `http://127.0.0.1:8000`). Ollama and LM Studio need no key; OMLX accepts
     either the origin or a trailing `/v1`, discovers models from `GET /v1/models`,
     and only needs a key when its server has API-key protection enabled. LM
     Studio's context must match the loaded model context.
   - **Hosted providers (OpenAI / Anthropic)** — for OpenAI, click **Sign in with
     ChatGPT**. For Claude, click **Sign in with Claude** and paste back the
     `code#state` Anthropic gives you.
3. **Assume Role** → pick a workspace member. The business-owner agent's enrich
   endpoints are **403 until a role is assumed** (server-enforced). The assumed
   member shows in the top toolbar.
4. **Deep Agent** → choose **enrich labels** (default `AI`), scheduler cadence
   (5/10/15 min), parallelism, and caps. **Auto-attach enrich labels to new
   projects** (on by default) stamps those labels on any Linear project created for
   a new business, so it's immediately picked up by the enrichment scheduler.

---

## 4. Workspace views (using the app)

The SPA (`public/js/app.js`) hash-routes between workspace views; the core planning/history views are:

| Tab | What it does | View file |
| --- | ------------ | --------- |
| **Business** | Map a "business" to a backing Linear project (OTA is pre-seeded). Jump to its Planning/Board. | `public/js/views/business.js` |
| **Projects** | Project list + a milestone **planning timeline** per project. | `public/js/views/projects.js` |
| **Board** | Kanban board of a project's issues by workflow state, drag-and-drop to move. | `public/js/views/board.js` |
| **Agent** | Conversational planning workspace, local enrichment, and a five-item recent-work preview. | `public/js/views/agent.js` |
| **Agent jobs** | Complete planner and coding history with status, trace/task links, expandable steps, and cleanup controls. | `public/js/views/agent-jobs.js` |
| **Settings** | Everything in §3. | `public/js/views/settings.js` |

---

## 5. The two deep agents (developer mental model)

Each agent runs in its **own service** (`services/planner`, `services/coder`),
but both are built from the SAME **workflow-driven framework** that lives once in
the shared library (`packages/shared/src/agent/framework.js`), configured by a
declarative *workflow file* (`agent/workflows/*.workflow.js`). A workflow declares
its **skills**, **tools**, backend, and system prompt; the framework installs the
skills, builds the `deepagents` agent (FilesystemBackend for the planner,
LocalShellBackend for the coder), and runs it. Both share the LLM provider factory
(`agent/llm.js` → `resolveLlm`), which resolves a model by **task role**: the
planner runs on the **`thinking`** role and the coder on the **`execution`** role
(`testing` is reserved for tool-calling agents and not wired to a consumer yet).
Each role independently names any provider — local (Ollama / LM Studio) or hosted
(OpenAI / Anthropic) — and reuses that provider's shared config block. Repoint a
role in **Settings → Task Models** to change which model runs that task.

> **Legacy note:** the planner may still stamp `local`/`hosted` size labels under
> the **`Models` issue-label group** (`CONFIG.CODER.modelLabelGroup`) for
> reporting, but they no longer influence model selection — the coder always uses
> the `execution` model. `node scripts/models-label-group.js` still manages that
> label group.

- **Skills** (`skills/<name>/SKILL.md`) = instructions loaded on demand:
  `software-planning`, `web-research` (planner); `linear`, `commit`, `push`,
  `pull`, `land` (coder).
- **Tools** (`tools.js`) = `web_search`, `linear_graphql`. Optionally, **MCP tool
  groups** (`mcp.js`) — Linear MCP + GitHub MCP — attach when enabled
  (`LINEAR_MCP_ENABLED`, `GITHUB_MCP_TOKEN`); off by default.

The 3-step pipeline: **idea → project (+labels)** (businesses route, deterministic)
→ **software-design issues (AI-labeled)** (planner) → **coding on unblocked AI
tickets** (coder, scheduled + parallel).

### 5.1 Software-design planner (auto-runs on a schedule)
- **Files:** `workflows/planning.workflow.js` + `skills/software-planning`,
  `plan.js` (feasibility + framework draft + structured extraction + tracing),
  `schema.js` (Zod plan schema), `apply.js` (deterministic Linear writes; stamps
  each issue with the **AI** label), `scheduler.js` (5/10/15-min queue),
  `search.js` (keyless web search).
- **Flow:** discovers open projects carrying an enrich label → feasibility gate
  (buildable software? unfit → `aifail`) → the **planning workflow** drafts a
  SOFTWARE DESIGN plan (engineering milestones: Architecture → Data Model → Core
  Features → APIs → Quality; **no** go-to-market/business tasks) → **the server**
  applies it to Linear (milestones + AI-labeled issues + dependencies) → relabels
  the project `aidone`.
- **Guardrail:** the LLM only *proposes*; all Linear writes are deterministic
  server-side after Zod validation + clamping. Interrupted runs resume on restart.
- **Trigger it:** Agent tab → **Run now**, or `POST /api/agent/run-now`.

### 5.2 Code-writer (works an AI-labeled Linear ticket into a PR)
- **Files:** `workflows/coding.workflow.js` + `skills/` (linear, commit, push,
  pull, land), `coder.js` (one attempt; picks the execution backend),
  `coder-orchestrator.js` (board monitor), `workspace.js` (isolated git clone),
  `openswe.js` (Open SWE backend adapter).
- **Flow:** the monitor polls active-state tickets **carrying the `AI` label** and
  **not blocked by an unfinished dependency**, and dispatches up to `maxConcurrent`
  in parallel. Each ticket runs on the selected backend:
  - `CODER_BACKEND=local` (default) — framework coding workflow: a deepagents agent
    on a LocalShellBackend rooted at an isolated clone (the local sandbox). Keeps a
    single **"## Workpad"** Linear comment and drives the ticket to a PR.
  - `CODER_BACKEND=openswe` — dispatches to a running **Open SWE** LangGraph server
    (see [OPENSWE_SETUP.md](./OPENSWE_SETUP.md)); Open SWE runs the coding loop in
    its (optionally local) sandbox and opens the PR.
- **Config:** `CODER_*` env vars in `packages/shared/src/config.js` — `CODER_REPO_URL`,
  `CODER_WORKSPACE_ROOT`, `CODER_TASK_LABEL` (default `AI`), `CODER_BACKEND`.
- **Trigger it:**
  - one ticket → `POST /api/coder/run` with `{ "issueId": "..." }`
  - start/stop the board monitor → `POST /api/coder/monitor` with `{ "action": "start" | "stop" }`
  - status → `GET /api/coder`

---

## 6. Architecture map

The repo is an **npm-workspaces monorepo**: one shared library, three isolated
service processes. `data/store.json` and `public/` live at the repo root and are
shared by all services (resolved via `@ai-fleet/shared/config`).

```
packages/shared/              @ai-fleet/shared — ONE copy of all business logic
  index.js                    barrel (CONFIG, store, linear, log, util)
  src/
    config.js                 constants + repo-root paths + SERVICES topology + OAuth/CODER config
    store.js                  JSON-file store  →  data/store.json
    linear.js                 Linear GraphQL client (server holds the key)
    logger.js  util.js        stdout + data/app.log · asyncHandler/sendError/maskKey
    agent/
      framework.js              workflow-driven deep-agent runner (skills + tools + backend)
      workflows/                planning.workflow.js · coding.workflow.js (declarative)
      tools.js mcp.js safe-read.js   tool registry (web_search, linear_graphql) + optional MCP
      skills/                   SKILL.md dirs: software-planning, web-research, linear, commit, push, pull, land
      plan.js schema.js apply.js scheduler.js search.js   ← software-design planner
      coder.js coder-orchestrator.js workspace.js openswe.js  ← code-writer (+ Open SWE)
      llm.js llm-presets.json model-presets.js model-discovery.js lmstudio-context.js  ← LLM router + catalog
      oauth.js pkce.js claude-oauth.js trace-annotations.js
      *.test.js                 the whole test suite (node --test finds it here)

services/                     each an isolated Express process importing @ai-fleet/shared
  gateway/src/                :4000 — SPA + user API + OAuth; proxies /api/agent, /api/coder
    index.js  proxy.js  routes/ (settings · projects · issues · businesses · roles · codex · claude)
  planner/src/                :4010 — mounts /api/agent, boots scheduler
    index.js  routes/agent.js
  coder/src/                  :4020 — mounts /api/coder, boots board monitor
    index.js  routes/coder.js

scripts/
  start-all.js                boot all three services from one terminal
  models-label-group.js       one-off: create the Linear "Models" label group
public/                       index.html · styles.css · js/ (app.js router · api.js · dom.js · state.js · views/)
data/                         store.json (secrets/config/jobs) + app.log   ← git-ignored
```

**Store shape** (`data/store.json`): `settings`, `businesses`, `assumedRole`,
`agentConfig`, `jobs`.

**Key design rules to respect when contributing:**
- Secrets never leave the server — mask with `maskKey`, store only in `store.json`.
- OAuth provider URLs/client-ids are trusted server-side config (env-overridable
  via `CODEX_OAUTH_*` / `CLAUDE_OAUTH_*`), **never** read from a request body.
- LLM output is untrusted: validate with Zod, clamp caps, re-check indices before
  any Linear write. Web-search and Linear content are fenced as data (prompt-injection defense).

---

## 7. Logs & debugging

Everything is logged to **stdout and `data/app.log`**:

```bash
tail -f data/app.log                 # follow live
tail -n 50 data/app.log              # last 50 lines
grep -E "WARN|ERROR" data/app.log    # only problems
grep "coder ENG-123" data/app.log    # one ticket's code-writer run
```

In the UI, each **Agent jobs** row has a **Show activity** button that expands
the stored step trace for that job (persisted in `store.json`).

---

## 8. API quick reference

The full table lives in the root `README.md` (§ *API*). Most-used endpoints:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| PUT | `/api/settings` | Validate + save Linear key |
| GET | `/api/settings/llm-presets` | Read the shared local + hosted preset catalog |
| PUT | `/api/settings/llm-preset` | Apply a route preset with safe optional overrides |
| GET | `/api/projects` | List Linear projects |
| GET | `/api/issues/board/:projectId` | Board columns for a project |
| PATCH | `/api/issues/:id/state` | Move an issue between states |
| GET/PUT | `/api/agent/config` | Business-owner agent config |
| POST | `/api/agent/run-now` | Run the planner now (role required → else 403) |
| GET | `/api/coder` | Code-writer monitor status + in-flight tickets |
| POST | `/api/coder/run` | Run the code-writer on one ticket `{ issueId }` |
| POST | `/api/coder/monitor` | Start/stop the board monitor `{ action }` |

---

## 9. Common gotchas

- **"No API key" and views won't load** → add the Linear key in **Settings** first.
- **Agent tab returns 403** → assume a role in **Settings** (server-enforced).
- **Enrichment never runs** → the scheduler only processes projects once a role is
  assumed, the Linear key is set, and an LLM provider is fully configured.
- **Ollama model is missing/incompatible** → install the model named by the
  preset (`gpt-oss:20b` is the practical default) or use the compatible-model
  action shown in Settings. Local inference speed depends heavily on hardware.
- **LM Studio "not reachable" / empty model list** → start its server (Developer →
  Start Server) and load a **tool-capable** model; the host must match (default
  `http://localhost:1234`). Reload Settings after starting it.
- **OMLX "not reachable" / empty model list** → start OMLX and make a model or
  profile available. The host can be `http://127.0.0.1:8000` or the equivalent
  `/v1` base; check the saved API key when the server requires authentication,
  then use **Refresh models** in Settings.
- **Code-writer does nothing** → set `CODER_REPO_URL`, and start the monitor
  (`POST /api/coder/monitor {"action":"start"}`) or run a single ticket.
- **`data/` is git-ignored** — it holds your secrets, config, and jobs. Don't commit it.
