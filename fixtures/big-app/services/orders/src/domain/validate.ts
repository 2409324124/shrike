export interface OrderLine {
  productId: number;
  name: string;
  unitCents: number;
  qty: number;
  totalCents: number;
}
export interface OrderInput {
  userId: number;
  email: string;
  lines: OrderLine[];
  taxRate: number;
  shippingCents: number;
  totalCents: number;
}

export function validateOrder(input: Record<string, unknown>): OrderInput {
  const o = input as unknown as OrderInput;
  if (!Number.isInteger(o.userId) || typeof o.email !== "string") throw new Error("An order needs a signed-in shopper");
  if (!Array.isArray(o.lines) || !o.lines.length) throw new Error("An order needs at least one item");
  if (!Number.isInteger(o.totalCents) || o.totalCents <= 0) throw new Error("An order needs a total in whole cents");
  return o;
}
