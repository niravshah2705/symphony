"""Server configuration and shared constants (port of packages/shared/src/config.js).

CONFIG is built once from environment variables at import time. Section and field
names deliberately mirror the original JS ``CONFIG`` (camelCase within sections,
UPPER_SNAKE for top-level constants) so the port stays reviewable against the
original and so downstream references translate mechanically.
"""

from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlparse

# config.py lives at <repo>/ai_fleet/config.py, so the repo root is one level up
# from the package directory. All services resolve the SAME data/store.json and
# public/ regardless of which service process loads this shared config.
REPO_ROOT = Path(__file__).resolve().parents[1]

PORT = int(os.environ.get("PORT") or 4000)

AUTH_MODES = {"disabled", "istio"}
ISTIO_AUTH_PAYLOAD_HEADER = "x-ai-fleet-jwt-payload"


def _num(value, default):
    """Number(env) || default — falls back on empty/invalid/zero, matching JS ``||``."""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return default
    if n != n:  # NaN
        return default
    return int(n) if n == int(n) else n


def _num_allow_zero(value, default):
    """Number.isFinite(Number(env)) ? Number(env) : default — keeps an explicit 0."""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return default
    if n != n:
        return default
    return int(n) if n == int(n) else n


def _bool_true(value) -> bool:
    return str(value or "").lower() == "true"


def _split_csv(value: str) -> list[str]:
    return [s.strip() for s in str(value).split(",") if s.strip()]


def _required_auth_value(env, name: str) -> str:
    value = str(env.get(name) or "").strip()
    if not value:
        raise ValueError(f"{name} is required when AUTH_MODE=istio")
    if len(value) > 2048 or "\r" in value or "\n" in value:
        raise ValueError(f"{name} is invalid")
    return value


def _normalize_auth0_domain(value: str) -> str:
    import re

    domain = str(value or "").strip().lower()
    if not domain or len(domain) > 253 or not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", domain):
        raise ValueError("AUTH0_DOMAIN must be a hostname without a scheme or path")
    return domain


def _normalize_public_auth_url(value: str, name: str) -> str:
    try:
        parsed = urlparse(value)
        if not parsed.scheme or not parsed.netloc:
            raise ValueError
    except Exception:
        raise ValueError(f"{name} must be an absolute URL")
    hostname = parsed.hostname or ""
    local_http = parsed.scheme == "http" and hostname in ("localhost", "127.0.0.1", "::1")
    if parsed.scheme != "https" and not local_http:
        raise ValueError(f"{name} must use HTTPS (HTTP is allowed only for localhost)")
    if parsed.username or parsed.password or parsed.fragment:
        raise ValueError(f"{name} must not contain credentials or a fragment")
    return value


def build_auth_config(env=None) -> SimpleNamespace:
    """Browser auth is off for the local, single-user workflow. In production Istio
    validates Auth0 tokens and emits the verified JWT payload in a fixed header."""
    import re

    env = os.environ if env is None else env
    mode = str(env.get("AUTH_MODE") or "disabled").strip().lower()
    if mode not in AUTH_MODES:
        raise ValueError("AUTH_MODE must be either disabled or istio")
    if str(env.get("NODE_ENV") or "").strip().lower() == "production" and mode != "istio":
        raise ValueError("AUTH_MODE=istio is required when NODE_ENV=production")

    if mode == "disabled":
        return SimpleNamespace(mode=mode, enabled=False, payloadHeader=ISTIO_AUTH_PAYLOAD_HEADER)

    domain = _normalize_auth0_domain(_required_auth_value(env, "AUTH0_DOMAIN"))
    client_id = _required_auth_value(env, "AUTH0_CLIENT_ID")
    audience = _required_auth_value(env, "AUTH0_AUDIENCE")
    redirect_uri = _normalize_public_auth_url(_required_auth_value(env, "AUTH0_REDIRECT_URI"), "AUTH0_REDIRECT_URI")
    required_permission = _required_auth_value(env, "AUTH0_REQUIRED_PERMISSION")
    if not re.fullmatch(r"[A-Za-z0-9:_-]{1,160}", required_permission):
        raise ValueError("AUTH0_REQUIRED_PERMISSION must be a single permission name")
    origin = f"{urlparse(redirect_uri).scheme}://{urlparse(redirect_uri).netloc}"
    logout_return_to = _normalize_public_auth_url(
        str(env.get("AUTH0_LOGOUT_RETURN_TO") or origin), "AUTH0_LOGOUT_RETURN_TO"
    )

    return SimpleNamespace(
        mode=mode,
        enabled=True,
        provider="auth0",
        payloadHeader=ISTIO_AUTH_PAYLOAD_HEADER,
        domain=domain,
        issuer=f"https://{domain}/",
        clientId=client_id,
        audience=audience,
        requiredPermission=required_permission,
        redirectUri=redirect_uri,
        logoutReturnTo=logout_return_to,
        scope=str(env.get("AUTH0_SCOPE") or "openid profile email").strip() or "openid profile email",
        organization=str(env.get("AUTH0_ORGANIZATION") or "").strip(),
    )


