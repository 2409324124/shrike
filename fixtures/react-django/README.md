# fixtures/react-django

A Vite + React 19 (TypeScript) signup page at the root and a plain Django project in `backend/` (views returning JSON, the Django ORM on SQLite). No `.shrike/config.json`: Shrike's scanner finds both processes.

| Process | Folder | Command Shrike finds | Address |
|---|---|---|---|
| `app` | `.` | `npm run dev` (Vite, port 4520) | `http://localhost:4520` |
| `api` | `backend` | `.venv/bin/python manage.py runserver 4521` | `http://localhost:4521` |

CSRF works the way a React + Django app usually does it: the page first calls `GET /api/csrf` (`ensure_csrf_cookie`), then sends the `csrftoken` cookie's value as `X-CSRFToken` with `credentials: "include"`. `CSRF_TRUSTED_ORIGINS` and `django-cors-headers` allow `http://localhost:4520` (`FRONTEND_URL` to change it).

## Two ways the page calls the API

- **Through the Vite proxy** (the default): `/api` goes to `http://127.0.0.1:4521`, same origin for the browser.
- **Cross-origin with CORS**: put `VITE_API_URL=http://localhost:4521` in `.env.local`.

## Install

```sh
pnpm install                       # from the repo root
cd fixtures/react-django/backend
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python manage.py migrate
```

Open `fixtures/react-django` in Shrike and press Run.

## Flows

| Flow | Where | What you should see |
|---|---|---|
| Type a username, click "Check username" | `src/App.tsx:39`, `backend/accounts/views.py:23` | Works: `onClick`, `GET /api/username?u=ada`, `username_available()` and the ORM's `SELECT ... FROM "accounts_account"` in the SQLite lane. |
| Type an email, press Enter (the planted bug) | `backend/accounts/services.py:7` looks up `"Pro"` in a dict keyed `"pro"` | `onSubmit`, `POST /api/signup`, `signup()`, `create_account(...)`, `starting_credits(plan='Pro')` returning `None`, then the ORM's `INSERT INTO "accounts_account"` refused with `NOT NULL constraint failed: accounts_account.credits` at `services.py:12`. Fix: `PLAN_CREDITS.get(plan.strip().lower())`. |

## Automated checks

`apps/desktop/e2e/react-python.test.ts` runs both ways on a copy (migrating it first; skipped without `backend/.venv` or `node_modules`).
