# @shrike/node-agent

Runs **inside the user's dev server**, injected by Shrike through `NODE_OPTIONS`. Plain ESM JavaScript, no build step. Spec: [docs/mvp-contract.md](../../docs/mvp-contract.md#node-agent-packagesnode-agent-plain-esm-javascript).

```
NODE_OPTIONS="--import=<file URL of src/register.mjs> --enable-source-maps"
SHRIKE_INGEST_URL=http://127.0.0.1:<port>  SHRIKE_TOKEN=<token>  SHRIKE_PROJECT_ROOT=<abs root>
```

Inert unless `SHRIKE_INGEST_URL` is set, `NODE_ENV` is not `production`, this is the main thread, and the entry (`argv[1]` resolved like Node does, so `node dist/main` works) is the user's: a project file outside dot folders (not `.next/postcss.js`), or a server CLI in `node_modules` (`next`, `@remix-run/serve`, `@react-router/serve`, `ts-node`, `ts-node-dev`, not its workers) run from inside the project. Watchers and bundlers (nodemon, nest start, remix dev, vite) stay inert but keep the agent's `--import` in the `NODE_OPTIONS` of what they spawn, even when a script sets its own (`NODE_OPTIONS='--inspect' next dev`).

| File | Does |
|---|---|
| `src/register.mjs` | activation checks, installs everything, registers the loader, sends `hello` |
| `src/loader.mjs` | `load` hook (hooks thread): transforms project `.ts .mts .js .mjs` ESM files |
| `src/cjs.mjs` | `Module.prototype._compile` hook: transforms project CommonJS files (require, ts-node, nest's `dist`, Next's Turbopack chunks, Remix's esbuild build) |
| `src/babel-plugin.mjs` | TS strip + wraps function bodies in `__shrike.run(id, args, () => body)`; a compiled or bundled file's source map (inline, `.map` next to it, sectioned) picks the user's functions, their original file:line and original names; secret-named parameters are marked so their arguments are redacted |
| `src/runtime.mjs` | `AsyncLocalStorage` context, `__shrike.def/run`, `function` events |
| `src/http.mjs` | `http(s).Server` `request` patch, `http_request` events |
| `src/place.mjs` | places (docs/12-feature-map.md D1, D3, D7): service name (`SHRIKE_SERVICE`, else nearest `package.json` name), caller from `user-agent` / `SHRIKE_CALLER`, outside host labels |
| `src/outgoing.mjs` | global `fetch` + `http(s).request/get`: injects `traceparent`, `external_call` events |
| `src/libs.mjs` | `module.registerHooks` resolve hook: when the app resolves `ioredis`, `lru-cache`, `@electric-sql/pglite` or `node:sqlite`, loads that exact file (sync `require`, which also loads ESM on Node 24) and patches its prototypes before the importer runs |
| `src/cache.mjs` | ioredis `sendCommand` and `LRUCache` get/set/has/delete → `cache_op` events |
| `src/sqlite.mjs`, `src/pglite.mjs` | `node:sqlite` statements and PGlite `query`/`exec` → `db_query` events with a data place |
| `src/drivers/*.mjs` | docs/13 DB "see it run": pg / pg-pool / @neondatabase/serverless, postgres.js (`postgres` resolves to `postgres-entry.mjs`), mysql2, mongodb 3.6+ (command monitoring per connection), node-redis v4+, better-sqlite3 / libsql, Prisma 4-6 (its engine addon via `process.dlopen`), DynamoDB `send()`, and `http.mjs` turning Supabase PostgREST, Upstash, Neon HTTP and libSQL HTTP calls into database events. Params of secret-named columns are masked; writes carry `change` from RETURNING rows or the statement's own params |
| `src/console.mjs` | console patch, `log` events |
| `src/preview.mjs`, `src/stack.mjs` | value previews with redaction, repo-relative stack frames |
| `src/exporter.mjs` | batches events to `POST /ingest` every 100ms |
| `src/inspect.mjs` | place inspector (docs/13 I): registry of live database and cache handles, long poll on `POST /inspect/poll`, read-only reads (separate read-only SQLite connection or app-built SELECT/PRAGMA, PGlite READ ONLY transaction rolled back, lru-cache `peek`, Redis duplicate connection with read commands only), secret-named columns and keys masked; I3 write capture (`change` on `db_query`) |

Every event carries `place`; `hello` carries the service place (sent again with `url` once the server listens). A request without `traceparent` gets `caller` (curl, Postman, explorer, browser, other). Outside a request, outgoing calls are recorded only when `SHRIKE_CALLER` is set (each call starts a trip, `caller` on the `external_call`).

Tests: `node --test test/*.test.mjs` (`drivers.test.mjs` runs `test/drivers/app.mjs` with and without the agent against real databases from `test/drivers/containers.sh up`, skipping the ones not running; spawns `test/app`, `test/inspect` (the place inspector against a stand-in hub), and `test/topo` (api → auth, a fake Stripe, a fake Redis, lru-cache, PGlite, sqlite) with the agent against a fake ingest).
