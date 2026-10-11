import type { CartLine } from "../db/cartRepo.ts";

export const TAX_RATE = 0.0825;
const SHIPPING_CENTS = 499;

// Everything in whole cents. Tax is worked out once on the subtotal and rounded.
export function priceCart(userId: number, lines: CartLine[]) {
  const priced = [];
  for (const line of lines) priced.push({ ...line, totalCents: lineTotal(line) });
  const subtotalCents = cartSubtotal(priced);
  const taxCents = Math.round(subtotalCents * TAX_RATE);
  return { userId, lines: priced, subtotalCents, taxCents, shippingCents: SHIPPING_CENTS, totalCents: subtotalCents + taxCents + SHIPPING_CENTS, taxRate: TAX_RATE };
}

export function lineTotal(line: CartLine): number {
  return line.unitCents * line.qty;
}

export function cartSubtotal(lines: { totalCents: number }[]): number {
  let sum = 0;
  for (const l of lines) sum += l.totalCents;
  return sum;
}
