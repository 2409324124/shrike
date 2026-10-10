import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionView } from "@shrike/schema";
import { exportIssue, noteAgentStep, notePatch } from "./issue.ts";

test("exportIssue writes the markdown under .shrike/issues and copies the newest clip of the trip beside it", async () => {
  const root = await mkdtemp(join(tmpdir(), "shrike-issue-"));
  const clips = await mkdtemp(join(tmpdir(), "shrike-clips-"));
  const t0 = Date.now() - 60_000;
  const root0 = { id: "a1b2c3d4e5f60718", traceId: "f".repeat(32), origin: "browser" as const, kind: "user_action" as const, name: 'Clicked "Add Todo"', startMs: t0, status: "error" as const, trigger: "click" as const };
  const view: ActionView = {
    id: root0.id, traceId: root0.traceId, trigger: "click", label: root0.name, startMs: t0, durationMs: 48, status: "error", complete: true, tree: [], root: root0, flags: [],
    summary: { headline: "It broke.", steps: [{ ok: false, text: "insertTodo() got userId: undefined", eventId: "x", source: { file: "server/c.ts", line: 2, precision: "exact" } }], stats: { files: 0, functions: 0, requests: 0, queries: 0, logs: 0, errors: 1, totalMs: 48 } },
  };
  const old = join(clips, "shrike-todo-app-old.webm");
  await writeFile(old, "old");
  await utimes(old, new Date(t0 - 5000), new Date(t0 - 5000));
  await writeFile(join(clips, "shrike-todo-app-new.mp4"), "new");
  await writeFile(join(clips, "shrike-other-new.mp4"), "other");

  noteAgentStep({ id: "s1", runId: "r", kind: "findings", text: "", actionIds: [view.id], summary: "Wrong field.", findings: [{ confidence: "observed", claim: "Reads user" }], createdAt: 0 });
  notePatch({ id: "p1", files: [{ path: "server/c.ts", before: "a\nuser\n", after: "a\nuserId\n" }], rationale: "Read userId.", status: "applied" });
  noteAgentStep({ id: "s2", runId: "r", kind: "patch", text: "", patchId: "p1", createdAt: 0 });

  const out = await exportIssue({ root, project: "todo-app", view, actions: [view], appUrl: "http://localhost:5173", clipDir: clips, readFile: async () => "one\ntwo\nthree\n" });
  assert.ok(out.clipPath?.endsWith("-clicked-add-todo-a1b2c3.mp4"), out.clipPath);
  assert.equal(await readFile(out.clipPath!, "utf8"), "new");
  const saved = await readFile(out.clipPath!.replace(/\.mp4$/, ".md"), "utf8");
  assert.equal(saved, out.markdown);
  assert.match(out.markdown, /> 2 \| two/);
  assert.match(out.markdown, /\(observed\) Reads user/);
  assert.match(out.markdown, /-user\n\+userId/);

  const none = await exportIssue({ root, project: "nope", view, actions: [view], clipDir: clips, readFile: async () => { throw new Error("gone"); } });
  assert.equal(none.clipPath, undefined);
  assert.doesNotMatch(none.markdown, /## Clip|## Where it breaks/);
});
