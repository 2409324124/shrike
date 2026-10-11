import { urlOf } from "../../../shared/http.ts";

export interface Product {
  id: number;
  name: string;
  maker: string;
  category: string;
  priceCents: number;
}

export async function getProduct(id: number): Promise<Product | undefined> {
  const res = await fetch(`${urlOf.catalog}/products/${id}`);
  return res.ok ? res.json() : undefined;
}
