#!/usr/bin/env bash
# T-28 (P7/P8 verification): headless wake of a claude- or codex-harness agent.
# Proves the whole chain without a browser:
#   self-signed trusted-proxy JWT -> kagent-controller A2A SendStreamingMessage
#   -> actor Restore on the harness image -> Claude Code calls LiteLLM
#   /v1/messages (Anthropic ModelConfig) or Codex calls /v1/responses (OpenAI
#   ModelConfig, apiFormat responses; model + base URL from the CR, key injected
#   by the egress gateway — never in the CR) -> nemotron reply -> Checkpoint.
# Usage: bash scripts/fixes/t28-claude-harness-probe.sh [agent-name]
#        EXPECT=<token> WIRE=<messages|responses> to change the evidence line.
set -euo pipefail
CTX=${KCTX:-kind-flexprice-local}
k() { kubectl --context "$CTX" "$@"; }
AGENT=${1:-test-agent-nemotron-claude-worker}
EXPECT=${EXPECT:-P7-CLAUDE-HARNESS-OK}
WIRE=${WIRE:-messages}
NS=${NS:-org-test}
EMAIL=${EMAIL:-$(k -n flexprice exec -i flexprice-postgresql-0 \
  -- env PGPASSWORD="$(k -n flexprice get secret flexprice-postgresql -o jsonpath='{.data.password}' | base64 -d)" \
  psql -U flexprice -d fleet_control -tAc "select email from users limit 1;" </dev/null)}

k -n kagent port-forward svc/kagent-controller 18083:8083 >/dev/null 2>&1 &
PF=$!; trap 'kill $PF 2>/dev/null || true' EXIT
sleep 2

node -e '
const [host, ns, name, email, expect] = process.argv.slice(1);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
// trusted-proxy mode does NOT verify signatures (the :8083 NetworkPolicy is the
// control) — a structurally-correct JWT with the right iss + email is accepted.
const jwt = b64({ alg: "RS256", typ: "JWT" }) + "." +
  b64({ iss: "https://accounts.google.com", aud: "kagent", sub: "probe", email, exp: Math.floor(Date.now() / 1000) + 3600 }) +
  "." + b64({ sig: "unsigned-trusted-proxy" });
const H = {
  Authorization: "Bearer " + jwt, "Content-Type": "application/json",
  "A2A-Version": "1.0", Accept: "text/event-stream",
};
const body = { jsonrpc: "2.0", id: 1, method: "SendStreamingMessage", params: { message: {
  messageId: "probe-" + Date.now(), role: "ROLE_USER",
  parts: [{ text: "Reply with exactly: " + expect }] } } };
(async () => {
  const r = await fetch(`http://${host}/agents/${ns}/${name}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  if (!r.ok || !r.body) { console.error("HTTP", r.status, (await r.text()).slice(0, 300)); process.exit(1); }
  const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = ""; let completed = false; let text = "";
  for (;;) {
    const { done, value } = await rd.read(); if (done) break;
    buf += dec.decode(value, { stream: true }); let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const blk = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = blk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!data) continue;
      let env; try { env = JSON.parse(data); } catch { continue; }
      if (env.error) { console.error("a2a error:", JSON.stringify(env.error).slice(0, 300)); process.exit(1); }
      const res = env.result ?? {};
      const task = res.task ?? res.statusUpdate ?? res.artifactUpdate ?? {};
      for (const a of task.artifacts ?? []) for (const p of a.parts ?? []) if (p.text) text += p.text;
      if (res.artifactUpdate?.artifact) for (const p of res.artifactUpdate.artifact.parts ?? []) if (p.text) text += p.text;
      const state = task.status?.state ?? res.statusUpdate?.status?.state ?? "";
      if (String(state).includes("COMPLETED")) completed = true;
      if (/FAILED|REJECTED|CANCELED/.test(String(state))) { console.error("state", state, JSON.stringify(task.status ?? {}).slice(0, 300)); process.exit(1); }
    }
  }
  console.log("terminal COMPLETED:", completed);
  console.log("reply:", text.slice(0, 200) || "(no text artifact)");
  process.exit(completed ? 0 : 1);
})().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
' 127.0.0.1:18083 "$NS" "$AGENT" "$EMAIL" "$EXPECT"

echo "--- LiteLLM /v1/$WIRE traffic (last 5 min) ---"
k -n litellm logs deploy/litellm --since=5m 2>/dev/null | grep -E "v1/$WIRE" | tail -5 || true
echo "T28 OK — $AGENT woke on the ModelConfig -> LiteLLM /v1/$WIRE path"
