#!/usr/bin/env node
// A fake gh for the quests e2e (SHRIKE_GH_BIN): open issues to import, and issue create recorded, never sent. Calls: $SHRIKE_FAKE_GH_DIR/calls.log.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const a = process.argv.slice(2);
const dir = process.env.SHRIKE_FAKE_GH_DIR;
if (dir) appendFileSync(join(dir, "calls.log"), JSON.stringify(a) + "\n");
const k = a.slice(0, 2).join(" ");
const issues = [
  { number: 12, title: "Let people edit a todo", url: "https://github.com/e2e/todo-app/issues/12", body: "### Acceptance criteria\n\n* [ ] Click a title to edit it\n* [ ] Esc cancels\n<!-- from the template -->", labels: [{ name: "enhancement" }] },
  { number: 9, title: "Dark mode", url: "https://github.com/e2e/todo-app/issues/9", body: "", labels: [] },
];
if (a[0] === "--version") process.stdout.write("gh version 2.81.0 (fake)\n");
else if (k === "auth status") process.stdout.write("Logged in (fake)\n");
else if (k === "issue list") process.stdout.write(JSON.stringify(issues));
else if (k === "issue view") {
  const i = issues.find((x) => String(x.number) === a[2]);
  if (!i) (process.stderr.write("issue not found\n"), process.exit(1));
  process.stdout.write(JSON.stringify(i));
} else if (k === "issue create") process.stdout.write("https://github.com/e2e/todo-app/issues/42\n");
else (process.stderr.write(`fake-gh-quests: no ${k}\n`), process.exit(1));
