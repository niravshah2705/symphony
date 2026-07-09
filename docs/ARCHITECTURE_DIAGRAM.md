# AI Fleet Architecture Diagram

This diagram shows the local-first DeepAgent architecture: Linear is the ticket
system, Ollama and LM Studio provide local LLM inference, and the DeepAgent
runtime uses skills plus Linear/GitHub tools to plan and execute work.

```mermaid
flowchart LR
  User["User / operator"] --> Browser["AI Fleet SPA<br/>Business, Projects, Board, Agent, Settings"]
  Browser -->|REST API| Api["Node.js + Express API<br/>server/index.js + routes"]

  Api --> Store["Server-side store<br/>data/store.json<br/>settings, keys, jobs"]
  Api <-->|GraphQL with server-held Linear key| Linear["Linear<br/>ticket management<br/>projects, milestones, issues, labels"]

  subgraph AgentRuntime["DeepAgent runtime"]
    Framework["Workflow framework<br/>server/agent/framework.js"]
    Planner["Planning DeepAgent<br/>software-design planner"]
    Coder["Code-writer DeepAgent<br/>Linear ticket to merged PR"]
    Skills["Skills<br/>software-planning, web-research<br/>linear, commit, push, pull, land"]
    BuiltInTools["Built-in tools<br/>web_search, linear_graphql"]
    McpTools["Optional MCP tools<br/>Linear MCP, GitHub MCP"]

    Framework --> Planner
    Framework --> Coder
    Framework --> Skills
    Framework --> BuiltInTools
    Framework -.-> McpTools
  end

  Api -->|scheduler, run-now, coder monitor| AgentRuntime

  subgraph LocalLlm["Local LLM providers"]
    Ollama["Ollama<br/>http://localhost:11434<br/>@langchain/ollama"]
    LmStudio["LM Studio<br/>http://localhost:1234/v1<br/>OpenAI-compatible API"]
  end

  Framework -->|tool-capable chat model| Ollama
  Framework -->|tool-capable chat model| LmStudio

  BuiltInTools -->|linear_graphql| Linear
  McpTools -.->|Linear MCP| Linear

  Coder --> Workspace["Isolated git workspace<br/>per project / ticket branch"]
  Workspace -->|clone, commit, push| GitHub["GitHub<br/>repository, branches, pull requests"]
  McpTools -.->|GitHub MCP / token| GitHub

  AgentRuntime -->|traces and run metadata| Observability["Langfuse / LangSmith tracing<br/>trace links in Agent tab"]
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
  participant LLM as Local LLM - Ollama or LM Studio
  participant GitHub as GitHub
  participant Obs as Langfuse or LangSmith

  User->>UI: Configure Linear, GitHub, local LLM, tracing, labels
  UI->>API: Save settings and start planner/coder
  API->>Linear: Discover projects and active tickets
  API->>Agent: Run planning or coding workflow
  Agent->>Agent: Load workflow skills and tools
  Agent->>LLM: Reason with local model
  Agent->>Linear: Create/update milestones, issues, labels, Workpad
  Agent->>GitHub: Clone, branch, push, open/land PR
  Agent->>Obs: Emit trace
  API-->>UI: Job status, logs, trace links
```

## Component Notes

- **Linear** is the source of truth for ticket management: projects, issues,
  labels, dependencies, state transitions, and Workpad comments.
- **Ollama** and **LM Studio** are local inference providers. They require a
  tool-capable model and no hosted LLM API key.
- **DeepAgent skills** improve execution by giving the agent reusable operating
  procedures for planning, Linear updates, commits, pushes, pulls, and landing PRs.
- **Linear and GitHub integrations** are available through built-in tools and
  optional MCP tool groups when enabled.
- **Tracing** is represented as Langfuse/LangSmith-compatible observability. The
  current codebase stores LangSmith settings and emits trace links from agent jobs.
