import { LRUCache } from "lru-cache";
import { ordersFor } from "./db.ts";

const orders = new LRUCache<string, Awaited<ReturnType<typeof ordersFor>>>({ max: 100, ttl: 60_000 });

export async function listOrders(userId: number) {
  const key = `user:${userId}`;
  const cached = orders.get(key);
  if (cached) return cached;
  const fresh = await ordersFor(userId);
  orders.set(key, fresh);
  return fresh;
}

export function forgetOrders(userId: number): void {
  orders.delete(`user:${userId}`);
}
