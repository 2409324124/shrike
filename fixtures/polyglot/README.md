# fixtures/polyglot

One trip across two languages: a React page (Vite), an Express gateway on Node, and a FastAPI pricing service on Python with SQLite. node-agent records the gateway, python-agent the pricing service; the gateway's `fetch` carries a `traceparent`, so the Python request nests under the gateway's call in the same trip.

| Process | Port | What it is | Places it shows |
|---|---|---|---|
| `web` | 4610 | Vite page, `/api` proxied to the gateway | `client:http://localhost:4610` |
| `gateway` | 4611 | Express 5 (`gateway/server.js`), calls pricing once per cart line | `service:gateway` |
| `pricing` | 4612 | FastAPI under uvicorn (`pricing/main.py`), SQLite at `pricing/.data/pricing.db` | `service:pricing`, `data:sqlite:pricing.db` |

## Install

Node deps come with the workspace's `pnpm install`. Python 3.12 or newer for function steps:

```sh
cd fixtures/polyglot/pricing
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Flows

| Flow | Where | What you should see |
|---|---|---|
| Quote 2 tea books (the planted bug) | `pricing/main.py:33` looks up `TAX_RATES[tax_class]`; books are in a `reduced` class that has no rate | WEB, then `POST /api/quote`, `buildQuote()`, `priceLine()` and `fetch GET /price/book?qty=2` in GATEWAY, then `GET /price/book` in PRICING with `price(sku='book', qty=2)`, `query()` and its `SELECT` in DATABASE, then `with_tax(cents=2400, tax_class='reduced')` red with `KeyError: 'reduced'`. The dive opens `pricing/main.py:47`, the line that passed the class in. The gateway answers 502 and the page shows "Couldn't get a quote". Fix: add a `reduced` rate. |
| Quote 2 tins of tea | same path | Works: Total 10.80, no error. |

## Automated checks

`apps/desktop/src/main/polyglot.test.ts` runs the gateway and pricing through Shrike's runner, ingest and store and checks the Node to Python hop. `apps/desktop/e2e/polyglot.test.ts` drives the built app on a temp copy. Both skip without `node_modules` or `pricing/.venv`.
