# AI Fleet

A simple Node.js UI (branded **AI Fleet**) to manage Linear projects:

- **Projects** — project list + a **milestone planning view** (timeline of milestones with issues grouped under each).
- **Board** — Linear issues shown as a Kanban **board** by workflow state, with drag-and-drop to move issues between columns.
- **Business** — a Business tab where each business is backed by a Linear project in the background. **OTA** is pre-seeded as the initial business.
- **Agent** — a **business-owner planning deep agent** (local Ollama + web search) enriches projects **carrying any of the chosen labels** (default `AI`): it checks business viability (unfit → `aifail`), writes a business plan — **MVB** (Minimal Viable Business) first, then business metrics, branding, and beyond — creates milestones, tasks, and dependencies, and marks the project **`aidone`** once issues exist. Interrupted projects **resume on restart** (missing issues get created). Projects are **discovered and processed on a configurable 5/10/15-minute schedule**.
- **Settings** — a tidy page of **collapsible sections**: **API Keys & Connection** (Linear + LangSmith key/host/project/tracing), **Deep Agent LLM** (choose **Ollama** local or **Codex** OpenAI-via-OAuth, plus each provider's model/limits), **Assume Role**, and **Deep Agent** (enrich labels, schedule cadence, parallelism, caps, toggles). All secrets are validated/stored **server-side** (never exposed to the browser).

## Settings

Collapsible sections:

1. **API Keys & Connection** — the Linear and LangSmith keys together, plus the LangSmith **host/endpoint**, project, and tracing toggle. One **Save keys** button; the Linear key is validated on save and connection status is shown.
2. **Deep Agent LLM** — pick the **active provider** for the deep agent:
   - **Ollama (local)** — the local **Ollama host** (default `http://localhost:11434`), **model** (dropdown of models detected on that host — pick one that supports tool-calling, e.g. `llama3.1`, `qwen2.5`, `gpt-oss`), **context window** (`num_ctx`), and **num tokens** (`num_predict`). No API key required — inference is fully local.
   - **Codex (OpenAI · OAuth)** — **Sign in with ChatGPT** using an OAuth 2.0 **Authorization Code + PKCE (S256)** flow (no API key pasted). Choose the OpenAI **model** (default `gpt-5-codex`) and **num tokens** (`max_tokens`). Access/refresh tokens are stored **server-side only** and refreshed automatically; provider endpoint URLs and the client id are **trusted server-side config** (env-overridable via `CODEX_OAUTH_*`), never taken from the browser. Register the shown **redirect URI** (`http://localhost:4000/auth/callback`) with your OAuth client.
3. **Assume Role** — pick a workspace member (validated server-side). The assumed role owns enriched projects and is shown in the **top toolbar**.
4. **Deep Agent** — **enrich labels** (multi-select dropdown of your Linear project labels), **scheduler cadence** (5 / 10 / 15 minutes), parallelism, and per-run/milestone/issue caps, plus toggles.

## Agent tab (project enrichment)

- **Auto Enrichment** — open projects (no lead) carrying any selected label are **picked up automatically** on the schedule. The Agent tab shows a read-only preview of what the next run will process and a **Run now** button; there is no manual project list. Assume a role in **Settings** first (the section is disabled and server-enforced until then). For each project the deep agent:
  - generates a validated plan (description + milestones + dates + issues + dependencies) under **LangSmith tracing**;
  - the server deterministically applies it to Linear using your **existing Linear token**: assign lead, update description, create milestones (start date preserved in the milestone note, target date = stop date), create issues per milestone, and create `blocks` dependencies.
- **Enrichment Jobs** — live status (pending → running → done/error), a per-job **Trace** link into LangSmith, and per-job/finished cleanup.

### How the deep agent works (business-owner planner)

The agent plans **as a business owner**, not a software PM — it does **not** produce a software development lifecycle. Built on `deepagents` (LangGraph) + **`@langchain/ollama`** (local inference) + keyless **web search** (DuckDuckGo); tracing via the `langsmith` SDK. Steps, all traced and recorded on the job:

1. **Viability gate** — web-researches the domain and decides whether the project is a business product that can be delivered as a software-driven solution. **If not viable**, it appends a note to the project description and switches the project's label to **`aifail`** (removing the enrich label, so it isn't retried) — no milestones are created.
2. **Business plan** — if viable, it web-researches each phase and drafts business milestones in order:
   - **MVB — Minimal Viable Business** (first): the smallest workable product; tasks are the essential **features** to launch.
   - **Business Metrics**: the KPIs to instrument (acquisition, activation, retention, revenue).
   - **Branding**: brand identity & presence.
   - then further business milestones (Go-to-Market, Monetization, Growth).
   Every **milestone** gets a measurable **evaluation criterion** (success/exit criteria, appended to the milestone description as `**Evaluation criteria:** …`), and every **feature/issue** gets an **acceptance criterion** (definition of done, appended to the issue description as `**Acceptance criteria:** …`). Resume runs add these to existing milestones too.
3. A constrained `format: 'json'` Ollama call emits the plan; it is validated with Zod and clamped. The **server performs all Linear writes** (deterministic guardrail).

**Label lifecycle & resume.** A project is *managed* while it carries the enrich label (default `AI`). On completion its label is switched (replacing the enrich label, so it drops out of discovery):
- **`aidone`** — once the project's issues have been created.
- **`aifail`** — when the viability check fails.

If a run is interrupted after milestones are created but before issues (crash/restart), the project keeps the enrich label. On the next tick — and **immediately on restart** — the agent **reviews the existing milestones and creates the missing issues** (researching tasks per milestone), then marks the project `aidone`. Milestones that already have issues are left untouched (no duplicates).

