# @shrike/scanner

Static project understanding, zero config. `detectProject(root)` returns a `ProjectInfo`.

## Owns

- Framework detection from package.json deps (root and workspace packages): Vite, Next.js, Express, Fastify, Hono
- Dev command and likely page URL (`appUrl`); none for a backend-only project
- Processes (D12): `.shrike/config.json` `processes`, else root `dev:*` scripts, else npm/pnpm workspace packages with a `dev` script, else `Procfile`, else one `app` process running the dev command. A `--port N`, `-p N` or `PORT=N` in the command gives the process URL. A FastAPI or Django app in the root or a top folder is an `api` process from its virtualenv, on the port the page expects: an `API_URL`-style env value, else the Vite config's first local `server.proxy` target, else 8000. `sqlite3` in its Python code adds the SQLite place.
- Expected places (D11): client (page origin), one service per process (the page process and declared ones excepted), cache/data/outside guesses from deps (`pg`, `@electric-sql/pglite`, `mysql2`, `mongodb`, `mongoose`, `better-sqlite3`, `node:sqlite` and Python `sqlite3` imports, `ioredis`, `redis`, `lru-cache`, `stripe`, `openai`, `@anthropic-ai/sdk`) and the URL scheme of `DATABASE_URL` / `REDIS_URL` in `.env*` (values are never kept). Ids are prefixes of what the agents report at run time (`data:postgres` before `data:postgres:orders`).
- Declared places (D8): `.shrike/config.json` `places`, validated (`configPlaces`)
- Route discovery by regex: Express `app.<method>` / `router.<method>`, Next.js `app/**/route.ts` exports and `pages/api/**`, plain `node:http` route tables (`"POST /v1/users": handler`) and `method === "POST" && path === "/v1/users"` checks, FastAPI and Flask decorators (`@app.get("/orders/{id}")`, `@bp.route("/rooms/<int:id>", methods=[...])`, params written `:id`; router and blueprint prefixes not applied, Django `urls.py` not read). Handler file:line for each.
- Python backends: FastAPI, Flask or Django in the root or a top folder becomes an `api` process run from its virtualenv (else `uv run`, `poetry run`): `uvicorn module:app`, `fastapi dev`, `python app.py` for a Flask file that runs itself (its `port=` or `PORT` default as the port) else `flask --app module run`, `manage.py runserver`.

Runtime-observed routes are merged in by the desktop app from traces.
