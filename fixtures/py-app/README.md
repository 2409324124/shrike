# fixtures/py-app

A plain HTML page and the same small shop API three times: FastAPI, Flask and Django. Shrike records each with python-agent on Python 3.12+: the request, every call into the app's own functions with their arguments and return values, and the SQLite queries, nested under the click. It is also the check that a backend speaking OpenTelemetry shows real steps in its lane.

| Process | Port | What it is | Places it shows |
|---|---|---|---|
| `web` | 5190 | `python3 -m http.server` serving `web/index.html` | `client:http://localhost:5190` |
| `api` | 8010 | FastAPI under uvicorn (`api/main.py`), SQLite at `api/.data/shop.db` | `service:api`, `data:sqlite:shop.db` |
| `flask` | 8011 | Flask (`api/flask_app.py`, data in `api/shop.py`) | `service:flask`, `data:sqlite:shop.db` |
| `django` | 8012 | Django in one file (`api/django_app.py`, data in `api/shop.py`) | `service:django`, `data:sqlite:shop.db` |

The page calls the API cross-origin (no traceparent), so Shrike joins the API's side to the click by method, host, path and time, as it does for Node services. It calls the FastAPI one; open `http://localhost:5190/?api=8011` (Flask) or `?api=8012` (Django) for the others.

## Install

Python 3.12 or newer for function steps (3.10 and 3.11 work with OpenTelemetry only, see below):

```sh
cd fixtures/py-app/api
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Then open `fixtures/py-app` in Shrike and press Run. Shrike puts python-agent first on `PYTHONPATH`; nothing in the app changes.

## Flows

| Flow | Where | What you should see |
|---|---|---|
| Unit price of Gift card on FastAPI (the planted bug) | `api/main.py:47` divides by `pack_size`, which is 0 for the gift card | The click, the page's call, `GET /api/items/3/unit-price` in the API lane with `ZeroDivisionError` at `api/main.py:47`, under it `unit_price(item_id=3)` and `query(sql='SELECT name, price_cents, pack_size ...', args=(3,))` returning `[('Gift card', 2500, 0)]`, and its `SELECT` in the SQLite lane. The page shows "Couldn't get the price". Fix: answer a clear 400, or give gift cards a pack size of 1. |
| Unit price of Gift card on Flask or Django | `api/shop.py:27`, same division | Same trip; the error is on `unit_cents(price_cents=2500, pack_size=0)`, and the request's 500 carries it although the framework answered it. Django shows the `cors` middleware step around the view. |
| Unit price of Coffee beans | same routes | Works: the request, its steps and query, no error. |

## OpenTelemetry instead

Run the API under `opentelemetry-instrument` (Python 3.10 or 3.11, or to compare): change the `api` command to `.venv/bin/opentelemetry-instrument .venv/bin/uvicorn main:app --port 8010`. Shrike sets `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` and the rest, so its traces go to Shrike's `/v1/traces`. That gives basic tracing: requests, queries and outside calls with timing and errors, no argument or return values, a step's place in the code only where the SDK records it (or from a Python traceback on errors). OpenTelemetry's own `sitecustomize` then comes first, so python-agent stays out of that process and nothing is recorded twice.

## Automated checks

When `api/.venv` exists: `apps/desktop/src/main/python.test.ts` runs the three APIs for real through Shrike's runner, ingest and store (and the OpenTelemetry command, to show it records alone), and `apps/desktop/src/main/otlp.test.ts` runs the OpenTelemetry command. Both skip otherwise.