AUTH = build_auth_config()

# --- Codex (OpenAI) OAuth provider configuration ---------------------------
# Provider endpoint URLs and client id are TRUSTED server-side config; never
# accepted from a request body. The redirect URI is derived from this server's
# own fixed origin.
OAUTH = SimpleNamespace(
    authorizeUrl=os.environ.get("CODEX_OAUTH_AUTHORIZE_URL") or "https://auth.openai.com/oauth/authorize",
    tokenUrl=os.environ.get("CODEX_OAUTH_TOKEN_URL") or "https://auth.openai.com/oauth/token",
    clientId=os.environ.get("CODEX_OAUTH_CLIENT_ID") or "app_EMoamEEZ73f0CkXaXp7hrann",
    scope=os.environ.get("CODEX_OAUTH_SCOPE") or "openid profile email offline_access",
    baseUrl=os.environ.get("CODEX_OPENAI_BASE_URL") or "https://api.openai.com/v1",
    defaultModel=os.environ.get("CODEX_OPENAI_MODEL") or "gpt-5-codex",
    backend="api" if str(os.environ.get("CODEX_BACKEND") or "chatgpt").lower() == "api" else "chatgpt",
    chatgptBaseUrl=os.environ.get("CODEX_CHATGPT_BASE_URL") or "https://chatgpt.com/backend-api/codex",
    clientVersion=os.environ.get("CODEX_CLIENT_VERSION") or "0.144.1",
    chatgptModel=os.environ.get("CODEX_CHATGPT_MODEL") or "gpt-5.6-sol",
    redirectUri=f"http://localhost:{PORT}/auth/callback",
    loginTtlMs=10 * 60 * 1000,
    refreshSkewMs=60 * 1000,
    charsPerToken=_num(os.environ.get("CODEX_CHARS_PER_TOKEN"), 4),
    promptMarginTokens=_num(os.environ.get("CODEX_PROMPT_MARGIN_TOKENS"), 4096),
    summaryMaxTokens=_num(os.environ.get("CODEX_SUMMARY_MAX_TOKENS"), 2048),
)

# --- Claude (Anthropic) OAuth 2.0 + PKCE configuration ---------------------
CLAUDE = SimpleNamespace(
    authorizeUrl=os.environ.get("CLAUDE_OAUTH_AUTHORIZE_URL") or "https://claude.ai/oauth/authorize",
    tokenUrl=os.environ.get("CLAUDE_OAUTH_TOKEN_URL") or "https://console.anthropic.com/v1/oauth/token",
    clientId=os.environ.get("CLAUDE_OAUTH_CLIENT_ID") or "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    scope=os.environ.get("CLAUDE_OAUTH_SCOPE") or "org:create_api_key user:profile user:inference",
    redirectUri=os.environ.get("CLAUDE_OAUTH_REDIRECT_URI") or "https://console.anthropic.com/oauth/code/callback",
    baseUrl=os.environ.get("CLAUDE_ANTHROPIC_BASE_URL") or "https://api.anthropic.com",
    defaultModel=os.environ.get("CLAUDE_MODEL") or "claude-opus-4-8",
    betaHeader=os.environ.get("CLAUDE_OAUTH_BETA") or "oauth-2025-04-20",
    systemPrefix=(
        os.environ.get("CLAUDE_OAUTH_SYSTEM_PREFIX")
        if os.environ.get("CLAUDE_OAUTH_SYSTEM_PREFIX") is not None
        else "You are Claude Code, Anthropic's official CLI for Claude."
    ),
    loginTtlMs=10 * 60 * 1000,
    refreshSkewMs=60 * 1000,
)

