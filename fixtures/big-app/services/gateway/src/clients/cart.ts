import { urlOf } from "../../../shared/http.ts";

export interface Cart {
  userId: number;
  lines: { productId: number; name: string; unitCents: number; qty: number; totalCents: number }[];
  subtotalCents: number;
  taxCents: number;
  shippingCents: number;
  totalCents: number;
  taxRate: number;
}

export async function fetchCart(userId: number): Promise<Cart | undefined> {
  const res = await fetch(`${urlOf.cart}/carts/${userId}`);
  return res.ok ? res.json() : undefined;
}
