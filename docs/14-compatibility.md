# 14 · Compatibility: ten real projects, every popular database

Status on 2026-10-08, after the real-project phase. The bar: Shrike works on real projects, not just our fixtures, and supports the popular databases (see docs/13, "DB · Every popular database").

How this was checked: each project was cloned unchanged (see `scratchpad/realworld/MANIFEST.json` for repo and commit), set up with its own `setup.sh`, opened in a fresh build of Shrike running headless under Playwright, run, and driven with the test action from its `notes.md`. Every check below comes from the last verification round (two engineers who did not write the fixes), with screenshots looked at. Projects were run one or two at a time and torn down after.

Checks:

- **Opens**: Setup detects the right processes, commands and address with no hand edits.
- **Runs**: the app starts from Shrike's Run.
- **Trip**: the test action is recorded as a trip.
- **Lanes**: the right lanes (caller, client, service, data, cache) get the events.
- **Server steps**: function-level steps with real source file and line (Node servers in this round; Python 3.12+ servers since python-agent, see "Python backends" below).
- **Inspector**: clicking the database or cache lane lists real tables, collections or keys.
- **Changed**: "what this click changed" shows the write.
- **No crash**: no Shrike error toasts and no new Electron crash reports.

## Real projects

| Project | Stack | Database (driver) |
|---|---|---|
| nextjs-prisma-t3 ([create-t3-app](https://github.com/t3-oss/create-t3-app)) | Next 15 App Router, tRPC 11, Turbopack | Postgres 16 (Prisma 6) |
| nextjs-supabase ([next.js with-supabase](https://github.com/vercel/next.js/tree/canary/examples/with-supabase)) | Next 16, @supabase/ssr, local Supabase | Postgres 17 through PostgREST and GoTrue (supabase-js) |
| vite-react-firebase ([reactfire](https://github.com/FirebaseExtended/reactfire)) | Vite + React SPA, no app server | Firestore emulator (firebase 9 browser SDK) |
| express-mongoose ([node-express-boilerplate](https://github.com/hagopj13/node-express-boilerplate)) | Express 4, CommonJS, API only | MongoDB 7 (mongoose 5, mongodb 3.7) |
| nestjs-typeorm-mysql ([nest sample 05-sql-typeorm](https://github.com/nestjs/nest)) | NestJS, compiled to dist, API only | MySQL 8.4 (TypeORM over mysql2) |
| remix-indie-stack ([indie-stack](https://github.com/remix-run/indie-stack)) | Remix 2, one esbuild bundle, remix-serve | SQLite file (Prisma 5) |
| hono-drizzle-pg ([create-better-t-stack](https://github.com/AmanVarshney01/create-better-t-stack)) | Turborepo: Hono + oRPC server, Vite web on another origin | Postgres 16 (Drizzle over pg Pool) |
| express-sequelize-mysql ([sequelize/express-example](https://github.com/sequelize/express-example)) | Express 4, CommonJS, app in a subfolder | MySQL 8.4 (Sequelize over mysql2) |
| express-redis ([redis-starter-js](https://github.com/redis-developer/redis-starter-js)) | Express 5, TypeScript via tsx, API only | Redis 8 with JSON and search (node-redis 5) |
| fastapi-sqlalchemy-pg ([full-stack-fastapi-template](https://github.com/fastapi/full-stack-fastapi-template)) | FastAPI (Python) + Vite React | Postgres (SQLModel over psycopg) |

### Results

pass / partial / fail / n/a, each with the reason.

| Project | Opens | Runs | Trip | Lanes | Server steps | Inspector | Changed | No crash |
|---|---|---|---|---|---|---|---|---|
| nextjs-prisma-t3 | pass: `npm run dev` on :3000 (Next's own port) | pass | pass: Submit, refetch folded in | pass: you, page, server, Postgres | pass: `create (mutation)()` post.ts:16; the INSERT is placed at trpc.ts:91 (the await), not post.ts:17 | pass: Post, real rows, read-only transaction from .env | pass: Post 1 added | pass |
| nextjs-supabase | pass | pass | pass: sign up, login, /notes by typed address and by link | pass: Supabase calls on the Supabase data lane, not "the server" | pass: `Page()` app/notes/page.tsx:3, then `SELECT * FROM notes` | pass: notes, from supabase/config.toml | partial: sign up shows auth.users 1 added; login writes (sessions, last_sign_in_at) are not shown | pass |
| vite-react-firebase | pass: finds both processes and picks firebase-tools@13 with JDK 17, with a plain note why | pass | pass: Clicked "+" is one Firestore update | pass: you, page, Firestore | n/a: no app server | pass: count/counter = 1 (emulator only) | pass: count 1 changed | pass |
| express-mongoose | pass: `npm run dev` on :13002, port read from .env | pass | pass: register, list users | pass: explorer, server, MongoDB | pass: CommonJS steps under nodemon; Mongo queries have no source line | pass: users, tokens, passwords masked | pass: users 1 added, tokens 1 added | pass |
| nestjs-typeorm-mysql | partial: `npm run start:dev` on :13004 found; last verified with the command `set -a; source .env; set +a; npm run start:dev` typed in Setup | pass | pass: POST /users | pass: explorer, api, MySQL | pass: `UsersController.create()` src/users/users.controller.ts:19 (mapped from dist) | pass: user table | pass: user 1 added | pass |
| remix-indie-stack | pass: `remix dev -c "remix-serve ./build/index.js"` on :13005 | pass | pass: Save note | pass: you, page, server, SQLite | pass: `action()` notes.new.tsx:9 (bundler rename undone), `createNote()` | pass: prisma/data.db tables | pass: Note 1 added | pass |
| hono-drizzle-pg | pass: server and web per package, ports from config | pass | pass: Add joins page fetch and server across origins | pass: you, page, server, Postgres | pass: `create (handler)()` todo.ts:14; queries at todo.ts:14 (approximate) | pass: todo, from apps/server/.env | pass: todo 1 added (generated id not shown) | pass |
| express-sequelize-mysql | pass: `npm run start` in express-main-example on :13003 | pass | pass: POST /api/instruments | pass: explorer, server, MySQL | pass: `create()` routes/instruments.js:19 (CommonJS) | pass: instruments, orchestras, users | pass: instruments 1 added | pass |
| express-redis | pass: offers `node --import tsx server/index.ts` instead of the Bun script | pass | pass: create, search | pass: explorer, server, Redis cache lane | pass: controller and model steps; JSON.SET at model.ts:149; full key shown | pass: todos:&lt;uuid&gt; keys and the logs stream | partial: the cache inspector does not light the key a JSON.SET wrote | pass |
| fastapi-sqlalchemy-pg | pass: finds the uv/fastapi api and the vite web | pass | pass: Save item, joined to the API lane | partial: database lane present but gets no queries (Python) | n/a: Python | pass: alembic_version, item, user, from .env | partial: says plainly it can't see writes behind a Python server | pass |

Summary: every project opens, runs, records its trip and shows real data in the inspector, with no error toasts and no new crash reports. Six of ten pass every check that applies; nextjs-supabase, nestjs-typeorm-mysql, express-redis and fastapi-sqlalchemy-pg each have a partial, listed under "What remains".

Two notes on method:

- The last round reused `.shrike/config.json` files for nestjs, remix, hono, express-redis and fastapi. Each holds only commands and ports a user can type in Setup. Remix, hono, express-redis and fastapi were also run in the round before with pure detection and no config, and passed. nestjs was not, so its Opens is partial.
- Next projects run on Next's default port 3000, not the MANIFEST's 13000/13001. That is the project's own behavior and is correct.

## Database support matrix

Two layers (docs/13): **see it run** is node-agent or browser-agent hooking the driver, so queries show in the trip; **look inside** is Shrike's own read-only connection from the main process, for the inspector.

Verification levels:

- **Real project**: one of the ten projects above, in built Shrike.
- **Container**: a unit test against a real database in Docker (`packages/node-agent/test/drivers/containers.sh`).
- **In-process**: a real library with no server needed (SQLite files).
- **Fake**: a small HTTP or protocol double.
- **Not yet**: no hook or not tested.

### See it run (drivers, ORMs, SDKs)

| Engine | Driver or ORM | Status |
|---|---|---|
| Postgres | pg, pg Pool | Real project (hono via Drizzle), container |
| Postgres | Drizzle | Real project (hono), container |
| Postgres | Prisma 6 | Real project (t3, through Turbopack chunks) |
| Postgres | postgres.js | Container |
| Postgres | Neon serverless (HTTP and pg-style) | Fake |
| Postgres | PGlite | In-process (fixtures) |
| Postgres | Knex, Kysely | Not tested; they run on pg, so they should be covered, but nothing proves it |
| Postgres | TypeORM, Sequelize on pg | Not tested (both are proven on mysql2) |
| MySQL | mysql2 | Real project (nestjs, sequelize), container |
| MySQL | TypeORM | Real project (nestjs) |
| MySQL | Sequelize | Real project (express-sequelize), container |
| MySQL | Prisma on MySQL | Not tested |
| MySQL | @planetscale/database (HTTP) | Not yet: no hook |
| MariaDB | mysql2 | Not tested (same protocol; look-inside handles MariaDB's timeout setting) |
| SQLite | node:sqlite | In-process (fixtures) |
| SQLite | better-sqlite3 | In-process |
| SQLite | Prisma 5 and 6 | Real project (remix, Prisma 5), in-process (Prisma 6) |
| SQLite | @libsql/client local, libSQL/Turso HTTP | In-process (local), fake (HTTP) |
| MongoDB | mongodb 3.7 (through mongoose 5) | Real project (express-mongoose), container |
| MongoDB | mongodb 7, mongoose current | Container |
| Redis | node-redis 5 (incl. JSON.SET, FT.SEARCH) | Real project (express-redis), container |
| Redis | node-redis 4 | Container |
| Redis | ioredis | In-process fake (fixtures) |
| Redis | @upstash/redis (HTTP) | Fake |
| Supabase | supabase-js in the browser (PostgREST, auth) | Real project (nextjs-supabase, real local Supabase) |
| Supabase | supabase-js on the server | Real project (nextjs-supabase /notes) |
| Firestore | firebase browser SDK (WebChannel and REST) | Real project (vite-react-firebase, real emulator) |
| Firestore | firebase-admin on the server | Not yet: no hook |
| DynamoDB | client-dynamodb, lib-dynamodb | Fake (DynamoDB Local container not run) |
| In-process caches | lru-cache | In-process (fixtures) |
| In-process caches | node-cache, keyv | Not yet: no hook |
| SQLite | Python sqlite3 (python-agent) | In-process (`fixtures/py-app` FastAPI, Flask and Django, `python.test.ts`; `packages/python-agent/test`) |
| Any engine from .NET, Python, Go, Java | the SDK's OpenTelemetry database instrumentation, sent to `/v1/traces` | In-process for Python sqlite3 (`fixtures/py-app` under `opentelemetry-instrument`, the real SDK, a test in `otlp.test.ts`); other SDKs and engines not tested. Python drivers other than sqlite3 (psycopg, SQLAlchemy, pymongo, redis-py) show queries only this way |

### Look inside (direct read-only connections)

Settings are found in the project's `.env` files (also in subfolders), `DB_HOST`-style variables, the Prisma schema, docker-compose, `supabase/config.toml` and `firebase.json`. Values are never shown.

| Engine | How it stays read-only | Status |
|---|---|---|
| Postgres | read-only session and read-only transaction (a `COMMIT;` plus INSERT is refused) | Real project (t3, hono, fastapi), container |
| MySQL / MariaDB | read-only session and transaction, rolled back | Real project (nestjs, sequelize), container; MariaDB not tested |
| SQLite | file opened read-only | Real project (remix), in-process |
| MongoDB | find, count and list only; `$out` and `$merge` refused | Real project (express-mongoose), container |
| Redis | read-command allowlist; SET and FLUSHALL refused | Real project (express-redis), container |
| Supabase | Postgres from config.toml when local, else PostgREST GET with the anon key (labelled: row level security applies) | Real project (Postgres path), fake (PostgREST path) |
| Firestore | the emulator's read API | Real project (vite-react-firebase); a real Firebase project is not supported yet |
| DynamoDB | list, describe and scan only | Fake |

Every read has a timeout, errors come back in plain words without the connection string, databases not on this machine are labelled, and main still masks secret columns.

## Python backends (python-agent, 2026-10-11)

Plan, as built: Reddit users asked for Python. OpenTelemetry already gave a Python API its requests, queries and errors, but not what Node gets: every call into the app's own code in order, with arguments, return values and the exact file and line, nested under the request. `packages/python-agent` does that with the standard library only:

1. **Loading**: the runner puts `packages/python-agent/src` first on `PYTHONPATH` (the user's own entries kept after it), so Python imports its `sitecustomize.py` at startup, which runs the one it shadows. Inert unless the `SHRIKE_*` variables are set and Python is 3.12 or newer.
2. **Steps**: `sys.monitoring` (PEP 669) watches function starts and, only on functions that have been a step, returns and suspends; code outside the project root, `.venv` and `site-packages` is switched off after its first call. Previews are bounded and secret names masked.
3. **Requests**: an import hook wraps the app's entry point when its framework loads (`Starlette.__call__` for FastAPI, `Flask.wsgi_app`, Django's `WSGIHandler` and `ASGIHandler`); a `contextvars` variable carries the trip across `await`, tasks and FastAPI's threadpool.
4. **Queries**: `sqlite3.connect` returns a recording `Connection` subclass; place `data:sqlite:<file>` like node-agent.
5. **Exporter**: a daemon thread posts batches to `/ingest` every 100ms; the `hello` (place `service:<name>`) also makes the ingest drop that service's OTLP spans, so an app with its own OpenTelemetry SDK is recorded once. Under `opentelemetry-instrument`, OpenTelemetry's `sitecustomize` wins and records the process alone.

| Framework | Fixture | Join to the click | Steps with values | Error at its line | sqlite3 lane |
|---|---|---|---|---|---|
| FastAPI 0.143 (async and threadpool endpoints) on uvicorn | `fixtures/py-app` `api` | pass | pass: `unit_price(item_id=3)`, `query(...)` returning `[('Gift card', 2500, 0)]` | pass: `api/main.py:47` | pass |
| Flask 3.1 on its dev server | `fixtures/py-app` `flask` | pass | pass: `unit_cents(price_cents=2500, pack_size=0)` | pass: `api/shop.py:27`, on the 500 Flask answered | pass |
| Django 6.1 `runserver` (WSGI) | `fixtures/py-app` `django` | pass | pass: the `cors` middleware, the view, `unit_cents(...)` | pass: `api/shop.py:27`, on the 500 Django answered | pass |
| Django ASGI, other ASGI or WSGI frameworks | none | not tested (Django ASGI is hooked) | | | |

Checked with `apps/desktop/src/main/python.test.ts` (real servers through the Runner, ingest and store) and `packages/python-agent/test` on Python 3.12 and 3.14 (3.13 not installed here). Overhead on the FastAPI fixture endpoint (0.7 ms, Apple M4 Pro): +81 us per request (12%) one at a time, 24% fewer requests per second at 10 concurrent with the CPU saturated; Flask's dev server: within noise. A call into the project's own code costs about 0.15 us outside a request, a recorded step about 4 us, and past the cap of 2000 steps per request about 0.35 us.

## Operating systems

Status on 2026-10-11 (roadmap Phase 9, Windows and Linux). Everything that differs by OS goes through `apps/desktop/src/main/platform.ts` and, in the renderer, `src/renderer/src/lib/platform.ts`.

| OS | Build | Checked | Differences |
|---|---|---|---|
| macOS, Apple Silicon | Signed, notarised `.dmg` (released) | Everything, including the e2e suite and voice | None: this is the reference |
| Linux x64, arm64 | AppImage and `.deb` from `scripts/release/build-linux.sh` or the CI artifact; not released yet | In Docker (Debian 12, arm64): install, typecheck and the unit suite (609 tests: 594 pass, 13 skip; the 2 failures were the Electron sandbox in a container and a timing check under load); `build-linux.sh arm64` built both packages; the packaged app opened its window under Xvfb. Not checked: x64 outside CI, a real desktop, the e2e suite, running a project end to end | No voice. Shells run in `$SHELL -lc`, else `/bin/sh` (NixOS has no `/bin/zsh`). No "Open in Terminal" in the workspace menu. The window buttons sit over the right end of the top bar in the theme's colours. Shortcut labels read Ctrl and Alt |
| Windows x64 | Unsigned NSIS installer from `electron-builder.yml`; no script yet | Not run on Windows. CI typechecks there and runs the platform tests; the Windows branches of `platform.ts` are unit tested on macOS through an injected platform | No voice. Commands run in `cmd.exe /d /s /c` with no login-shell PATH; a process tree is stopped with `taskkill /T /F`; `node_modules` is linked with junctions, copied when that fails. Claude Code must be the native `claude.exe` (the npm `.cmd` shim can't be spawned without a shell). Open in editor uses the default app. Same title bar and labels as Linux |

NixOS: run the AppImage with `appimage-run`, or wrap `linux-unpacked` with nixpkgs' `electron`. JDKs are also looked for in `/run/current-system/sw/lib/openjdk` and `~/.nix-profile/lib/openjdk` (after `JAVA_HOME`).

## What was fixed in this phase

At the start every project ran but none had a working database lane, and only one showed any server events. Fixed, by area:

**Getting the agent into real servers (loader-runtime)**

- Framework commands that live in node_modules (`next`, `remix-serve`, `ts-node`, `ts-node-dev`) now turn the agent on when run from the project. Their helper workers (Turbopack's postcss worker, jest workers) stay off, so "instrumented" is no longer a false positive.
- An entry with no extension (`node dist/main`, as nest-cli runs it) is resolved the way Node does it.
- CommonJS code gets function steps (a compile hook), and so do Next's bundled server chunks.
- Steps point at source files through source maps (`src/*.ts`, not `dist/*.js`), and bundler renames like `action5` map back to `action`.
- Scripts that set their own `NODE_OPTIONS` (remix's `dev:serve`, `cross-env NODE_OPTIONS=...`) keep the agent.
- Arguments with secret-looking parameter names are masked.

**Database hooks and look-inside (db-drivers)**

- New hooks for pg, postgres.js, Neon, Prisma 4 to 6, mysql2, MongoDB 3.6 to 7, node-redis 4 and 5, better-sqlite3, libSQL, DynamoDB, and HTTP-based Supabase, Upstash, Neon and libSQL.
- The read-only direct connections above, used whenever no running process holds the lane.
- The inspector no longer says "Your app isn't running" while it runs; that text now appears only when the lane's process is stopped.
- Prisma: concurrent queries keep their own SQL, and a write leads its statement so the station reads INSERT, not SELECT.
- Lazy query builders (Drizzle, Prisma) get the location of the function step around them, marked approximate.

**Browser SDKs and joining trips (browser-sdk)**

- Supabase PostgREST and auth calls, and Firestore WebChannel and REST calls, become database queries on their own lane.
- A page calling the project's own API on another origin is joined to that server's work (hono), instead of splitting into "(from outside the app)" trips.
- Turbopack dev source maps resolve browser locations to `.tsx` files.
- Next's own dev calls (`/__nextjs_*`, HMR) are no longer trips.

**Setup detection (runner-setup)**

- No more proposing a `dev` script that doesn't exist. Detection now finds `start:dev`, `start`, nested app folders without workspaces, Remix, the Python backend, `bun.lock`, firebase.json emulators, and ports from `.env` files. The package manager now follows the lockfile's kind (a yarn v1 lockfile no longer runs under a global yarn 4).
- `dev:*` sub-scripts aren't treated as separate processes when `dev` already runs them.
- A Bun script gets a Node command instead, so the agent can run.
- The project's `.env` now reaches each process.
- Firebase emulators get a Java that works: Setup picks a JDK 21 if present, else firebase-tools 13 on the newest JDK, with a plain note.

**UI and other**

- A page opened by typing its address is now one trip with the server's work in it.
- Argument boxes are red only when that step failed, and labels no longer overlap.
- A fetch cut off by the page's own navigation is "cancelled", not broken.
- "What this click changed" says plainly when the click went through a server Shrike can't see inside (fastapi), instead of claiming nothing changed.
- Popups are allowed in the app pane (Firebase and OAuth sign-in).
- The redactor no longer eats URL ports and paths, `className` values, or UUID parts of Redis keys.
- ANSI colour codes are stripped from log lines.

## What remains

| Gap | Where seen | Why it is still open |
|---|---|---|
| The cache inspector doesn't mark keys written by JSON.SET and other module commands | express-redis | `cacheMarks` in `apps/desktop/src/renderer/src/inspector/logic.ts` only knows plain write commands; found in the last round, not fixed yet |
| Login's writes (sessions, refresh tokens, last sign-in) don't show in "what this click changed" | nextjs-supabase | `packages/browser-agent/src/data.ts` only builds a change for sign up; GoTrue writes inside Supabase, so Shrike only sees the HTTP reply |
| Mongo queries have no source line | express-mongoose | `drivers/mongodb.mjs` reads the stack from the driver's command event and doesn't use the approximate fallback yet |
| Prisma INSERT placed at the middleware's await (trpc.ts:91), not post.ts | nextjs-prisma-t3 | Prisma's query is lazy and starts at the first await. That frame is real app code, so the fallback never runs |
| Python 3.12+ backends now get function steps and values (python-agent), but queries only for sqlite3, and "what this click changed" stays empty. .NET, Go, Java and older Python get basic tracing through OpenTelemetry only | fastapi-sqlalchemy-pg (not re-run since python-agent or `/v1/traces` landed; its psycopg queries need OpenTelemetry) | python-agent hooks sqlite3 only and captures no row data. Checked on `fixtures/py-app` (FastAPI, Flask, Django) only |
| A real Firebase project can't be read (emulator only), and server-side firebase-admin isn't hooked | vite-react-firebase | Needs firebase-admin and a service account; marked as the upgrade path in `datasources/firestore.ts` |
| nestjs detection not re-checked without the typed `.env` command | nestjs-typeorm-mysql | The runner now passes `.env` to every process (unit test), but the real project wasn't re-run without the hint |
| Drizzle insert without RETURNING shows no generated id | hono-drizzle-pg | pg doesn't return the key in that case |
| TypeORM queries carry the service step's location, not the exact line | nestjs-typeorm-mysql | The stack holds only TypeORM internals |
| Knex, Kysely, Prisma on MySQL, MariaDB, Sequelize/TypeORM on Postgres not tested | none of the ten | No project or test uses them; they sit on drivers that are tested |
| @planetscale/database, node-cache and keyv have no hook | none of the ten | Lower priority in docs/13; not built |
| DynamoDB, Upstash, Neon HTTP, libSQL HTTP and the Supabase PostgREST look-inside are only checked against fakes | none of the ten | No real project uses them; DynamoDB Local was skipped to save disk |
| A packaged build must ship pg, mysql2, mongodb, redis and the DynamoDB client | build | `electron.vite.config.ts` keeps them external because bundling them broke the build |
| Windows has never been run | build | No Windows machine; CI gates only the platform, redact and correlator tests there, the rest of the suite still assumes a POSIX shell and "/" paths |
| Linux hasn't run a project end to end in the packaged app | build | Only the welcome window was checked under Xvfb |
| firebase-tools 14+ needs Java 21 | vite-react-firebase | Environment limit. Setup now works around it with JDK 11 to 20, and asks for Java 21 when there is none |

Environment lessons for whoever runs these again:

- Remove containers with `docker rm -fv`. Anonymous volumes filled the OrbStack disk once and broke database setup.
- Delete nest's `tsconfig.build.tsbuildinfo` along with `dist`, or tsc emits nothing.
- Vite's default port 5173 clashes with the fixture regression; run real projects that default to it when fixtures are not running.
