import http from "node:http";
import { insertTodo, listTodos } from "./db.ts";
import { Calc, greet, runJob, sum } from "./logic.ts";

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

function send(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

async function createTodo(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = JSON.parse(await readBody(req));
  const title = body.title;
  console.log("creating todo", { title });
  try {
    insertTodo({ title, userId: body.user });
    send(res, 201, listTodos());
  } catch (e) {
    send(res, 500, { error: (e as Error).message });
  }
}

const routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => unknown> = {
  "GET /api/hello": async (_req, res) => send(res, 200, { message: await greet(7) }),
  "POST /api/todos": createTodo,
  "GET /api/calc": (_req, res) => send(res, 200, { sum: sum({ a: 2, b: 3 }), scaled: new Calc(3).scale(4) }),
  "GET /api/fail": async (_req, res) => {
    try {
      await runJob(5);
    } catch (e) {
      send(res, 500, { error: (e as Error).message });
    }
  },
  "GET /api/env": (_req, res) =>
    send(res, 200, { shrike: "__shrike" in globalThis, patched: Object.hasOwn(http.Server.prototype, "emit") }),
};

const server = http.createServer((req, res) => {
  const handler = routes[`${req.method} ${req.url}`];
  if (!handler) return send(res, 404, { error: "not found" });
  handler(req, res);
});

server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => {
  const address = server.address();
  console.log(`listening ${typeof address === "object" && address ? address.port : ""}`);
});
