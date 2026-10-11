# A cron-style script: two calls to a local API (one refused with 500), then one to a port nobody listens on.
import http.server
import threading
import urllib.error
import urllib.request

seen = []


class Api(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        seen.append(self.headers.get("traceparent"))
        self.rfile.read(int(self.headers["content-length"]))
        self.send_response(500 if self.path == "/orders" else 200)
        self.end_headers()

    def log_message(self, *a):
        pass


server = http.server.HTTPServer(("127.0.0.1", 0), Api)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{server.server_port}"


def post(path):
    try:
        urllib.request.urlopen(urllib.request.Request(base + path, b"{}", {"content-type": "application/json"})).read()
    except urllib.error.HTTPError:
        pass


post("/orders")
post("/ok")
try:
    urllib.request.urlopen("http://127.0.0.1:9/nobody", timeout=2)
except OSError:
    pass
server.shutdown()
print(server.server_port, *seen)
