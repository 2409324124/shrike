import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AgentStep } from "@shrike/schema";
import { frontMatter, parseSkill, skillSteps, whenOf } from "@shrike/mcp-server";
import {
  answerProposal,
  claudeOffer,
  draftFromRun,
  editablePath,
  editDraft,
  listDrafts,
  loadSkills,
  noteSkillStep,
  noteUse,
  proposeUpdate,
  readClaudeSkills,
  saveAsCommand,
  saveAsSkill,
  setClaudeImport,
  setFields,
  setFlowLookup,
  settle,
  undoDraft,
  type SkillDirs,
} from "./skills.ts";

const keep = async (d: SkillDirs, skillId: string) => assert.equal((await settle(d, { expect: "fix", ok: true, skillIds: [skillId] })).applied.length, 1);
const md = (fm: string, body = "# X\n\n1. One.\n2. Two.\n") => `---\n${fm}\n---\n\n${body}`;

function fixture(): SkillDirs {
  const base = mkdtempSync(join(tmpdir(), "shrike-skills-"));
  const d: SkillDirs = { builtin: join(base, "builtin"), project: join(base, "proj"), personal: join(base, "personal"), claude: join(base, "claude"), state: join(base, "state") };
  for (const p of [d.builtin, join(d.project!, ".shrike/skills"), d.personal, join(d.claude, "navigate-app"), join(d.claude, "no-front"), d.state]) mkdirSync(p, { recursive: true });
  writeFileSync(join(d.builtin, "auth.md"), md("name: Auth\nwhen: Logins fail"));
  writeFileSync(join(d.builtin, "cache.md"), md("name: Cache\nwhen: Stale data"));
  writeFileSync(join(d.builtin, "slow.md"), md("name: Slow page\nwhen: It is slow"));
  writeFileSync(join(d.personal, "cache.md"), md("name: My cache\nwhen: Stale data, my way\nversion: 3"));
  writeFileSync(join(d.personal, "slow.md"), md("name: My slow\nwhen: personal"));
  writeFileSync(join(d.project!, ".shrike/skills/slow.md"), md("name: Project slow\nwhen: project"));
  writeFileSync(join(d.claude, "navigate-app/SKILL.md"), md("name: navigate-app\ndescription: >-\n  Drive the app with the chrome-devtools MCP. Use when asked to\n  click through a flow or take screenshots.\nmetadata:\n  tags: a, b", "## 1. Attach\n\nx\n\n## 2. Log in\n\ny\n"));
  writeFileSync(join(d.claude, "loose.md"), md('name: loose\ndescription: "Writes a DM. Use whenever he says \\"write a message\\"."'));
  writeFileSync(join(d.claude, "no-front/SKILL.md"), "just text");
  writeFileSync(join(d.claude, "auth.md"), md("name: claude-auth\ndescription: Use when auth"));
  return d;
}

test("front matter: plain, quoted, folded and nested keys; steps from lists or sections", () => {
  const fm = frontMatter("---\r\nname: 'It''s'\r\ndescription: |\r\n  line one\r\n  line two\r\nmetadata:\r\n  k: v\r\nkind: git\r\n---\r\nBody")!;
  assert.deepEqual(fm.fields, { name: "It's", description: "line one\nline two", metadata: "", kind: "git" });
  assert.equal(fm.body, "Body");
  assert.equal(frontMatter("no front matter"), null);
  assert.equal(frontMatter("---\nname: a---b\n---\nx")!.fields.name, "a---b");

  assert.equal(whenOf("Drive the dashboard via MCP. Use when asked to test a change. Pairs with x."), "Use when asked to test a change");
  assert.equal(whenOf("Best practices for Remotion - Video creation in React"), "Best practices for Remotion - Video creation in React");
  assert.ok(whenOf(`Use when ${"x ".repeat(200)}`).length <= 140);

  assert.deepEqual(parseSkill("g", md("name: G\nwhen: W\nkind: git\nversion: 2\nimproved: 1700000000000\nfrom: claude")), {
    id: "g", name: "G", when: "W", body: "# X\n\n1. One.\n2. Two.", kind: "git", version: 2, improvedAt: 1700000000000, from: "claude",
  });
  assert.equal(parseSkill("x", "---\nname: X\n---\nno when"), null);

  assert.deepEqual(skillSteps("# T\n\n1. **Find** the `request`. Then more.\n2. Open [it](http://x).\n\n```\n1. not a step\n```"), ["Find the request", "Open it"]);
  assert.deepEqual(skillSteps("## 1. Attach\n1. a\n1. b\n## 2. Log in\n"), ["Attach", "Log in"]); // several lists: the sections
  assert.deepEqual(skillSteps("just prose"), []);
});

