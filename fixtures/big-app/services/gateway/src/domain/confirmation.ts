export function confirmationView(order: { id: number; receipt: unknown }, recommended: unknown[], related: string[]) {
  return { orderId: order.id, receipt: order.receipt, recommended, related };
}
