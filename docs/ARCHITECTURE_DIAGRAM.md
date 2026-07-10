# AI Fleet Architecture Diagram

This diagram shows the preset-routed DeepAgent architecture: Linear is the ticket
system, Ollama/LM Studio provide the local route, OpenAI/Claude provide the hosted
route, and the DeepAgent runtime uses skills plus Linear/GitHub tools to plan and
execute work.

```mermaid
flowchart LR
  User["User / operator"] --> Browser["AI Fleet SPA<br/>Business, Projects, Board, Agent, Settings"]
  Browser -->|REST API| Api["Node.js + Express API<br/>server/index.js + routes"]

  Api --> Store["Server-side store<br/>data/store.json<br/>settings, keys, jobs"]
  Catalog["LLM preset catalog<br/>server/agent/llm-presets.json<br/>limits, sampling, reasoning adapters"] --> Api
  Api <-->|GraphQL with server-held Linear key| Linear["Linear<br/>ticket management<br/>projects, milestones, issues, labels"]

  subgraph AgentRuntime["DeepAgent runtime"]
    Framework["Workflow framework<br/>server/agent/framework.js"]
    Planner["Planning DeepAgent<br/>software-design planner"]
    Coder["Code-writer DeepAgent<br/>Linear ticket to merged PR"]
    Skills["Skills<br/>software-planning, web-research<br/>linear, commit, push, pull, land"]
    BuiltInTools["Built-in tools<br/>web_search, linear_graphql"]
    McpTools["Optional MCP tools<br/>Linear MCP, GitHub MCP"]
    LlmRouter["Role-aware LLM router<br/>local / XS vs hosted / planner"]

    Framework --> Planner
    Framework --> Coder
    Framework --> Skills
    Framework --> BuiltInTools
    Framework -.-> McpTools
    Planner -->|hosted route| LlmRouter
    Coder -->|route by issue label| LlmRouter
  end

  Api -->|scheduler, run-now, coder monitor| AgentRuntime

  subgraph LocalLlm["Local LLM providers"]
    Ollama["Ollama<br/>http://localhost:11434<br/>@langchain/ollama"]
    LmStudio["LM Studio<br/>http://localhost:1234/v1<br/>OpenAI-compatible API"]
  end

  subgraph HostedLlm["Hosted LLM providers"]
    OpenAI["OpenAI GPT-5.5<br/>ChatGPT / Codex OAuth"]
    Claude["Claude Opus 4.8<br/>Anthropic OAuth"]
  end

  LlmRouter -->|local preset| Ollama
  LlmRouter -->|local preset| LmStudio
  LlmRouter -->|hosted preset| OpenAI
  LlmRouter -->|hosted preset| Claude

  BuiltInTools -->|linear_graphql| Linear
  McpTools -.->|Linear MCP| Linear

  Coder --> Workspace["Isolated git workspace<br/>per project / ticket branch"]
  Workspace -->|clone, commit, push| GitHub["GitHub<br/>repository, branches, pull requests"]
  McpTools -.->|GitHub MCP / token| GitHub

  AgentRuntime -->|traces and run metadata| Observability["LangSmith tracing<br/>trace links in Agent tab"]
  Api --> Logs["data/app.log<br/>server logs"]
```

## Request Flow

```mermaid
sequenceDiagram
  actor User as User
  participant UI as AI Fleet SPA
  participant API as Express API
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
- **Ollama** and **LM Studio** are local inference providers. **OpenAI** and
  **Claude** are hosted providers authenticated with OAuth. The planner uses the
  hosted route; the coder selects local or hosted by issue label.
- **The JSON preset catalog** owns model limits, recommended request parameters,
  provider-native reasoning adapters, and effective output/context constraints.
- **DeepAgent skills** improve execution by giving the agent reusable operating
  procedures for planning, Linear updates, commits, pushes, pulls, and landing PRs.
- **Linear and GitHub integrations** are available through built-in tools and
  optional MCP tool groups when enabled.
- **Tracing** uses LangSmith settings and emits trace links from agent jobs.
