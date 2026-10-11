// A small stand-in for Stripe's PaymentIntents API, so Bazaar runs offline. Declared "outside" in .shrike/config.json.
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson, send, serve } from "../../services/shared/http.ts";

const MINIMUM_CENTS = 50;
const PROCESSING_POLLS = 2; // like a card that needs a moment: the first two reads still say "processing"
const intents = new Map<string, { id: string; amount: number; currency: string; status: string; polls: number }>();

async function createIntent(req: IncomingMessage, res: ServerResponse) {
  const { amount, currency } = await readJson(req);
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < MINIMUM_CENTS) {
    return send(res, 400, { error: { type: "invalid_request_error", message: "Amount must be a whole number of cents, at least 50" } });
  }
  const intent = { id: `pi_${randomBytes(8).toString("hex")}`, amount, currency: String(currency ?? "usd"), status: "processing", polls: 0 };
  intents.set(intent.id, intent);
  setTimeout(() => send(res, 200, { ...intent, object: "payment_intent" }), 120);
}

function retrieveIntent(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>) {
  const intent = intents.get(params.id ?? "");
  if (!intent) return send(res, 404, { error: { type: "invalid_request_error", message: "No such payment_intent" } });
  if (++intent.polls > PROCESSING_POLLS) intent.status = "succeeded";
  setTimeout(() => send(res, 200, { ...intent, object: "payment_intent" }), 40);
}

serve("stripe", { "POST /v1/payment_intents": createIntent, "GET /v1/payment_intents/:id": retrieveIntent });
