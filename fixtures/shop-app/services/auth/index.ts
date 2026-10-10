import { LRUCache } from "lru-cache";
import { readJson, send, serve } from "../http.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

// Signed-in sessions by token. ponytail: one demo session, seeded on start.
const sessions = new LRUCache<string, { userId: number; name: string }>({ max: 1000 });
sessions.set("demo-token", { userId: 1, name: "Sam" });

async function verifyToken(req: IncomingMessage, res: ServerResponse) {
  const { token } = await readJson(req);
  const session = sessions.get(String(token));
  send(res, session ? 200 : 401, session ?? { error: "Unknown or expired session" });
}

serve("auth", Number(process.env.AUTH_PORT ?? 4101), { "POST /verify": verifyToken });
