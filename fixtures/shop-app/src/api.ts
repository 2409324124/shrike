export interface CartItem {
  name: string;
  price: number; // dollars
}

export interface Cart {
  id: string;
  items: CartItem[];
  total: number; // dollars
}

export interface Order {
  id: number;
  total: number; // dollars
  status: string;
  createdAt: string;
}

// ponytail: one signed-in demo customer.
const headers = { "content-type": "application/json", authorization: "Bearer demo-token" };

async function json<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export async function getCart(): Promise<Cart> {
  return json(await fetch("/api/cart", { headers }));
}

export async function listOrders(): Promise<Order[]> {
  return json(await fetch("/api/orders", { headers }));
}

export async function payNow(cartId: string): Promise<Order> {
  const res = await fetch("/api/checkout", { method: "POST", headers, body: JSON.stringify({ cartId }) });
  return json(res);
}
