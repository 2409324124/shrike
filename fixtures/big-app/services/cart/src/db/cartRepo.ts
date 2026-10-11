import { db } from "./pool.ts";

export interface CartLine {
  productId: number;
  name: string;
  unitCents: number; // the price when it went in the cart
  qty: number;
}

export async function loadLines(userId: number): Promise<CartLine[]> {
  const r = await db.query<CartLine>(
    "SELECT product_id AS \"productId\", name, unit_cents AS \"unitCents\", qty FROM cart_lines WHERE user_id = $1 ORDER BY product_id",
    [userId],
  );
  return r.rows;
}
