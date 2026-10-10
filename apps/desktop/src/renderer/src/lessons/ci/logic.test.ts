import assert from "node:assert/strict";
import { test } from "node:test";
import type { CiJob, PreflightRun } from "@shrike/schema";
import { hostedLine, jobLine, jobTone, lanes, recordLine, resultParts, short, sideBySide, skillLine, skippedLine, touchLine } from "./logic.ts";

const job = (o: Partial<CiJob> & { name: string }): CiJob => ({ id: o.name, workflow: "CI-pr", file: "ci.yml", system: "github", stage: 0, needs: [], services: [], env: {}, secrets: [], steps: [], scope: [], ...o });

test("ci lessons logic: record, tones, lines and lanes", () => {
  assert.deepEqual(recordLine({ pushes: [], surprises: 0, streak: 0 }), { n: 0, line: "No pushes measured yet. Run pre-flight, then push" });
  assert.deepEqual(recordLine({ pushes: ["clean", "surprise", "clean", "waiting"], surprises: 1, streak: 1 }), { n: 1, line: "surprise from CI in your last 3 pushes" });
  assert.equal(short("ci / Dashboard lint"), "Dashboard lint");
  assert.equal(jobTone(job({ name: "a", stats: { runs: 6, fails: 2, flaky: 0 } })), "fail");
  assert.equal(jobTone(job({ name: "a", stats: { runs: 6, fails: 1, flaky: 1 } })), "flaky");
  assert.equal(jobTone(job({ name: "a", off: "merge queue only" })), "off");
  assert.equal(jobLine(job({ name: "a", node: "22", stats: { runs: 6, fails: 1, flaky: 0, seconds: 237 } })), "node 22 · 4 min · 1 in 6 failed");
  const l = lanes({ systems: ["github"], files: [], jobs: [job({ name: "a" }), job({ name: "b", workflow: "Nix CI" }), job({ name: "c", stage: 1, stageName: "test" }), job({ name: "d" })], history: { runs: 0 }, at: 0 });
  assert.deepEqual(l.map((x) => [x.label, x.groups.map((g) => `${g.workflow}:${g.jobs.map((j) => j.name).join("")}`)]), [["Stage 1 · 3 jobs", ["CI-pr:ad", "Nix CI:b"]], ["test · 1 job", ["CI-pr:c"]]]);
  const pipe = (jobs: CiJob[]) => ({ systems: [], files: [], jobs, history: { runs: 0 }, at: 0 });
  assert.equal(skillLine(0, pipe([job({ name: "a" })])), "no CI failures seen yet", "a fresh v1 never says 0 lessons");
  assert.equal(skillLine(0, pipe([job({ name: "a", stats: { runs: 3, fails: 1, flaky: 0, last: { kind: "lint", line: "x" } } }), job({ name: "b", stats: { runs: 3, fails: 1, flaky: 0, last: { kind: "memory", line: "y" } } })])), "knows lint and out of memory failures");
  assert.equal(skillLine(2, pipe([])), "2 lessons");
  assert.equal(lanes({ systems: [], files: [], jobs: [job({ name: "a" }), job({ name: "b", off: "merge queue only" })], history: { runs: 0 }, at: 0 })[0]!.label, "Stage 1 · 2 jobs, 1 runs on pull requests");
  assert.equal(touchLine({ ready: true, pipeline: { systems: [], files: [], jobs: [job({ name: "a" }), job({ name: "b" }), job({ name: "c", off: "x" })], history: { runs: 0 }, at: 0 }, touched: ["a"], files: 2, run: null, record: { pushes: [], surprises: 0, streak: 0 } }), "1 of 2 CI jobs look at this change");
});

test("ci lessons logic: result card parts and local vs hosted, first mismatch", () => {
  const run: PreflightRun = {
    id: "r", at: 0, state: "done", files: 3, warnings: [], from: "skill", verdict: "Fix 1 thing before you push", safe: false,
    legs: [
      { job: "1", name: "ci / Backend typecheck + build", state: "pass" },
      { job: "2", name: "Validate schema migrations", state: "fail", why: "the database schema" },
      { job: "3", name: "ci / Secret scan (gitleaks)", state: "skipped", why: "Needs gitleaks, which this computer doesn't have" },
    ],
    hosted: { sha: "s", state: "done", matched: false, first: "ci / Backend typecheck + build", jobs: [{ name: "ci / Backend typecheck + build", state: "fail" }, { name: "Validate schema migrations", state: "fail" }, { name: "Enum guard", state: "fail" }] },
  };
  assert.deepEqual(resultParts(run), [{ name: "Backend typecheck + build", state: "pass", job: "1" }, { name: "Validate schema migrations", state: "fail", job: "2", why: "the database schema" }]);
  assert.equal(skippedLine(run), "Secret scan (gitleaks) didn't run here: needs gitleaks, which this computer doesn't have");
  const sb = sideBySide(run);
  assert.equal(sb.first, "ci / Backend typecheck + build");
  assert.deepEqual(sb.rows.map((r) => [r.name, r.local, r.hosted, r.differs]), [["ci / Backend typecheck + build", "pass", "fail", true], ["Validate schema migrations", "fail", "fail", false], ["ci / Secret scan (gitleaks)", "skipped", "none", false], ["Enum guard", "none", "fail", false]]);
  assert.deepEqual(hostedLine(run), { text: "CI disagreed on Backend typecheck + build. Shrike is learning why", tone: "fail" });
  assert.deepEqual(hostedLine({ ...run, hosted: { ...run.hosted!, matched: true } }), { text: "CI agreed with the pre-flight", tone: "ok" });
});
