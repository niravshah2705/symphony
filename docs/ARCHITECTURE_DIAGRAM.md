# AI Fleet Architecture Diagram

This diagram shows the preset-routed DeepAgent architecture, decomposed into
**three isolated services over one shared library**: a browser-facing **gateway**
(SPA + user API + OAuth) that reverse-proxies the two isolated agent services
(**planner** and **coder**). Linear is the ticket system, Ollama/LM Studio/OMLX provide
the local route, OpenAI/Claude provide the hosted route, and the DeepAgent runtime
(shipped once in `@ai-fleet/shared`) uses skills plus Linear/GitHub tools to plan
and execute work.

```mermaid
flowchart LR
  User["User / operator"] --> Browser["AI Fleet SPA<br/>Business, Projects, Board, Agent, Settings"]
  Browser -->|same-origin REST| Gateway["Gateway service :4000<br/>services/gateway<br/>SPA + user API + OAuth"]

  Gateway -->|proxy /api/agent| Planner["Planner service :4010<br/>services/planner<br/>scheduler + /api/agent"]
  Gateway -->|proxy /api/coder| CoderSvc["Coder service :4020<br/>services/coder<br/>board monitor + /api/coder"]

  Gateway --> Store["Shared store<br/>data/store.json<br/>settings, keys, jobs"]
  Planner --> Store
  CoderSvc --> Store
  Shared["@ai-fleet/shared<br/>config · store · linear · logger/util<br/>+ DeepAgent runtime (one copy)"] -.->|imported by| Gateway
  Shared -.->|imported by| Planner
  Shared -.->|imported by| CoderSvc
  Catalog["LLM preset catalog<br/>agent/llm-presets.json<br/>limits, sampling, reasoning adapters"] --> Shared
  Gateway <-->|GraphQL with server-held Linear key| Linear["Linear<br/>ticket management<br/>projects, milestones, issues, labels"]

  subgraph AgentRuntime["DeepAgent runtime (in @ai-fleet/shared)"]
    Framework["Workflow framework<br/>agent/framework.js"]
    PlannerAgent["Planning DeepAgent<br/>software-design planner"]
    CoderAgent["Code-writer DeepAgent<br/>Linear ticket to merged PR"]
    Skills["Skills<br/>software-planning, web-research<br/>linear, commit, push, pull, land"]
    BuiltInTools["Built-in tools<br/>web_search, linear_graphql"]
    McpTools["Optional MCP tools<br/>Linear MCP, GitHub MCP"]
    LlmRouter["Role-aware LLM router<br/>thinking / execution / testing"]

    Framework --> PlannerAgent
    Framework --> CoderAgent
    Framework --> Skills
    Framework --> BuiltInTools
    Framework -.-> McpTools
    PlannerAgent -->|hosted route| LlmRouter
    CoderAgent -->|route by issue label| LlmRouter
  end

  Planner -->|scheduler, run-now| AgentRuntime
  CoderSvc -->|board monitor, run one ticket| AgentRuntime

  subgraph LocalLlm["Local LLM providers"]
    Ollama["Ollama<br/>http://localhost:11434<br/>@langchain/ollama"]
    LmStudio["LM Studio<br/>http://localhost:1234/v1<br/>OpenAI-compatible API"]
    Omlx["OMLX<br/>http://127.0.0.1:8000/v1<br/>OpenAI-compatible API"]
  end

  subgraph HostedLlm["Hosted LLM providers"]
    OpenAI["OpenAI GPT-5.5<br/>ChatGPT / Codex OAuth"]
    Claude["Claude Opus 4.8<br/>Anthropic OAuth"]
  end

  LlmRouter -->|local preset| Ollama
  LlmRouter -->|local preset| LmStudio
  LlmRouter -->|local preset| Omlx
  LlmRouter -->|hosted preset| OpenAI
  LlmRouter -->|hosted preset| Claude

  BuiltInTools -->|linear_graphql| Linear
  McpTools -.->|Linear MCP| Linear

  CoderAgent --> Workspace["Isolated git workspace<br/>per project / ticket branch"]
  Workspace -->|clone, commit, push| GitHub["GitHub<br/>repository, branches, pull requests"]
  McpTools -.->|GitHub MCP / token| GitHub

  AgentRuntime -->|traces and run metadata| Observability["LangSmith tracing<br/>trace links in Agent tab"]
  Shared --> Logs["data/app.log<br/>shared logger, one file"]
```

## Request Flow

```mermaid
sequenceDiagram
  actor User as User
  participant UI as AI Fleet SPA
  participant API as Gateway + agent services
  participant Linear as Linear
  participant Agent as DeepAgent framework
  participant LLM as Routed LLM - local or hosted
  participant GitHub as GitHub
  participant Obs as LangSmith

  User->>UI: Configure Linear, local + hosted presets, tracing, labels
  UI->>API: Save settings and start planner/coder
  API->>Linear: Discover projects and active tickets
  API->>Agent: Run planning or coding workflow
  Agent->>Agent: Load workflow skills and tools
  Agent->>LLM: Reason through the selected route preset
  Agent->>Linear: Create/update milestones, issues, labels, Workpad
  Agent->>GitHub: Clone, branch, push, open/land PR
  Agent->>Obs: Emit trace
  API-->>UI: Job status, logs, trace links
```

## Component Notes

- **Linear** is the source of truth for ticket management: projects, issues,
  labels, dependencies, state transitions, and Workpad comments.
- **Ollama**, **LM Studio**, and **OMLX** are local inference providers. OMLX
  discovers models through `GET /v1/models` and supports an optional server-held
  API key. **OpenAI** and **Claude** are hosted providers authenticated with
  OAuth. The planner uses the
  hosted route; the coder selects local or hosted by issue label.
- **The JSON preset catalog** owns model limits, recommended request parameters,
  provider-native reasoning adapters, and effective output/context constraints.
- **DeepAgent skills** improve execution by giving the agent reusable operating
  procedures for planning, Linear updates, commits, pushes, pulls, and landing PRs.
- **Linear and GitHub integrations** are available through built-in tools and
  optional MCP tool groups when enabled.
- **Tracing** uses LangSmith settings and emits trace links from agent jobs.
