import type { ReviewLessonsView, SelfCheck, SkillRank } from "@shrike/schema";

// RL: pure helpers shared by main/review-lessons.ts and the Lessons tab. No runtime imports.

export const MASTER_AT = 5; // reviewed PRs without the issue: rank S, mastered
const RANKS: SkillRank[] = ["E", "D", "C", "B", "A", "S"];

/** RL7: rank by reviewed PRs since the lesson last came up. */
export const rankOfClean = (clean: number): SkillRank => RANKS[Math.max(0, Math.min(MASTER_AT, Math.floor(clean)))]!;

export type Severity = "blocking" | "nit" | "question" | "note";

/** RL1: the reviewer's own markers decide; a review that asked for changes blocks. */
export function severity(body: string, state?: string): Severity {
  if (state === "CHANGES_REQUESTED") return "blocking";
  const head = body.slice(0, 400);
  const first = head.split("\n").find((l) => l.trim()) ?? "";
  if (/\[(minor|nit|optional)\]/i.test(head)) return "nit";
  if (/\[(must fix|blocker|major|should fix)\]/i.test(head)) return "blocking";
  if (/🔵|⚪|\bnit(pick)?s?\b|\bn\d{2}\b|not a blocker|non-blocking|\boptional\b|\bminor\b/i.test(head)) return "nit";
  if (/🔴|🟠|🟡|🛑|\bblock(er|ing)\b|\bmust\b|\bcritical\b|\bw\d{2}\b|\bb\d{2}\b|\bsecurity\b|\bbreaks?\b/i.test(head)) return "blocking";
  if (/\?\s*$/.test(first.trim()) || /^(why|what|how|is|are|can|could|should|do|does)\b/i.test(first.trim())) return "question";
  return "note";
}

export function nth(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
}

/** RL8: "4th time: loading state" (the title starts lowercase in the chip). */
export const chipText = (nthTime: number, title: string): string => `${nth(nthTime)} time: ${title.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())}`;

const who = (r: string[]) => (r.length ? ` for ${r.slice(0, 2).map((x) => `@${x}`).join(" and ")}` : "");

/** RL6: "Checked 6 repeat issues for @ana: 1 found (loading state), fixed". */
export function checkLine(c: Pick<SelfCheck, "state" | "checked" | "reviewers" | "found">): string {
  const head = `${c.state === "checking" ? "Checking" : "Checked"} ${c.checked} repeat ${c.checked === 1 ? "issue" : "issues"}${who(c.reviewers)}`;
  if (c.state !== "done") return head;
  if (!c.found.length) return `${head}: none found`;
  const names = c.found.map((f) => f.title.replace(/^[A-Z](?=[a-z])/, (x) => x.toLowerCase())).join(", ");
  const fixed = c.found.every((f) => f.fixed) ? ", fixed" : c.found.some((f) => f.fixed) ? `, ${c.found.filter((f) => f.fixed).length} fixed` : "";
  return `${head}: ${c.found.length} found (${names})${fixed}`;
}

/** RL7 sparkline: an SVG path through the points, oldest left. */
export function sparkPath(values: readonly number[], w: number, h: number): string {
  if (!values.length) return "";
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  return values.map((v, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)},${(h - 1 - (v / max) * (h - 2)).toFixed(1)}`).join(" ");
}

/** "up" when the newer half has more than the older half, "down" when fewer. */
export function trendOf(values: readonly number[]): "up" | "down" | "flat" {
  if (values.length < 2) return "flat";
  const half = Math.floor(values.length / 2);
  const avg = (a: readonly number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
  const before = avg(values.slice(0, half));
  const lately = avg(values.slice(values.length - half));
  return lately > before + 0.25 ? "up" : lately < before - 0.25 ? "down" : "flat";
}

/** RL-ui1: repeat issues per reviewed PR, earlier vs lately. */
export function burnSummary(burn: ReviewLessonsView["burn"]): { before: number; lately: number; verdict: "fewer" | "more" | "same" } {
  const vals = burn.map((b) => b.flagged);
  const half = Math.max(1, Math.floor(vals.length / 2));
  const avg = (a: number[]) => Math.round((a.reduce((s, x) => s + x, 0) / Math.max(1, a.length)) * 10) / 10;
  const before = avg(vals.slice(0, half));
  const lately = avg(vals.slice(vals.length - half));
  return { before, lately, verdict: lately < before ? "fewer" : lately > before ? "more" : "same" };
}
