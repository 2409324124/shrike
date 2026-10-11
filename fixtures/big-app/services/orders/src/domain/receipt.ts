import { receiptTotals } from "./totals.ts";
import type { OrderInput } from "./validate.ts";

export function buildReceipt(orderId: number, order: OrderInput) {
  const lines = [];
  for (const l of order.lines) lines.push({ name: l.name, qty: l.qty, cents: l.totalCents, taxRate: order.taxRate });
  return { orderId, ...receiptTotals(lines, order.shippingCents) };
}
