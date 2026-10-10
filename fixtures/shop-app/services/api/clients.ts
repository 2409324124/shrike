// Calls from the API to the other services.
const AUTH_URL = `http://localhost:${process.env.AUTH_PORT ?? 4101}`;
const PAYMENTS_URL = `http://localhost:${process.env.PAYMENTS_PORT ?? 4199}`; // our Stripe test double

export async function verifyToken(token: string): Promise<{ userId: number; name: string } | undefined> {
  const res = await fetch(`${AUTH_URL}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  return res.ok ? res.json() : undefined;
}

// Stripe takes amounts in the smallest currency unit (cents for usd).
export async function chargeCard(charge: { amount: number; currency: string; customer: number }): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const res = await fetch(`${PAYMENTS_URL}/v1/charges`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(charge) });
  const body = await res.json();
  return res.ok ? { ok: true, id: body.id } : { ok: false, error: body.error?.message ?? `Payment service said ${res.status}` };
}
