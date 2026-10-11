# python3 -m unittest discover packages/python-agent/test   (Python 3.12+, stdlib only)
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from collections import namedtuple

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "src")
TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"
Run = namedtuple("Run", "got stderr stdout seconds")


def run_app(shrike=True, extra_path="", script="app.py", python=sys.executable, ingest="", timeout=30, env_extra=None):
    """Runs a test/proj script (in a temp copy of the project) against a fake ingest. Returns (messages, stderr)."""
    got = []

    class Ingest(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers["content-length"]))
            got.append((self.path, self.headers["x-shrike-token"], json.loads(body)))
            self.send_response(204)
            self.end_headers()

        def log_message(self, *a):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Ingest)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory() as tmp:
        root = os.path.join(tmp, "proj")
        shutil.copytree(os.path.join(HERE, "proj"), root)
        site = os.path.join(root, ".venv", "lib", "site-packages")
        os.makedirs(site)
        with open(os.path.join(site, "vendored.py"), "w") as f:
            f.write("def half(n):\n    return n / 2\n")
        env = {k: v for k, v in os.environ.items() if not k.startswith(("SHRIKE_", "PYTHON"))}
        env["PYTHONPATH"] = os.pathsep.join(p for p in (SRC if shrike else "", os.path.join(HERE, "libs"), site, extra_path) if p)
        if shrike:
            env.update(SHRIKE_INGEST_URL=ingest or f"http://127.0.0.1:{server.server_port}", SHRIKE_TOKEN="tok", SHRIKE_PROJECT_ROOT=root, SHRIKE_SERVICE="api")
        env.update(env_extra or {})
        t0 = time.perf_counter()
        p = subprocess.run([python, script], cwd=root, env=env, capture_output=True, text=True, timeout=timeout)
        seconds = time.perf_counter() - t0
    server.shutdown()
    server.server_close()
    assert p.returncode == 0, p.stderr
    return Run(got, p.stderr, p.stdout, seconds)


