# Open SWE coding backend (with a local sandbox)

The code-writer agent has two execution backends, selected by `CODER_BACKEND`:

| `CODER_BACKEND` | What runs the code | Sandbox |
| --------------- | ------------------ | ------- |
| `local` (default) | The framework's coding workflow — a `deepagents` agent on a `LocalShellBackend` rooted at an isolated git clone. | The clone dir on this host. |
| `openswe` | A separate **Open SWE** LangGraph server, invoked over its Agent Protocol via `@langchain/langgraph-sdk`. Open SWE runs the coding loop in **its** sandbox and opens the PR. | Configured on the Open SWE side (local host, local Docker, or a cloud sandbox). |

Open SWE ([`langchain-ai/open-swe`](https://github.com/langchain-ai/open-swe)) is a
Python LangGraph server — it is **not** an npm library, so we don't embed it; we
run it separately and dispatch tickets to it. Nothing about the UI flow changes:
the board monitor still picks up AI-labeled Linear tickets, it just hands each one
to Open SWE instead of the local agent.

## 1. Run Open SWE locally with a local sandbox

```bash
git clone https://github.com/langchain-ai/open-swe && cd open-swe
uv venv && source .venv/bin/activate && uv sync --all-extras

# Minimal .env — LLM + GitHub App (required for cloning/PRs) + a LOCAL sandbox:
#   ANTHROPIC_API_KEY=...        (or OPENAI_API_KEY)
#   GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_INSTALLATION_ID
#   SANDBOX_TYPE=local           # runs on the host (dev only, no isolation)
#   LOCAL_SANDBOX_ROOT_DIR=/path/to/scratch

make dev            # serves the LangGraph API on http://localhost:2024
```

### Isolated local sandbox (recommended over `SANDBOX_TYPE=local`)

`SANDBOX_TYPE=local` runs the agent's shell commands directly on your host. For an
**isolated local sandbox**, use the local Docker backend shipped here:

1. Copy [`integrations/openswe/local_docker_sandbox.py`](../integrations/openswe/local_docker_sandbox.py)
   into your Open SWE checkout as `agent/integrations/local_docker.py`.
2. `uv pip install docker`.
3. Register it in `agent/utils/sandbox.py`:
   ```python
   SANDBOX_FACTORIES["local_docker"] = (
       "agent.integrations.local_docker", "create_local_docker_sandbox"
   )
   ```
4. Run with `SANDBOX_TYPE=local_docker LOCAL_DOCKER_IMAGE=python:3.12-slim make dev`.
   Each run gets a throwaway container — no host filesystem access.

## 2. Point tech-symphony at it

Set env before starting this app:

```bash
CODER_BACKEND=openswe            # switch the coder to Open SWE
OPENSWE_URL=http://localhost:2024
OPENSWE_REPO=your-org/your-repo  # or rely on CODER_REPO_URL
OPENSWE_USER_EMAIL=you@org.com   # optional: attributes PRs to you
```

`OPENSWE_URL` is used only by the trusted direct-development profile. When
`EGRESS_PROXY_URL` is present, the coder always calls the fixed `/openswe`
sidecar route; configure the real origin only on the proxy as
`OPENSWE_PROXY_UPSTREAM`. Cloud deployments pass this as the Terraform variable
`openswe_proxy_upstream`, so the agent app container never needs the upstream
origin.

The board monitor (`POST /api/coder/monitor {"action":"start"}`) then dispatches
each AI-labeled, dependency-unblocked ticket to Open SWE, waits for the run, and
logs the PR URL. With `CODER_BACKEND=local` (default) none of the above is needed.

## Optional: Linear / GitHub MCP tools

Independently of the backend, the agents can attach hosted MCP tools:

```bash
LINEAR_MCP_ENABLED=true                 # Linear MCP; proxy injects the selected vault key
GITHUB_MCP_ENABLED=true                 # GitHub MCP; proxy injects the selected vault token
npm i @langchain/mcp-adapters            # required for MCP tool loading
```

Both are off by default; when enabled the framework loads their tools for any
workflow that declares `mcp: [...]` (the coding workflow declares `linear`,`github`).
