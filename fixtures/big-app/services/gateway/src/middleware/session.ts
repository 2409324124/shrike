import type { IncomingMessage, ServerResponse } from "node:http";
import { bearer, send } from "../../../shared/http.ts";
import { verifySession, type Session } from "../clients/auth.ts";

export async function requireSession(req: IncomingMessage, res: ServerResponse): Promise<Session | undefined> {
  const session = await verifySession(bearer(req));
  if (!session) send(res, 401, { error: "Please sign in again." });
  return session;
}
