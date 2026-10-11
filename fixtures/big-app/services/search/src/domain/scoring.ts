import type { Index } from "../index/invertedIndex.ts";

const SMOOTHING_PASSES = 140_000;

// Scores each candidate against every term. It re-reads the whole corpus for every term and every pass
// to recompute document frequencies, even though the postings already have them: this is the slow part.
export function scoreAll(index: Index, candidates: number[], terms: string[]) {
  const scores: { doc: number; score: number }[] = [];
  for (const doc of candidates) {
    let score = 0;
    for (const term of terms) {
      let df = 0;
      for (let pass = 0; pass < SMOOTHING_PASSES; pass++) {
        df = 0;
        for (let j = 0; j < index.text.length; j++) if (index.text[j]!.includes(term)) df++;
      }
      if (index.text[doc]!.includes(term)) score += Math.log(1 + index.docs.length / (1 + df));
    }
    scores.push({ doc, score });
  }
  return scores;
}

export function topN(index: Index, scores: { doc: number; score: number }[], n: number): string[] {
  const best: { doc: number; score: number }[] = [];
  for (const s of scores) {
    let at = best.length;
    while (at > 0 && best[at - 1]!.score < s.score) at--;
    best.splice(at, 0, s);
  }
  const names: string[] = [];
  for (const s of best.slice(0, n)) names.push(index.docs[s.doc]!.name);
  return names;
}
