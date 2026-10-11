# @shrike/scanner

Static project understanding, zero config. `detectProject(root)` returns a `ProjectInfo`.

## Owns

- Framework detection from package.json deps (root and workspace packages): Vite, Next.js, Express, Fastify, Hono
- Dev command and likely page URL (`appUrl`); none for a backend-only project
- Processes (D12): `.shrike/config.json` `processes`, else root `dev:*` scripts, else npm/pnpm workspace packages with a `dev` script, else `Procfile`, else one `app` process running the dev command. A `--port N`, `-p N` or `PORT=N` in the command gives the process URL. A FastAPI or Django app in the root or a top folder is an `api` process from its virtualenv, on the port the page expects: an `API_URL`-style env value, else the Vite config's first local `server.proxy` target, else 8000. `sqlite3` in its Python code adds the SQLite place.
- Expected places (D11): client (page origin), one service per process (the page process and declared ones excepted), cache/data/outside guesses from deps (`pg`, `@electric-sql/pglite`, `mysql2`, `mongodb`, `mongoose`, `better-sqlite3`, `node:sqlite` imports, `ioredis`, `redis`, `lru-cache`, `stripe`, `openai`, `@anthropic-ai/sdk`) and the URL scheme of `DATABASE_URL` / `REDIS_URL` in `.env*` (values are never kept). Ids are prefixes of what the agents report at run time (`data:postgres` before `data:postgres:orders`).
- Declared places (D8): `.shrike/config.json` `places`, validated (`configPlaces`)
- Route discovery by regex: Express `app.<method>` / `router.<method>`, Next.js `app/**/route.ts` exports and `pages/api/**`, plain `node:http` route tables (`"POST /v1/users": handler`) and `method === "POST" && path === "/v1/users"` checks. Handler file:line for each.

Runtime-observed routes are merged in by the desktop app from traces.
