import { saveOrder } from "../db/orderRepo.ts";
import { writeOutbox } from "../db/outbox.ts";
import { chargeWithBackoff } from "../domain/payment.ts";
import { buildReceipt } from "../domain/receipt.ts";
import { validateOrder } from "../domain/validate.ts";
import { relayOutbox } from "../outbox/relay.ts";

// Charge, save, tell the rest of Bazaar (outbox -> queue -> notifications), then hand back the receipt.
export async function placeOrder(input: Record<string, unknown>) {
  const order = validateOrder(input);
  const payment = await chargeWithBackoff(order.totalCents, order.userId);
  const saved = await saveOrder(order, payment.id);
  const event = writeOutbox("order.placed", { orderId: saved.id, email: order.email, totalCents: order.totalCents, items: order.lines.length });
  await relayOutbox(event);
  return { id: saved.id, receipt: buildReceipt(saved.id, order) };
}
