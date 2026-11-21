import json, uuid, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
WATCH = ("baggage", "traceparent", "x-fleet-org-id", "x-fleet-project-id", "x-fleet-user-id", "authorization")
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        echo = {k.lower(): v for k, v in self.headers.items() if k.lower() in WATCH}
        if "authorization" in echo:
            echo["authorization"] = echo["authorization"][:12] + "...(redacted)"
        print("MOCK_HEADERS " + json.dumps(echo), flush=True)
        resp = {
            "id": "chatcmpl-" + uuid.uuid4().hex,
            "object": "chat.completion",
            "model": body.get("model", "mock-gpt"),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "mock reply"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 120, "completion_tokens": 45, "total_tokens": 165},
            "fleet_echo_headers": echo,
        }
        data = json.dumps(resp).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *a):
        pass
HTTPServer(("0.0.0.0", 8000), H).serve_forever()
