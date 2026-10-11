import { cachedProduct, rememberProduct } from "../cache/products.ts";
import { findById, type Product } from "../db/productRepo.ts";

export async function getProduct(id: number): Promise<Product | undefined> {
  const cached = cachedProduct(id);
  if (cached) return cached;
  const product = await findById(id);
  if (product) rememberProduct(product);
  return product;
}
