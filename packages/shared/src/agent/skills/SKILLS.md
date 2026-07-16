# Agent Skills Catalog

Skills available to the deep-agent (`server/agent/skills/`). Each subdirectory is one
skill: a `SKILL.md` definition plus any supporting `scripts/`, `assets/`, or `references/`.

The catalog has two groups:

1. **Core workflow skills** — built for this app's implementation loop; these are the
   only skills wired into the deep-agent workflows and vendored in this directory.
2. **Plugin-provided skills** — available in the environment but managed by the plugin
   system; documented here, not vendored.

---

## 1. Core workflow skills

These drive the ticket → implement → review → land loop.

| Skill | What it does |
|-------|--------------|
| `linear` | Read the issue, manage the single Workpad comment, and transition ticket state via the injected `linear_graphql` tool. |
| `software-planning` | Turn an idea into an engineering plan: milestones and buildable issues as user stories with acceptance criteria and dependencies. |
| `web-research` | Ground planning/tech decisions in current real-world info via the `web_search` tool. |
| `pull` | Sync the working branch with `origin/main` at kickoff and before every push/handoff. |
| `commit` | Produce clean, logical git commits during implementation. |
| `push` | Publish the current branch and keep the remote up to date before review. |
| `land` | Merge the ticket's PR into `main` as the final step before a `completed` verdict. |

---

## 2. Plugin-provided skills (not vendored)

These exist in the Claude Code environment but are **managed by the plugin system**
(versioned under `~/.claude/plugins/`, invoked with a `plugin:skill` namespace). They were
**intentionally not vendored** — copying would duplicate plugin-managed content that goes
stale on the next update. Install the plugin instead if the agent should use them.

### `security` — RAVEN security framework
- **Marketplace:** `uipath-claude-marketplace` · **Version:** `1.6.2` · **Author:** Tiberiu Baron (UiPath)
- **Namespace:** `security:` · **Skills (5):** `raven` (multi-agent vuln scan), `raven-fix`
  (triage + fix findings), `raven-validate` (triage without code changes),
  `license-verification` (dependency license policy check), `tribal-knowledge`
  (curated exploit-pattern checklists).

### `ecc` — comprehensive Claude Code plugin
- **Marketplace:** `ecc` · **Version:** `2.0.0-rc.1` · **Author:** Affaan Mustafa · **Home:** https://ecc.tools
- Provides ~**187 skills** and 50 agents (e.g. `deep-research`, `benchmark`, `github-ops`,
  `api-design`, and language/framework pattern packs). Browse
  `~/.claude/plugins/marketplaces/ecc/skills/` for the full list.

### Installed plugins with no user-invokable skills
| Plugin | Marketplace | Version | Purpose |
|--------|-------------|---------|---------|
| `security-guidance` | `claude-plugins-official` | 2.0.0 | Pattern + LLM security review on edits/commits (Anthropic). |
| `playwright` | `claude-plugins-official` | — | Browser-automation MCP server (Microsoft). |
| `langsmith-tracing` | `langsmith-claude-code-plugins` | 0.1.3 | Traces Claude Code conversations to LangSmith (LangChain). |
