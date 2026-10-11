export interface Product {
  id: number;
  name: string;
  maker: string;
  category: string;
  priceCents: number;
}

export interface Cart {
  lines: { productId: number; name: string; unitCents: number; qty: number; totalCents: number }[];
  subtotalCents: number;
  taxCents: number;
  shippingCents: number;
  totalCents: number;
}

export interface Confirmation {
  orderId: number;
  recommended: Product[];
  related: string[];
}

// ponytail: one signed-in demo shopper.
const headers = { "content-type": "application/json", authorization: "Bearer demo-token" };

async function json<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export async function listProducts(): Promise<Product[]> {
  return json(await fetch("/api/products", { headers }));
}

export async function getCart(): Promise<Cart> {
  return json(await fetch("/api/cart", { headers }));
}

export async function placeOrder(): Promise<Confirmation> {
  return json(await fetch("/api/orders", { method: "POST", headers, body: "{}" }));
}
