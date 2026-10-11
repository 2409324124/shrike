import { urlOf } from "../../../shared/http.ts";

const STRIPE = urlOf.stripe; // our Stripe test double
type Intent = { id: string; status: string; amount: number };

// Stripe takes amounts in the smallest currency unit (cents for usd).
export async function createPaymentIntent(amount: number, customer: number): Promise<Intent> {
  const res = await fetch(`${STRIPE}/v1/payment_intents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount, currency: "usd", customer }) });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message ?? `Stripe said ${res.status}`);
  return body;
}

export async function retrieveIntent(id: string): Promise<Intent> {
  const res = await fetch(`${STRIPE}/v1/payment_intents/${id}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message ?? `Stripe said ${res.status}`);
  return body;
}
