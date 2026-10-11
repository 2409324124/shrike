# Writing a recorder for a new stack

Shrike doesn't care what language your backend is in. A recorder is a small library that runs inside the app, turns what the app does into `DebugEvent`s, and posts them to Shrike. The Thread, the Files view, the inspector and the agent all read those events and nothing else, so a new recorder lights up every feature at once.

There are two ways in. Pick the first unless you need function-level steps.

## 1. Use OpenTelemetry (no recorder code)

If the stack has an OpenTelemetry SDK, Shrike already understands it. The runner sets `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_SERVICE_NAME` for every process it starts, and `apps/desktop/src/main/otlp.ts` maps the spans it receives on `/v1/traces` into events. You get requests, queries, outside calls and errors ("basic tracing"), but no function steps or values. Try this first and open an issue with what's missing.

## 2. Write a recorder

Read [`packages/python-agent`](../packages/python-agent) first. It's the smallest complete recorder (standard library only), and every rule below is visible in it. [`packages/node-agent`](../packages/node-agent) is the full-featured one.

### What Shrike gives your process

The runner starts the app with these environment variables. Stay completely inert unless they're set.

| Variable | Meaning |
|---|---|
| `SHRIKE_INGEST_URL` | Base URL of Shrike's local ingest, for example `http://127.0.0.1:53211` |
| `SHRIKE_TOKEN` | Send it as the `x-shrike-token` header on every post |
| `SHRIKE_PROJECT_ROOT` | Record only code under this folder (skip dependencies and virtualenvs) |
| `SHRIKE_SERVICE` | The process name; becomes the lane, place id `service:<name>` |
| `SHRIKE_CALLER` | Set for scripts like cron jobs: calls they make start their own trip |

To load your recorder without the user changing code, add a line to the runner where it builds each process's environment (`apps/desktop/src/main/runner.ts`), the way Node gets `NODE_OPTIONS=--import` and Python gets `PYTHONPATH`.

### What you send

`POST <SHRIKE_INGEST_URL>/ingest` with JSON, batched about every 100 ms:

- `{"type": "hello", "source": "server", "pid": ..., "place": {...}, "url": "http://localhost:<port>", "at": <ms>}` once you know your port, so the lane counts as recorded.
- `{"type": "events", "events": [DebugEvent, ...]}` for everything else.

The full `DebugEvent` type is in [`packages/schema/src/index.ts`](../packages/schema/src/index.ts) and the wire format in [docs/04-data-model.md](04-data-model.md#ingest-wire-format-agents--main). The events that matter most:

| `kind` | When | Key fields |
|---|---|---|
| `http_request` | A request arrives | `http.method`, `http.url`, `http.status`, `http.reqHeaders.host` |
| `function` | A call into the user's own code | `name`, `source` (file and line), `args`, `returned`, `error` |
| `db_query` | A query runs | `db.system`, `db.statement`, `db.params`, `place` (`data:<system>:<db>`) |
| `external_call` | An outgoing HTTP call | `http.*`, `place` (`outside:<host>`) |
| `log`, `error` | Logs and uncaught errors | `log`, `error` |

Joining: read the incoming `traceparent` header and reuse its trace id, with its span id as your request's `parentId`. Send `traceparent` on outgoing calls so the next service nests under you. Ids are 32 (trace) and 16 (span) lowercase hex characters.

### The rules

These are what make a recorder safe to run inside someone else's app:

1. **Never break the host app.** Wrap every hook, swallow your own errors, and never block a request on Shrike. If the ingest is down or slow, drop events.
2. **Stay cheap.** Turn hooks off for code outside `SHRIKE_PROJECT_ROOT` after the first call. Cap previews (2 KB per value, 64 KB per body) and the queue (10,000 events, drop the oldest).
3. **Mask secrets at the source.** Values named like passwords, tokens or keys are masked before they leave the process. Shrike redacts again on ingest, but don't rely on it.
4. **No dependencies** beyond the language's standard library, if you can manage it.
5. **Inert by default.** No env variables, a production environment, or an unsupported runtime version means do nothing at all.

### Testing it

Copy the shape of `packages/python-agent/test`: a tiny fake ingest that collects posts, a small app under `test/proj`, and checks that events nest correctly, values are captured and masked, only project files are recorded, and the app keeps working when the ingest is down. Then add a fixture under `fixtures/` with a planted bug and a live check like `apps/desktop/src/main/python.test.ts`, and a row under "Tested combinations" in [docs/14-compatibility.md](14-compatibility.md).

Open a [Support my stack](https://github.com/SumantxD/shrike/issues/new/choose) issue before you start, so we can agree on the approach.
