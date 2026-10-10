// Contents of the sample project used by the mock api. Line numbers match docs/mvp-contract.md.

export const MOCK_ROOT = "/Users/you/Projects/todo-app";

export const files: Record<string, string> = {
  "package.json": `{
  "name": "todo-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "concurrently \\"vite\\" \\"node --watch server/index.ts\\""
  },
  "dependencies": {
    "express": "^5.1.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  }
}
`,
  ".shrike/config.json": `{
  "appUrl": "http://localhost:5173"
}
`,
  "README.md": `# todo-app

A tiny todo list with a **React** page and an *Express* server.

![The app](docs/screenshot.png)

## Run it

1. Install with \`npm install\`
2. Start both halves with \`npm run dev\`
3. Open [the app](http://localhost:5173)

\`\`\`sh
npm run dev
\`\`\`

## How it's built

- \`src/\` is the page: \`TodoForm.tsx\` adds, \`TodoList.tsx\` ticks
- \`server/\` is the API: routes in \`index.ts\`, the database in \`db.ts\`

> Todos belong to a user. The server needs a \`userId\` on every new todo.
`,
  "docs/screenshot.png": "",
  "public/logo.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#8B5CF6"/><stop offset="1" stop-color="#3FE7FF"/></linearGradient></defs><rect width="160" height="160" rx="32" fill="#060B18"/><path d="M40 52 H80 V80 H120 V108" fill="none" stroke="url(#g)" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="80" cy="52" r="8" fill="#060B18" stroke="#3FE7FF" stroke-width="5"/><circle cx="120" cy="108" r="8" fill="#060B18" stroke="#38F2A0" stroke-width="5"/></svg>
`,
  "src/api.ts": `export interface Todo {
  id: number;
  title: string;
  done: boolean;
}

export async function getTodos(): Promise<Todo[]> {
  return fetch("/api/todos").then((r) => r.json());
}

export async function createTodo(title: string, userId: number): Promise<Todo> {
  const res = await fetch("/api/todos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, userId }),
  });
  if (!res.ok) throw new Error(\`Request failed: \${res.status}\`);
  return res.json();
}

export async function toggleTodo(id: number, done: boolean): Promise<Todo> {
  const res = await fetch(\`/api/todos/\${id}\`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ done }),
  });
  return res.json();
}
`,
  "src/TodoForm.tsx": `import { useState } from "react";
import { createTodo, type Todo } from "./api.ts";

const CURRENT_USER_ID = 1;

export function TodoForm({ onAdded }: { onAdded(todo: Todo): void }) {
  const [title, setTitle] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      const todo = await createTodo(title, CURRENT_USER_ID);
      onAdded(todo);
      setTitle("");
    } catch {
      // TODO: show an error
    }
  }

  return (
    <form onSubmit={handleSubmit} className="todo-form">
      <input
        name="title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What needs doing?"
        aria-label="New todo"
        autoFocus
      />
      <button type="submit" className="primary">
        Add Todo
      </button>
    </form>
  );
}
`,
  "src/TodoList.tsx": `import { toggleTodo, type Todo } from "./api.ts";

export function TodoList({ todos, onChange }: { todos: Todo[]; onChange(t: Todo): void }) {
  if (todos.length === 0) return <p className="empty">Nothing to do.</p>;
  return (
    <ul className="todo-list">
      {todos.map((todo) => (
        <li key={todo.id}>
          <label>
            <input
              type="checkbox"
              checked={todo.done}
              onChange={async () => onChange(await toggleTodo(todo.id, !todo.done))}
            />
            {todo.title}
          </label>
        </li>
      ))}
    </ul>
  );
}
`,
  "src/App.tsx": `import { useEffect, useState } from "react";
import { getTodos, type Todo } from "./api.ts";
import { TodoForm } from "./TodoForm.tsx";
import { TodoList } from "./TodoList.tsx";

export function App() {
  const [todos, setTodos] = useState<Todo[]>([]);

  useEffect(() => {
    getTodos().then(setTodos);
  }, []);

  return (
    <main>
      <h1>My Todos</h1>
      <TodoForm onAdded={(t) => setTodos((list) => [...list, t])} />
      <TodoList todos={todos} onChange={(t) => setTodos((list) => list.map((x) => (x.id === t.id ? t : x)))} />
    </main>
  );
}
`,
  "src/main.tsx": `import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
`,
  "src/styles.css": `body {
  font-family: system-ui, sans-serif;
  max-width: 480px;
  margin: 48px auto;
}
`,
  "server/index.ts": `import express from "express";
import { createTodo, getTodos, toggleTodo, deleteTodo } from "./todos.controller.ts";

const app = express();
app.use(express.json());

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/todos", getTodos);
app.post("/api/todos", createTodo);
app.patch("/api/todos/:id", toggleTodo);
app.delete("/api/todos/:id", deleteTodo);

app.listen(3001, () => console.log("API listening on http://localhost:3001"));
`,
  "server/todos.controller.ts": `import type { Request, Response } from "express";
import { findUser, insertTodo, listTodos, removeTodo, setDone } from "./db.ts";

export async function getTodos(_req: Request, res: Response) {
  const todos = listTodos();
  const withUsers = [];
  for (const todo of todos) {
    withUsers.push({ ...todo, user: findUser(todo.user_id) });
  }
  res.json(withUsers);
}

// POST /api/todos
export async function createTodo(req: Request, res: Response) {
  const { title } = req.body;
  console.log("creating todo", { title });
  try {
    const todo = insertTodo({ title, userId: req.body.user });
    res.status(201).json(todo);
  } catch (err) {
    console.error("could not create todo", err);
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function toggleTodo(req: Request, res: Response) {
  const todo = setDone(Number(req.params.id), Boolean(req.body.done));
  res.json(todo);
}

export async function deleteTodo(req: Request, res: Response) {
  removeTodo(Number(req.params.id));
  res.status(204).end();
}
`,
  "server/db.ts": `import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec(\`
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, user_id INTEGER NOT NULL);
\`);

export function listTodos() {
  return db.prepare("SELECT * FROM todos").all() as { id: number; user_id: number }[];
}

export function findUser(id: number) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

export function insertTodo(input: { title: string; userId?: number }) {
  const stmt = db.prepare("INSERT INTO todos (title, user_id) VALUES (?, ?) RETURNING *");
  return stmt.get(input.title, input.userId ?? null);
}

export function setDone(id: number, done: boolean) {
  return db.prepare("UPDATE todos SET done = ? WHERE id = ? RETURNING *").get(done ? 1 : 0, id);
}

export function removeTodo(id: number) {
  db.prepare("DELETE FROM todos WHERE id = ?").run(id);
}
`,
};
