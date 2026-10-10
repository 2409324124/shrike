import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { Redis } from "ioredis";
import { LRUCache } from "lru-cache";

const { REDIS_PORT, DB_DIR } = process.env;
const file = new DatabaseSync(path.join(DB_DIR ?? ".", "shop.db"));
file.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, password TEXT NOT NULL)");
file.exec("INSERT INTO users (name, password) VALUES ('Ann', 'hunter2'), ('Bo', 'swordfish')");
const mem = new DatabaseSync(":memory:");
mem.exec("CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)");
mem.exec("INSERT INTO todos (title) VALUES ('one'), ('two'), ('three')");
const pg = new PGlite("memory://orders");
await pg.exec("CREATE TABLE orders (id SERIAL PRIMARY KEY, amount INT NOT NULL, status TEXT NOT NULL DEFAULT 'new'); INSERT INTO orders (amount) VALUES (100), (250)");
const sessions = new LRUCache<string, { user: string }>({ max: 10, ttl: 60_000 });
const redis = new Redis({ host: "127.0.0.1", port: Number(REDIS_PORT), maxRetriesPerRequest: 1 });

const routes: Record<string, (arg: string) => unknown> = {
  "todo-add": (title) => mem.prepare("INSERT INTO todos (title) VALUES (?) RETURNING *").get(title),
  "todo-done": (id) => mem.prepare("UPDATE todos SET done = 1 WHERE id = ?").run(Number(id)),
  "todo-del": (id) => mem.prepare("DELETE FROM todos WHERE id = ?").run(Number(id)),
  "todo-bad": () => mem.prepare("INSERT INTO todos (title) VALUES (?)").run(null),
  "user-add": (name) => file.prepare("INSERT INTO users (name, password) VALUES (?, ?)").run(name, "letmein"),
  "users": () => file.prepare("SELECT id, name FROM users ORDER BY id").all(),
  "order-add": async (amount) => (await pg.query("INSERT INTO orders (amount) VALUES ($1) RETURNING id, amount", [Number(amount)])).rows,
  "order-ship": async (id) => (await pg.query("UPDATE orders SET status = $1 WHERE id = $2", ["shipped", Number(id)])).affectedRows,
  "session": (id) => {
    let s = sessions.get(id);
    if (!s) sessions.set(id, (s = { user: `user${id}` }));
    return s;
  },
  "lru-order": () => [...sessions.keys()],
  "redis": async (key) => redis.get(key),
};

const server = http.createServer(async (req, res) => {
  const [, name, arg] = (req.url ?? "").split("/");
  const route = routes[name ?? ""];
  res.setHeader("content-type", "application/json");
  if (!route) return void res.writeHead(404).end("{}");
  try {
    res.end(JSON.stringify((await route(decodeURIComponent(arg ?? ""))) ?? null));
  } catch (e) {
    res.writeHead(500).end(JSON.stringify({ error: (e as Error).message }));
  }
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  console.log(`listening ${typeof address === "object" && address ? address.port : ""}`);
});
