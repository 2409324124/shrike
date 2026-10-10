# fixtures/api-only

A backend with no web page: one Node 24 TypeScript API on `node:http` and SQLite (`node:sqlite`, `.data/users.db`, seeded with sam@example.com and lee@example.com on every start). Shrike shows no page for it; send requests from the API explorer or curl.

| Route | What it does |
|---|---|
| `POST /v1/users` `{ email, name }` | Creates a user. Safe to repeat: an email that is already registered returns that user (200). |
| `GET /v1/users` | Lists users. |
| `GET /health` | Readiness check. |

`src/nightly.ts` is a cron-style job that syncs the CRM export into accounts. Run `npm run nightly`. Under Shrike, run it with `SHRIKE_CALLER=cron` (for example as an extra process `SHRIKE_CALLER=cron node src/nightly.ts`) so its trips start in a CRON lane instead of "from outside the app". Plain curl calls show up as CURL trips.

## Planted bug

Emails are stored as typed. The unique index ignores case (`src/users.ts:10`, `COLLATE NOCASE`), but the "already registered?" lookup compares exactly (`src/users.ts:20`, `WHERE email = ?`, used at `src/server.ts:25`). So after `sam@example.com`, creating `Sam@Example.com` isn't found by the lookup, the insert hits the unique index, and the API answers 409 "Sam@Example.com is already registered." instead of returning Sam (200). The nightly sync reports "1 of 2 failed".

Fix: lowercase the email before the lookup and the insert (`const key = email.trim().toLowerCase()`).

```
curl -X POST localhost:4300/v1/users -d '{"email":"Sam@Example.com","name":"Sam Rivera"}'   # 409, should be 200
```

The port follows `API_PORT` (default 4300). Shrike sets it per worktree (W2).
