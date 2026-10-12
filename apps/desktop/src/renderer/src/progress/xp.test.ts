import { test } from "node:test";
import assert from "node:assert/strict";
import type { ActionView, Progress, QuestResult } from "@shrike/schema";
import { midWork, TRIP_QUIET_MS, useProgress, userTrip } from "./store.ts";
import { CARDS, gradeOf, medalOf, newCards, scoreQuest, TITLES, titleOf, XP_TABLE, type CardTallies, type QuestFacts } from "./xp.ts";

const facts = (f: Partial<QuestFacts> = {}): QuestFacts => ({ kind: "fix", ms: 60_000, firstTry: true, fixes: 0, skillsUsed: 1, verified: true, rewards: [], ...f });

test("XP1 quest math: clear + pace + first try + no fixes + skills + verified + bonus, never below the clear", () => {
  const T = XP_TABLE;
  const r = scoreQuest(facts({ rewards: [{ kind: "acquired", skillId: "a", name: "A" }, { kind: "leveled", skillId: "b", name: "B", level: 2 }, { kind: "used", skillId: "c", name: "C" }] }));
  assert.deepEqual(r.lines.map((l) => l.id), ["clear", "time", "first_try", "fixes", "skills", "verified", "bonus"]);
  assert.equal(r.xp, T.clear.fix + T.fast + T.firstTry + T.noFixes + T.skillUsed + T.verified + T.acquired + T.leveled);
  assert.equal(r.lines.find((l) => l.id === "time")!.value, "1:00");
  const worst = scoreQuest(facts({ kind: "start", ms: 3_600_000, firstTry: false, fixes: 5, skillsUsed: 0, verified: false }));
  assert.equal(worst.xp, T.clear.start + T.slow); // no penalties
  assert.equal(worst.grade, "D");
  assert.equal(worst.medal, undefined);
  assert.equal(scoreQuest(facts({ skillsUsed: 9 })).lines.find((l) => l.id === "skills")!.xp, 3 * T.skillUsed); // capped at 3
  assert.equal(scoreQuest(facts({ kind: "ship", ms: undefined })).lines.find((l) => l.id === "time")!.value, "-");
  assert.equal(scoreQuest(facts({ ms: 45_000 })).lines[1]!.value, "45s");
});

test("XP3/XP4 grade and medal bands", () => {
  assert.deepEqual([100, 90, 89, 75, 74, 60, 59, 45, 44, 0].map(gradeOf), ["S", "S", "A", "A", "B", "B", "C", "C", "D", "D"]);
  assert.deepEqual([90, 89, 75, 74, 55, 54].map(medalOf), ["gold", "silver", "silver", "bronze", "bronze", undefined]);
  const s = scoreQuest(facts({ skillsUsed: 2 })); // a fast first-try verified fix
  assert.equal(s.grade, "S");
  assert.equal(s.medal, "gold");
  assert.ok(s.score <= 100);
  assert.equal(scoreQuest(facts({ firstTry: false, fixes: 1, ms: 7 * 60_000, skillsUsed: 0 })).grade, "B"); // 35+8+0+6+0+15
});

test("XP2 titles: Intern first, Fellow last, thresholds rise faster later, a normal first day promotes twice", () => {
  assert.equal(TITLES.length, 12);
  assert.deepEqual([TITLES[0]!.title, TITLES.at(-1)!.title], ["Intern", "Fellow"]);
  const gaps = TITLES.slice(1).map((t, i) => t.xp - TITLES[i]!.xp);
  assert.ok(gaps.every((g, i) => i === 0 || g >= gaps[i - 1]!), "each title needs at least as much as the last");
  assert.deepEqual(titleOf(0), { index: 0, title: "Intern", from: 0, next: "Junior Dev", nextAt: 250, progress: 0 });
  assert.equal(titleOf(1240).title, "SDE2");
  assert.equal(titleOf(70000).progress, 1);
  assert.equal(titleOf(-5).title, "Intern");
  const day = scoreQuest(facts({ kind: "start", ms: 400_000, firstTry: true, fixes: 1 })).xp + 3 * scoreQuest(facts()).xp + scoreQuest(facts({ kind: "ship", ms: undefined, verified: false })).xp;
  assert.equal(titleOf(day).index, 2, `a day of ${day} XP reaches SDE1`);
});

