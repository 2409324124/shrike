import { buildQuery } from "../domain/query.ts";
import { scoreAll, topN } from "../domain/scoring.ts";
import { ensureIndex, lookupPostings } from "../index/invertedIndex.ts";

// "Shoppers also searched for": products that share words with what's in the cart.
export async function relatedFor(names: string[]) {
  const terms = buildQuery(names);
  const index = await ensureIndex();
  const candidates = lookupPostings(index, terms, names);
  return topN(index, scoreAll(index, candidates, terms), 4);
}
