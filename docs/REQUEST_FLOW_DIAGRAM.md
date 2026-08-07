# Current Request & Traffic Flow

This diagram describes both deployment modes: local development (direct service calls and a JSON store) and the deployed Google Cloud path (Firebase Hosting SPA, Cloud Run, Pub/Sub, Firestore, and Cloud Run Jobs).

```mermaid
flowchart TB
  User["User browser"]

  subgraph Browser["Browser"]
    SPA["AI Fleet SPA\npublic/ vanilla-JS"]
    EventSource["EventSource / SSE\nagent progress"]
  end

  User --> SPA

  subgraph Gateway["Gateway :4000 locally / public Cloud Run"]
    Auth["Firebase ID-token auth\n(local: no-op)"]
    API["Gateway REST API\nsettings · projects · issues · business · roles\nOAuth · observability · locale"]
    SSE["GET /api/agent/stream\nsigned stream token"]
    Publish["POST /api/agent/enqueue\nPOST /api/coder/run"]
    Proxy["Reverse proxy\nother /api/agent/* and /api/coder/*"]
  end

  SPA -->|"HTTPS REST + Firebase bearer token"| Auth
  Auth --> API
  SPA -->|"mint stream token, then connect"| EventSource
  EventSource --> SSE

  subgraph AgentControl["Isolated agent control services"]
    Planner["Planner :4010 locally / internal Cloud Run\n/api/agent · /pubsub/planner"]
    CoderControl["Coder control :4020 locally / internal Cloud Run\n/api/coder · /pubsub/coder"]
  end

  Proxy -->|"OIDC ID token in cloud"| Planner
  Proxy -->|"OIDC ID token in cloud"| CoderControl

  subgraph Async["Long-running request path"]
    Topics[("Pub/Sub topics\nplanner · coder")]
    PlannerPush["OIDC push\n/pubsub/planner"]
    CoderPush["OIDC push\n/pubsub/coder"]
    Job["Coder worker\nCloud Run Job\n(one ticket execution)"]
  end

  Publish -->|"create conversation + return 202 / conversationId"| Topics
  Topics --> PlannerPush --> Planner
  Topics --> CoderPush --> CoderControl
  CoderControl -->|"launch per-ticket run"| Job

  subgraph Cadence["Autonomous traffic"]
    Scheduler["Cloud Scheduler\nplanner/coder ticks"]
  end
  Scheduler -->|"OIDC POST /pubsub/planner-tick"| Planner
  Scheduler -->|"OIDC POST /pubsub/coder-tick"| CoderControl

  subgraph Shared["Shared application runtime: @ai-fleet/shared"]
    Store[("Local: data/store.json\nCloud: Firestore")]
    Events[("Local: in-process event bus\nCloud: Firestore event relay")]
    Runtime["DeepAgent runtime\nplanner/coder workflows · skills · LLM router"]
    Linear["Linear GraphQL"]
    LLM["Local: Ollama / LM Studio / OMLX\nHosted: OpenAI Codex / Claude"]
    Repo["GitHub / GitLab\nrepository broker"]
    Logs["data/app.log / Cloud logs\nLangSmith traces"]
  end

  API <--> Store
  Planner <--> Store
  CoderControl <--> Store
  Job <--> Store

  Planner --> Runtime
  Job --> Runtime
  Runtime <--> Linear
  Runtime <--> LLM
  Runtime <--> Repo
  Runtime --> Logs

  Planner -->|"lifecycle events"| Events
  CoderControl -->|"dispatch/status events"| Events
  Job -->|"run events"| Events
  Events --> SSE
  SSE --> EventSource
```

## Request paths

### Standard browser reads and writes

```mermaid
sequenceDiagram
  actor U as User
  participant SPA as SPA
  participant G as Gateway
  participant S as Shared store
  participant L as Linear

  U->>SPA: Interact with UI
  SPA->>G: HTTPS /api/settings, projects, issues, businesses, roles, etc.
  G->>G: Verify Firebase bearer token (cloud only)
  G->>S: Read/write app configuration and state
  G->>L: Query or mutate Linear when required
  L-->>G: GraphQL result
  S-->>G: Stored state
  G-->>SPA: JSON response
```

### Agent submission and streamed progress

```mermaid
sequenceDiagram
  actor U as User
  participant SPA as SPA
  participant G as Gateway
  participant PS as Pub/Sub
  participant P as Planner or coder-control
  participant W as Coder worker (coder only)
  participant R as DeepAgent runtime
  participant E as Event relay

  U->>SPA: Start planning or code-ticket run
  SPA->>G: POST /api/agent/enqueue or /api/coder/run
  G->>G: Create conversation
  G->>PS: Publish request
  G-->>SPA: 202 Accepted + conversationId
  SPA->>G: GET stream token, then EventSource /api/agent/stream
  PS->>P: OIDC-authenticated push
  P-->>PS: Ack quickly
  alt Planner
    P->>R: Queue/process planning work
  else Coder
    P->>W: Launch detached local run / Cloud Run Job
    W->>R: Run ticket workflow
  end
  R->>E: Publish lifecycle and progress events
  E-->>G: Local bus or cloud Firestore relay
  G-->>SPA: SSE events
```

### Cloud-only ingress and service boundary

```mermaid
flowchart LR
  GCS["Public Firebase-hosted SPA\n** → /index.html"] -->|"cross-origin HTTPS\nCORS allowlisted"| GW["Public gateway Cloud Run"]
  Firebase["Firebase Authentication"] -->|"ID token"| GW
  GW -->|"Google OIDC ID token"| P["IAM-gated planner Cloud Run"]
  GW -->|"Google OIDC ID token"| C["IAM-gated coder-control Cloud Run"]
  PubSub["Pub/Sub with OIDC push"] --> P
  PubSub --> C
  Scheduler["Cloud Scheduler with OIDC"] --> P
  Scheduler --> C
  C --> Job["Coder worker Cloud Run Job"]
  GW <--> FS[("Firestore")]
  P <--> FS
  C <--> FS
  Job <--> FS
```
