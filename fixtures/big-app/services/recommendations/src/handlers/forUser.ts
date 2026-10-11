import { getProduct, type Product } from "../clients/catalog.ts";
import { rankByAffinity } from "../domain/affinity.ts";
import { recentlyViewed } from "../domain/history.ts";

// "You might also like": the shopper's recent views, fetched from the catalog and ranked.
export async function recommendationsFor(userId: number) {
  const viewed = recentlyViewed(userId);
  const products: Product[] = [];
  for (const id of viewed.productIds) {
    const p = await getProduct(id); // one request per product, one after another
    if (p) products.push(p);
  }
  return rankByAffinity(products, viewed.categories);
}
