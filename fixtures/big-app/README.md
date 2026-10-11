# fixtures/big-app

Bazaar, a marketplace split into twelve processes, to show Shrike on a large, complicated flow. One "Place order" click is a single trip through 8 services, 3 Postgres databases, an SQLite outbox, 3 LRU caches, a queue, and Stripe and email test doubles: about 75 named functions in about 50 files, timings from under 1ms to 1.2s. Vite 6 + React 18 page, Node 24 TypeScript services on `node:http` (type stripping, `node --watch`), the same dependencies as `fixtures/shop-app`.

| Process | Port | What it is | Places it shows |
|---|---|---|---|
| `web` | 5190 | The Bazaar page, `/api` proxied to the gateway | `client:http://localhost:5190` |
| `gateway` | 4400 | Signs the shopper in, then orchestrates the order | `service:gateway` |
| `auth` | 4401 | Session check | `service:auth`, `cache:lru:sessions` (hit, then refreshed) |
| `catalog` | 4402 | Products, prices, promotions | `service:catalog`, `data:postgres:catalog` (PGlite), `cache:lru:products` |
| `search` | 4403 | In-memory inverted index, related searches | `service:search` |
| `cart` | 4404 | The cart, priced in whole cents | `service:cart`, `data:postgres:carts`, `cache:lru:carts` |
| `orders` | 4405 | Charges, saves, writes the outbox, builds the receipt | `service:orders`, `data:postgres:orders`, `data:sqlite:outbox.db` (`.data/outbox.db`) |
| `recommendations` | 4406 | "You might also like" | `service:recommendations` |
| `notifications` | 4407 | Order emails | `service:notifications` |
| `queue` | 4408 | A tiny in-memory broker: accepts, then delivers to subscribers | declared `queue` place "QUEUE · order-events" |
| `stripe` | 4498 | A stand-in for Stripe's PaymentIntents API | declared outside place "Stripe (test double)", runs without the recorder |
| `email` | 4499 | A stand-in for an email provider | declared outside place "Email (test double)", runs without the recorder |
| `cron` | none | Nightly search reindex (once 4s after boot, then every 24h), `SHRIKE_CALLER=cron` | the `CRON` caller lane |

Code lives in `services/<name>/src/{routes,handlers,domain,db,cache,clients,...}`; `services/shared/http.ts` is the shared server and the port table. The doubles are in `doubles/`.

## Place order, step by step

1. **gateway** `routes/orders.ts` checks the session with **auth** (`LRU · sessions` hit, then set), then loads the cart from **cart** (`LRU · carts` hit; the page load filled it from Postgres).
2. **At the same time** (`Promise.all`): **catalog** quotes today's prices (Postgres, promotions); **search** scores related products (`domain/scoring.ts` re-reads the whole corpus for every term: the 1.2s step); **recommendations** fetches 6 products from **catalog** one after another (`handlers/forUser.ts`, an N+1: a `getProduct() ×6` coil, each a product cache miss, a Postgres read and a cache fill).
3. **orders** `handlers/placeOrder.ts`: creates a Stripe payment intent, which answers "processing", and polls it with exponential backoff (100, 200, 400ms) until it succeeds (`domain/payment.ts`); saves the order in a transaction (BEGIN, two INSERTs, COMMIT); writes an outbox row to SQLite; relays it to the **queue**, which answers 202 and delivers to **notifications**, which renders the email and sends it through the email double; marks the outbox row sent.
4. **orders** builds the receipt. This is where it breaks.

Other trips: opening the page (products from catalog, the cart with a cache miss and fill) and the cron reindex (CRON, search, catalog, Postgres) both work.

## Planted bug

The receipt shows tax per line. `services/orders/src/domain/totals.ts:25` multiplies each line's cents by the tax rate and doesn't round: `money(line.cents * line.taxRate)` gets 2499 × 0.0825 = 206.1675 cents, and `money()` (`domain/money.ts`), which only accepts whole cents, throws `RangeError: Money must be a whole number of cents, got 206.16750000000002`. Orders answers 500, the gateway 502, and the page shows "We couldn't place your order." By then the card was charged, the order saved and the email sent: the trip snaps red at the very end, on `money()` called at `totals.ts:25`.

Fix (one line):

```ts
return money(Math.round(line.cents * line.taxRate));
```

The per-line taxes are then 206 + 285 + 214 = 705 cents, the same tax the cart charged. Nothing is red; the trip reads SLOW and points at `scoreAll()` in search, the next thing to look at.

## Run

Shrike starts the processes from `.shrike/config.json`. By hand: `npm run dev` (all of them at once) or `npm run dev:<name>` per terminal.

Ports follow env vars, with the table above as defaults: `WEB_PORT`, `GATEWAY_PORT`, `AUTH_PORT`, `CATALOG_PORT`, `SEARCH_PORT`, `CART_PORT`, `ORDERS_PORT`, `RECOMMENDATIONS_PORT`, `NOTIFICATIONS_PORT`, `QUEUE_PORT`, `STRIPE_PORT`, `EMAIL_PORT` (`services/shared/http.ts` and the Vite proxy follow them). Shrike sets them per worktree (W2), so two copies run side by side. `CRON_BOOT_DELAY_MS` moves the first reindex.

The page signs in as the seeded demo shopper (`authorization: Bearer demo-token`).