# --- LM Studio (local, OpenAI-compatible) ----------------------------------
LMSTUDIO = SimpleNamespace(
    defaultHost=os.environ.get("LMSTUDIO_HOST") or "http://localhost:1234",
    apiPath=os.environ.get("LMSTUDIO_API_PATH") or "/v1",
    requestTimeoutMs=_num(os.environ.get("LMSTUDIO_REQUEST_TIMEOUT_MS"), 30 * 60 * 1000),
    maxRetries=_num_allow_zero(os.environ.get("LMSTUDIO_MAX_RETRIES"), 1),
    charsPerToken=_num(os.environ.get("LMSTUDIO_CHARS_PER_TOKEN"), 3),
    promptMarginTokens=_num(os.environ.get("LMSTUDIO_PROMPT_MARGIN_TOKENS"), 1024),
    summaryMaxTokens=_num(os.environ.get("LMSTUDIO_SUMMARY_MAX_TOKENS"), 1024),
)

# --- oMLX (local, OpenAI-compatible) ---------------------------------------
OMLX = SimpleNamespace(
    defaultHost=os.environ.get("OMLX_HOST") or "http://127.0.0.1:8000",
    apiPath=os.environ.get("OMLX_API_PATH") or "/v1",
    requestTimeoutMs=_num(os.environ.get("OMLX_REQUEST_TIMEOUT_MS"), 30 * 60 * 1000),
    maxRetries=_num_allow_zero(os.environ.get("OMLX_MAX_RETRIES"), 1),
    charsPerToken=_num(os.environ.get("OMLX_CHARS_PER_TOKEN"), 3),
    promptMarginTokens=_num(os.environ.get("OMLX_PROMPT_MARGIN_TOKENS"), 1024),
    summaryMaxTokens=_num(os.environ.get("OMLX_SUMMARY_MAX_TOKENS"), 1024),
)

# --- Hugging Face hosted inference (OpenAI-compatible router) ---------------
HUGGINGFACE = SimpleNamespace(
    defaultHost=os.environ.get("HUGGINGFACE_HOST") or "https://router.huggingface.co",
    apiPath=os.environ.get("HUGGINGFACE_API_PATH") or "/v1",
    requestTimeoutMs=_num(os.environ.get("HUGGINGFACE_REQUEST_TIMEOUT_MS"), 10 * 60 * 1000),
    maxRetries=_num_allow_zero(os.environ.get("HUGGINGFACE_MAX_RETRIES"), 1),
)

# --- Code-writer deep agent + workflow config ------------------------------
CODER = SimpleNamespace(
    repoUrl=os.environ.get("CODER_REPO_URL") or "",
    workspaceRoot=os.environ.get("CODER_WORKSPACE_ROOT") or str(Path.home() / "code" / "techmavins-workspaces"),
    plannedWorkspaceRoot=os.environ.get("CODER_PLANNED_WORKSPACE_ROOT") or str(Path.home() / "git" / "workspace"),
    plannedLabel=os.environ.get("CODER_PLANNED_LABEL") or "aiplanned",
    activeStates=_split_csv(os.environ.get("CODER_ACTIVE_STATES") or "Todo,In Progress,Merging,Rework"),
    terminalStates=_split_csv(os.environ.get("CODER_TERMINAL_STATES") or "Done,Closed,Cancelled,Canceled,Duplicate"),
    maxTurns=_num(os.environ.get("CODER_MAX_TURNS"), 40),
    maxConcurrent=_num(os.environ.get("CODER_MAX_CONCURRENT"), 3),
    pollIntervalMs=_num(os.environ.get("CODER_POLL_INTERVAL_MS"), 15000),
    shellTimeoutSec=_num(os.environ.get("CODER_SHELL_TIMEOUT_SEC"), 600),
    prLabel=os.environ.get("CODER_PR_LABEL") or "techmavins",
    backend="openswe" if str(os.environ.get("CODER_BACKEND") or "local").lower() == "openswe" else "local",
    taskLabel=os.environ.get("CODER_TASK_LABEL") or "AI",
    tshirtSizes=_split_csv(os.environ.get("CODER_TSHIRT_SIZES") or "XS,S,M,L,XL"),
    localModelLabel=os.environ.get("CODER_LOCAL_MODEL_LABEL") or "local",
    hostedModelLabel=os.environ.get("CODER_HOSTED_MODEL_LABEL") or "hosted",
    modelLabelGroup=os.environ.get("CODER_MODEL_LABEL_GROUP") or "Models",
    localSize=os.environ.get("CODER_LOCAL_SIZE") or "XS",
    openswe=SimpleNamespace(
        url=os.environ.get("OPENSWE_URL") or "http://localhost:2024",
        assistant=os.environ.get("OPENSWE_ASSISTANT") or "agent",
        repo=os.environ.get("OPENSWE_REPO") or "",
        runTimeoutSec=_num(os.environ.get("OPENSWE_RUN_TIMEOUT_SEC"), 1800),
    ),
)

