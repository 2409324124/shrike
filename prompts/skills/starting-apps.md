---
name: Starting apps
when: Pressing Run on any project: how to find out how it starts, and what usually goes wrong
kind: run
---

# Starting apps

Every Run starts here. Lessons that hold across projects; each project's own run skill (`.shrike/skills/run-<project>.md`) says how *that* one starts. When you learn something that would help start any project, propose it with `propose_lesson`.

## Find the recipe before you run anything

1. A Shrike run skill or the project's own run skill (`.claude/skills/run-*`) beats everything: follow it exactly.
2. Else the README or CONTRIBUTING setup section, then the task runner (`justfile`, `Makefile`, `Taskfile.yml`, `package.json` scripts), then compose files, `flake.nix` / `.envrc` / `devbox.json`, `Procfile`, `pyproject.toml`, and the CI workflow (it starts the app from a clean machine, so it lists every prerequisite).
3. A script called `dev:all`, `start` or `setup` may be an interactive menu. Read it before running it; run the pieces it calls instead.

## Order that usually works

1. Check the tools and versions the project pins (`.nvmrc`, `.node-version`, `packageManager` in package.json, `.tool-versions`, `pyproject.toml`).
2. Install dependencies with the project's own package manager (the lockfile says which: `pnpm-lock.yaml` means pnpm, `uv.lock` means uv, `poetry.lock` means poetry).
3. Build shared packages that apps import from `dist` (monorepos often have `build:shared` or a `prepare` step). A stale `dist` renders a blank page.
4. Start the infra first (databases, caches, queues), wait for each port, then the API, then the web page.
5. Check each service with a real signal: its health URL, `tcp:<port>`, or `pg_isready` / `redis-cli ping`.

## Gotchas that repeat

- Python tools (`uvicorn`, `alembic`, `pytest`) are rarely on PATH: run them through the project's runner (`uv run`, `poetry run`, `pipenv run`, or `.venv/bin/`).
- Nix projects put their tools on PATH through `.envrc` (`use flake`): use `nix develop -c <cmd>` or `direnv exec . <cmd>`.
- process-compose (often behind `just services` or `nix run`) opens a full-screen TUI and dies without a terminal: set `PC_DISABLE_TUI=true`.
- Missing settings: copy the template (`.env.example`) and ask the user only for real secrets. Read the app's env loader to know which file it reads (`.env.local` vs `.env`).
- "Port already in use" usually means an old copy of this app is still running: find it with `lsof -i :<port>` and ask before stopping it.
- `Cannot find package` or `Cannot find module` after a pull: install again, then rebuild the shared packages.
- Two ways to start the same infra (Nix and Docker) fight over the same ports: pick one.

## Lessons learned
