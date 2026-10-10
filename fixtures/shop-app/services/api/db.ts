import { PGlite } from "@electric-sql/pglite";

// The "orders" Postgres database, in memory and seeded on every start.
export const db = new PGlite("memory://orders");

await db.exec(`
  CREATE TABLE carts (id TEXT PRIMARY KEY, user_id INT NOT NULL);
  CREATE TABLE cart_items (cart_id TEXT NOT NULL, name TEXT NOT NULL, price_dollars INT NOT NULL);
  CREATE TABLE orders (id SERIAL PRIMARY KEY, user_id INT NOT NULL, total_cents INT NOT NULL, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
  INSERT INTO carts VALUES ('cart-1', 1);
  INSERT INTO cart_items VALUES ('cart-1', 'Trail mug', 19), ('cart-1', 'Wool socks', 30);
  INSERT INTO orders (user_id, total_cents, status) VALUES (1, 2500, 'delivered'), (1, 8900, 'shipped');
`);

export interface Cart {
  id: string;
  items: { name: string; price: number }[];
  total: number; // dollars, as the shop shows it
}

export async function loadCart(cartId: string, userId: number): Promise<Cart | undefined> {
  const owner = await db.query<{ id: string }>("SELECT id FROM carts WHERE id = $1 AND user_id = $2", [cartId, userId]);
  if (!owner.rows.length) return undefined;
  const items = await db.query<{ name: string; price_dollars: number }>("SELECT name, price_dollars FROM cart_items WHERE cart_id = $1", [cartId]);
  const list = items.rows.map((r) => ({ name: r.name, price: r.price_dollars }));
  return { id: cartId, items: list, total: list.reduce((sum, i) => sum + i.price, 0) };
}

export async function ordersFor(userId: number) {
  const r = await db.query<{ id: number; total_cents: number; status: string; created_at: Date }>(
    "SELECT id, total_cents, status, created_at FROM orders WHERE user_id = $1 ORDER BY id DESC",
    [userId],
  );
  return r.rows.map((o) => ({ id: o.id, total: o.total_cents / 100, status: o.status, createdAt: o.created_at.toISOString() }));
}

export async function createOrder(userId: number, totalCents: number) {
  const r = await db.query<{ id: number }>("INSERT INTO orders (user_id, total_cents, status) VALUES ($1, $2, 'paid') RETURNING id", [userId, totalCents]);
  return { id: r.rows[0]!.id, total: totalCents / 100, status: "paid" };
}