# --- Optional MCP tool servers ---------------------------------------------
MCP = SimpleNamespace(
    linear=SimpleNamespace(
        enabled=_bool_true(os.environ.get("LINEAR_MCP_ENABLED") or "false"),
        url=os.environ.get("LINEAR_MCP_URL") or "https://mcp.linear.app/mcp",
    ),
    github=SimpleNamespace(
        enabled=bool(os.environ.get("GITHUB_MCP_TOKEN")),
        url=os.environ.get("GITHUB_MCP_URL") or "https://api.githubcopilot.com/mcp/",
        token=os.environ.get("GITHUB_MCP_TOKEN") or "",
    ),
    playwright=SimpleNamespace(
        enabled=_bool_true(os.environ.get("PLAYWRIGHT_MCP_ENABLED") or "false"),
        transport="stdio",
        command=os.environ.get("PLAYWRIGHT_MCP_COMMAND") or "npx",
        args=_split_csv(os.environ.get("PLAYWRIGHT_MCP_ARGS") or "-y,@playwright/mcp@latest,--headless,--isolated"),
    ),
)

# --- Developer-tool folder limits ------------------------------------------
TOOLS = SimpleNamespace(
    timeoutSec=_num(os.environ.get("TOOLS_TIMEOUT_SEC"), 900),
    maxOutputBytes=_num(os.environ.get("TOOLS_MAX_OUTPUT_BYTES"), 64 * 1024),
)

DATA_DIR = os.environ.get("AI_FLEET_DATA_DIR") or str(REPO_ROOT / "data")
PUBLIC_DIR = os.environ.get("AI_FLEET_PUBLIC_DIR") or str(REPO_ROOT / "public")

# --- Isolated agent-service topology ---------------------------------------
PLANNER_PORT = int(_num(os.environ.get("PLANNER_PORT"), 4010))
CODER_SERVICE_PORT = int(_num(os.environ.get("CODER_SERVICE_PORT"), 4020))
SERVICES = SimpleNamespace(
    gatewayPort=PORT,
    plannerPort=PLANNER_PORT,
    coderPort=CODER_SERVICE_PORT,
    plannerUrl=os.environ.get("PLANNER_URL") or f"http://localhost:{PLANNER_PORT}",
    coderUrl=os.environ.get("CODER_URL") or f"http://localhost:{CODER_SERVICE_PORT}",
)

CONFIG = SimpleNamespace(
    PORT=PORT,
    LINEAR_API_URL="https://api.linear.app/graphql",
    DATA_DIR=DATA_DIR,
    STORE_FILE=str(Path(DATA_DIR) / "store.json"),
    LOG_FILE=str(Path(DATA_DIR) / "app.log"),
    PUBLIC_DIR=PUBLIC_DIR,
    SERVICES=SERVICES,
    PAGE_SIZE=100,
    ISSUE_PAGE_SIZE=250,
    INTERVAL_OPTIONS=[5, 10, 15],
    LLM_PROVIDERS=["ollama", "lmstudio", "omlx", "codex", "claude", "huggingface"],
    OLLAMA_JSON_MODES=["json", "text"],
    LMSTUDIO_JSON_MODES=["text", "json_object", "json_schema"],
    OMLX_JSON_MODES=["text", "json_object", "json_schema"],
    LMSTUDIO_CONTEXT_MODES=["summarize", "trim", "none"],
    OMLX_CONTEXT_MODES=["summarize", "trim", "none"],
    CODEX_CONTEXT_MODES=["summarize", "trim", "none"],
    LLM_STREAM_RETRIES=int(_num_allow_zero(os.environ.get("LLM_STREAM_RETRIES"), 1)),
    OAUTH=OAUTH,
    CLAUDE=CLAUDE,
    LMSTUDIO=LMSTUDIO,
    OMLX=OMLX,
    HUGGINGFACE=HUGGINGFACE,
    CODER=CODER,
    MCP=MCP,
    TOOLS=TOOLS,
    AUTH=AUTH,
)
