import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson, send } from "../../../shared/http.ts";
import { verifySession } from "../handlers/verify.ts";

export async function verifyRoute(req: IncomingMessage, res: ServerResponse) {
  const { token } = await readJson(req);
  const session = verifySession(String(token ?? ""));
  send(res, session ? 200 : 401, session ?? { error: "Unknown or expired session" });
}
