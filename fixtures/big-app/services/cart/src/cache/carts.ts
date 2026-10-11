import { LRUCache } from "lru-cache";
import type { CartLine } from "../db/cartRepo.ts";

const carts = new LRUCache<string, CartLine[]>({ max: 5000, ttl: 10 * 60_000 });

export function cachedLines(userId: number): CartLine[] | undefined {
  return carts.get(`cart:${userId}`);
}

export function rememberLines(userId: number, lines: CartLine[]): void {
  carts.set(`cart:${userId}`, lines);
}
