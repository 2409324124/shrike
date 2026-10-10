import { test } from "node:test";
import assert from "node:assert/strict";
import type { SkillEvent } from "@shrike/schema";
import { enqueue, MAX_QUEUE, mergeLog } from "./queue.ts";
import { LEVEL_XP, rankOf } from "./ranks.ts";
import { useSystem } from "./store.ts";
import { useProgress } from "../progress/store.ts";

const ev = (kind: SkillEvent["kind"], skillId: string, at: number): SkillEvent => ({ kind, skillId, name: skillId, level: 1, rank: "E", proficiency: 0, at });

test("SL4 rank math: level carries XP, thresholds E0 D3 C10 B25 A50 S100, progress toward the next rank", () => {
  assert.deepEqual(rankOf(1, 0), { level: 1, proficiency: 0, rank: "E", nextRank: "D", nextRankAt: 3, rankFrom: 0, progress: 0 });
  assert.equal(rankOf(1, 2).rank, "E");
  assert.equal(rankOf(1, 3).rank, "D");
  assert.equal(rankOf(1, 3).nextRankAt, 10);
  assert.equal(rankOf(3, 10).rank, "C"); // 10 + 2×5 = 20 XP
  assert.equal(rankOf(3, 10).nextRankAt, 25 - 2 * LEVEL_XP);
  assert.equal(rankOf(1, 100).rank, "S");
  assert.equal(rankOf(1, 100).nextRankAt, undefined);
  assert.equal(rankOf(1, 100).progress, 1);
  assert.equal(rankOf(1, 6).progress, (6 - 3) / (10 - 3));
  assert.equal(rankOf(2, 0).rank, "D"); // one kept improvement alone reaches D
  assert.equal(rankOf(2, 0).progress, 0); // the bar starts at zero, not below it
  assert.deepEqual([rankOf(undefined, undefined).level, rankOf(0, -4).proficiency], [1, 0]); // missing or bad values are Lv.1 with no uses
});

test("queue: one at a time, repeats dropped, overflow drops plain uses first", () => {
  let q = enqueue([], null, ev("acquired", "a", 1000));
  q = enqueue(q, null, ev("acquired", "a", 1500)); // the same window twice in 2s
  assert.equal(q.length, 1);
  assert.equal(enqueue(q, ev("used", "b", 0), ev("used", "b", 900)).length, 1); // repeat of what's on screen
  q = [ev("used", "u1", 1), ...Array.from({ length: MAX_QUEUE - 1 }, (_, i) => ev("leveled", `l${i}`, 10 + i))];
  q = enqueue(q, null, ev("quest_complete", "q", 100));
  assert.equal(q.length, MAX_QUEUE);
  assert.ok(!q.some((e) => e.skillId === "u1"), "the plain use went first");
  assert.equal(q.at(-1)!.kind, "quest_complete");
  assert.deepEqual(mergeLog([ev("used", "a", 2)], [ev("used", "a", 2), ev("acquired", "b", 1)]).map((e) => e.skillId), ["b", "a"]);
});

test("store: the first event shows, the rest wait their turn, next() advances, every event lands in the log", () => {
  useSystem.setState({ current: null, queue: [], log: [] });
  const s = useSystem.getState();
  s.push(ev("acquired", "run", 1));
  s.push(ev("used", "run", 5000));
  s.push(ev("quest_complete", "run", 9000));
  assert.equal(useSystem.getState().current?.kind, "acquired");
  assert.deepEqual(useSystem.getState().queue.map((e) => e.kind), ["used", "quest_complete"]);
  s.next();
  assert.equal(useSystem.getState().current?.kind, "used");
  s.next();
  s.next();
  assert.equal(useSystem.getState().current, null);
  assert.equal(useSystem.getState().log.length, 3);
});

test("one focal point: a [PROMOTED] notice waits for [Quest Complete], and the next window waits for the notice", () => {
  useSystem.setState({ current: null, queue: [], log: [] });
  useProgress.setState({ notice: null });
  const s = useSystem.getState();
  s.push(ev("quest_complete", "run", 1));
  useProgress.setState({ notice: { id: 1, promoted: { from: "SDE2", to: "SDE3" }, cards: [] } });
  s.push(ev("acquired", "seed", 5000));
  assert.equal(useSystem.getState().current?.kind, "quest_complete", "the notice doesn't cut in");
  s.next();
  assert.equal(useSystem.getState().current, null, "the notice plays alone");
  assert.equal(useSystem.getState().queue.length, 1);
  useProgress.setState({ notice: null });
  s.next();
  assert.equal(useSystem.getState().current?.kind, "acquired");
});
