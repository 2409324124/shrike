# fixtures/py-app

A plain HTML page and a FastAPI API recorded through OpenTelemetry, not node-agent. It's the check that any backend speaking OpenTelemetry shows real steps in its lane instead of the grey "Shrike can't see inside it" station.

| Process | Port | What it is | Places it shows |
|---|---|---|---|
| `web` | 5190 | `python3 -m http.server` serving `web/index.html` | `client:http://localhost:5190` |
| `api` | 8010 | FastAPI under `opentelemetry-instrument`, SQLite at `api/.data/shop.db` | `service:api`, `data:sqlite` |

The page calls the API cross-origin (no traceparent), so Shrike joins the API's side to the click by method, host, path and time, as it does for Node services.

## Install

Python 3.10 or newer:

```sh
cd fixtures/py-app/api
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Then open `fixtures/py-app` in Shrike and press Run. Shrike sets `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` and the rest, so `opentelemetry-instrument` sends its traces to Shrike's `/v1/traces`.

## Flows

| Flow | Where | What you should see |
|---|---|---|
| Unit price of Gift card (the planted bug) | `api/main.py:47` divides by `pack_size`, which is 0 for the gift card | The click, the page's call, the API's `GET /api/items/3/unit-price` in the API lane with `ZeroDivisionError` at `api/main.py:47`, and its `SELECT` in the SQLite lane. The page shows "Couldn't get the price". Fix: answer a clear 400, or give gift cards a pack size of 1. |
| Unit price of Coffee beans | same route | Works: the request and its query, no error. |

## What OpenTelemetry gives

Basic tracing: requests, queries and outside calls, with timing and errors. No argument or return values per function, and a step's place in the code only where the SDK records it (or from a Python traceback on errors).

## Automated check

`apps/desktop/src/main/otlp.test.ts` runs this app for real when `api/.venv` exists, and skips that test otherwise. The rest of that file needs no Python.