- **Local-first (Ollama):** requires [Ollama](https://ollama.com) running with a **tool-capable** model pulled (e.g. `ollama pull llama3.1`). Nothing is sent to a hosted LLM. If the model lacks tool support, the reasoning pass degrades gracefully and the plan is still produced from the web research + JSON step.
- **Codex (OpenAI) provider:** the same deep-agent pipeline runs against OpenAI (`@langchain/openai` → `ChatOpenAI`) when the active provider is **Codex**, authenticated by the OAuth flow above. Constrained JSON steps use `response_format: json_object`; tokens are refreshed on demand before each run.
- **Web search** runs **in parallel**: the deep agent's `web_search` tool takes an array of queries and fans them out concurrently, and the per-phase / per-milestone research searches are issued together (`webSearchMany` → `Promise.all`). Results are untrusted and fenced as data in prompts (prompt-injection defense), like Linear content.

## Security notes

- **Role assumption is enforced server-side** — enrich endpoints return `403` without an assumed role; the assumed member id is validated against the real workspace member list.
- **Secrets stay on the server** — Linear/LangSmith keys and **Codex OAuth tokens** live only in `data/store.json`, are masked in API responses, and are never sent to the browser. Ollama needs no key.
- **Codex OAuth** — Authorization Code + **PKCE (S256, never `plain`)**; a cryptographically-random, server-issued, **single-use** `state` guards the callback against CSRF/replay; the `redirect_uri` is server-derived and reused exact-match in the code exchange; **refresh tokens rotate** on use. Provider endpoint URLs + client id are trusted server-side config, **not** accepted from request bodies (only the model name is browser-settable, and it is charset-validated).
- **Ollama host** — operator-configured server-side (not a request parameter), restricted to `http`/`https` and validated as a URL on save. This is a local single-user tool, so localhost is the intended target.
- **Prompt-injection defenses** — Linear-sourced project text is fenced in a `<project_context>` block and treated strictly as data; LLM output is schema-validated and clamped (milestone/issue caps, date ordering, dependency indices re-checked before any write).
- **Runaway guards** — bounded output via `num_predict`, bounded agent recursion, a per-tick project cap, and the configurable cadence throttle processing.

## Architecture

- **Backend** (`server/`) — Express server that proxies the Linear GraphQL API (`https://api.linear.app/graphql`) so the API key stays on the server. Local settings + the business→project mapping are stored in `data/store.json`.
- **Frontend** (`public/`) — a dependency-free vanilla-JS single-page app (ES modules) served by Express. Hash-based routing between the four views.

```
server/
  index.js            Express app + routes wiring + SPA fallback
  config.js           Constants (port, Linear URL, paths)
  store.js            JSON-file store (settings, businesses, assumed role, agent config, jobs)
  linear.js           Linear GraphQL client (queries/mutations)
  util.js             asyncHandler + JSON error + maskKey
  routes/             settings.js · projects.js · issues.js · businesses.js · roles.js · agent.js
  agent/              schema.js (Zod plan) · plan.js (deep agent + tracing) · apply.js (Linear writes) · scheduler.js (5-min queue)
public/
  index.html · styles.css
  js/                 app.js (router) · api.js · dom.js · state.js
  js/views/           projects.js · board.js · business.js · agent.js · settings.js
```

## Run

```bash
npm install
npm start          # http://localhost:4000   (PORT env var to override)
# or: npm run dev  # restarts on file changes
```

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
5. **Settings** → in **Deep Agent LLM** pick a provider: for **Ollama** set the host
   and a tool-capable model (start Ollama first: `ollama pull llama3.1`), or for
   **Codex** click **Sign in with ChatGPT** and choose an OpenAI model;
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
| GET | `/api/projects` | List Linear projects |
| GET | `/api/projects/teams` | List teams (for new projects) |
| GET | `/api/projects/:id/milestones` | Milestone planning data |
| GET | `/api/issues/board/:projectId` | Issues grouped into board columns |
| PATCH | `/api/issues/:id/state` | Move an issue to another state |
| GET/POST/PUT/DELETE | `/api/businesses[...]` | Manage businesses ↔ project mapping |
| PUT | `/api/settings/llm` | Save Ollama config (host, model, num_ctx, num_predict) |
| PUT | `/api/settings/langsmith` | Save LangSmith config (key masked) |
| GET | `/api/agent/ollama-models` | Models installed on the configured Ollama host |
| GET | `/api/roles/members` | Assumable workspace members |
| GET/PUT/DELETE | `/api/roles/assumed` | Get / assume (validated) / clear the role |
| GET/PUT | `/api/agent/config` | Agent config (labels, interval, parallelism, caps, model, toggles) |
| GET | `/api/agent/models` | Local model + interval (5/10/15) choices |
| GET | `/api/agent/labels` | Distinct Linear project labels (for the dropdown) |
| GET | `/api/agent/status` | Scheduler + readiness (LLM/tracing/role/labels/interval) |
| GET | `/api/agent/candidates` | Preview of labelled projects to be processed *(role required → 403)* |
| POST | `/api/agent/run-now` | Trigger a scheduler tick now (auto-discovers by label) |
| GET/DELETE | `/api/agent/jobs[...]` | Job history / cleanup |

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
  them — only once a role is assumed, the Linear key is set, and an Ollama host +
  model are configured. Completed projects become `aidone` / `aifail` (the label
  is replaced), so they drop out of discovery and are not re-processed.
- **Ollama is required** for enrichment: install it, run it, and pull a
  tool-capable model. Local inference is slower than a hosted API (expect tens of
  seconds per project depending on model/hardware).
