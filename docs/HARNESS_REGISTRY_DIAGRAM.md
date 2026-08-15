# Harness Registry v2 Implementation Diagram

The registry pipeline resolves moving external inputs once, builds eight
harness-native filesystem trees without cloud credentials, verifies their
shared source identity, and grants cloud identity only to the final publisher.

```mermaid
flowchart TB
  Trigger["Workflow triggers<br/>weekly schedule · manual dispatch<br/>selected pushes to main"]

  subgraph Inputs["Versioned inputs"]
    Sources["sources.json<br/>harness-registry/v2 · registry version v1"]
    ECC["ECC marketplace<br/>moving main ref"]
    Pinned["Pinned public marketplaces<br/>Claude plugins · LangSmith plugins"]
    Vendored["Seven vendored skills"]
  end

  subgraph Actions["GitHub Actions: Sync Harness Registry"]
    Resolve["1 · Resolve<br/>contents: read · no OIDC<br/>resolve ECC main to one commit<br/>fetch, normalize, and build inert bundles"]
    Resolved[("Resolved-source artifact<br/>source.json · source.tar.gz · inert/")]

    subgraph Matrix["2 · Build matrix × 8 · no OIDC"]
      DeepAgent["DeepAgent<br/>DCode plugin"]
      Codex["Codex SDK<br/>Codex marketplace"]
      Claude["Claude Agent SDK<br/>Claude marketplace"]
      Antigravity["Antigravity SDK<br/>Antigravity profile"]
      OpenCode["OpenCode<br/>OpenCode profile"]
      Pi["Pi<br/>Pi package"]
      OhMyPi["Oh My Pi<br/>Bun marketplace"]
      DeepSeek["DeepSeek Harness<br/>native DSH skills"]
    end

    Built[("Eight harness artifacts<br/>artifact.json + rootfs.tar.gz per harness")]
    Assemble["3 · Assemble and verify<br/>contents: read · no OIDC<br/>require exactly eight legs<br/>validate schema, source identity, digests,<br/>sizes, file counts, archives, and content"]
    Verified[("Verified registry tree<br/>v1/harnesses/ · v1/inert/ · v1/registry.json")]
    Publish["4 · Publish<br/>id-token: write<br/>validate before cloud authentication<br/>stage, compare checksums/object count,<br/>publish payload first and registry index last"]
  end

  subgraph Cloud["Private Google Cloud Storage registry"]
    Bucket[("v1/<br/>├─ registry.json<br/>├─ harnesses/&lt;id&gt;/artifact.json<br/>├─ harnesses/&lt;id&gt;/rootfs.tar.gz<br/>└─ inert/...")]
    IAM["Terraform controls<br/>public-access prevention enforced<br/>publisher: objectAdmin<br/>planner/coder: objectViewer"]
  end

  Loader["Runtime registry loader<br/>validate index · select descriptor<br/>return metadata and archive reference"]
  Activation["Archive activation / execution<br/>intentionally not implemented in this change"]

  ScanGate{{"Draft review gate<br/>scan structured state fail-closed<br/>when content is large or contains NUL"}}
  SourceGate{{"Draft review gate<br/>realpath-contain marketplace plugin sources<br/>and reject symlink/traversal escapes"}}

  Trigger --> Resolve
  Sources --> Resolve
  ECC --> Resolve
  Pinned --> Resolve
  Vendored --> Resolve
  Resolve --> Resolved

  Resolved --> DeepAgent
  Resolved --> Codex
  Resolved --> Claude
  Resolved --> Antigravity
  Resolved --> OpenCode
  Resolved --> Pi
  Resolved --> OhMyPi
  Resolved --> DeepSeek

  DeepAgent --> Built
  Codex --> Built
  Claude --> Built
  Antigravity --> Built
  OpenCode --> Built
  Pi --> Built
  OhMyPi --> Built
  DeepSeek --> Built

  Resolved --> Assemble
  Built --> Assemble
  Assemble --> Verified
  Verified --> Publish
  Publish --> Bucket
  IAM --> Bucket

  Bucket -.->|descriptor lookup only| Loader
  Loader -.->|future activation boundary| Activation
  Resolve -.-> SourceGate
  Assemble -.-> ScanGate

  classDef external fill:#f5f5f5,stroke:#616161,color:#212121
  classDef noOidc fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20
  classDef artifact fill:#e3f2fd,stroke:#1565c0,color:#0d47a1
  classDef privileged fill:#f3e5f5,stroke:#7b1fa2,color:#4a148c
  classDef cloud fill:#e0f7fa,stroke:#00838f,color:#006064
  classDef inactive fill:#eeeeee,stroke:#757575,color:#424242
  classDef warning fill:#fff3e0,stroke:#ef6c00,color:#e65100

  class Trigger,Sources,ECC,Pinned,Vendored external
  class Resolve,DeepAgent,Codex,Claude,Antigravity,OpenCode,Pi,OhMyPi,DeepSeek,Assemble noOidc
  class Resolved,Built,Verified artifact
  class Publish privileged
  class Bucket,IAM,Loader cloud
  class Activation inactive
  class ScanGate,SourceGate warning
```

## Security and delivery invariants

- The resolve job converts ECC's moving `main` ref into one immutable commit;
  every matrix leg must report that same source identity.
- Jobs that fetch or execute third-party installers have no `id-token`
  permission and therefore cannot mint Google Cloud credentials.
- The DeepSeek leg pins the official `dsh` CLI, validates its version, and
  stages only native `SKILL.md` bundles; credentials and mutable profile state
  are never included in the artifact.
- The publish job receives only assembled bytes, validates them before
  authenticating, verifies the staged copy, and writes `registry.json` last.
- Terraform keeps the bucket private and separates publisher write access from
  planner/coder read access.
- The runtime loader stops at validated metadata selection. Extracting or
  executing a selected archive remains a separate, future trust boundary.
- The orange nodes are known review gates on the draft pull request and must be
  closed before the implementation is marked ready to merge.
