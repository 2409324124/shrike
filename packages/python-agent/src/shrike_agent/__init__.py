# Shrike's Python recorder. sitecustomize.py calls start() on Python 3.12+ when Shrike started this process.
import os
import sys
import time

from . import db, trace, web

# ponytail: request context comes from these framework entry points only (FastAPI and Starlette, Flask, Django).
# Another ASGI or WSGI framework records its steps only as OpenTelemetry does; upgrade path: one more entry here.
FRAMEWORKS = {
    "starlette.applications": ("Starlette", "__call__", web.wrap_asgi),
    "flask.app": ("Flask", "wsgi_app", web.wrap_wsgi),
    "django.core.handlers.wsgi": ("WSGIHandler", "__call__", web.wrap_wsgi),
    "django.core.handlers.asgi": ("ASGIHandler", "__call__", web.wrap_asgi),
}

OUTGOING = {"httpx": "patch_httpx", "http.client": "patch_http_client"}


def start():
    from .exporter import Exporter

    trace.project = os.path.realpath(os.environ["SHRIKE_PROJECT_ROOT"])
    service = (os.environ.get("SHRIKE_SERVICE") or "").strip() or "app"
    trace.place = {"kind": "service", "id": f"service:{service.lower()}", "name": service.upper()}
    out = Exporter(os.environ["SHRIKE_INGEST_URL"], os.environ.get("SHRIKE_TOKEN"))
    trace.sink = out.push
    from . import outgoing

    outgoing.configure((out.host, out.port))

    def hello(url=None):
        msg = {"type": "hello", "source": "server", "pid": os.getpid(), "at": time.time() * 1000, "place": dict(trace.place)}
        if url:
            msg["url"] = url
        out.hello(msg)

    def on_port(port):
        if port and "detail" not in trace.place:
            trace.place["detail"] = f"localhost:{port}"
            hello(f"http://localhost:{port}")

    web.on_port = on_port
    said = []

    def patch(name, module):
        if name == "sqlite3":
            from . import sqlite

            sqlite.patch(module)
            return
        if name in db.PATCHES:
            db.PATCHES[name](module)
            return
        if name in OUTGOING:
            from . import outgoing

            getattr(outgoing, OUTGOING[name])(module)
            return
        cls, attr, wrap = FRAMEWORKS[name]
        klass = getattr(module, cls)
        if not getattr(klass, "_shrike", False):
            setattr(klass, attr, wrap(getattr(klass, attr)))
            klass._shrike = True
        if not said:
            said.append(True)
            hello()  # a web app lives here: its lane is recorded (and its own OpenTelemetry SDK skipped by the ingest)

    if not trace.install():
        return
    sys.meta_path.insert(0, _Finder(set(FRAMEWORKS) | set(OUTGOING) | set(db.PATCHES) | {"sqlite3"}, patch))
    for name in OUTGOING:
        if name in sys.modules:  # http.client often loads before us
            trace.quietly(patch, name, sys.modules[name])


# Patches a module right after it loads, before whoever imported it gets it.
class _Finder:
    def __init__(self, names, patch):
        self.names, self.patch = names, patch

    def find_spec(self, name, path=None, target=None):
        if name not in self.names:
            return None
        for finder in sys.meta_path:
            if finder is self or not hasattr(finder, "find_spec"):
                continue
            spec = finder.find_spec(name, path, target)
            if spec is not None:
                break
        else:
            return None
        loader = spec.loader
        if loader is None or not hasattr(loader, "exec_module"):
            return spec
        exec_module = loader.exec_module
        patch = self.patch

        def exec_and_patch(module):
            exec_module(module)
            if module.__name__ == name:
                trace.quietly(patch, name, module)

        try:
            loader.exec_module = exec_and_patch
        except Exception:
            pass
        return spec
