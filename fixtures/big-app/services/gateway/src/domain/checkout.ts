import type { Session } from "../clients/auth.ts";
import type { Cart } from "../clients/cart.ts";

export interface Checkout {
  userId: number;
  email: string;
  lines: Cart["lines"];
  taxRate: number;
  shippingCents: number;
  totalCents: number;
}

export function buildCheckout(session: Session, cart: Cart, quote: { productId: number; priceCents: number }[]): Checkout {
  assertPricesFresh(cart, quote);
  return { userId: session.userId, email: session.email, lines: cart.lines, taxRate: cart.taxRate, shippingCents: cart.shippingCents, totalCents: cart.totalCents };
}

// A price that changed since it went in the cart must be confirmed by the shopper first.
export function assertPricesFresh(cart: Cart, quote: { productId: number; priceCents: number }[]): void {
  const today = new Map<number, number>();
  for (const q of quote) today.set(q.productId, q.priceCents);
  for (const line of cart.lines) {
    if (today.get(line.productId) !== line.unitCents) throw new Error(`The price of ${line.name} changed. Please review your cart.`);
  }
}
