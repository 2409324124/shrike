import type { OrderInput } from "../domain/validate.ts";
import { db } from "./pool.ts";

export async function saveOrder(order: OrderInput, paymentId: string): Promise<{ id: number }> {
  await db.exec("BEGIN");
  try {
    const r = await db.query<{ id: number }>("INSERT INTO orders (user_id, total_cents, payment_id, status) VALUES ($1, $2, $3, 'paid') RETURNING id", [order.userId, order.totalCents, paymentId]);
    const id = r.rows[0]!.id;
    const values: string[] = [];
    const params: unknown[] = [id];
    for (const l of order.lines) {
      values.push(`($1, $${params.length + 1}, $${params.length + 2}, $${params.length + 3}, $${params.length + 4})`);
      params.push(l.productId, l.name, l.unitCents, l.qty);
    }
    await db.query(`INSERT INTO order_lines (order_id, product_id, name, unit_cents, qty) VALUES ${values.join(", ")}`, params);
    await db.exec("COMMIT");
    return { id };
  } catch (err) {
    await db.exec("ROLLBACK");
    throw err;
  }
}
