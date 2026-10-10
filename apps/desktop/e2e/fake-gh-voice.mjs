#!/usr/bin/env node
// A fake gh for the voice e2e (SHRIKE_GH_BIN): open PRs #7, #42 and #57, each readable by number; everything else is
// fake-gh.mjs (its PR #7, renumbered to the one asked for). Nothing reaches GitHub.
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const a = process.argv.slice(2);
const dir = process.env.SHRIKE_FAKE_GH_DIR;
if (!dir) (process.stderr.write("fake-gh-voice: set SHRIKE_FAKE_GH_DIR\n"), process.exit(2));
const k = a.slice(0, 2).join(" ");
const TITLE = { 7: "Fix: Add Todo works again", 42: "Dark mode for the todo list", 57: "Faster checkout" };
const pr = (n) => ({ number: n, title: TITLE[n], url: `https://github.com/e2e/todo-app/pull/${n}`, state: "OPEN", isDraft: false, headRefName: `pr-${n}`, author: { login: "sam" } });

if (k === "pr list") {
  appendFileSync(join(dir, "calls.log"), JSON.stringify(a) + "\n");
  process.stdout.write(JSON.stringify([7, 42, 57].map(pr)));
} else {
  const asked = Number(k === "pr view" && /^\d+$/.test(a[2] ?? "") ? a[2] : (a.find((x) => /^n=\d+$/.test(x)) ?? "n=7").slice(2));
  const n = TITLE[asked] ? asked : 7;
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "fake-gh.mjs"), ...a], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  let out = r.stdout ?? "";
  if (n !== 7) out = out.replaceAll('"number":7', `"number":${n}`).replaceAll("/pull/7", `/pull/${n}`).replaceAll(JSON.stringify(TITLE[7]), JSON.stringify(TITLE[n]));
  process.stdout.write(out);
  process.stderr.write(r.stderr ?? "");
  process.exit(r.status ?? 1);
}
