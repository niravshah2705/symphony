# Developer tools

Hardened, pre-wired tools the coding agent **picks up by name** instead of
hand-writing shell commands. Every tool **delegates to a pre-installed standard
CLI or MCP server** (Docker, Gradle, uv, npm, Trivy, Playwright, …) — none
re-implements the underlying behaviour. This keeps agent activity consistent,
auditable, and safe.

## How it fits together

- `../tools.js` is the framework's tool registry. It spreads `TOOL_FACTORIES`
  from `./index.js` into its `FACTORIES` map alongside the built-in
  `web_search` / `linear_graphql` tools.
- A workflow references tools **by name** in its `tools: [...]` array. The
  coding workflow (`../workflows/coding.workflow.js`) auto-wires the whole folder
  via `...TOOL_NAMES`, so new tools attach without editing that list.
- `framework.buildAgent` resolves names to LangChain tools with
  `toolRegistry.buildMany(workflow.tools, ctx)`.

## Tool catalogue

| Domain | Tools |
| --- | --- |
| `docker.js` | `dockerfile_generate`, `docker_build`, `docker_run`, `docker_compose`, `docker_info` |
| `environments.js` | `setup_local_env`, `setup_python_env`, `setup_node_env`, `devcontainer_generate` |
| `build.js` | `project_build` |
| `android.js` | `android_build` |
| `security.js` | `security_scan`, `secret_scan` |
| `quality.js` | `lint_format`, `test_run` |
| `codegen.js` | `openapi_generate` |
| `playwright.js` | `playwright_test` (+ interactive Playwright **MCP**, opt-in) |

Interactive browser control (navigate/click/snapshot) comes from the Playwright
**MCP** server, enabled with `PLAYWRIGHT_MCP_ENABLED=true` (see `../mcp.js` and
`config.MCP.playwright`).

## Security model (`exec.js`)

`exec.js` is the single door every delegated command goes through:

- **No shell.** Commands run via `execFile` with an **argument array**, so tool
  inputs can never be interpreted as shell metacharacters (no command injection).
- **Secrets stay server-side.** The child inherits the real environment (build
  tools need `$HOME`/`$PATH`/`$ANDROID_HOME`), but every credential-looking
  variable is **stripped** first, and any known secret value is **redacted** from
  returned output.
- **Workspace-scoped.** A tool's optional `dir` is resolved **inside** the
  workspace root carried on `ctx`; traversal (`../etc`) is refused.
- **Hardened generators.** `dockerfile_generate` / `devcontainer_generate` emit a
  pinned base image, a non-root `USER`, and a secret-free build context.
- **Bounded.** Output is length-limited; a single command times out
  (`config.TOOLS.timeoutSec`, default 900s).

## Adding a tool

1. Create `tools/<domain>.js` exporting a frozen
   `FACTORIES = { tool_name: (ctx) => LangChainTool }`. Use `defineTool` and the
   `execTool` / `runSequence` helpers from `./exec` — never spawn a shell or
   accept a freeform command string.
2. Register the module in `DOMAINS` in `./index.js`.
3. Add tests in `tools/<domain>.test.js` (`node --test`). Test the **pure**
   helpers (rendering, detection, validation) directly.

That's it — the coding workflow and registry pick it up automatically.
