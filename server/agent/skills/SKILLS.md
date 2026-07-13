# Agent Skills Catalog

Skills available to the deep-agent (`server/agent/skills/`). Each subdirectory is one
skill: a `SKILL.md` definition plus any supporting `scripts/`, `assets/`, or `references/`.

The catalog has three groups:

1. **Core workflow skills** — built for this app's implementation loop.
2. **Imported skills** — general-purpose skills vendored in from local Claude/Codex
   configuration on **2026-07-13**.
3. **Plugin-provided skills** — available in the environment but managed by the plugin
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

## 2. Imported skills

General-purpose skills copied in from local agent configuration. Origins recorded for
resync; they are **snapshots**, not linked to the upstream copies.

### From Claude user config (`~/.claude/skills/`)

| Skill | Trigger | What it does |
|-------|---------|--------------|
| `deepagent-web-search` | `/deepagent-web-search` | Search the web for technical info/debug logs/docs, then summarize findings and tasks. |
| `deepagent-task-summarizer` | `/deepagent-task-summarizer` | Extract actionable tasks from requirements/research and format as a structured todo list. |
| `graphify` | `/graphify` | Turn any input (code, docs, papers, images) into a knowledge graph with clustered communities → HTML + JSON + audit report. |
| `research` | `/research` | Preliminary research on a topic → research outline (academic, benchmark, tech selection). |
| `research-add-fields` | `/research-add-fields` | Add field definitions to an existing research outline. |
| `research-add-items` | `/research-add-items` | Add items (research objects) to an existing research outline. |
| `research-deep` | `/research-deep` | Read a research outline and launch an independent agent per item for deep research. |
| `research-report` | `/research-report` | Summarize deep-research results into a markdown report covering all fields. |
| `youtube-channel` | `/youtube-channel` | Crawl a YouTube channel/playlist, download transcripts, build a CSV + per-video Markdown + index archive. |

> `deepagent-web-search` and `deepagent-task-summarizer` use the JS-style
> `export const meta = {…}` skill format; the others use YAML-frontmatter `SKILL.md`.

### From Codex system skills (`~/.codex/skills/.system/`)

Codex built-in system skills; each ships with its `scripts/`, `assets/`, `references/`,
and a `LICENSE.txt`.

| Skill | What it does |
|-------|--------------|
| `imagegen` | Generate or edit raster images (photos, illustrations, textures, sprites, mockups, transparent cutouts). |
| `openai-docs` | Answer "how to build with OpenAI/Codex" questions with up-to-date official docs and citations. |
| `plugin-creator` | Scaffold Codex plugin directories (`.codex-plugin/plugin.json`, manifests, marketplace entries). |
| `skill-creator` | Guide for creating/updating effective skills. |
| `skill-installer` | Install Codex skills into `$CODEX_HOME/skills` from a curated list or a GitHub repo. |

---

## 3. Plugin-provided skills (not vendored)

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

---

## Resync imported skills from upstream

```bash
DEST=server/agent/skills
for d in ~/.claude/skills/*/;        do cp -R "${d%/}" "$DEST"/; done   # Claude user skills
for d in ~/.codex/skills/.system/*/; do cp -R "${d%/}" "$DEST"/; done   # Codex system skills
```

> Copy each skill folder **without** a trailing slash — `cp -R dir/` (trailing slash)
> flattens contents into the destination on macOS.
