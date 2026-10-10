import type { SkillEvent } from "@shrike/schema";

// SL: one System window at a time, never modal. Pure, so it tests without a DOM.

export const SHOW_MS: Record<SkillEvent["kind"], number> = { acquired: 2500, leveled: 2500, used: 1800, quest_complete: 4200, not_learned: 3000 };
export const LEAVE_MS = 220;
export const MAX_QUEUE = 6;

const same = (a: SkillEvent, b: SkillEvent) => a.kind === b.kind && a.skillId === b.skillId && Math.abs(a.at - b.at) < 2000;

/** Adds e behind what's waiting. A repeat within 2s is dropped; past MAX_QUEUE the oldest plain "used" goes first, then the oldest of any kind. */
export function enqueue(queue: readonly SkillEvent[], current: SkillEvent | null, e: SkillEvent): SkillEvent[] {
  if ((current && same(current, e)) || queue.some((q) => same(q, e))) return [...queue];
  const q = [...queue, e];
  while (q.length > MAX_QUEUE) {
    const i = q.findIndex((x) => x.kind === "used");
    q.splice(i >= 0 && i < q.length - 1 ? i : 0, 1);
  }
  return q;
}

export const keyOf = (e: SkillEvent) => `${e.kind}:${e.skillId}:${e.at}`;

/** Log entries, oldest first, without duplicates (the live event and getSkillLog can both bring one). */
export function mergeLog(log: readonly SkillEvent[], more: readonly SkillEvent[], max = 500): SkillEvent[] {
  const by = new Map(log.map((e) => [keyOf(e), e]));
  for (const e of more) by.set(keyOf(e), e);
  return [...by.values()].sort((a, b) => a.at - b.at).slice(-max);
}
