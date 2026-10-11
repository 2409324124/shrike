# fixtures/py-api-only

A Python backend with no web page: a small FastAPI orders API on SQLite (`.data/orders.db`, reseeded on every start with three products and the coupon `WELCOME10`). Shrike shows no page for it; send requests from the API explorer or curl. `fixtures/flask-api-only` is the same idea on Flask.

| Route | What it does |
|---|---|
| `POST /orders` `{ customer, lines: [{ sku, qty }], coupon? }` | Places an order and returns its total in cents. |
| `GET /orders/{order_id}` | One order. |
| `GET /products` | The products. |
| `GET /health` | Readiness check. |

`reorder.py` is a cron-style job: every `REORDER_EVERY` seconds (default 60) it re-places each cafe's standing order. Under Shrike, add it in Setup as a second process, `SHRIKE_CALLER=cron .venv/bin/python reorder.py`, so its trips start in a CRON lane. Plain curl calls show up as CURL trips.

## Install

Python 3.12 or newer (python-agent records function steps on 3.12+):

```sh
cd fixtures/py-api-only
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Then open `fixtures/py-api-only` in Shrike and press Run. It runs `.venv/bin/uvicorn main:app --port 4410` (`.shrike/config.json`).

## Planted bug

Coupon codes are stored in capitals, but the lookup compares exactly (`main.py:57`, `WHERE code = ?`). A coupon typed in lower case (`welcome10`, as the standing order in `reorder.py` has it) isn't found, `coupon_percent()` returns `None`, and `order_total()` multiplies by it (`main.py:66`): `TypeError`, 500, instead of the 10% discount.

```
curl -X POST localhost:4410/orders -H 'content-type: application/json' \
  -d '{"customer":"ana@corner.cafe","lines":[{"sku":"BEANS","qty":3}],"coupon":"welcome10"}'   # 500, should be 6480
```

The trip shows `order_total(lines=[...], coupon='welcome10')` failing, under it `coupon_percent(code='welcome10')` returning `None` and its `SELECT` in the SQLITE lane. Fix: `code.upper()` in `coupon_percent()`, and a clear 400 for a code that really doesn't exist.

## Automated checks

When `.venv` exists: `apps/desktop/e2e/py-api-only.test.ts` (built app: setup, explorer, curl and cron trips) and `packages/scanner/test/scanner.test.ts` (detection and routes). The e2e skips otherwise.
