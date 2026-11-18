---
name: graphify
description: Query a codebase as a local knowledge graph. Use for architectural questions — what connects X to Y, what is in a subsystem, the blast radius of a change, the neighborhood of a symbol — before reading files top to bottom.
---

# Graphify

Graphify parses the repository into an AST knowledge graph with community
clustering and answers structural questions from it. It is deterministic and
local: every edge is explained, there is no vector store, and nothing leaves the
machine. The `graphify` CLI is installed in the **harness runtime image**, not
in this read-only mount.

## Build it once, then ask it questions

```bash
graphify update            # (re)build graphify-out/ from the current checkout
graphify query "what connects gateway auth to the org service" --budget 800
graphify path "<NodeA>" "<NodeB>"
graphify explain "<Symbol>"
```

`graphify-out/GRAPH_REPORT.md` is the human-readable community report; it is
generated, so never hand-edit it and never treat it as the source when the code
disagrees.

## When to reach for it

- A question spans several modules, or you would otherwise grep more than twice.
- You want the neighborhood of a subsystem rather than one symbol.
- You are reviewing a change and need its blast radius.

Stay in the source when the question is about one known file, one literal string,
or a config value — the graph does not index those.

## Limits worth knowing before you trust an answer

- A graph built from an earlier commit answers about that commit. Refresh after a
  rebase or a large merge.
- Language coverage is what the parser supports. An unindexed file contributes
  zero nodes silently, so a missing edge is not proof that nothing connects the
  two.
- `--budget` caps how much of the graph a query may read; a truncated answer
  looks complete. Re-run with a larger budget when the answer is suspiciously
  small.