test("XP6 cards unlock from tallies, once", () => {
  const t: CardTallies = { starts: 0, fixes: 0, ships: 0, skills: 0, sRank: 0, racesWon: 0, flowStreak: 0, golds: 0, sGrades: 0, projects: 0, titleIndex: 0 };
  assert.deepEqual(newCards(t, {}), []);
  assert.deepEqual(newCards({ ...t, starts: 1, fixes: 1 }, {}), ["first-start", "first-fix"]);
  assert.deepEqual(newCards({ ...t, starts: 1, fixes: 1 }, { "first-start": 1 }), ["first-fix"]);
  assert.deepEqual(newCards({ ...t, sRank: 1, flowStreak: 4 }, {}), ["skill-s"]);
  assert.ok(newCards({ ...t, flowStreak: 5, racesWon: 1, titleIndex: 11 }, {}).includes("fellow"));
  assert.ok(CARDS.some((c) => c.rarity === "golden") && new Set(CARDS.map((c) => c.id)).size === CARDS.length);
});

test("XP9 never blocks: mid-work holds the result as the chip, idle opens it, hold folds it back", () => {
  const idle = { tripAgo: TRIP_QUIET_MS, typing: false, open: [false, null, 0] };
  assert.equal(midWork(idle), false);
  assert.equal(midWork({ ...idle, tripAgo: 1000 }), true);
  assert.equal(midWork({ ...idle, typing: true }), true);
  assert.equal(midWork({ ...idle, open: [false, "ship"] }), true);
  const progress = { xp: 0 } as Progress;
  const r = (id: string) => ({ id, lines: [] }) as unknown as QuestResult;
  const p = useProgress.getState();
  p.apply({ progress, result: r("a") }, true);
  assert.deepEqual([useProgress.getState().result?.id, useProgress.getState().open], ["a", false]);
  p.apply({ progress, result: r("b") }, true);
  assert.deepEqual([useProgress.getState().result?.id, useProgress.getState().open, useProgress.getState().queue.length], ["b", false, 0], "the chip holds the newest result, not an unopened older one");
  p.show();
  p.apply({ progress, result: r("c") });
  assert.deepEqual(useProgress.getState().queue.map((q) => q.id), ["c"], "one on screen: the next waits");
  p.hold(); // opened from the chip: a trip doesn't fold it
  assert.equal(useProgress.getState().open, true);
  p.next();
  assert.deepEqual([useProgress.getState().result?.id, useProgress.getState().open], ["c", true]);
  p.hold(); // auto-opened: folds
  assert.equal(useProgress.getState().open, false);
  p.next(true);
  assert.equal(useProgress.getState().result, null);
});

test("XP9 user trips: clicks on an element, loads and explorer requests count; polling, server, agent and old trips don't", () => {
  const now = 1_000_000;
  const a = (trigger: ActionView["trigger"], target = false, ago = 0) => ({ trigger, startMs: now - ago, root: target ? { target: {} } : {} }) as unknown as ActionView;
  assert.equal(userTrip(a("click", true), now), true);
  assert.equal(userTrip(a("submit", true), now), true);
  assert.equal(userTrip(a("navigation"), now), true);
  assert.equal(userTrip(a("click"), now), false); // implicit: a fetch with no click
  assert.equal(userTrip(a("server"), now), false);
  assert.equal(userTrip(a("agent"), now), false);
  assert.equal(userTrip(a("click", true, TRIP_QUIET_MS), now), false); // loaded from disk
  assert.ok(!scoreQuest(facts({ kind: "ship", ms: undefined, verified: undefined })).lines.some((l) => l.id === "verified"));
});
