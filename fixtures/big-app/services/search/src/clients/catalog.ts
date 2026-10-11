import { urlOf } from "../../../shared/http.ts";

export interface CatalogDoc {
  id: number;
  name: string;
  maker: string;
  category: string;
}

export async function fetchCatalog(): Promise<CatalogDoc[]> {
  const res = await fetch(`${urlOf.catalog}/products/export`);
  if (!res.ok) throw new Error(`catalog export said ${res.status}`);
  return res.json();
}
