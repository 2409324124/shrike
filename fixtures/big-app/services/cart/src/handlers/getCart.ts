import { cachedLines, rememberLines } from "../cache/carts.ts";
import { loadLines } from "../db/cartRepo.ts";
import { priceCart } from "../domain/pricing.ts";

export async function getCart(userId: number) {
  let lines = cachedLines(userId);
  if (!lines) {
    lines = await loadLines(userId);
    rememberLines(userId, lines);
  }
  return priceCart(userId, lines);
}
