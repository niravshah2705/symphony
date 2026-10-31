---
name: code-review-graph
description: "Use before grep/read whenever a task in this repo requires locating or tracing code — including tasks that don't say \"search\" explicitly, like \"change/update/fix/bump <a setting or config value>\", \"remove this function\", \"add a field to X\", or any change whose first step is finding where something lives. Also covers direct lookups: \"where is X defined\", \"who calls X\", \"what imports/uses X\", \"what breaks if I change X\", \"tests for X\", \"blast radius of this change\". Wraps the code-review-graph (CRG) CLI/MCP: a SQLite structural graph (functions/classes/tests, CALLS/IMPORTS edges, full-text search) kept fresh by a pre-commit hook. Do NOT use for config values, log strings, comments, generic YAML, or Terraform variable *usage* lookups — those stay grep territory (see gap note below)."
---

# code-review-graph (CRG) — structural code search before grep

CRG is already installed and its index (`.code-review-graph/graph.db`) is
already built in this repo — kept in sync by `.githooks/pre-commit`. Don't
spend a call checking `which code-review-graph` or `--help`; the full command
surface is below, use it directly.

**This applies to change/fix/bump tasks too, not just literal searches.**
"Change concurrency to 50" or "fix the retry limit in the scheduler" both
start with the same hidden step: find where that setting lives. Treat that
step as a CRG `search` call before reaching for grep — the task doesn't have
to say "search" or "find" for this skill to apply.

## When to reach for this vs grep vs graphify

Fall back in this order (fewest tokens / most precise first):

1. **This (CRG)** — precise symbol lookup: where something is defined, who
   calls/imports it, what tests cover it, blast radius of a change.
2. **graphify** (`graphify query "..."`) — only on a CRG miss, for broad
   architectural questions spanning subsystems ("what connects A to B").
3. **grep / read** — last resort: config, logs, string literals, comments,
   generic YAML, and the Terraform-usage gap below.

## Command reference — copy as-is

```bash
# 1. find where a symbol/string is declared — start here, always
code-review-graph search "<term>" [--kind Function|Class|File|Type|Test] [--limit 10]

# 2. graph relationships — pick the kind that matches the question, don't guess:
code-review-graph query callers_of     <target>   # who calls this?
code-review-graph query callees_of     <target>   # what does this call?
code-review-graph query imports_of     <target>   # what does this file import?
code-review-graph query importers_of   <target>   # what imports this file/module?
code-review-graph query children_of    <target>   # subclasses / nested defs
code-review-graph query tests_for      <target>   # tests covering this symbol
code-review-graph query inheritors_of  <target>   # subclasses of this class
code-review-graph query file_summary   <target>   # all symbols in a file

# 3. blast radius of a change
code-review-graph impact --files <path> [--depth N]
```

`<target>` takes a bare name, qualified name, or file path. Run `search`
first to get the exact qualified name, then feed that into `query`/`impact` —
this is the only reliable way to avoid a 0-result guess on the wrong kind.

If the CRG MCP server is running, its tools (`semantic_search_nodes_tool`,
`query_graph_tool`, `get_impact_radius_tool`, …) wrap this same CLI/index —
same command semantics, same caveats below.

## Keep output lean

CRG's default JSON (full `qualified_name`, `_hints.next_steps` suggestions,
etc.) runs ~2.5x the size of an equivalent grep match — that's extra prompt
tokens on every subsequent turn. Cap `--limit` and strip hints when scanning
several results rather than reading one:

```bash
code-review-graph search "<term>" --limit 5 | jq -c '.results[] | {name,file_path,line_start}'
```

## Known gap — Terraform variable *usage* is not a graph edge

CRG indexes `.tf` declarations fine (`search "var_name"` finds the
definition site), but `importers_of`/`callers_of` do **not** track `var.X`
interpolation inside a resource block — there is no query kind for it (the
only kinds are the eight listed above). For "where is this Terraform
variable *used*", skip straight to `grep -rn 'var\.<name>' deploy/` — don't
burn a call finding out CRG returns 0 results first.

## If the index looks stale

```bash
npm run graph:build            # incremental rebuild of .code-review-graph/graph.db and graphify-out/
npm run graph:build -- --clean # force full re-parse (needed after new language support lands)
```
