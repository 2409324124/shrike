import { fetchCatalog } from "../clients/catalog.ts";
import { rebuildIndex } from "../index/invertedIndex.ts";

export async function reindex() {
  const products = await fetchCatalog();
  const index = rebuildIndex(products);
  return { documents: index.docs.length, terms: index.postings.size };
}
