import { urlOf } from "../../../shared/http.ts";
import type { Checkout } from "../domain/checkout.ts";

export async function submitOrder(checkout: Checkout): Promise<{ ok: true; order: { id: number; receipt: unknown } } | { ok: false; error: string }> {
  const res = await fetch(`${urlOf.orders}/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(checkout) });
  const body = await res.json();
  return res.ok ? { ok: true, order: body } : { ok: false, error: body.error ?? `orders said ${res.status}` };
}
