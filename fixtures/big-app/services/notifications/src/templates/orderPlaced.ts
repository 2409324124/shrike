import { formatMoney } from "./format.ts";

export function renderOrderEmail(event: { orderId: number; totalCents: number; items: number }) {
  return {
    subject: `Your Bazaar order #${event.orderId}`,
    text: `Thanks for your order. ${event.items} items, ${formatMoney(event.totalCents)} charged. We'll email you when it ships.`,
  };
}
