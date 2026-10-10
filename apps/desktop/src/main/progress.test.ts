import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShrikeEvents } from "@shrike/schema";
import { configureProgress, credit, observe, progressOf, readLedger, recordQuest, shipped } from "./progress.ts";
import { XP_TABLE } from "../renderer/src/progress/xp.ts";

const base = { kind: "fix" as const, quest: "Fix: Add Todo", ms: 60_000, firstTry: true, fixes: 0, skillsUsed: 1, verified: true, rewards: [] };

test("ledger persists, one result per key, per-project tallies, cards and promotion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shrike-xp-"));
  try {
    const r = await recordQuest(dir, { ...base, root: "/p/todo", project: "todo", key: "run1" });
    assert.ok(r);
    assert.equal(r.before, 0);
    assert.equal(r.after, r.xp);
    assert.equal(r.grade, "S");
    assert.deepEqual(r.cards.map((c) => c.id), ["first-fix", "first-gold", "first-s"]);
    assert.equal(r.promoted, undefined);
    assert.equal(await recordQuest(dir, { ...base, key: "run1" }), null, "the same run never scores twice");
    const r2 = (await recordQuest(dir, { ...base, root: "/p/todo", key: "run2" }))!;
    assert.deepEqual(r2.promoted, { from: "Intern", to: "Junior Dev" });
    assert.deepEqual(r2.cards, []);
    const l = await readLedger(dir);
    assert.equal(l.xp, r.xp + r2.xp);
    assert.equal(l.projects["/p/todo"]!.quests, 2);
    assert.equal(l.medals.gold, 2);
    const p = progressOf(l, "/p/todo");
    assert.equal(p.bugsFixed, 2);
    assert.equal(p.project?.name, "todo");
    assert.equal(p.cards.filter((c) => c.at).length, 3);
    assert.ok(p.formula.length > 5);
    await writeFile(join(dir, "progress.json"), "{not json");
    assert.equal((await readLedger(dir)).xp, 0, "a broken file reads as a fresh ledger");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a skill acquired on its own then rewarded by the quest counts once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shrike-xp-"));
  try {
    const own = await credit(dir, { key: "acquired:run-todo:1", apply: () => XP_TABLE.acquired });
    assert.equal(own?.ledger.xp, XP_TABLE.acquired);
    assert.equal(await credit(dir, { key: "acquired:run-todo:1", apply: () => XP_TABLE.acquired }), null);
    const r = (await recordQuest(dir, { ...base, kind: "start", rewards: [{ kind: "acquired", skillId: "run-todo", name: "Run todo", level: 1 }] }))!;
    assert.equal(r.before, XP_TABLE.acquired, "the bar starts where the top bar already is");
    assert.equal(r.after, r.xp, "the bonus line takes over the skill's own XP");
    assert.equal((await readLedger(dir)).xp, r.xp);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restarts score once a project a day; skills past the bonus cap keep their own XP; no double promotion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shrike-xp-"));
  try {
    const start = { ...base, kind: "start" as const, root: "/p/todo" };
    assert.ok(await recordQuest(dir, { ...start, key: "s1" }));
    assert.equal(await recordQuest(dir, { ...start, key: "s2" }), null, "a restart the same day scores nothing");
    assert.ok(await recordQuest(dir, { ...start, root: "/p/other", key: "s3" }), "another project still scores");
    const grew = await recordQuest(dir, { ...start, key: "s4", rewards: [{ kind: "leveled", skillId: "run", name: "Run", level: 2 }] });
    assert.ok(grew, "a restart that improved a skill scores");

    const d2 = await mkdtemp(join(tmpdir(), "shrike-xp-"));
    const ids = ["a", "b", "c", "d", "e"];
    for (const id of ids) await credit(d2, { key: `acquired:${id}:1`, apply: () => XP_TABLE.acquired });
    const r = (await recordQuest(d2, { ...base, rewards: ids.map((id) => ({ kind: "acquired" as const, skillId: id, name: id, level: 1 })) }))!;
    assert.equal(r.before, 5 * XP_TABLE.acquired);
    assert.equal(r.after, r.xp + 2 * XP_TABLE.acquired, "skills 4 and 5 keep their XP");

    await writeFile(join(d2, "progress.json"), JSON.stringify({ xp: 240 }));
    const c = await credit(d2, { key: "acquired:z:1", apply: () => XP_TABLE.acquired });
    assert.deepEqual(c?.promoted, { from: "Intern", to: "Junior Dev" });
    const q = (await recordQuest(d2, { ...base, key: "q", rewards: [{ kind: "acquired", skillId: "z", name: "z", level: 1 }] }))!;
    assert.equal(q.before, 265);
    assert.equal(q.promoted, undefined, "the notice already showed it");
    await rm(d2, { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("observe and shipped: flows pay once a day, watched flows pay nothing, a red one resets the streak; a PR from shipFix ships once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shrike-xp-"));
  const sent: ShrikeEvents["progress:update"][] = [];
  configureProgress({ dir: () => dir, root: () => "/p/todo" }, ((ch: string, p: unknown) => ch === "progress:update" && sent.push(p as never)) as never);
  try {
    await observe("flow:result", { flowId: "f1", ok: true, actionIds: [], watched: false });
    await observe("flow:result", { flowId: "f1", ok: true, actionIds: [], watched: false });
    await observe("flow:result", { flowId: "f2", ok: true, actionIds: [], watched: true });
    let l = await readLedger(dir);
    assert.equal(l.xp, XP_TABLE.flowGreen);
    assert.equal(l.flowStreak, 3);
    await observe("flow:result", { flowId: "f1", ok: false, actionIds: [], watched: false });
    assert.equal((await readLedger(dir)).flowStreak, 0);

    const pr = (number: number, state: "open" | "closed" = "open") => ({ number, title: "Fix add todo", url: "", state, checks: [] });
    await shipped(pr(8));
    await shipped(pr(8)); // the next fix sent to the same PR isn't a second ship
    await shipped(pr(9, "closed"));
    l = await readLedger(dir);
    assert.equal(l.ships, 1);
    assert.deepEqual(l.shipped, ["/p/todo#8"]);
    assert.ok(sent.some((e) => e.result?.kind === "ship"));
    const file = JSON.parse(await readFile(join(dir, "progress.json"), "utf8"));
    assert.equal(file.ships, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
