// A small stand-in for Stripe's charges API, so the shop runs offline.
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson, send, serve } from "../http.ts";

const MINIMUM_CENTS = 50; // Stripe's minimum charge for usd

async function createCharge(req: IncomingMessage, res: ServerResponse) {
  const { amount, currency } = await readJson(req);
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < MINIMUM_CENTS) {
    return send(res, 400, { error: { type: "invalid_request_error", message: "Amount must be at least 50 cents" } });
  }
  send(res, 200, { id: `ch_${randomBytes(8).toString("hex")}`, object: "charge", amount, currency, status: "succeeded" });
}

serve("payments", Number(process.env.PAYMENTS_PORT ?? 4199), { "POST /v1/charges": createCharge });