test("the owner's real ~/.claude/skills parse, read-only", { skip: !existsSync(join(homedir(), ".claude/skills")) }, async () => {
  const dir = join(homedir(), ".claude/skills");
  const files = readdirSync(dir).flatMap((n) => (existsSync(join(dir, n, "SKILL.md")) ? [join(dir, n, "SKILL.md")] : n.endsWith(".md") ? [join(dir, n)] : []));
  const before = files.map((f) => statSync(f).mtimeMs);
  const skills = await readClaudeSkills(dir);
  assert.ok(skills.length >= Math.min(20, files.length), `parsed ${skills.length} of ${files.length}`);
  for (const s of skills) {
    assert.ok(s.name && s.when, s.id);
    assert.ok(s.when.length <= 140 && !s.when.includes("\n"), `${s.id}: ${s.when}`);
    assert.equal(s.source, "claude");
    assert.equal(s.readOnly, true);
  }
  const brief = skills.find((s) => s.id === "daily-brief");
  if (brief) assert.match(brief.when, /^Use when he says "daily brief"/);
  const fold = skills.find((s) => s.id === "explain-file-change"); // its description is a `>-` block
  if (fold) assert.match(fold.when, /^Use when the user asks to "explain the changes in this file"/);
  assert.deepEqual(files.map((f) => statSync(f).mtimeMs), before);
});

test("merge: project over personal over builtin; Claude skills only after import, after Shrike's own", async () => {
  const d = fixture();
  assert.equal(await claudeOffer(d), 3); // no-front has no front matter
  let all = await loadSkills(d);
  assert.deepEqual(all.map((s) => [s.id, s.name, s.source]), [["auth", "Auth", "builtin"], ["cache", "My cache", "personal"], ["slow", "Project slow", "project"]]);
  assert.equal(all[1]!.version, 3);
  assert.deepEqual(all[0]!.steps, ["One", "Two"]);

  await setClaudeImport(d, true);
  assert.equal(await claudeOffer(d), null);
  all = await loadSkills(d);
  assert.deepEqual(all.map((s) => `${s.source}:${s.id}`), ["builtin:auth", "personal:cache", "project:slow", "claude:loose", "claude:navigate-app"]); // claude "auth" loses to Shrike's
  const nav = all.find((s) => s.id === "navigate-app")!;
  assert.equal(nav.when, "Use when asked to click through a flow or take screenshots");
  assert.deepEqual(nav.steps, ["Attach", "Log in"]);
  assert.equal(all.find((s) => s.id === "loose")!.when, 'Use whenever he says "write a message"');

  await noteUse(d, "auth");
  await Promise.all([noteUse(d, "auth"), noteUse(d, "auth")]);
  assert.equal((await loadSkills(d))[0]!.uses, 3);

  await setClaudeImport(d, false);
  assert.equal((await loadSkills(d)).some((s) => s.source === "claude"), false);
});

