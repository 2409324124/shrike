import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { Redis } from "ioredis";

const { AUTH_URL, STRIPE_URL, REDIS_PORT, DB_DIR } = process.env;
const redis = new Redis({ host: "127.0.0.1", port: Number(REDIS_PORT), maxRetriesPerRequest: 1 });
const sqlite = new DatabaseSync(path.join(DB_DIR ?? ".", "profiles.db"));
sqlite.exec("CREATE TABLE IF NOT EXISTS profiles (id INTEGER PRIMARY KEY, name TEXT)");
sqlite.exec("INSERT OR REPLACE INTO profiles VALUES (7, 'Ann')");
const pg = new PGlite();
await pg.exec("CREATE TABLE orders (id SERIAL PRIMARY KEY, amount INT NOT NULL)");

function send(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

async function profile(id: string) {
  const cached = await redis.get(`profile:${id}`);
  if (cached) return JSON.parse(cached);
  const row = sqlite.prepare("SELECT id, name FROM profiles WHERE id = ?").get(Number(id));
  await redis.set(`profile:${id}`, JSON.stringify(row));
  return row;
}

async function pay(amount: number) {
  await pg.query("INSERT INTO orders (amount) VALUES ($1)", [amount]);
  const r = await fetch(`${STRIPE_URL}/v1/charges`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amount }),
  });
  return { status: r.status, body: await r.json() };
}

function ping(): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(`${STRIPE_URL}/v1/ping`, (r) => {
        let body = "";
        r.on("data", (c) => (body += c));
        r.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
}

const routes: Record<string, (id: string, res: http.ServerResponse) => Promise<unknown>> = {
  session: async (id, res) => send(res, 200, await (await fetch(`${AUTH_URL}/verify?id=${id}`)).json()),
  profile: async (id, res) => send(res, 200, await profile(id)),
  pay: async (id, res) => {
    const r = await pay(Number(id));
    send(res, r.status === 200 ? 200 : 402, r.body);
  },
  ping: async (_id, res) => send(res, 200, { ping: await ping() }),
  down: async (_id, res) => {
    try {
      await fetch("http://127.0.0.1:9/nothing");
      send(res, 200, {});
    } catch {
      send(res, 502, { error: "payments are down" });
    }
  },
};

const server = http.createServer((req, res) => {
  const [, , name, id] = (req.url ?? "").split("/");
  const route = routes[name ?? ""];
  if (!route) return send(res, 404, { error: "not found" });
  route(id ?? "", res);
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  console.log(`listening ${typeof address === "object" && address ? address.port : ""}`);
});
