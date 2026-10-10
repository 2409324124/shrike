import assert from "node:assert/strict";
import { test } from "node:test";
import { actionsIds, checkSummary, conflictHunks, failingLines, ghStatus, listPrs, mergeBlocker, prChecks, toPr, type Gh } from "./github.ts";

const gh = (map: Record<string, { code: number; stdout: string }>): Gh => ({ run: async (args) => ({ stderr: "", ...(map[args.slice(0, 2).join(" ")] ?? map[args[0]!] ?? { code: 1, stdout: "" }) }) });

test("gh detection: missing, signed out, ready", async () => {
  assert.deepEqual(await ghStatus(gh({}), "/"), { ready: false, problem: "missing" });
  assert.deepEqual(await ghStatus(gh({ "--version": { code: 0, stdout: "" } }), "/"), { ready: false, problem: "signed-out" });
  assert.deepEqual(await ghStatus(gh({ "--version": { code: 0, stdout: "" }, "auth status": { code: 0, stdout: "" } }), "/"), { ready: true });
});

test("PRs and checks map to plain states", async () => {
  assert.equal(toPr({ number: 1, title: "t", url: "u", state: "MERGED" }).state, "merged");
  const checks = await prChecks(gh({ "pr checks": { code: 8, stdout: JSON.stringify([{ name: "a", bucket: "pass" }, { name: "b", bucket: "cancel" }, { name: "c", bucket: "skipping" }, { name: "d", bucket: "pending", link: "l" }]) } }), "/", 1);
  assert.deepEqual(checks, [{ name: "a", state: "pass" }, { name: "b", state: "fail" }, { name: "c", state: "skipped" }, { name: "d", state: "pending", url: "l" }]);
  assert.deepEqual(await prChecks(gh({ "pr checks": { code: 1, stdout: "no checks reported on the 'x' branch" } }), "/", 1), []);
  assert.deepEqual(await listPrs(gh({ "pr list": { code: 0, stdout: JSON.stringify([{ number: 2, title: "t", url: "u", state: "OPEN" }]) } }), "/"), [{ number: 2, title: "t", url: "u", state: "open", checks: [] }]);
});

test("G4: failing lines come out of an Actions log with the step name", () => {
  assert.deepEqual(actionsIds("https://github.com/o/r/actions/runs/123/job/456"), { run: "123", job: "456" });
  assert.deepEqual(actionsIds("https://github.com/o/r/actions/runs/123"), { run: "123" });
  assert.equal(actionsIds("https://circleci.com/x"), undefined);
  const log = [
    "build\tSet up job\t2026-10-08T10:00:00.1234567Z Current runner version: '2.3'",
    "build\tRun tests\t2026-10-08T10:00:01.1Z ##[group]Run pnpm test",
    "build\tRun tests\t2026-10-08T10:00:02.1Z not ok 3 - totals add up",
    "build\tRun tests\t2026-10-08T10:00:02.2Z   AssertionError: expected '12' to equal 3",
    "build\tRun tests\t2026-10-08T10:00:03.1Z ##[error]Process completed with exit code 1.",
    "build\tRun tests\t2026-10-08T10:00:03.2Z Error: Process completed with exit code 1.",
  ].join("\n");
  const f = failingLines(log);
  assert.equal(f.step, "Run tests");
  assert.deepEqual(f.lines, ["not ok 3 - totals add up", "AssertionError: expected '12' to equal 3", "Process completed with exit code 1."]);
  assert.equal(checkSummary("test", f), `The "test" check failed during "Run tests". The first problem it printed: not ok 3 - totals add up`);
  assert.match(checkSummary("test", { lines: [] }), /didn't say why/);
});

test("G5: merge waits for green checks and green flows", () => {
  assert.equal(mergeBlocker([{ name: "a", state: "fail" }], []), `The "a" check failed. Fix it first.`);
  assert.equal(mergeBlocker([{ name: "a", state: "fail" }, { name: "b", state: "fail" }], []), "2 checks failed. Fix them first.");
  assert.equal(mergeBlocker([{ name: "a", state: "pending" }], []), "Checks are still running.");
  assert.equal(mergeBlocker([{ name: "a", state: "pass" }], [{ name: "Checkout" }]), `Your flow "Checkout" hasn't run on this change yet.`);
  assert.equal(mergeBlocker([{ name: "a", state: "skipped" }], [{ name: "Checkout", lastRun: { at: 1, ok: true, actionIds: [] } }]), undefined);
  assert.equal(mergeBlocker([], []), undefined);
});

test("G3: conflict hunks with both sides, diff3 base dropped", () => {
  const text = ["a", "<<<<<<< HEAD", "ours 1", "ours 2", "||||||| base", "old", "=======", "theirs", ">>>>>>> abc123 (my change)", "b", "<<<<<<< HEAD", "=======", "x", ">>>>>>> main"].join("\n");
  assert.deepEqual(conflictHunks(text), [
    { line: 2, end: 9, ours: ["ours 1", "ours 2"], theirs: ["theirs"], oursLabel: "HEAD", theirsLabel: "abc123 (my change)" },
    { line: 11, end: 14, ours: [], theirs: ["x"], oursLabel: "HEAD", theirsLabel: "main" },
  ]);
  assert.deepEqual(conflictHunks("no markers\n======="), []);
});