test("proposals: a verified outcome writes in place or to a copy (never into ~/.claude), discard writes nothing", async () => {
  const d = fixture();
  await setClaudeImport(d, true);
  const claudeFile = join(d.claude, "navigate-app/SKILL.md");
  const claudeText = readFileSync(claudeFile, "utf8");

  // Project skill: in place, version bumped, other front matter kept.
  const p1 = await proposeUpdate(d, { skillId: "slow", reason: "Learned: check the port first", after: "1. Check the port.\n2. Then the rest." });
  assert.equal(p1.before, "# X\n\n1. One.\n2. Two.");
  await assert.rejects(answerProposal(d, p1.id, true), /by itself/); // no Keep that skips the outcome
  await keep(d, "slow");
  const slow = (await loadSkills(d)).find((s) => s.id === "slow")!;
  assert.equal(slow.version, 2);
  assert.ok(slow.improvedAt && Date.now() - slow.improvedAt < 5000);
  assert.equal(slow.name, "Project slow");
  assert.deepEqual(slow.steps, ["Check the port", "Then the rest"]);
  await assert.rejects(answerProposal(d, p1.id, false), /isn't there/);

  // Discard: nothing changes.
  const p2 = await proposeUpdate(d, { skillId: "auth", reason: "x", after: "nope" });
  assert.equal(await answerProposal(d, p2.id, false), null);
  assert.equal(existsSync(join(d.personal, "auth.md")), false);

  // Built-in: a personal copy.
  await proposeUpdate(d, { skillId: "auth", reason: "x", after: "1. New auth step.\n2. Two." });
  await keep(d, "auth");
  assert.equal(readFileSync(join(d.builtin, "auth.md"), "utf8"), md("name: Auth\nwhen: Logins fail"));
  assert.equal((await loadSkills(d)).find((s) => s.id === "auth")!.source, "personal");

  // Claude: copy-on-write into personal, marked as the evolving version, still listed as Claude's; ~/.claude untouched.
  await proposeUpdate(d, { skillId: "navigate-app", reason: "Learned: port 5173 is often taken", after: "## 1. Check the port\n\n## 2. Attach\n" });
  const copy = join(d.personal, "navigate-app.md");
  await keep(d, "navigate-app");
  assert.equal(readFileSync(claudeFile, "utf8"), claudeText);
  assert.match(readFileSync(copy, "utf8"), /^---\nname: navigate-app\ndescription: >-\n {2}Drive the app[\s\S]*\nversion: 2\nimproved: \d+\nfrom: claude\n---\n\n## 1\. Check the port/);
  let nav = (await loadSkills(d)).find((s) => s.id === "navigate-app")!;
  assert.deepEqual([nav.source, nav.readOnly, nav.path, nav.version], ["claude", false, copy, 2]);
  assert.equal((await loadSkills(d)).filter((s) => s.id === "navigate-app").length, 1);

  // A second improvement to the evolving copy lands in the same copy.
  await proposeUpdate(d, { skillId: "navigate-app", reason: "again", after: "## 1. A\n\n## 2. B\n" });
  await keep(d, "navigate-app");
  nav = (await loadSkills(d)).find((s) => s.id === "navigate-app")!;
  assert.equal(nav.version, 3);
  assert.equal(readFileSync(claudeFile, "utf8"), claudeText);
  assert.equal((readFileSync(copy, "utf8").match(/^from: claude$/gm) ?? []).length, 1);

  await assert.rejects(proposeUpdate(d, { skillId: "nope", reason: "x", after: "y" }), /No skill/);
  assert.equal(setFields("a: 1\nversion: 1", { version: 2, b: "x" }), "a: 1\nversion: 2\nb: x");
});

test("evolve-on-outcome: an outcome with no run or skill settles only drafts made in this project; Undo never loses a later hand edit", async () => {
  const d = fixture();
  const other = { ...d, project: join(d.project!, "..", "other") };
  await proposeUpdate(d, { skillId: "auth", reason: "x", after: "1. New auth." });
  assert.equal((await settle(other, { expect: "fix", ok: true })).applied.length, 0, "another project's outcome");
  const r = await settle(d, { expect: "fix", ok: true });
  assert.equal(r.applied.length, 1);
  writeFileSync(join(d.personal, "auth.md"), readFileSync(join(d.personal, "auth.md"), "utf8") + "\nhand edit\n");
  await assert.rejects(undoDraft(d, r.applied[0]!.id), /changed again/);
});

test("evolve-on-outcome: a missed outcome leaves the skill byte-identical; drafts survive a restart; a verified one levels up with a changelog line and a backup; Undo restores the bytes", async () => {
  const d = fixture();
  const file = join(d.project!, ".shrike/skills/slow.md");
  const v1 = readFileSync(file);
  const p = await proposeUpdate(d, { skillId: "slow", reason: "Learned: Wait for MySQL login before seeding.", after: "1. Wait for MySQL.\n2. Seed." });
  assert.equal((await listDrafts(d))[0]!.expect, "fix");

  const miss = await settle(d, { expect: "fix", ok: false, runIds: ["r1"], skillIds: ["slow"] });
  assert.equal(miss.missed[0]!.missed, "the fix wasn't verified");
  assert.deepEqual(readFileSync(file), v1, "untouched");
  assert.equal((await settle(d, { expect: "fix", ok: false, skillIds: ["slow"] })).missed.length, 0, "said once");
  assert.equal((await settle(d, { expect: "run", ok: true, skillIds: ["slow"] })).applied.length, 0, "another outcome doesn't count");

  // A fresh process sees the draft on disk and a later verified run promotes it.
  const mod = fileURLToPath(new URL("./skills.ts", import.meta.url));
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(mod)}); const r = await m.settle(${JSON.stringify(d)}, { expect: "fix", ok: true, runIds: ["r2"], skillIds: ["slow"] }); console.log(JSON.stringify(r.applied))`], { encoding: "utf8" });
  const [applied] = JSON.parse(out) as { id: string; version: number }[];
  assert.equal(applied!.id, p.id);
  assert.equal(applied!.version, 2);
  const v2 = readFileSync(file, "utf8");
  assert.match(v2, /^---\nname: Project slow\nwhen: project\nversion: 2\nimproved: \d+\n---\n\n1\. Wait for MySQL\.\n2\. Seed\.\n\n## Changelog\n\n- v2: wait for MySQL login before seeding, learned on run of \d{1,2} \w{3}\n$/);
  assert.deepEqual(readFileSync(join(d.project!, ".shrike/skills/versions/slow.v1.md")), v1, "previous version kept next to it");
  assert.deepEqual((await loadSkills(d)).find((s) => s.id === "slow")!.steps, ["Wait for MySQL", "Seed"], "the changelog isn't a step");

  await undoDraft(d, p.id);
  assert.deepEqual(readFileSync(file), v1, "Undo restores the bytes");
  assert.equal((await listDrafts(d))[0]!.status, "undone");
  await assert.rejects(undoDraft(d, p.id), /nothing to undo/);

  // Built-in: the first improvement is a new personal copy (backup in userData); Undo removes the copy. Edit before keeping wins.
  const b = await proposeUpdate(d, { skillId: "auth", reason: "Check the cookie domain", after: "1. Cookie.\n2. Two." });
  const rel = await editDraft(d, b.id);
  assert.match(rel, /^\.shrike\/skill-drafts\/auth-[0-9a-f]+\.md$/);
  writeFileSync(join(d.project!, rel), "1. Check the cookie domain first.\n2. Then the session.\n");
  await settle(d, { expect: "fix", ok: true, skillIds: ["auth"] });
  assert.match(readFileSync(join(d.personal, "auth.md"), "utf8"), /version: 2[\s\S]*cookie domain first[\s\S]*- v2: check the cookie domain/);
  assert.equal(existsSync(join(d.project!, rel)), false);
  assert.ok(existsSync(join(d.state, "skill-versions/auth.v1.md")));
  await undoDraft(d, b.id);
  assert.equal(existsSync(join(d.personal, "auth.md")), false);
  assert.equal((await loadSkills(d)).find((s) => s.id === "auth")!.source, "builtin");

  // A draft written against an older body never lands over a newer one.
  const c = await proposeUpdate(d, { skillId: "cache", reason: "x", after: "1. A.\n2. B." });
  writeFileSync(join(d.personal, "cache.md"), md("name: My cache\nwhen: Stale data, my way\nversion: 3", "1. Changed by hand.\n2. Two.\n"));
  assert.equal((await settle(d, { expect: "fix", ok: true, skillIds: ["cache"] })).applied.length, 0);
  assert.equal((await listDrafts(d)).find((x) => x.id === c.id)!.status, "superseded");
});

const step = (p: Partial<AgentStep> & Pick<AgentStep, "kind" | "text">): AgentStep => ({ id: Math.random().toString(16), runId: "r1", createdAt: 1, ...p });

test("save as a skill from a verified fix or a flow; save as command; edit makes a project copy", async () => {
  const d = fixture();
  for (const s of [
    step({ kind: "message", text: "My plan: check" }),
    step({ kind: "tool_call", text: 'Clicking "Add Todo"', actionIds: ["a1"] }),
    step({ kind: "tool_call", text: 'Clicking "Add Todo"' }),
    step({ kind: "tool_call", text: "Reading server/todos.controller.ts" }),
    step({ kind: "findings", text: "Wrong field", summary: "The server read req.body.user.", findings: [{ confidence: "observed", claim: "The server read req.body.user", file: "server/todos.controller.ts", line: 18 }] }),
    step({ kind: "patch", text: "Fix applied", patchId: "p1" }),
    step({ kind: "done", text: "Done", summary: "Fixed and verified" }),
  ]) noteSkillStep(s, "Adding a todo fails.\nmore");

  const skill = await saveAsSkill(d, { actionId: "a1" });
  assert.equal(skill.id, "adding-a-todo-fails");
  assert.equal(skill.source, "project");
  assert.equal(skill.kind, "debug");
  assert.equal(skill.when, "Something like this happens again: Adding a todo fails.");
  assert.deepEqual(skill.steps, [
    'Clicking "Add Todo"', "Reading server/todos.controller.ts", "Check: The server read req.body.user (server/todos.controller.ts:18)", "Propose the smallest fix with propose_patch", "Run it again and compare, to prove it works",
  ]);
  assert.match(readFileSync(skill.path!, "utf8"), /Last time: The server read req\.body\.user\./);
  assert.equal((await saveAsSkill(d, { runId: "r1", name: "Adding a todo fails" })).id, "adding-a-todo-fails-2"); // never overwrites
  await assert.rejects(saveAsSkill(d, { actionId: "nope" }), /no agent run/);
  assert.equal(draftFromRun("x", []).steps.length, 3);

  setFlowLookup((id) => (id === "f1" ? { id: "f1", name: "Add a todo", steps: [{ type: "type", name: "What needs doing?", text: "milk", submit: true }, { type: "type", name: "Password", text: "enc", secret: true }, { type: "click", name: "Add" }] } : undefined));
  const flow = await saveAsSkill(d, { flowId: "f1" });
  assert.deepEqual([flow.id, flow.kind, flow.when], ["add-a-todo", "flow", 'You want to check that "Add a todo" still works']);
  assert.deepEqual(flow.steps, ['Type "milk" into "What needs doing?" and press Enter', 'Type the secret into "Password"', 'Click "Add"', "Check every trip came back without errors"]);
  await assert.rejects(saveAsSkill(d, { flowId: "gone" }), /isn't saved/);

  const cmd = await saveAsCommand(d.project!, "Check Prices!", "Check every price is in cents.\nThen tell me.");
  assert.equal(cmd, join(d.project!, ".shrike/commands/check-prices.md"));
  assert.equal(readFileSync(cmd, "utf8"), "---\ndescription: Check every price is in cents. Then tell me.\n---\n\nCheck every price is in cents.\nThen tell me.\n");
  await assert.rejects(saveAsCommand(d.project!, "!!", "x"), /name/);

  assert.equal(await editablePath(d, "slow"), ".shrike/skills/slow.md");
  assert.equal(await editablePath(d, "cache"), ".shrike/skills/cache.md"); // personal → project copy
  assert.match(readFileSync(join(d.project!, ".shrike/skills/cache.md"), "utf8"), /name: My cache/);
  assert.equal(readFileSync(join(d.personal, "cache.md"), "utf8"), md("name: My cache\nwhen: Stale data, my way\nversion: 3"));
});
