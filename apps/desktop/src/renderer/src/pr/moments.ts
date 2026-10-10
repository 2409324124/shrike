import type { PrView } from "@shrike/schema";

// PR13: the big moments the panel can see happen between two reads. Pure (moments.test.ts).

export type PrMoment = { kind: "opened" | "green" | "merged"; n?: number; base?: string; passed?: number };

const FRESH_MS = 15 * 60_000;
const live = (s?: string) => s === "open" || s === "draft";

export function prMoment(prev: PrView | null, next: PrView, now = Date.now()): PrMoment | null {
  if (!prev?.ghReady || !next.ghReady || prev.branch !== next.branch) return null;
  const a = prev.pr;
  const b = next.pr;
  if (a && b && a.number !== b.number) return null; // looking at another PR now
  if (a && b && live(a.state) && b.state === "merged") return { kind: "merged", n: b.number, base: b.base };
  if (!a && b && live(b.state) && b.head === next.branch && now - Date.parse(b.updatedAt) < FRESH_MS) return { kind: "opened", n: b.number };
  if (!a !== !b) return null;
  const was = prev.checks.some((c) => c.state === "pending" || c.state === "fail");
  const counted = next.checks.filter((c) => c.state !== "skipped");
  if (was && counted.length && counted.every((c) => c.state === "pass")) return { kind: "green", passed: counted.length, ...(b ? { n: b.number } : {}) };
  return null;
}
