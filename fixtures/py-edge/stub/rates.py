# A stand-in for an outside exchange-rate API, so the fixture stays offline. Shrike runs it without the recorder.
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# The planted bug's cause: this API sends EUR as a string.
RATES = {"USD": {"EUR": "0.92", "GBP": 0.79}, "GBP": {"USD": 1.27, "EUR": 1.17}}


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/health":
            return self.reply(200, {"ok": True})
        base = parse_qs(url.query).get("base", ["USD"])[0]
        self.reply(200, RATES.get(base, {}))

    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length") or 0))
        self.reply(202, {"queued": True})

    def log_message(self, *args):
        pass


ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("RATES_PORT", 4621))), Handler).serve_forever()
