import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { findUserByEmail, insertUser, listUsers } from "./users.ts";

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) text += chunk;
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

// Creating a user is safe to repeat: if the email is already registered, you get that user back (200).
async function createUser(req: IncomingMessage, res: ServerResponse) {
  const { email, name } = await readJson(req);
  if (typeof email !== "string" || !email.includes("@") || typeof name !== "string" || !name.trim()) {
    return send(res, 400, { error: "Send an email and a name." });
  }
  const existing = findUserByEmail(email);
  if (existing) return send(res, 200, existing);
  try {
    send(res, 201, insertUser(email, name.trim()));
  } catch (err) {
    if (/UNIQUE constraint failed/.test((err as Error).message)) return send(res, 409, { error: `${email} is already registered.` });
    throw err;
  }
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const path = (req.url ?? "/").split("?")[0];
  try {
    if (req.method === "POST" && path === "/v1/users") return await createUser(req, res);
    if (req.method === "GET" && path === "/v1/users") return send(res, 200, listUsers());
    if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });
    send(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: (err as Error).message });
  }
}

createServer(route).listen(Number(process.env.API_PORT ?? 4300), function onListen() {
  console.log(`API ready on http://localhost:${process.env.API_PORT ?? 4300}`);
});
