# fixtures/py-edge

The Python edge shapes: a FastAPI app that calls an outside API with httpx, writes through SQLAlchemy to Postgres (psycopg), queues a background task and fans out with `asyncio.gather`. It checks that python-agent records the queries and the rows they changed, and that under OpenTelemetry each query shows once.

| Process | Port | What it is | Places it shows |
|---|---|---|---|
| `rates` | 4621 | `stub/rates.py`, a stand-in exchange-rate API (stdlib), declared in `.shrike/config.json` as outside place "Rates API (stub)" | `outside:localhost:4621` |
| `api` | 4620 | FastAPI under uvicorn (`app/main.py`), serves the page at `/` | `service:api` |
| Postgres | 4622 | `compose.yaml` (`docker compose up -d`), declared as data place "Postgres" | the DATABASE lane, read through `compose.yaml`'s settings |

Without Docker, set `DATABASE_URL=sqlite:///.data/edge.db` in front of the `api` command: SQLAlchemy then runs on `sqlite3`, which python-agent records.

## Install

```sh
cd fixtures/py-edge
docker compose up -d
cd app
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

`sqlalchemy<2.1` keeps OpenTelemetry's SQLAlchemy instrumentation working (0.66b1 refuses 2.1); with it and the psycopg one both on, each query is traced twice and Shrike shows it once.

## Flows

| Flow | What you should see |
|---|---|
| Order a mug in USD | `create_order()`, `usd_rate(currency='USD')`, `convert(cents=1200, rate=1)`, then the background task `send_receipt()` and its `POST /receipts` in the RATES API lane, all in the click's trip, with the INSERT under `create_order()` and the UPDATE under `send_receipt()` in the DATABASE lane. Its "What this click changed" shows `orders · 1 added, 1 changed` with the row. |
| Order a mug in EUR (the planted bug) | `usd_rate(currency='EUR')` with its `GET /rates?base=USD` (the answer has `"EUR": "0.92"`, a string), then `convert(cents=1200, rate='0.92')` red: `type str doesn't define __round__ method`. The page shows "Couldn't place the order". Fix: `float(...)` the rate in `usd_rate()`. |
| Load dashboard | `dashboard()` with two `fetch_rates()` (each with its own rates call) and `count_orders()` from `asyncio.to_thread`, all directly under it. |

Under `opentelemetry-instrument` (`.venv/bin/opentelemetry-instrument .venv/bin/uvicorn main:app --port 4620`): the request, the rates and receipts calls, the background task and the Postgres queries (each once), no function steps or values.

## Automated checks

`apps/desktop/src/main/py-edge.test.ts` runs the app through Shrike's runner, ingest and store under python-agent and under `opentelemetry-instrument`, on Postgres in Docker (port 4623) or SQLite without it. `apps/desktop/e2e/py-edge.test.ts` drives the built app on a temp copy. Both skip without `app/.venv`.
