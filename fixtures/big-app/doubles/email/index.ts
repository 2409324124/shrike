// A stand-in for a transactional email provider, so Bazaar sends nothing real. Declared "outside" in .shrike/config.json.
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson, send, serve } from "../../services/shared/http.ts";

async function sendEmail(req: IncomingMessage, res: ServerResponse) {
  const { to, subject } = await readJson(req);
  if (typeof to !== "string" || !to.includes("@")) return send(res, 422, { error: { message: "A recipient address is required" } });
  setTimeout(() => send(res, 202, { id: `msg_${randomBytes(6).toString("hex")}`, to, subject, status: "queued" }), 60);
}

serve("email", { "POST /v1/messages": sendEmail });
