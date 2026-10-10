# fixtures/todo-app

The demo and test app. Vite 6 + React 18 frontend, Express 5 + TypeScript backend (run directly by Node 24 type stripping, `node --watch`), in-memory SQLite (`node:sqlite`). Seeded with 2 users and 4 todos on every server start.

## Must contain

| Flow | File | Purpose |
|---|---|---|
| Add a todo | `server/todos.controller.ts:18` reads `req.body.user`; frontend sends `userId` (`src/api.ts:12`); `todos.user_id` is NOT NULL | The killer demo bug: `POST /api/todos` returns 500 `NOT NULL constraint failed: todos.user_id`, the form shows "Something went wrong" |
| Dashboard | `server/dashboard.ts`: two independent 300ms awaits run sequentially (~600ms) | Sequential-await heuristic |
| List with owners | `server/todos.list.ts`: one owner query per todo | N+1 heuristic |
| Toggle a todo | `PATCH /api/todos/:id` works correctly | Clean flow (heuristics must stay quiet) |

Pinned lines (docs and tests depend on them): `src/TodoForm.tsx:31` is the "Add Todo" `<button`, `src/api.ts:12` the `fetch(` in `createTodo`, `server/todos.controller.ts:14/16/18` are `createTodo`, its `console.log`, and the `insertTodo` call. Keep them stable or update the docs.

`vite.config.ts` keeps `.tsx` out of plugin-react's Babel step so React `_debugSource` line numbers are exact (see the comment there). Edits do a full page reload instead of Fast Refresh.

Run: `npm run dev` (or `pnpm dev`) starts both: frontend on :5173 (`/api` proxied), API on :3001.

Ports follow `APP_PORT` (frontend, default 5173) and `SERVER_PORT` (API and the `/api` proxy, default 3001). Shrike sets them per worktree (W2).
