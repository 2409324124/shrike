import { fetchCatalog, type CatalogDoc } from "../clients/catalog.ts";

export interface Index {
  docs: CatalogDoc[];
  text: string[]; // each doc's words, joined
  postings: Map<string, Set<number>>; // word -> doc positions
}

let current: Index = { docs: [], text: [], postings: new Map() };

export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function rebuildIndex(docs: CatalogDoc[]): Index {
  const next: Index = { docs, text: [], postings: new Map() };
  for (const [i, d] of docs.entries()) {
    const words = tokenize(`${d.name} ${d.maker} ${d.category}`);
    next.text.push(words.join(" "));
    for (const w of words) next.postings.set(w, (next.postings.get(w) ?? new Set()).add(i));
  }
  current = next;
  return next;
}

// ponytail: the nightly cron builds the index; a search before the first run builds it on the spot.
export async function ensureIndex(): Promise<Index> {
  return current.docs.length ? current : rebuildIndex(await fetchCatalog());
}

export function lookupPostings(index: Index, terms: string[], skip: string[]): number[] {
  const hits = new Set<number>();
  for (const t of terms) for (const i of index.postings.get(t) ?? []) if (!skip.includes(index.docs[i]!.name)) hits.add(i);
  return [...hits];
}
