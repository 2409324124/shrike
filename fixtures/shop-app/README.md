# fixtures/shop-app

A small shop split into four processes, for multi-lane trips (docs/12-feature-map.md D1–D13, T15–T19). Vite 6 + React 18 web page, three Node 24 TypeScript services on `node:http` (run directly with type stripping, `node --watch`). No Express.

| Process | Port | What it is | Places it shows |
|---|---|---|---|
| `web` | 5180 | Vite page, `/api` proxied to the API | `client:http://localhost:5180` |
| `api` | 4100 | Cart, orders, checkout | `service:api`, `data:postgres:orders` (PGlite, in memory), `cache:lru:orders`, `data:sqlite:events.db` (`.data/events.db`) |
| `auth` | 4101 | `POST /verify` checks a token against the `sessions` LRU cache | `service:auth`, `cache:lru:sessions` |
| `payments` | 4199 | A stand-in for Stripe's charges API | declared in `.shrike/config.json` as outside place "Stripe (test double)", so Shrike runs it without the recorder |

## Flows

| Flow | Where | What you should see |
|---|---|---|
| Pay now (the planted bug) | `services/api/index.ts:33` sends `amount: cart.total`; the cart total is in dollars (49), Stripe wants cents (4900) | API calls auth (session cache hit), then at the same time (`Promise.all`, line 32) charges the card and writes `checkout_started` to `events.db`. Stripe refuses with 400 "Amount must be at least 50 cents", the API answers 402 and the page shows "Payment failed". Fix: `amount: cart.total * 100`. |
| Past orders | `services/api/orders.ts:8` | First load: cache miss, Postgres query, cache set. "Refresh orders": cache hit, no query. |
| Every API call | `services/api/clients.ts` `verifyToken` | A hop from API to AUTH and a hit in `LRU · sessions`. |

The web page signs in as the seeded demo customer (`authorization: Bearer demo-token`).

Run: Shrike starts the four processes from `.shrike/config.json`. By hand: `npm run dev:web`, `npm run dev:api`, `npm run dev:auth`, `npm run dev:payments` in four terminals.

Ports follow env vars, with the table above as defaults: `WEB_PORT`, `API_PORT`, `AUTH_PORT`, `PAYMENTS_PORT` (the Vite proxy and the API's clients follow them too). Shrike sets them per worktree (W2), so two copies run side by side.
