import { LRUCache } from "lru-cache";
import type { Product } from "../db/productRepo.ts";

const products = new LRUCache<string, Product>({ max: 500, ttl: 5 * 60_000 });

export function cachedProduct(id: number): Product | undefined {
  return products.get(`product:${id}`);
}

export function rememberProduct(product: Product): void {
  products.set(`product:${product.id}`, product);
}
