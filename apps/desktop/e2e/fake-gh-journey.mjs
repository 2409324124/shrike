#!/usr/bin/env node
// A fake gh for the journey e2e (SHRIKE_GH_BIN): no PR on the branch until `pr create`, PR #5 to check out from the
// test's local origin (pull/5/head), and everything else answered by fake-gh.mjs (its PR #7). Nothing reaches GitHub.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const a = process.argv.slice(2);
const dir = process.env.SHRIKE_FAKE_GH_DIR;
if (!dir) (process.stderr.write("fake-gh-journey: set SHRIKE_FAKE_GH_DIR\n"), process.exit(2));
const created = join(dir, "created.json");
const k = a.slice(0, 2).join(" ");
const PR5 = { number: 5, title: "Dark mode for the list", headRefName: "dark-list", url: "https://github.com/e2e/todo-app/pull/5", state: "OPEN", isDraft: false, author: { login: "sam" } };

if (k === "pr create") {
  appendFileSync(join(dir, "calls.log"), JSON.stringify(a) + "\n");
  const v = (f) => a[a.indexOf(f) + 1];
  writeFileSync(created, JSON.stringify({ head: v("--head"), base: v("--base"), title: v("--title"), body: readFileSync(0, "utf8") }));
  process.stdout.write("https://github.com/e2e/todo-app/pull/7\n");
} else if (k === "pr checkout" && a[2] === "5") {
  appendFileSync(join(dir, "calls.log"), JSON.stringify(a) + "\n");
  execFileSync("git", ["fetch", "-q", "origin", "pull/5/head:dark-list"], { stdio: "inherit" });
  execFileSync("git", ["checkout", "-q", "dark-list"], { stdio: "inherit" });
} else if (k === "pr list") {
  appendFileSync(join(dir, "calls.log"), JSON.stringify(a) + "\n");
  const mine = existsSync(created) ? [{ number: 7, title: JSON.parse(readFileSync(created, "utf8")).title, headRefName: JSON.parse(readFileSync(created, "utf8")).head, url: "https://github.com/e2e/todo-app/pull/7", state: "OPEN", isDraft: true, author: { login: "e2e" } }] : [];
  process.stdout.write(JSON.stringify([PR5, ...mine]));
} else if (k === "pr view" && !existsSync(created)) {
  appendFileSync(join(dir, "calls.log"), JSON.stringify(a) + "\n");
  process.stderr.write("no pull requests found for branch\n");
  process.exit(1);
} else {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "fake-gh.mjs"), ...a], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  process.exit(r.status ?? 1);
}
