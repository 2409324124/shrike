import { hkey, lev, skel } from "./normalize.ts";

// Slot snapping (docs/16 §2.3): a heard value counts only when it lands on a live name.
// Jaro-Winkler 0.88+, or the same English skeleton, or the same Hinglish key. Tested in understand.test.ts.

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array<boolean>(a.length).fill(false);
  const bm = new Array<boolean>(b.length).fill(false);
  let m = 0;
  for (let i = 0; i < a.length; i++)
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++)
      if (!bm[j] && a[i] === b[j]) {
        am[i] = bm[j] = true;
        m++;
        break;
      }
  if (!m) return 0;
  let t = 0;
  for (let i = 0, k = 0; i < a.length; i++)
    if (am[i]) {
      while (!bm[k]) k++;
      if (a[i] !== b[k++]) t++;
    }
  const jaro = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
  let p = 0;
  while (p < 4 && a[p] === b[p]) p++;
  return jaro + p * 0.1 * (1 - jaro);
}

const flat = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** How well a heard word (or words) names a live value, 0..1. 0 below every threshold. */
export function nameScore(heard: string, name: string): number {
  const h = flat(heard);
  const n = flat(name);
  if (!h || !n) return 0;
  if (h === n) return 1;
  const jw = jaroWinkler(h, n);
  if (jw >= 0.88) return jw;
  if (h.length >= 3 && (hkey(h) === hkey(n) || skel(h) === skel(n))) return 0.9;
  if (h.length >= 5 && lev(skel(h), skel(n)) <= 1) return 0.87;
  // one word of a longer name: "e2e" for "e2e (chromium)", "admin" for "admin-panel"
  const parts = name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (parts.length > 1) {
    const best = Math.max(...parts.map((p) => (p === h ? 0.95 : p.length >= 3 && jaroWinkler(h, p) >= 0.9 ? 0.88 : 0)));
    if (best) return best - 0.02;
  }
  return 0;
}

export interface Snap<T> {
  value: T;
  score: number;
  span: number; // how many heard words it used
}

/**
 * The best live values for the heard words, best first. Tries spans of 1 to 3 words starting at each position,
 * so "fix cart" can name "fix-cart". Only values over the threshold come back.
 */
export function snapAll<T>(words: string[], items: readonly T[], label: (t: T) => string[]): Snap<T>[] {
  const out: Snap<T>[] = [];
  for (const it of items) {
    let best: Snap<T> | null = null;
    for (const name of label(it))
      for (let i = 0; i < words.length; i++)
        for (let n = 1; n <= Math.min(3, words.length - i); n++) {
          const sc = nameScore(words.slice(i, i + n).join(" "), name);
          if (sc && (!best || sc > best.score || (sc === best.score && n > best.span))) best = { value: it, score: sc, span: n };
        }
    if (best) out.push(best);
  }
  return out.sort((a, b) => b.score - a.score || b.span - a.span);
}

/** Accept the top value only with a 0.05 margin over the runner-up; else both are "did you mean" chips. */
export function decide<T>(snaps: Snap<T>[]): { value: T; snap: Snap<T> } | { close: Snap<T>[] } | null {
  const [a, b] = snaps;
  if (!a) return null;
  if (b && a.score - b.score < 0.05) return { close: snaps.filter((x) => a.score - x.score < 0.05).slice(0, 3) };
  return { value: a.value, snap: a };
}
