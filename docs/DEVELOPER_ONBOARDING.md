# AI Fleet — Developer Onboarding

Welcome! This guide gets a new developer from a fresh clone to a running app,
explains what the software does, and points you at the code you'll be working in.

> **What is this?** AI Fleet (npm package `linear-manager`, repo `tech-symphony`)
> is a **single-user Node.js + Express** tool with a dependency-free vanilla-JS
> single-page frontend. It manages **Linear** projects/issues **and** runs two AI
> "deep agents" against them:
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
| **An LLM provider** (for the agents only) | Pick **one**: Ollama (local), LM Studio (local), Codex (OpenAI via OAuth), or Claude (Anthropic via OAuth). Not needed just to browse projects/board. |
| **git** | Required by the **code-writer** agent (it clones and pushes). |
| **Ollama** (optional) | Only if you use the Ollama local provider. Install from <https://ollama.com>, then `ollama pull llama3.1` (must be a **tool-capable** model). |
| **LM Studio** (optional) | Only if you use the LM Studio local provider (handy for models not in Ollama's catalog). Install from <https://lmstudio.ai>, load a **tool-capable** model, then start its server (Developer → Start Server, default `http://localhost:1234`). |

No database, no build step, no framework — the frontend is plain ES modules
served straight from `public/`.

---

## 2. Install & start (the commands)

```bash
# from the repo root: /Users/niravshah2705/git/reasearch/tech-symphony

npm install            # install dependencies (one time)

npm start              # run the server → http://localhost:4000
# or
npm run dev            # same, but auto-restarts on file changes (node --watch)

npm test               # run the test suite (node --test)
```

Override the port with the `PORT` env var:

```bash
PORT=5000 npm start    # → http://localhost:5000
```

Then open **<http://localhost:4000>** in a browser. On first launch you'll be
prompted to add a Linear API key before any view will load.

### What happens on boot
`server/index.js` wires the Express routes, serves the SPA, and then
**starts the enrichment scheduler** (`scheduler.startScheduler()`), which also
reconciles any interrupted jobs. The code-writer board monitor is **not** started
automatically — you start it explicitly (see §5.2).

---

## 3. First-run configuration (Settings tab)

Everything is configured in the UI under **Settings** — no `.env` file is
required for normal use. Secrets are validated and stored **server-side** in
`data/store.json` and are never sent back to the browser.

1. **API Keys & Connection** → paste your **Linear personal API key**. It is
   validated against Linear on save; the header shows connection status.
   (Optional: add a **LangSmith** key + host to trace agent runs.)
2. **Deep Agent LLM** → choose the active provider for the agents:
   - **Ollama (local)** — set the host (default `http://localhost:11434`) and pick
     a tool-capable model from the dropdown. No key needed.
   - **LM Studio (local)** — set the host (default `http://localhost:1234`) and pick
     a tool-capable model from the dropdown (LM Studio serves an OpenAI-compatible
     API). No key needed. Use this for models Ollama doesn't provide.
   - **Codex (OpenAI · OAuth)** — **Sign in with ChatGPT** (Authorization Code +
     PKCE). Register the shown redirect URI (`http://localhost:4000/auth/callback`)
     with your OAuth client.
   - **Claude (Anthropic · OAuth)** — **Sign in with Claude** (PKCE); paste back the
     `code#state` Anthropic gives you. Uses a Claude Pro/Max or Console account.
3. **Assume Role** → pick a workspace member. The business-owner agent's enrich
   endpoints are **403 until a role is assumed** (server-enforced). The assumed
   member shows in the top toolbar.
4. **Deep Agent** → choose **enrich labels** (default `AI`), scheduler cadence
   (5/10/15 min), parallelism, and caps. **Auto-attach enrich labels to new
   projects** (on by default) stamps those labels on any Linear project created for
   a new business, so it's immediately picked up by the enrichment scheduler.

---

## 4. The five tabs (using the app)

The SPA (`public/js/app.js`) hash-routes between five views:

| Tab | What it does | View file |
| --- | ------------ | --------- |
| **Business** | Map a "business" to a backing Linear project (OTA is pre-seeded). Jump to its Planning/Board. | `public/js/views/business.js` |
| **Projects** | Project list + a milestone **planning timeline** per project. | `public/js/views/projects.js` |
| **Board** | Kanban board of a project's issues by workflow state, drag-and-drop to move. | `public/js/views/board.js` |
| **Agent** | Preview + **Run now** the business-owner planner; watch **Enrichment Jobs** and open their LangSmith traces. | `public/js/views/agent.js` |
| **Settings** | Everything in §3. | `public/js/views/settings.js` |

---

## 5. The two deep agents (developer mental model)

Both agents live under `server/agent/` and share the LLM provider factory
(`llm.js` → `resolveLlm`), so switching provider in Settings affects both.

### 5.1 Business-owner planner (auto-runs on a schedule)
- **Files:** `plan.js` (LLM plan + tracing), `schema.js` (Zod plan schema),
  `apply.js` (deterministic Linear writes), `scheduler.js` (5/10/15-min queue),
  `search.js` (keyless web search).
- **Flow:** discovers open projects carrying an enrich label → viability gate
  (web research; unfit projects get relabelled `aifail`) → drafts business
  milestones (MVB → metrics → branding → …) → **the server** applies the plan to
  Linear (creates milestones/issues/dependencies) → relabels the project `aidone`.
- **Guardrail:** the LLM only *proposes*; all Linear writes are done deterministically
  server-side after Zod validation + clamping. Interrupted runs resume on restart.
- **Trigger it:** Agent tab → **Run now**, or `POST /api/agent/run-now`.

### 5.2 Code-writer (works a Linear ticket into a PR)
- **Files:** `coder.js` (one attempt / AgentRunner), `coder-orchestrator.js` (board
  monitor: poll active-state tickets, dispatch up to `maxConcurrent`),
  `workspace.js` (isolated git clone), `skills/` (linear, commit, push, pull, land).
- **Flow:** for a ticket in an active state, it clones the repo into an isolated
  workspace, uses filesystem/shell tools + skills to implement the change, keeps a
  single **"## Workpad"** Linear comment as the source of truth, and drives the
  ticket through its state machine to a PR (stamped with `CODER_PR_LABEL`).
- **Config:** all `CODER_*` env vars in `server/config.js` — most importantly
  `CODER_REPO_URL` (repo to clone) and `CODER_WORKSPACE_ROOT` (where clones live).
- **Trigger it:**
  - one ticket → `POST /api/coder/run` with `{ "issueId": "..." }`
  - start/stop the board monitor → `POST /api/coder/monitor` with `{ "action": "start" | "stop" }`
  - status → `GET /api/coder`

---

## 6. Architecture map

```
server/
  index.js              Express app + route wiring + SPA fallback + boots scheduler
  config.js             All constants + env-overridable OAuth/CODER config
  store.js              JSON-file store  →  data/store.json
  linear.js             Linear GraphQL client (server holds the key)
  logger.js             stdout + data/app.log
  util.js               asyncHandler, sendError, maskKey
  routes/               settings · projects · issues · businesses · roles
                        · agent · coder · codex(OAuth) · claude(OAuth)
  agent/
    plan.js schema.js apply.js scheduler.js search.js   ← business-owner planner
    coder.js coder-orchestrator.js workspace.js skills/  ← code-writer
    llm.js                provider factory (ollama | lmstudio | codex | claude)
    oauth.js pkce.js      Codex OAuth (+ .test.js)
    claude-oauth.js       Claude OAuth (+ .test.js)
public/
  index.html styles.css
  js/  app.js (router) · api.js · dom.js · state.js
  js/views/  projects · board · business · agent · settings
data/                    store.json (secrets/config/jobs) + app.log   ← git-ignored
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

In the UI, each **Agent → Enrichment Jobs** row has a **🧾** button that expands
the stored step trace for that job (persisted in `store.json`).

---

## 8. API quick reference

The full table lives in the root `README.md` (§ *API*). Most-used endpoints:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| PUT | `/api/settings` | Validate + save Linear key |
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
- **Ollama model has no tool support** → pick a tool-capable model (`llama3.1`,
  `qwen2.5`, `gpt-oss`); local inference is slow (tens of seconds/project).
- **LM Studio "not reachable" / empty model list** → start its server (Developer →
  Start Server) and load a **tool-capable** model; the host must match (default
  `http://localhost:1234`). Reload Settings after starting it.
- **Code-writer does nothing** → set `CODER_REPO_URL`, and start the monitor
  (`POST /api/coder/monitor {"action":"start"}`) or run a single ticket.
- **`data/` is git-ignored** — it holds your secrets, config, and jobs. Don't commit it.
