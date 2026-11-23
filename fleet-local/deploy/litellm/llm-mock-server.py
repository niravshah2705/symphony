import json, time, uuid, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

WATCH = ("baggage", "traceparent", "x-fleet-org-id", "x-fleet-project-id", "x-fleet-user-id", "authorization")
MOCK_TEXT = "mock reply"
# Split across deltas on purpose. The ModelConfigs kagent renders all set
# `stream: true`, and this stub used to answer every request with a
# non-streamed chat.completion body: LiteLLM then converted it into one chunk
# with an EMPTY delta, so the harness received a clean completion carrying zero
# text and the task settled COMPLETED with no parts at all. A client that reads
# only the first chunk, or concatenates without a separator, shows up here
# instead of passing silently.
MOCK_DELTAS = ("mock ", "reply")


def chunk(cid, model, delta, finish, usage=None):
    out = {
        "id": cid,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }
    if usage is not None:
        out["usage"] = usage
    return out


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        echo = {k.lower(): v for k, v in self.headers.items() if k.lower() in WATCH}
        if "authorization" in echo:
            echo["authorization"] = echo["authorization"][:12] + "...(redacted)"
        print("MOCK_HEADERS " + json.dumps(echo), flush=True)
        if body.get("stream"):
            self.stream_completion(body, echo)
        else:
            self.json_completion(body, echo)

    def json_completion(self, body, echo):
        resp = {
            "id": "chatcmpl-" + uuid.uuid4().hex,
            "object": "chat.completion",
            "created": int(time.time()),
            "model": body.get("model", "mock-gpt"),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": MOCK_TEXT}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 120, "completion_tokens": 45, "total_tokens": 165},
            "fleet_echo_headers": echo,
        }
        data = json.dumps(resp).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def stream_completion(self, body, echo):
        cid = "chatcmpl-" + uuid.uuid4().hex
        model = body.get("model", "mock-gpt")
        usage = {"prompt_tokens": 120, "completion_tokens": 45, "total_tokens": 165}
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        # No Content-Length: the close delimits the response, which is what a
        # stream of unknown length needs.
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        def event(payload):
            self.wfile.write(b"data: " + json.dumps(payload).encode() + b"\n\n")
            self.wfile.flush()

        for i, text in enumerate(MOCK_DELTAS):
            # The OpenAI shape puts the role on the first delta only.
            delta = {"role": "assistant", "content": text} if i == 0 else {"content": text}
            event(chunk(cid, model, delta, None))
        event(chunk(cid, model, {}, "stop", usage))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def log_message(self, *a):
        pass


HTTPServer(("0.0.0.0", 8000), H).serve_forever()
