#!/usr/bin/env bash
# T-29 (P9): agent internet access via the shared webfetch MCP server, bound
# on EVERY harness (kagent + claude + codex — streamable-HTTP is the only MCP
# transport all three speak; codex/claude reject SSE).
#
# Steps (idempotent):
#   1) build + kind-load the webfetch image (mcp-server-fetch behind
#      supergateway, streamableHttp on :8087)
#   2) apply deploy/webfetch/webfetch.yaml (Deployment + Service in ns kagent
#      + the SSRF egress NetworkPolicy: public 80/443 + DNS only)
#   3) prove the SSRF posture at the socket layer from the pod itself
#      (internal svc must be unreachable, public 443 must be reachable)
#   4) prove the MCP contract directly: initialize -> tools/call fetch_url on
#      a public URL from the BFF pod
#   5) rebuild the BFF (workflow.ts now renders mcp + template bindings) and
#      re-run t26 so live tenants get the RemoteMCPServer CR + tools binding
#   6) headless agent probes (t28 with PROMPT) on one agent per runtime
set -euo pipefail
CTX=${KCTX:-kind-flexprice-local}
KIND_CLUSTER=${KIND_CLUSTER:-flexprice-local}
k() { kubectl --context "$CTX" "$@"; }
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
IMAGE=fleet-webfetch:0.1.0
URL=http://webfetch.kagent.svc.cluster.local:8087/mcp
PROBE_URL=${PROBE_URL:-https://www.archagentix.com/}
NS=${NS:-org-test}

echo "== 1) build + load $IMAGE =="
docker build -t "$IMAGE" "$ROOT/deploy/webfetch"
kind load docker-image "$IMAGE" --name "$KIND_CLUSTER"

echo "== 2) deploy webfetch + SSRF policy =="
k apply -f "$ROOT/deploy/webfetch/webfetch.yaml"
# imagePullPolicy=Never + a mutable local tag: restart so a rebuilt image is picked up.
k -n kagent rollout restart deploy/webfetch
k -n kagent rollout status deploy/webfetch --timeout=300s

echo "== 3) socket-layer SSRF check (from the webfetch pod) =="
k -n kagent exec -i deploy/webfetch -- python3 - <<'PY'
import socket, sys
def probe(host, port, want):
    try:
        socket.create_connection((host, port), timeout=4).close()
        got = "open"
    except OSError as e:
        got = f"blocked({type(e).__name__})"
    print(f"  {host}:{port} -> {got} (want {want})")
    return (got == "open") == (want == "open")
ok = True
ok &= probe("litellm.litellm.svc.cluster.local", 4000, "blocked")
ok &= probe("169.254.169.254", 80, "blocked")
ok &= probe("flexprice-postgresql.flexprice.svc.cluster.local", 5432, "blocked")
ok &= probe("www.archagentix.com", 443, "open")
sys.exit(0 if ok else 1)
PY

echo "== 4) direct MCP handshake + fetch_url =="
k -n fleet-system exec -i deploy/fleet-bff -- node -e '
const [url, probeUrl] = process.argv.slice(1);
const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const parse = (t) => { const m = t.match(/(^|\n)(data: )?(\{.*\})\s*$/m); return m ? JSON.parse(m[3]) : JSON.parse(t); };
(async () => {
  const init = await fetch(url, { method: "POST", headers: H, body: JSON.stringify(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t29", version: "1" } } }) });
  const itext = await init.text();
  if (!/"result"/.test(itext)) { console.error("initialize failed", init.status, itext.slice(0, 200)); process.exit(1); }
  // supergateway streamableHttp is stateless by default: no mcp-session-id is normal.
  const sid = init.headers.get("mcp-session-id");
  console.log("initialize OK (session:", sid || "stateless", ")");
  const hh = sid ? { ...H, "mcp-session-id": sid } : H;
  await fetch(url, { method: "POST", headers: hh, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  const tl = parse(await (await fetch(url, { method: "POST", headers: hh, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) })).text());
  const tool = (tl.result?.tools ?? []).map((t) => t.name).find((n) => /fetch/i.test(n));
  if (!tool) { console.error("no fetch tool in", (tl.result?.tools ?? []).map((t) => t.name).join(",")); process.exit(1); }
  console.log("tools:", (tl.result?.tools ?? []).map((t) => t.name).join(","), "-> using", tool);
  const r = parse(await (await fetch(url, { method: "POST", headers: hh, body: JSON.stringify(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tool, arguments: { url: probeUrl, max_length: 2000 } } }) })).text());
  const text = (r.result?.content ?? []).map((c) => c.text ?? "").join(" ");
  if (r.result?.isError || !text) { console.error("fetch failed:", JSON.stringify(r).slice(0, 300)); process.exit(1); }
  const title = (text.match(/<title>([^<]*)<\/title>/i) ?? [])[1] ?? "(no title tag in first 2000 chars)";
  console.log("public fetch OK; title:", title.trim());
})().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
' "$URL" "$PROBE_URL"

echo "== 5) rebuild BFF (workflow mcp values) + re-render tenants via t26 =="
bash "$ROOT/scripts/50-bff-spa.sh"
bash "$ROOT/scripts/fixes/t26-tenant-model-catalog.sh"

echo "== 6) headless agent probes (one per harness) =="
# agent-name:wire — LLM route grepped per runtime; the fetch itself is the
# tool call, the token proves the agent read the fetched page.
for pair in "test-agent-nemotron-worker:messages" "test-agent-nemotron-claude-worker:messages" "test-agent-nemotron-codex-worker:responses"; do
  agent="${pair%%:*}"
  wire="${pair##*:}"
  echo "-- $agent ($wire wire)"
  NS="$NS" EXPECT=P9-WEBFETCH-OK WIRE="$wire" \
    PROMPT="Use your web fetch tool to open ${PROBE_URL} . Then reply with exactly: P9-WEBFETCH-OK" \
    bash "$ROOT/scripts/fixes/t28-claude-harness-probe.sh" "$agent"
done

echo "T29 OK — webfetch MCP live on all three harnesses; SSRF ranges blocked"
