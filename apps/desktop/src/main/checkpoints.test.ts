import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Checkpoint } from "@shrike/schema";
import { clearCheckpoints, getCheckpoints, rewindTo } from "./checkpoints.ts";
import { proposePatch, reapplyPatch, revertPatch, settle, type PatchDeps } from "./patches.ts";

test("every applied patch is a checkpoint; rewind undoes it and later ones newest first, then goes forward again", async () => {
  clearCheckpoints();
  const root = mkdtempSync(join(tmpdir(), "shrike-cp-"));
  mkdirSync(join(root, "server"));
  const file = join(root, "server/a.ts");
  writeFileSync(file, "a = 1\nb = 1\nc = 1\n");
  let cps: Checkpoint[] = [];
  let answer = true;
  const order: string[] = [];
  let settled = 0;
  const deps: PatchDeps = {
    root,
    requestApproval: async () => answer,
    waitForServerHello: async () => (settled++, true),
    onUpdate: (p) => order.push(`${p.id.slice(0, 4)}:${p.status}`),
    onCheckpoints: (l) => (cps = l),
  };
  const fix = (k: string, why: string) => proposePatch(deps, [{ path: "server/a.ts", edits: [{ oldText: `${k} = 1`, newText: `${k} = 2` }] }], why);
  const p1 = await fix("a", "Fix a. It was wrong.");
  const p2 = await fix("b", "Fix b");
  answer = false;
  await fix("c", "rejected, so no checkpoint");
  answer = true;
  const p3 = await fix("c", "Fix c with a much longer explanation that keeps going well past the label limit");
  assert.deepEqual(cps.map((c) => [c.patchId, c.label, c.current]), [
    [p1.patchId, "Fix a", true],
    [p2.patchId, "Fix b", true],
    [p3.patchId, "Fix c with a much longer explanation that keeps going w…", true],
  ]);
  assert.deepEqual(getCheckpoints(), cps);
  assert.equal(readFileSync(file, "utf8"), "a = 2\nb = 2\nc = 2\n");

  const steps: string[] = [];
  const rd = {
    revert: async (id: string) => (steps.push(`revert ${id}`), revertPatch(deps, id)),
    reapply: async (id: string) => (steps.push(`apply ${id}`), reapplyPatch(deps, id)),
    settle: async (paths: string[], since: number) => (steps.push(`settle ${paths.join()}`), settle(deps, paths, since)),
  };
  settled = 0;
  await rewindTo(rd, cps[1]!.id);
  assert.deepEqual(steps, [`revert ${p3.patchId}`, `revert ${p2.patchId}`, "settle server/a.ts"]);
  assert.equal(settled, 1); // waited for the server restart once
  assert.equal(readFileSync(file, "utf8"), "a = 2\nb = 1\nc = 1\n");
  assert.deepEqual(cps.map((c) => c.current), [true, false, false]);

  steps.length = 0;
  await rewindTo(rd, cps[2]!.id); // forward: oldest rewound first
  assert.deepEqual(steps, [`apply ${p2.patchId}`, `apply ${p3.patchId}`, "settle server/a.ts"]);
  assert.equal(readFileSync(file, "utf8"), "a = 2\nb = 2\nc = 2\n");
  assert.deepEqual(cps.map((c) => c.current), [true, true, true]);

  // The Undo button (revertPatch) moves the checkpoint too; a file edited since then stops the rewind.
  await revertPatch(deps, p3.patchId);
  assert.deepEqual(cps.map((c) => c.current), [true, true, false]);
  writeFileSync(file, "a = 2\nb = 9\nc = 1\n");
  await assert.rejects(rewindTo(rd, cps[0]!.id), /changed after the patch was applied/);
  assert.deepEqual(cps.map((c) => c.current), [true, true, false]);
  await assert.rejects(rewindTo(rd, "nope"), /doesn't exist/);
});
