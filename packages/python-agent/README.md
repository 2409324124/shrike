# python-agent

Runs **inside the user's Python server**, loaded by Shrike through `PYTHONPATH`. Plain Python, standard library only, no install, no change to the user's code. What node-agent does for Node, for Python 3.12+.

```
PYTHONPATH=<this package's src>:<the user's own PYTHONPATH>
SHRIKE_INGEST_URL=http://127.0.0.1:<port>  SHRIKE_TOKEN=<token>  SHRIKE_PROJECT_ROOT=<abs root>  SHRIKE_SERVICE=<process name>
```

The runner puts `src/` first on `PYTHONPATH` for every recorded process (harmless for Node), so Python imports `src/sitecustomize.py` at startup. It does nothing unless `SHRIKE_INGEST_URL` and `SHRIKE_PROJECT_ROOT` are set and the interpreter is 3.12 or newer, then runs the `sitecustomize` it shadows (Homebrew's, a venv's, the user's own) so that one still works.

| File | Does |
|---|---|
| `src/sitecustomize.py` | activation checks, starts the agent, chains to the next `sitecustomize` on `sys.path` |
| `src/shrike_agent/__init__.py` | service place from `SHRIKE_SERVICE`, `hello`, an import hook that patches a module right after it loads |
| `src/shrike_agent/trace.py` | `sys.monitoring` (PEP 669) callbacks: `function` events for code under the project root, value previews, secret masking, caps |
| `src/shrike_agent/web.py` | `http_request` events and the request context, from `Starlette.__call__` (FastAPI), `Flask.wsgi_app`, Django's `WSGIHandler` and `ASGIHandler` |
| `src/shrike_agent/sqlite.py` | `sqlite3.connect` hands out a `Connection` subclass whose cursors emit `db_query` events in a `data:sqlite:<file>` place |
| `src/shrike_agent/outgoing.py` | in a `SHRIKE_CALLER` script (cron, test) only: `http.client` calls (urllib, urllib3, requests) outside a request become `external_call` events with the script as `caller`, each its own trip, sent with a `traceparent` |
| `src/shrike_agent/exporter.py` | daemon thread, batches to `POST /ingest` every 100ms |

## What it records

- **Steps**: every call into a function whose file is under `SHRIKE_PROJECT_ROOT`, outside dot folders (`.venv`), `site-packages`, `dist-packages`, `node_modules` and `__pypackages__`, while a request is being served. Name is the qualified name (`Cart.total()`), `source` is the `def` line (not the decorator above it), `callSite` the nearest calling line in the project, `args` as `name=value` previews (`self` and `cls` left out), `returned`, `durationMs`, and `error` (type, message, traceback with project-relative paths) when an exception escapes it. Module bodies, lambdas and comprehensions are not steps.
- **Nesting**: a `contextvars` variable holds the step new events nest under, so concurrent requests, `asyncio.gather`, `asyncio.to_thread` and FastAPI's threadpool keep the right parent. Generators and coroutines give it back when they suspend and take it again when resumed. A step still open when its request ends (a generator left unfinished, or closed without running on 3.12.3) is recorded then, as it stood when it last suspended. A bare `ThreadPoolExecutor.submit` doesn't copy the context, so its work isn't recorded.
- **Requests**: method, path and query, headers, bodies up to 64 KB (read with `read`, `readline` or `readinto`, as werkzeug does), status, the incoming `traceparent` (else a `caller` from the user-agent, as node-agent does). A 500 that Flask or Django answer themselves carries the exception that escaped the app's code. The first request's port becomes the service's `detail` (`localhost:8000`) and a second `hello` with its URL.
- **Scripts**: a process started with `SHRIKE_CALLER=cron` (or `test`, ...) records each HTTP call it makes as its own trip: `caller` `{ kind, label, command: "python <script>" }`, the call's method, URL, status and calling line, and a `traceparent` header so the server's side nests under it (node-agent's `outgoing.mjs`). Other processes record no outgoing calls.
- **Queries**: `sqlite3` statements with their params, duration, error and the calling line. Other database drivers are left to OpenTelemetry.
- **Values**: previews are bounded `repr`s (2 KB, 20 items, 3 levels, bytes and strings cut before they're copied), plain objects show their fields, a `__repr__` that raises shows as the type. Arguments and dict keys or fields named like `password`, `secret`, `token`, `api_key`, `authorization`, `cookie` or `session` show `[redacted]`. The ingest's redaction runs on everything after that.
- **Caps**: 2000 steps per request and 64 nested levels; past either, one `log` event (warn) in the trip says what was skipped.

## Safety

Every hook catches its own errors; a `__repr__` or `__str__` called for a preview is never recorded and never re-enters the agent. Unrecorded code costs one callback the first time each function runs (`sys.monitoring.DISABLE`), and the project's own code outside a request about 0.15 us per call. A recorded step costs about 4 us. The exporter never blocks a request: a full queue drops the oldest of 10,000 events, a failed POST is not retried, and at exit it waits at most about a second for the batch in flight. A forked worker starts its own sender. Packaged builds ship `src/` with files named `__pycache__` so Python never writes bytecode into the signed app.

## Not covered (ceilings)

- Python before 3.12: inert; run the app under `opentelemetry-instrument` for basic tracing.
- Started under `opentelemetry-instrument`: its own `sitecustomize` comes first on `PYTHONPATH` and doesn't chain, so OpenTelemetry records the process alone (no doubled steps). An app that sets up the OpenTelemetry SDK in code is recorded by python-agent, and the ingest drops that service's OTLP spans after its `hello`.
- Request context only from FastAPI and Starlette, Flask and Django. Another framework's steps are recorded only if it is built on one of those.
- Steps run while a WSGI server iterates a streamed body, after the app returned, are not nested under the request.
- Outgoing calls only from a `SHRIKE_CALLER` script; a server's own outgoing calls (`external_call` inside a request), logs, cache and row change (`change`) events aren't recorded yet; no place inspector.

## Done when

`pnpm test` runs `test/agent.test.mjs`, which runs `python -m unittest discover -s packages/python-agent/test` on every Python 3.12+ it finds (skipped when there's none): `test_agent.py` (a stand-in Starlette and Flask app against a fake ingest: nesting, previews, masking, only project files, sqlite, errors, WSGI (bodies read with `readinto` too), a `SHRIKE_CALLER` script's calls, inert without the env and on older Python, a down or silent ingest, the queue cap, chaining) and `test_semantics.py` (classes, decorators, recursion and step caps, caught and re-raised errors, generators and async generators, threads, huge and unprintable values, secrets, concurrent requests). `apps/desktop/src/main/python.test.ts` runs `fixtures/py-app`'s FastAPI, Flask and Django APIs for real through the Runner, the ingest and the store when `fixtures/py-app/api/.venv` exists.
