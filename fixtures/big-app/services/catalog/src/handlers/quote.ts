import { activePromotions, findByIds } from "../db/productRepo.ts";
import { applyPromotions } from "../domain/promotions.ts";

// Today's price for each product in a cart, promotions applied.
export async function quoteItems(productIds: number[]) {
  const rows = await findByIds(productIds);
  const promos = await activePromotions();
  return applyPromotions(rows, promos);
}