class Agent(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.got, cls.stderr, _, _ = run_app()
        cls.events = [e for _, _, m in cls.got if m["type"] == "events" for e in m["events"]]
        cls.by_name = {}
        for e in cls.events:
            cls.by_name.setdefault(e["name"], []).append(e)

    def test_posts_hello_and_events_with_token(self):
        self.assertTrue(all(path == "/ingest" and tok == "tok" for path, tok, _ in self.got))
        hellos = [m for _, _, m in self.got if m["type"] == "hello"]
        self.assertTrue(hellos)
        self.assertEqual(hellos[0]["place"]["id"], "service:api")
        self.assertIn({"url": "http://localhost:8010", "detail": "localhost:8010"}, [{"url": h.get("url"), "detail": h["place"].get("detail")} for h in hellos])
        self.assertEqual("HI THERE", self.stderr.strip(), "the app's own output is untouched")

    def test_request_with_function_steps_nested_and_previewed(self):
        req = self.by_name["GET /api/items/1/unit-price"][0]
        self.assertEqual((req["kind"], req["status"], req["http"]["status"], req["http"]["url"]), ("http_request", "ok", 200, "/api/items/1/unit-price?full=1"))
        self.assertEqual(req["http"]["reqHeaders"]["host"], "localhost:8010")
        self.assertEqual(req["caller"]["kind"], "curl")
        self.assertEqual(req["place"], {"kind": "service", "id": "service:api", "name": "API", "detail": "localhost:8010"})
        self.assertIn('"unit": 900.0', req["http"]["resBody"])
        steps = [e for e in self.events if e["traceId"] == req["traceId"] and e["kind"] == "function"]
        handler = next(e for e in steps if e["name"] == "handler()")
        self.assertEqual(handler["parentId"], req["id"])
        self.assertEqual(handler["source"], {"file": "app.py", "line": 42, "functionName": "handler", "precision": "exact"})
        load = next(e for e in steps if e["name"] == "load()")
        self.assertEqual(load["parentId"], handler["id"])
        self.assertEqual(load["args"], ["item_id=1", "opts={'token': [redacted], 'full': True}"])
        self.assertIn("'api_key': [redacted]", load["returned"])
        self.assertIn("'name': 'Coffee'", load["returned"])
        self.assertEqual(load["callSite"], {"file": "app.py", "line": 44, "precision": "exact"})
        price = next(e for e in steps if e["name"] == "unit_price()")
        self.assertEqual(price["args"][1], "password=[redacted]")
        self.assertEqual(price["returned"], "900.0")
        rates = [e for e in steps if e["name"] == "rate()"]
        self.assertEqual(sorted(r["args"][0] for r in rates), ["n=1", "n=2"])
        self.assertTrue(all(r["parentId"] == handler["id"] for r in rates), "gathered coroutines nest under the coroutine that awaited them")
        self.assertTrue(all(e["durationMs"] >= 0 for e in steps))

    def test_only_project_code_inside_requests(self):
        files = {e["source"]["file"] for e in self.events if e["kind"] == "function"}
        self.assertEqual(files, {"app.py"}, "no library, site-packages or agent frames")
        self.assertEqual(len(self.by_name["load()"]), 2, "the call at startup, outside a request, is not recorded")
        self.assertNotIn("call()", self.by_name, "the test driver's own coroutine runs outside a request")

    def test_sqlite_query(self):
        q = next(e for e in self.events if e["kind"] == "db_query" and e["name"].startswith("SELECT"))
        load = next(e for e in self.events if e["id"] == q["parentId"])
        self.assertEqual(load["name"], "load()")
        self.assertEqual((q["origin"], q["db"]["system"], q["db"]["params"], q["status"]), ("db", "sqlite", "(1,)", "ok"))
        self.assertEqual(q["place"], {"kind": "data", "id": "data:sqlite:shop.db", "name": "SQLITE · shop.db"})
        self.assertEqual(q["source"], {"file": "app.py", "line": 23, "precision": "exact"})
        self.assertFalse([e for e in self.events if e["kind"] == "db_query" and not e["name"].startswith("SELECT")], "startup statements are outside a request")

    def test_exception_captured_on_the_step_and_the_request(self):
        req = self.by_name["GET /api/items/3/unit-price"][0]
        self.assertEqual((req["traceId"], req["parentId"]), (TRACE, "00f067aa0ba902b7"), "an incoming traceparent continues the trip")
        self.assertNotIn("caller", req)
        self.assertEqual((req["status"], req["http"]["status"], req["error"]["type"]), ("error", 500, "ZeroDivisionError"))
        price = next(e for e in self.by_name["unit_price()"] if e["traceId"] == TRACE)
        self.assertEqual((price["status"], price["error"]["type"]), ("error", "ZeroDivisionError"))
        self.assertIn("division by zero", price["error"]["message"])
        self.assertIn('File "app.py", line 29, in unit_price', price["error"]["stack"])
        self.assertIn("'qty': 0", price["args"][0])

    def test_wsgi_request(self):
        req = self.by_name["POST /echo"][0]
        self.assertEqual((req["http"]["status"], req["http"]["reqBody"], req["http"]["resBody"]), (201, "hi there", "HI THERE"))
        self.assertEqual(self.by_name["POST /echo-into"][0]["http"]["reqBody"], "hi there", "a body read with readinto (werkzeug) is kept too")
        echo = self.by_name["echo()"][0]
        self.assertEqual((echo["parentId"], echo["args"], echo["returned"]), (req["id"], ["body=b'hi there'"], "b'HI THERE'"))

    def test_inert_without_shrike_env(self):
        got, stderr, _, _ = run_app(shrike=False)
        self.assertEqual(got, [])
        self.assertEqual(stderr.strip(), "HI THERE")

    def test_chains_to_the_sitecustomize_it_shadows(self):
        with tempfile.TemporaryDirectory() as other:
            with open(os.path.join(other, "sitecustomize.py"), "w") as f:
                f.write("import sys\nprint('their sitecustomize ran', file=sys.stderr)\n")
            got, stderr, _, _ = run_app(extra_path=other)
        self.assertIn("their sitecustomize ran", stderr)
        self.assertTrue(any(m["type"] == "events" for _, _, m in got))


def old_python():
    for exe in ("/usr/bin/python3", shutil.which("python3.11"), shutil.which("python3.10"), shutil.which("python3.9")):
        if exe and os.path.exists(exe):
            v = subprocess.run([exe, "-c", "import sys; print(sys.version_info >= (3, 12))"], capture_output=True, text=True)
            if v.stdout.strip() == "False":
                return exe
    return None


def requests_ms(run):
    return int(run.stdout.split("requests_ms=")[1])


class Safety(unittest.TestCase):
    @unittest.skipUnless(old_python(), "no Python older than 3.12 on this machine")
    def test_inert_on_python_older_than_312(self):
        run = run_app(python=old_python())
        self.assertEqual((run.got, run.stderr.strip()), ([], "HI THERE"))

    def test_ingest_down_never_blocks_or_raises(self):
        import socket

        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()  # nothing listens there
        run = run_app(ingest=f"http://127.0.0.1:{port}")
        self.assertEqual(run.stderr.strip(), "HI THERE")
        self.assertLess(requests_ms(run), 1000)

    def test_ingest_that_never_answers_never_blocks_the_app(self):
        import socket

        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        s.listen(16)  # accepts connections, never reads or answers
        try:
            baseline = run_app()
            run = run_app(ingest=f"http://127.0.0.1:{s.getsockname()[1]}")
        finally:
            s.close()
        self.assertEqual(run.stderr.strip(), "HI THERE")
        self.assertLess(requests_ms(run), requests_ms(baseline) + 300, "requests don't wait on the ingest")
        self.assertLess(run.seconds, baseline.seconds + 2.5, "exit waits about a second for the batch in flight, no more")

    def test_queue_keeps_the_newest_10k(self):
        sys.path.insert(0, SRC)
        try:
            from shrike_agent.exporter import MAX_QUEUE, Exporter
        finally:
            sys.path.remove(SRC)
        out = Exporter("http://127.0.0.1:9", "t")
        out.thread = object()  # no sender: the queue only fills
        for i in range(MAX_QUEUE + 5):
            out.push({"n": i})
        self.assertEqual((len(out.queue), out.queue[0]["n"], out.queue[-1]["n"]), (MAX_QUEUE, 5, MAX_QUEUE + 4))
        out.queue.clear()

    def test_caller_script_calls_start_trips_with_a_traceparent(self):
        run = run_app(script="cron.py", env_extra={"SHRIKE_CALLER": "cron"})
        port, *seen = run.stdout.split()
        calls = [e for _, _, m in run.got if m["type"] == "events" for e in m["events"] if e["kind"] == "external_call"]
        self.assertEqual([(e["name"], e["status"], e["http"].get("status")) for e in calls], [(f"POST localhost:{port}/orders", "error", 500), (f"POST localhost:{port}/ok", "ok", 200), ("GET localhost:9/nobody", "error", None)])
        self.assertEqual(seen, [f"00-{e['traceId']}-{e['id']}-01" for e in calls[:2]], "the server got each call's traceparent")
        self.assertEqual(calls[0]["caller"], {"kind": "cron", "label": "cron", "command": "python cron.py"})
        self.assertEqual((calls[0]["place"]["id"], calls[0]["source"]["file"]), (f"outside:localhost:{port}", "cron.py"))
        self.assertEqual(len({e["traceId"] for e in calls}), 3, "one trip per call")
        plain = run_app(script="cron.py")
        self.assertFalse([e for _, _, m in plain.got if m["type"] == "events" for e in m["events"] if e["kind"] == "external_call"], "only a SHRIKE_CALLER script")
        self.assertEqual(plain.stdout.split()[1:], ["None", "None"])


if __name__ == "__main__":
    unittest.main()
