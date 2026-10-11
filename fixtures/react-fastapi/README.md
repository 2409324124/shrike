# fixtures/react-fastapi

A Vite + React 19 (TypeScript) shop in `web/` and a FastAPI API in `api/` with SQLite, laid out like a real monorepo: no root `package.json` and no `.shrike/config.json`. Shrike's scanner finds both processes on its own.

| Process | Folder | Command Shrike finds | Address |
|---|---|---|---|
| `web` | `web` | `npm run dev` (Vite, port 4510 from `vite.config.ts`) | `http://localhost:4510` |
| `api` | `api` | `.venv/bin/uvicorn main:app --reload --port 4511` | `http://localhost:4511` |

The API's port comes from the page's side: the Vite proxy target (`/api` to `http://localhost:4511`), or `VITE_API_URL` when it's set.

## Two ways the page calls the API

- **Through the Vite proxy** (the default): the page calls `/api/...` on its own origin, Vite forwards it, and the request carries the page's `traceparent`.
- **Cross-origin with CORS**: put `VITE_API_URL=http://localhost:4511` in `web/.env.local`. The page calls the API directly, FastAPI's `CORSMiddleware` allows `http://localhost:4510` (`CORS_ORIGINS` to change it), and Shrike joins the API's side to the click by method, host, path and time.

## Install

```sh
pnpm install                       # from the repo root: web/ is a workspace package
cd fixtures/react-fastapi/api
python3.12 -m venv .venv           # Python 3.12 or newer for function steps
.venv/bin/pip install -r requirements.txt
```

Open `fixtures/react-fastapi` in Shrike and press Run.

## Flows

| Flow | Where | What you should see |
|---|---|---|
| Click "Add Coffee beans" | `web/src/App.tsx:43`, `api/orders.py:17` | Works: `onClick` at `App.tsx:43`, the page's `fetch POST /api/cart`, `POST /api/cart` in the API lane with `add()`, `add_item(product_id=1, qty=1)` and the `INSERT INTO cart_items` in the SQLite lane. |
| Type an email and the promo `SAVE10`, press Enter (the planted bug) | `api/orders.py:28` multiplies by the percent instead of taking a percent of it | `onSubmit` at `App.tsx:56`, `POST /api/checkout`, `place_order()`, `discount_cents(subtotal_cents=1800, promo='SAVE10')` returning `18000`, then `INSERT INTO orders` refused with `CHECK constraint failed: total_cents >= 0` at `api/orders.py:35`. Fix: `subtotal_cents * percent // 100`. Cross-origin, the page only sees "Failed to fetch" (FastAPI's 500 carries no CORS headers); Shrike still reads it as the server's 500. |

## Automated checks

`apps/desktop/e2e/react-python.test.ts` runs both ways on a copy (skipped without `api/.venv` or `web/node_modules`).
