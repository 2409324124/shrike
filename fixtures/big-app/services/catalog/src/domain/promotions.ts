import type { Product, Promotion } from "../db/productRepo.ts";

export function applyPromotions(rows: Product[], promos: Promotion[]) {
  const out = [];
  for (const row of rows) out.push({ productId: row.id, priceCents: row.priceCents - discountFor(row, promos) });
  return out;
}

export function discountFor(row: Product, promos: Promotion[]): number {
  let best = 0;
  for (const p of promos) if (p.category === row.category) best = Math.max(best, Math.round((row.priceCents * p.percentOff) / 100));
  return best;
}
