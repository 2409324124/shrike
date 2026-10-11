import type { Product } from "../clients/catalog.ts";

// The shopper's favourite categories first, in the order they like them.
export function rankByAffinity(products: Product[], categories: string[]) {
  const ranked: Product[] = [];
  for (const c of categories) for (const p of products) if (p.category === c) ranked.push(p);
  return ranked.slice(0, 4);
}
