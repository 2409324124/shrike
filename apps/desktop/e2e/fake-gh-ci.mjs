#!/usr/bin/env node
// A fake gh for the CI lessons e2e (SHRIKE_GH_BIN): run history and the hosted run of a pushed commit, reads only.
// $SHRIKE_FAKE_GH_DIR/hosted.json is what CI "reports" for any pushed commit; every call is one JSON line in calls.log; anything else is refused.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const a = process.argv.slice(2);
const dir = process.env.SHRIKE_FAKE_GH_DIR;
if (!dir) (process.stderr.write("fake-gh-ci: set SHRIKE_FAKE_GH_DIR\n"), process.exit(2));
appendFileSync(join(dir, "calls.log"), JSON.stringify(a) + "\n");
const out = (o) => process.stdout.write(typeof o === "string" ? o : JSON.stringify(o));
const k = a.slice(0, 2).join(" ");
const hosted = () => (existsSync(join(dir, "hosted.json")) ? JSON.parse(readFileSync(join(dir, "hosted.json"), "utf8")) : null);
const at = (m) => new Date(Date.now() - m * 60_000).toISOString();
const job = (id, name, conclusion, m, secs) => ({ databaseId: id, name, conclusion, status: "completed", startedAt: at(m), completedAt: at(m - secs / 60) });
const HISTORY = { 501: [job(9001, "Typecheck", "failure", 90, 41), job(9002, "Lint", "success", 90, 12)], 502: [job(9003, "Typecheck", "success", 30, 38), job(9004, "Lint", "success", 30, 11)] };
const LOG = ["Typecheck\tUNKNOWN STEP\t2026-10-09T09:00:01.0Z ##[group]Run node scripts/check.mjs", "Typecheck\tUNKNOWN STEP\t2026-10-09T09:00:01.1Z ##[endgroup]", "Typecheck\tUNKNOWN STEP\t2026-10-09T09:00:02.0Z src/sum.mjs(1,1): error TS2322: Type 'string' is not assignable to type 'number'.", "Typecheck\tUNKNOWN STEP\t2026-10-09T09:00:02.1Z ##[error]Process completed with exit code 1."].join("\n");

if (a[0] === "--version") out("gh version 2.99.0 (fake-gh-ci)\n");
else if (k === "auth status") out("Logged in to github.com as e2e (fake)\n");
else if (k === "run list" && a.includes("--commit")) {
  const h = hosted();
  out(h ? [{ databaseId: h.run, workflowName: "CI", status: "completed", conclusion: h.jobs.some((j) => j.conclusion === "failure") ? "failure" : "success", event: "pull_request" }] : []);
} else if (k === "run list") {
  const runs = [{ databaseId: 502, workflowName: "CI", headSha: "bbb", conclusion: "success", attempt: 1, event: "pull_request", createdAt: at(30) }, { databaseId: 501, workflowName: "CI", headSha: "aaa", conclusion: "failure", attempt: 1, event: "pull_request", createdAt: at(90) }];
  out(a.includes("failure") ? runs.filter((r) => r.conclusion === "failure") : a.includes("--branch") ? [] : runs);
} else if (k === "run view" && a.includes("--log-failed")) out(`${LOG}\n`);
else if (k === "run view") {
  const h = hosted();
  out({ jobs: h && a[2] === String(h.run) ? h.jobs : (HISTORY[a[2]] ?? []) });
} else (process.stderr.write(`fake-gh-ci: refused ${a.slice(0, 3).join(" ")}\n`), process.exit(1));
