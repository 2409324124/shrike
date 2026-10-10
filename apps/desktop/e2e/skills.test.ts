// S1–S5 in the built app: the shelf with built-in, project and Claude Code skills (read-only), an improvement that waits
// as a draft (the file is untouched until its outcome), save as a skill. The real skill run (S3 checklist) needs SHRIKE_E2E_AGENT=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Skill, SkillDraft } from "@shrike/schema";
import { claudeSkillsListing, fixtureCopy, key, launch, mcpClient, openFolder, shot, sleep, waitFor } from "./helpers.ts";

const SKILL = `---
name: Check the todo routes
when: Use when you need to know what the todo API does before changing it.
---
1. List the project's routes with list_routes.
2. Read server/todos.controller.ts with read_file.
3. Say in one plain sentence what POST /api/todos does, then stop.
`;

const claudeDir = join(homedir(), ".claude", "skills");
const claudeCount = existsSync(claudeDir) ? readdirSync(claudeDir).filter((d) => existsSync(join(claudeDir, d, "SKILL.md")) || d.endsWith(".md")).length : 0;

test("skills: shelf, Claude Code import (read-only), an improvement waits as a draft, save as a skill, run with a checklist", { timeout: 900_000 }, async () => {
  const before = claudeSkillsListing();
  const personal = join(homedir(), ".shrike", "skills");
  const personalBefore = existsSync(personal) ? readdirSync(personal).sort().join(",") : null;
  const proj = fixtureCopy("todo-app");
  mkdirSync(join(proj, ".shrike", "skills"), { recursive: true });
  writeFileSync(join(proj, ".shrike", "skills", "check-routes.md"), SKILL);

  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj });
  try {
    await win.emulateMedia({ reducedMotion: "reduce" });
    await openFolder(win);
    const call = <T,>(fn: string, ...args: unknown[]) => win.evaluate(([f, a]) => (window.shrike as any)[f](...a), [fn, args] as const) as Promise<T>;

    // S1 + S2: K opens the shelf; it asks once about the Claude Code skills.
    await key(win, "k");
    const shelf = win.getByRole("region", { name: "Skills" });
    await shelf.waitFor();
    if (claudeCount) {
      const offer = shelf.getByRole("group", { name: "Use your Claude Code skills" });
      await offer.waitFor();
      assert.match(await offer.innerText(), new RegExp(`You have ${claudeCount} Claude Code skill`));
      await sleep(400);
      await shot(app, "skills-01-offer", "v5");
      await offer.getByRole("button", { name: "Use them" }).click();
      await shelf.getByText("From Claude Code · Shrike only reads these").waitFor();
    }
    const list = await call<Skill[]>("listSkills");
    const project = list.find((s) => s.id === "check-routes");
    assert.equal(project?.source, "project");
    assert.deepEqual(project?.steps?.length, 3);
    assert.ok(list.some((s) => s.source === "builtin" && s.id === "ship-fix" && s.kind === "git"), "built-in git skills are on the shelf");
    const claude = list.filter((s) => s.source === "claude");
    assert.equal(claude.length, claudeCount);
    assert.ok(claude.every((s) => s.readOnly), "Claude Code skills are read-only");
    await shelf.locator('[data-skill="check-routes"]').getByText("This project").waitFor();
    if (claude[0]) await shelf.locator(`[data-skill="${claude[0].id}"]`).getByText("Claude", { exact: true }).waitFor();
    await sleep(300);
    await shot(app, "skills-02-shelf", "v5");

    // Search narrows the shelf.
    await shelf.getByRole("textbox", { name: "Find a skill" }).fill("todo routes");
    await waitFor("search to narrow the shelf", async () => (await shelf.locator("[data-skill]").count()) === 1);
    await shot(app, "skills-03-search", "v5");
    await key(win, "Escape");
    await shelf.waitFor({ state: "detached" });

    // S4: the agent proposes an improvement. It waits as a draft; the skill file is untouched until the outcome is verified.
    const mcp = await mcpClient(app);
    const file0 = readFileSync(join(proj, ".shrike", "skills", "check-routes.md"), "utf8");
    const after = "1. Check the server answers on its port before anything else.\n2. List the project's routes with list_routes.\n3. Read server/todos.controller.ts with read_file.\n4. Say in one plain sentence what POST /api/todos does, then stop.";
    assert.match(await mcp.call("propose_skill_update", { skillId: "check-routes", reason: "Learned: check the server answers first", after }), /./);
    const drafts = await waitFor("the pending draft", async () => {
      const l = await call<SkillDraft[]>("listSkillDrafts");
      return l.find((d) => d.skillId === "check-routes" && d.status === "pending") && l;
    });
    const mine = drafts.find((d) => d.skillId === "check-routes" && d.status === "pending")!;
    assert.match(mine.reason, /check the server answers first/i);
    assert.equal(await win.getByRole("region", { name: "Learned something" }).count(), 0, "no Keep card");
    await assert.rejects(call("answerSkillProposal", mine.id, true), /keeps it by itself/);
    assert.equal(readFileSync(join(proj, ".shrike", "skills", "check-routes.md"), "utf8"), file0, "the skill file is untouched");
    await shot(app, "skills-04-draft", "v5");

    // A Claude Code skill's improvement, discarded: nothing is written anywhere.
    if (claude[0]) {
      await mcp.call("propose_skill_update", { skillId: claude[0].id, reason: "Learned: nothing real", after: "1. A.\n2. B." });
      const d = await waitFor("the Claude skill draft", async () => (await call<SkillDraft[]>("listSkillDrafts")).find((x) => x.skillId === claude[0]!.id && x.status === "pending"));
      await call("answerSkillProposal", d.id, false);
      assert.equal((await call<SkillDraft[]>("listSkillDrafts")).find((x) => x.id === d.id)?.status, "discarded");
    }
    await mcp.close();

    // S5: save a flow as a skill; it lands in .shrike/skills and on the shelf. Secrets are never written.
    const flow = await call<{ id: string }>("saveFlow", "Create Sam", [{ type: "request", request: { method: "POST", url: "/api/todos", headers: { "content-type": "application/json" }, body: '{"title":"buy milk"}' } }]);
    const saved = await call<Skill>("saveAsSkill", { flowId: flow.id });
    assert.equal(saved.source, "project");
    const file = readFileSync(join(proj, ".shrike", "skills", `${saved.id}.md`), "utf8");
    assert.match(file, /POST \/api\/todos/);
    await key(win, "k");
    await shelf.locator(`[data-skill="${saved.id}"]`).waitFor();
    await sleep(300);
    await shot(app, "skills-05-saved", "v5");
    await key(win, "Escape");
    await shelf.waitFor({ state: "detached" });

    // S3: a real skill run with Claude Code; the checklist ticks as it goes.
    if (process.env.SHRIKE_E2E_AGENT === "1") {
      await win.evaluate(() => window.shrike.on("agent:status", (i) => i.status !== "running" && ((window as any).__runEnd = i.status)));
      await key(win, "k");
      await shelf.locator('[data-skill="check-routes"]').getByRole("button", { name: "Run" }).click();
      const steps = win.getByRole("complementary", { name: "Check the todo routes steps" });
      await steps.waitFor({ timeout: 30_000 });
      await waitFor("the first step to tick", async () => (await steps.innerText()).match(/(\d)\/4/)?.[1] !== "0", 240_000);
      await shot(app, "skills-06-checklist-live", "v5");
      const end = await waitFor("the run to end", () => win.evaluate(() => (window as any).__runEnd as string | undefined), 600_000);
      const text = await steps.innerText().catch(() => "");
      console.log("run:", end, "checklist:", text.replace(/\n/g, " | "));
      assert.equal(end, "done");
      await shot(app, "skills-07-checklist-done", "v5");
      const uses = (await call<Skill[]>("listSkills")).find((s) => s.id === "check-routes")?.uses ?? 0;
      assert.ok(uses >= 1, "load_skill counted a use");
    }
  } finally {
    await cleanup();
  }
  assert.equal(claudeSkillsListing(), before, "~/.claude/skills untouched");
  assert.equal(existsSync(personal) ? readdirSync(personal).sort().join(",") : null, personalBefore, "no personal copy from a discard");
});
