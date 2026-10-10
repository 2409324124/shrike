// C1–C5, C7 in the built app with a recorded Claude Code stream (fake-claude.mjs): branch from FOUND IT and from a step,
// the map switches lines, Compare, an aside bubble, Bring it back. Main's session file never changes until Bring it back resumes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import type { AgentRunInfo } from "@shrike/schema";
import { addTodoAction, fakeClaude, fixtureCopy, freePort, launch, listening, openSampleAndRun, shot, sleep, todoAskAgent, typeTodo, waitFor } from "./helpers.ts";

const runs = (win: Page) => win.evaluate(() => window.shrike.listRuns()) as Promise<AgentRunInfo[]>;
const sha = (s: string) => createHash("sha1").update(s).digest("hex");

test("branches: fork from FOUND IT and from a step, map, compare, aside, bring it back; main's session untouched", { timeout: 600_000 }, async () => {
  const [web, api] = [await freePort(), await freePort()];
  const proj = fixtureCopy("todo-app", { ports: { 5173: web, 3001: api } });
  const cc = fakeClaude(250);
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj, ...cc.env });
  const pill = win.locator('aside[aria-label="Agent"]');
  const map = win.getByRole("navigation", { name: "Branches" });
  try {
    await win.emulateMedia({ reducedMotion: "reduce" });
    await todoAskAgent(app, win, web, "When I click Add Todo nothing shows up");
    const found = win.getByRole("region", { name: "Found it" });
    await found.waitFor({ timeout: 60_000 });
    const main = await waitFor("main's session", () => cc.calls().find((c) => c.kind === "main"));
    await waitFor("main to finish", () => cc.finished(main.session), 30_000);
    await waitFor("main done in Shrike", async () => (await runs(win)).find((r) => !r.parentRunId)?.status === "done", 20_000);
    const before = sha(cc.session(main.session));

    // C1 from FOUND IT: fork icon on the card, ask differently, name it.
    await found.getByRole("button", { name: "Branch from here" }).click();
    await found.getByRole("textbox", { name: "Ask differently" }).fill("what if the frontend is wrong instead?");
    await found.getByRole("textbox", { name: "Branch name (optional)" }).fill("frontend");
    await found.getByRole("textbox", { name: "Ask differently" }).press("Enter");
    const b1 = await waitFor("the branch's fork call", () => cc.calls().find((c) => c.kind === "branch"), 30_000);
    assert.equal(b1.resume, main.session, "the branch forks main's session");
    assert.equal(b1.fork, true, "with --fork-session");
    assert.notEqual(b1.session, main.session);
    assert.match(b1.disallowed ?? "", /mcp__shrike__propose_patch/, "no worktree (not a git repo): the branch can't patch main's code");
    assert.doesNotMatch(b1.goal, /Set aside everything/, "FOUND IT followed only by Done counts as the latest point");
    // C2 + C7: the map shows the branch thinking; its probe walks the Thread in its colour.
    await map.getByRole("button", { name: /^Branch frontend, thinking/ }).waitFor({ timeout: 10_000 });
    const probe = await waitFor("the branch's probe on the Thread", () => win.locator(".branch-probes i[data-branch]").count(), 10_000).catch(() => 0);
    await shot(app, "branch-probe", "v6");
    await map.getByRole("button", { name: /^Branch frontend, found/ }).waitFor({ timeout: 30_000 });
    assert.equal(sha(cc.session(main.session)), before, "main's session file is unchanged by the branch");

    // C1 from a step in the pill: a second branch from main's first message.
    await map.getByRole("button", { name: /^Main/ }).click();
    await pill.hover();
    const first = pill.locator("ol li").first();
    await first.hover();
    await first.getByRole("button", { name: "Branch from here" }).click();
    await first.getByRole("textbox", { name: "Ask differently" }).fill("what if the database dropped the column?");
    await first.getByRole("textbox", { name: "Branch name (optional)" }).fill("database");
    await first.getByRole("textbox", { name: "Ask differently" }).press("Enter");
    const b2 = await waitFor("the second fork", () => cc.calls().filter((c) => c.kind === "branch")[1], 30_000);
    assert.match(b2.goal, /^Set aside everything after this point of our conversation \("/, "an earlier step: told to set the rest aside, by its quoted text");
    await map.getByRole("button", { name: /^Branch database, found/ }).waitFor({ timeout: 30_000 });
    const lines = await runs(win);
    const [r1, r2] = [lines.find((r) => r.name === "frontend")!, lines.find((r) => r.name === "database")!];
    assert.ok(r1.color && r2.color && r1.color !== r2.color, `two colours: ${r1.color} ${r2.color}`);
    await pill.hover();
    await sleep(300);
    await shot(app, "branch-map-two", "v6");

    // C2 switching: the current line glows, the header names the branch.
    await map.getByRole("button", { name: /^Branch frontend/ }).click();
    assert.equal(await map.getByRole("button", { name: /^Branch frontend/ }).getAttribute("aria-current"), "true");
    assert.match(await pill.innerText(), /frontend · done/i);
    await map.getByRole("button", { name: /^Main/ }).click();
    assert.equal(await map.getByRole("button", { name: /^Main/ }).getAttribute("aria-current"), "true");

    // C4 Compare: main vs frontend, the different findings lit amber.
    await map.getByRole("button", { name: /^Branch frontend/ }).click();
    await pill.hover();
    await pill.getByRole("button", { name: "Compare" }).click();
    const cmp = win.getByRole("region", { name: "Compare branches" });
    await cmp.waitFor();
    const text = await cmp.innerText();
    assert.match(text, /req\.body\.user/, "main's finding");
    assert.match(text, /sends userId correctly|sends \{ title, userId \}/, "the branch's finding");
    assert.ok(await cmp.locator("p").evaluateAll((ps) => ps.some((p) => /inset/.test((p as HTMLElement).style.boxShadow))), "a differing finding is highlighted");
    await shot(app, "compare", "v6");
    await cmp.getByRole("button", { name: "Close" }).click();

    // C3 aside: a side question in a bubble; main's session still untouched; dismiss forgets it.
    await map.getByRole("button", { name: /^Main/ }).click();
    await pill.hover();
    await pill.getByRole("button", { name: "Aside" }).click();
    await pill.getByRole("textbox", { name: "Ask on the side" }).fill("does the cache touch POST at all?");
    await pill.getByRole("textbox", { name: "Ask on the side" }).press("Enter");
    const bubble = win.getByRole("region", { name: "Side question" });
    await bubble.getByText(/The cache only wraps GET/).waitFor({ timeout: 30_000 });
    const aside = cc.calls().find((c) => c.kind === "aside")!;
    assert.equal(aside.resume, main.session);
    assert.match(aside.disallowed ?? "", /propose_patch/, "an aside is read-only for real");
    await bubble.getByRole("button", { name: "Keep as a branch" }).waitFor();
    await win.mouse.move(5, 500);
    await sleep(400);
    await shot(app, "aside-bubble", "v6");
    assert.ok(!(await runs(win)).some((r) => r.aside), "asides never reach the run list");
    await bubble.getByRole("button", { name: "Dismiss" }).click();
    await bubble.waitFor({ state: "detached" });
    assert.equal(sha(cc.session(main.session)), before, "main's session file is unchanged by the aside");

    // C5 Bring it back: one short message resumes main (not a fork); the map keeps its branches.
    await map.getByRole("button", { name: /^Branch frontend/ }).click();
    await pill.hover();
    await pill.getByRole("button", { name: "Bring it back" }).click();
    const back = await waitFor("main resumed", () => cc.calls().find((c) => c.kind === "resume"), 20_000);
    assert.equal(back.resume, main.session);
    assert.match(back.goal, /^Another line of thinking found: /);
    await waitFor("bring-back finished", () => cc.finished(main.session) && sha(cc.session(main.session)) !== before, 30_000);
    await waitFor("the resumed run continues main", async () => (await runs(win)).some((r) => !!r.continues && r.status === "done"), 20_000);
    await map.getByRole("button", { name: /^Branch frontend/ }).waitFor();
    await map.getByRole("button", { name: /^Branch database/ }).waitFor();
    console.log(`branch probe drawn: ${probe}`);
    assert.ok(probe >= 1, "C7: the branch probe walked the Thread");
  } catch (err) {
    await shot(app, "branches-failure", "v6").catch(() => {});
    throw err;
  } finally {
    await cleanup();
    cc.remove();
  }
  await waitFor("todo ports to close", () => listening([web, api]) === "", 20_000);
});

