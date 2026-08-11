---
name: linear
description: Interact with Linear — read the issue and manage its single Workpad comment — using the injected linear_graphql tool. Use for every Linear read/write.
---

# linear

All Linear access goes through the injected `linear_graphql` tool: call it with a
GraphQL `query` (string) and optional `variables` (object). It runs against the
Linear API with the server-side API key — never ask the user for credentials.

## Read the issue

```graphql
query($id: String!) {
  issue(id: $id) {
    id identifier title description url
    state { name type }
    labels { nodes { name } }
    comments { nodes { id body } }
  }
}
```

## The single Workpad comment (source of truth)

- Search the issue's comments for the marker header `## Workpad`.
- If found, reuse that comment id; do NOT create a second one.
- If absent, create it once: `commentCreate(input: { issueId: $id, body: $body })`.
- Update it in place as work progresses: `commentUpdate(id: $cid, input: { body: $body })`.
- Never post separate "done"/summary comments — keep all progress in the Workpad.

## Rules

- Never move the issue state or add/remove issue labels. The orchestrator owns
  that lifecycle and applies the final outcome after the coding run.
- Never edit the issue description for planning/progress — use the Workpad.
- Keep issue text concise, specific, and reviewer-oriented.
