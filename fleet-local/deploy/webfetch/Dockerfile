# Fleet web-fetch MCP: mcp-server-fetch (stdio) fronted by supergateway as a
# STREAMABLE_HTTP MCP server, so ALL THREE harnesses can bind it — the codex
# and claude runtimes only speak streamable-HTTP MCP, not SSE.
#
# The Deployment/Service/NetworkPolicy live here (platform-shared, one instance
# in ns kagent); the tenant chart renders one RemoteMCPServer CR per org
# pointing at this Service.
#
# SSRF posture: the tool is model-driven — whatever URL the LLM asks for gets
# fetched — so the pod may reach ONLY the public internet + DNS. The
# NetworkPolicy below denies the private/link-local ranges, which keeps
# fetch_url from reaching LiteLLM, Flexprice, substrate internals or the
# Kubernetes API as a lateral hop.
# Node comes from NodeSource, NOT Debian: the python:*-slim default moved to
# trixie, whose apt `npm` is the jest-debundundle shim (npm's own installer
# rejects it: "This is not the npm installer"). bookworm + nodesource is the
# combo apt-based installs are supported on.
FROM python:3.12-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir mcp-server-fetch \
 && npm install -g --omit=dev supergateway@4

EXPOSE 8087
# supergateway must be v4: v2's CLI has no streamable-HTTP output at all
# (--outputTransport choices are stdio|sse|ws) and silently serves SSE, so the
# agent-side POST /mcp gets Express "Cannot POST /mcp".
ENTRYPOINT ["supergateway", "--stdio", "mcp-server-fetch", "--outputTransport", "streamableHttp", "--port", "8087"]