// One real Claude Code run (SHRIKE_E2E_AGENT=1): main finds the bug, one branch from FOUND IT; main's own session file stays byte for byte.
test("branches, real Claude Code: fork from FOUND IT leaves main's session file unchanged; X-ray live", { skip: process.env.SHRIKE_E2E_AGENT !== "1", timeout: 1_200_000 }, async () => {
  const fixture = join(import.meta.dirname, "../../../fixtures/todo-app");
  const keep = [join(fixture, "server/todos.controller.ts"), join(fixture, ".shrike/memory.md")].map((f) => [f, existsSync(f) ? readFileSync(f) : null] as const);
  const { app, win, userData, cleanup } = await launch();
  const pill = win.locator('aside[aria-label="Agent"]');
  const sessionOf = async (runId: string) =>
    waitFor(`run ${runId}'s session on disk`, () => {
      const dir = join(userData, "runs");
      for (const f of existsSync(dir) ? readdirSync(dir) : []) {
        const r = (JSON.parse(readFileSync(join(dir, f), "utf8")).runs as { info: { id: string }; session?: string }[]).find((x) => x.info.id === runId);
        if (r?.session) return r.session;
      }
      return undefined;
    }, 30_000);
  const sessionFile = (id: string) => execFileSync("find", [join(homedir(), ".claude", "projects"), "-name", `${id}.jsonl`], { encoding: "utf8" }).trim().split("\n")[0]!;
  try {
    await win.emulateMedia({ reducedMotion: "no-preference" });
    const guest = await openSampleAndRun(app, win);
    const closeSetup = win.getByRole("button", { name: "Close setup" });
    if (await closeSetup.isVisible({ timeout: 3000 }).catch(() => false)) await closeSetup.click();
    await typeTodo(guest, "buy milk");
    await guest.getByRole("button", { name: "Add Todo" }).click();
    await addTodoAction(win);
    await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await win.keyboard.press("Meta+k");
    const ask = win.getByRole("dialog", { name: "Ask your agent" });
    const brain = ask.getByRole("combobox", { name: "Which agent to use" });
    if (await brain.count()) await brain.selectOption("claude-code");
    await ask.getByRole("textbox", { name: "Ask your agent" }).fill("When I click Add Todo nothing shows up. Find the cause and report it with report_findings. Don't propose a fix yet.");
    await ask.getByRole("textbox", { name: "Ask your agent" }).press("Enter");
    await ask.waitFor({ state: "detached" });

    // X-ray live while main works.
    const seen = new Set<string>();
    let shots = 0;
    const found = win.getByRole("region", { name: "Found it" });
    await waitFor("FOUND IT", async () => {
      const t = await pill.locator(".xr-activity").first().innerText({ timeout: 300 }).catch(() => "");
      if (t) seen.add(t.trim());
      if (shots === 0 && (await pill.locator(".xr-files").count())) {
        shots++;
        await pill.hover();
        await sleep(300);
        await shot(app, "real-xray-live", "v6");
        await win.mouse.move(5, 500);
      }
      return found.isVisible();
    }, 600_000);
    console.log("activity seen:", [...seen].join(" | "));
    assert.ok([...seen].some((t) => /^(Reading|Read|Searching|Looking|Checking|Clicking)\b/.test(t)), "a live action with its target");
    const mainRun = await waitFor("main done", async () => (await runs(win)).find((r) => !r.parentRunId && r.status !== "running"), 600_000);
    assert.equal(mainRun.status, "done");
    await pill.hover();
    await sleep(400);
    assert.ok(await pill.locator(".xr-files button").count(), "file chips");
    assert.match(await pill.locator("p.xr-tokens").innerText(), /This run/);
    await shot(app, "real-xray-done", "v6");
    await win.locator(".fuel-ring").click();
    const map = (await win.evaluate((id) => window.shrike.getContextMap(id), mainRun.id))!;
    console.log("context map:", map.segments.map((s) => `${s.label}=${s.tokens}`).join(" | "), "total", map.totalTokens);
    assert.equal(map.segments.reduce((a, s) => a + s.tokens, 0), map.totalTokens);
    await win.getByRole("region", { name: "What fills your agent's context" }).waitFor();
    await shot(app, "real-context-map", "v6");
    await win.getByRole("region", { name: "What fills your agent's context" }).getByRole("button", { name: "Close" }).click();

    const mainSession = await sessionOf(mainRun.id);
    const mainFile = sessionFile(mainSession);
    const before = readFileSync(mainFile, "utf8");
    console.log(`main session ${mainSession}: ${before.split("\n").length} lines`);

    // One branch from FOUND IT.
    await found.getByRole("button", { name: "Branch from here" }).click();
    await found.getByRole("textbox", { name: "Ask differently" }).fill("what if the frontend is wrong instead?");
    await found.getByRole("textbox", { name: "Ask differently" }).press("Enter");
    const branch = await waitFor("the branch", async () => (await runs(win)).find((r) => r.parentRunId === mainRun.id), 60_000);
    await shot(app, "real-branch-thinking", "v6");
    const ended = await waitFor("the branch to end", async () => (await runs(win)).find((r) => r.id === branch.id && r.status !== "running"), 600_000);
    assert.equal(ended.status, "done");
    const branchSession = await sessionOf(branch.id);
    assert.notEqual(branchSession, mainSession, "the branch has its own session");
    assert.ok(existsSync(sessionFile(branchSession)), "Claude Code wrote the fork's session");
    const after = readFileSync(mainFile, "utf8");
    assert.equal(after, before, "main's session file (and its turns) are unchanged by the branch");
    const bSteps = await win.evaluate((id) => window.shrike.getRunSteps(id), branch.id);
    console.log(`branch "${ended.name}": ${bSteps.map((s) => `${s.kind}${s.tool ? `:${s.tool}` : ""}`).join(" ")}`);
    assert.ok(!bSteps.some((s) => s.kind === "tool_call" && s.tool === "propose_patch"), "no worktree here: the branch never calls propose_patch");
    await pill.hover();
    await sleep(400);
    await shot(app, "real-branch-done", "v6");
  } catch (err) {
    await shot(app, "real-failure", "v6").catch(() => {});
    throw err;
  } finally {
    await cleanup();
    for (const [f, b] of keep) b ? writeFileSync(f, b) : rmSync(f, { force: true });
    assert.ok(readFileSync(keep[0]![0], "utf8").includes("userId: req.body.user })"), "the planted bug is in place");
  }
});
