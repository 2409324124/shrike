import { tokenize } from "../index/invertedIndex.ts";

const STOP = new Set(["and", "the", "of", "set", "pair", "a"]);

export function buildQuery(names: string[]): string[] {
  const terms = new Set<string>();
  for (const t of tokenize(names.join(" "))) if (!STOP.has(t)) terms.add(t);
  return [...terms];
}
