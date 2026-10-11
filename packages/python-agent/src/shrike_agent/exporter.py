# Batches events to POST /ingest every 100ms from a daemon thread. Never raises into the app, never retries.
import atexit
import collections
import json
import os
import threading
from urllib.parse import urlsplit

MAX_QUEUE = 10_000
BATCH = 500  # keeps one POST well under the ingest's 5 MB body limit


class Exporter:
    def __init__(self, ingest_url, token):
        u = urlsplit(ingest_url)
        self.host, self.port, self.path = u.hostname or "127.0.0.1", u.port or 80, u.path.rstrip("/") + "/ingest"
        self.token = token or ""
        # ponytail: drops the oldest events when the ingest is unreachable for long; no retry.
        self.queue = collections.deque(maxlen=MAX_QUEUE)
        self.hellos = collections.deque(maxlen=10)
        self.wake = threading.Event()
        self.thread = None
        self.down = False
        self._locks()
        atexit.register(self._exit)
        os.register_at_fork(after_in_child=self._forked)

    def _locks(self):
        self.lock = threading.Lock()
        self.sending = threading.Lock()  # held while a batch is out: at exit, wait for it instead of losing it

    def push(self, event):
        self.queue.append(event)
        if self.thread is None:
            self._start()

    def hello(self, message):
        self.hellos.append(message)
        if self.thread is None:
            self._start()
        self.wake.set()

    def _start(self):
        try:
            with self.lock:
                if self.thread is None:
                    self.thread = threading.Thread(target=self._run, name="shrike-exporter", daemon=True)
                    self.thread.start()
        except Exception:
            pass

    def _run(self):
        while True:
            self.wake.wait(0.1)
            self.wake.clear()
            self.flush()

    # At exit: at most ~1s for the batch in flight, then one last try unless Shrike didn't answer the last POST.
    def _exit(self):
        try:
            if not self.sending.acquire(timeout=1):
                return
            try:
                if not self.down:
                    self._drain()
            finally:
                self.sending.release()
        except Exception:
            pass

    def flush(self):
        try:
            with self.sending:
                self._drain()
        except Exception:
            pass

    def _drain(self):
        while self.hellos:
            self._post(self.hellos.popleft())
        while self.queue:
            events = []
            while self.queue and len(events) < BATCH:
                events.append(self.queue.popleft())
            self._post({"type": "events", "events": events})

    def _post(self, message):
        try:
            import http.client

            conn = http.client.HTTPConnection(self.host, self.port, timeout=2)
            try:
                body = json.dumps(message, default=str)
                conn.request("POST", self.path, body, {"content-type": "application/json", "x-shrike-token": self.token})
                conn.getresponse().read()
                self.down = False
            finally:
                conn.close()
        except Exception:
            self.down = True

    def _forked(self):
        self.thread = None
        self._locks()
        self.queue.clear()
        self.hellos.clear()
