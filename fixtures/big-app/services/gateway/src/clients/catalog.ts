import { urlOf } from "../../../shared/http.ts";

export async function listCatalog() {
  const res = await fetch(`${urlOf.catalog}/products`);
  if (!res.ok) throw new Error(`catalog said ${res.status}`);
  return res.json();
}

export async function quoteItems(productIds: number[]): Promise<{ productId: number; priceCents: number }[]> {
  const res = await fetch(`${urlOf.catalog}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productIds }) });
  if (!res.ok) throw new Error(`catalog quote said ${res.status}`);
  return res.json();
}
