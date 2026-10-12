import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ProjectInfo, ShrikeHost, StartPlan, StartStep } from "@shrike/schema";
import { startMcpServer } from "@shrike/mcp-server";
import { Runner } from "../runner.ts";
import { listDrafts, settle, type SkillDirs } from "../skills.ts";
import { runStartBrain, NUDGE } from "./brain.ts";
import { Quest } from "./quest.ts";
import { discoverRecipes, setupSections } from "./recipes.ts";
import { proposeLesson, saveRunSkill } from "./runskill.ts";
import { StartSession } from "./session.ts";

/** A killed group can linger a moment on Linux while its children are reaped. */
async function groupGone(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(-pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../../..");
const tmp = mkdtempSync(join(tmpdir(), "shrike-start-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function snapshot(dir: string): string {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [`${join(d, e.name)}:${statSync(join(d, e.name)).mtimeMs}:${createHash("sha1").update(readFileSync(join(d, e.name))).digest("hex")}`]));
  return walk(dir).sort().join("\n");
}

function dirsFor(root: string, name: string): SkillDirs & { project: string } {
  const base = join(tmp, `home-${name}`);
  for (const d of ["personal", "claude", "state"]) mkdirSync(join(base, d), { recursive: true });
  return { builtin: join(repo, "prompts/skills"), project: root, personal: join(base, "personal"), claude: join(base, "claude"), state: join(base, "state") };
}

// ---- R1: recipe discovery ----

test("R1: recipes in order: Shrike run skill, personal, the project's .claude run skill, ~/.claude by name, README; lessons from the seed", async () => {
  const root = join(tmp, "xyne-spaces");
  const home = join(tmp, "home-r1");
  mkdirSync(join(root, ".shrike/skills"), { recursive: true });
  mkdirSync(join(root, ".claude/skills/run-xyne-spaces"), { recursive: true });
  mkdirSync(join(root, ".claude/skills/xyne-pr-review"), { recursive: true });
  mkdirSync(join(home, "claude/navigate-xyne-spaces"), { recursive: true });
  mkdirSync(join(home, "claude/run-other-thing"), { recursive: true });
  mkdirSync(join(home, "personal"), { recursive: true });
  writeFileSync(join(root, ".shrike/skills/run-xyne-spaces.md"), "---\nname: Run xyne-spaces\nwhen: Start it\nkind: run\nversion: 2\n---\n\n## Run\n\n1. `just services`\n");
  writeFileSync(join(root, ".claude/skills/run-xyne-spaces/SKILL.md"), "---\nname: run-xyne-spaces\ndescription: Build, run, and drive the Xyne Spaces local dev environment. Use when asked to start Xyne Spaces.\n---\n\nNix infra via `PC_DISABLE_TUI=true just services`.\n");
  writeFileSync(join(root, ".claude/skills/run-xyne-spaces/smoke.mjs"), "console.log('ok')\n");
  writeFileSync(join(root, ".claude/skills/xyne-pr-review/SKILL.md"), "---\nname: xyne-pr-review\ndescription: Review a PR before the reviewer.\n---\n\nChecks.\n");
  writeFileSync(join(home, "claude/navigate-xyne-spaces/SKILL.md"), "---\nname: navigate-xyne-spaces\ndescription: Drive the Xyne Spaces dashboard UI. Use when asked to click through it.\n---\n\nClick.\n");
  writeFileSync(join(home, "claude/run-other-thing/SKILL.md"), "---\nname: run-other-thing\ndescription: Start another project.\n---\n\nx\n");
  writeFileSync(join(root, "README.md"), "# Xyne\n\nIntro.\n\n## Getting started\n\n```bash\npnpm install\n```\n\n### Run it\n\n`pnpm dev`\n\n## License\n\nMIT\n");
  const before = snapshot(join(root, ".claude"));
  const { recipes, lessons } = await discoverRecipes({ root, name: "xyne-spaces", personal: join(home, "personal"), claude: join(home, "claude"), builtin: join(repo, "prompts/skills") });
  assert.deepEqual(recipes.map((r) => r.id), ["shrike:run-xyne-spaces", "project:run-xyne-spaces", "readme:README.md"]);
  assert.deepEqual(recipes.map((r) => r.source), ["shrike-skill", "project-skill", "readme"]);
  assert.equal(recipes[0]!.skillId, "run-xyne-spaces");
  assert.deepEqual(recipes[1]!.files?.map((f) => f.split("/").pop()), ["smoke.mjs"]);
  assert.match(recipes[2]!.body, /Getting started[\s\S]*pnpm install[\s\S]*pnpm dev/);
  assert.doesNotMatch(recipes[2]!.body, /License/);
  assert.equal(lessons[0]!.name, "Starting apps");
  assert.equal(snapshot(join(root, ".claude")), before, "discovery never writes to the project's .claude");

  // Without Shrike's own skill, the project's .claude run skill leads; a ~/.claude skill naming the project but not about starting stays out.
  rmSync(join(root, ".shrike"), { recursive: true });
  const again = await discoverRecipes({ root, name: "@xyne/root", personal: join(home, "personal"), claude: join(home, "claude"), builtin: join(repo, "prompts/skills") });
  assert.equal(again.recipes[0]!.id, "project:run-xyne-spaces");
  assert.ok(!again.recipes.some((r) => r.id === "claude:navigate-xyne-spaces" || r.id === "claude:run-other-thing"));
  writeFileSync(join(home, "claude/run-other-thing/SKILL.md"), "---\nname: run-xyne-spaces-docker\ndescription: Start xyne spaces on Docker.\n---\n\nx\n");
  const named = await discoverRecipes({ root, name: "xyne-spaces", personal: join(home, "personal"), claude: join(home, "claude"), builtin: join(repo, "prompts/skills") });
  assert.deepEqual(named.recipes.map((r) => r.source), ["project-skill", "claude-skill", "readme"]);
});

test("setupSections keeps only setup and run sections", () => {
  assert.equal(setupSections("# A\n\n## Usage\n\nrun it\n\n## API\n\nno"), "## Usage\n\nrun it");
  assert.equal(setupSections("# A\n\nnothing here"), "");
});

// ---- the quest state machine ----

test("quest: plan, steps move only along allowed paths, fixed needs a failure and words, ready needs every step", () => {
  const plans: StartPlan[] = [];
  const steps: StartStep[] = [];
  const q = new Quest("/p", "p", { plan: (p) => plans.push(p), step: (s) => steps.push(s) });
  assert.equal(q.plan.state, "planning");
  q.setPlan({ source: "explored", services: [{ name: "api", port: 3001 }], steps: [{ title: "Install the packages", kind: "install" }, { id: "api", title: "Start the API", kind: "service" }] });
  assert.deepEqual(q.plan.steps.map((s) => [s.id, s.state]), [["install-the-packages", "pending"], ["api", "pending"]]);
  assert.equal(q.plan.state, "running");
  assert.throws(() => q.update("api", { state: "fixed", fix: "x" }), /pending; it can't go to fixed/);
  q.update("api", { state: "running" });
  assert.throws(() => q.update("api", { state: "fixed", fix: "x" }), /never failed/);
  q.update("api", { state: "failed", detail: "uvicorn: command not found" });
  assert.throws(() => q.update("api", { state: "fixed" }), /Say what you changed/);
  q.update("api", { state: "fixed", fix: "Used uv run uvicorn" });
  assert.equal(steps.at(-1)!.fix, "Used uv run uvicorn");
  assert.throws(() => q.update("nope", { state: "done" }), /no step "nope"/);
  // replanning keeps progress of steps that keep their id
  q.setPlan({ source: "explored", services: [], steps: [{ id: "api", title: "Start the API (uv)", kind: "service" }, { id: "web", title: "Start the page", kind: "service" }] });
  assert.deepEqual(q.plan.steps.map((s) => [s.id, s.state]), [["api", "fixed"], ["web", "pending"]]);
  assert.deepEqual(q.unfinished().map((s) => s.id), ["web"]);
  q.update("web", { state: "waiting_approval", ask: { id: "a1", kind: "approve", title: "Free port 5173?" } });
  assert.throws(() => q.update("web", { state: "done" }), /waiting_approval; it can.t go to done/);
  q.update("web", { state: "running", ask: undefined });
  q.update("web", { state: "done" });
  q.reward({ kind: "acquired", skillId: "run-p", name: "Run p", level: 1 });
  q.reward({ kind: "acquired", skillId: "run-p", name: "Run p", level: 1 });
  assert.equal(q.plan.rewards!.length, 1);
  q.finish("ready");
  assert.equal(plans.at(-1)!.state, "ready");
  assert.throws(() => q.setPlan({ source: "explored", services: [], steps: [{ title: "x", kind: "other" }] }), /ready/);
});

test("quest output keeps a short tail and sends it batched", async () => {
  const steps: StartStep[] = [];
  const q = new Quest("/p", "p", { plan: () => {}, step: (s) => steps.push(s) });
  q.setPlan({ source: "explored", services: [], steps: [{ id: "i", title: "Install", kind: "install" }] });
  for (let i = 0; i < 100; i++) q.output("i", `line ${i}\n`);
  assert.equal(steps.length, 0);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(steps.length, 1);
  assert.match(steps[0]!.output!, /line 99/);
  assert.doesNotMatch(steps[0]!.output!, /line 10\n/);
});

// ---- R4/R7: ending with a skill ----

test("save_run_skill writes v1 in Shrike's format, then counts a same save as used and proposes a changed one", async () => {
  const root = join(tmp, "save-app");
  mkdirSync(join(root, ".claude/skills/run-save-app"), { recursive: true });
  writeFileSync(join(root, ".claude/skills/run-save-app/SKILL.md"), "---\nname: run-save-app\ndescription: Use when starting it.\n---\n\nx\n");
  const before = snapshot(join(root, ".claude"));
  const d = dirsFor(root, "save");
  const body = "## Prerequisites\n\nNode 24.\n\n## Run\n\n1. `pnpm install`\n2. `pnpm dev` (port 5173)\n\n## Gotchas\n\n- Rebuild `shared` after a pull.";
  await assert.rejects(saveRunSkill(d, { projectName: "save-app", body: "start it" }), /too short/);
  const first = await saveRunSkill(d, { projectName: "@acme/save-app", body, from: join(root, ".claude/skills/run-save-app/SKILL.md") });
  assert.equal(first.reward.kind, "acquired");
  assert.equal(first.reward.skillId, "run-save-app");
  const text = readFileSync(join(root, ".shrike/skills/run-save-app.md"), "utf8");
  assert.match(text, /^---\nname: Run save-app\nwhen: .+\nkind: run\nversion: 1\nimproved: \d+\nfrom-recipe: .+SKILL\.md\n---\n\n## Prerequisites/);
  const same = await saveRunSkill(d, { projectName: "@acme/save-app", body });
  assert.equal(same.reward.kind, "used");
  const changed = await saveRunSkill(d, { projectName: "@acme/save-app", body: `${body}\n- Port 5173 is often taken.`, learned: "port 5173 is often taken" });
  assert.equal(changed.reward.kind, "proposed");
  assert.equal(changed.reward.level, 2);
  assert.equal(readFileSync(join(root, ".shrike/skills/run-save-app.md"), "utf8"), text, "a draft changes nothing until its outcome is verified");
  await settle(d, { expect: "run", ok: true, skillIds: ["run-save-app"] });
  assert.match(readFileSync(join(root, ".shrike/skills/run-save-app.md"), "utf8"), /version: 2[\s\S]*often taken/);
  const again = await saveRunSkill(d, { projectName: "@acme/save-app", body: `${body}\n- Port 5173 is often taken.` });
  assert.equal(again.reward.kind, "used", "its own changelog doesn't make the same recipe look new");
  assert.equal(snapshot(join(root, ".claude")), before, "the project's .claude is never written");
});

test("R7: a lesson is proposed into the personal starting-apps skill (never written before a verified start)", async () => {
  const root = join(tmp, "lesson-app");
  mkdirSync(root, { recursive: true });
  const d = dirsFor(root, "lesson");
  const r = await proposeLesson(d, "Python services in uv projects start with uv run.");
  assert.equal(r.reward.kind, "proposed");
  assert.match(r.proposal!.after, /## Lessons learned\n+- Python services in uv projects start with uv run\./);
  assert.ok(!existsSync(join(d.personal, "starting-apps.md")));
  await settle(d, { expect: "run", ok: true, skillIds: ["starting-apps"] });
  assert.match(readFileSync(join(d.personal, "starting-apps.md"), "utf8"), /version: 2[\s\S]*uv run/);
  assert.equal((await proposeLesson(d, "Python services in uv projects start with uv run.")).reward.kind, "used");
  await proposeLesson(d, "Zebra lesson number one is about ports.", "s1");
  await proposeLesson(d, "Quokka lesson number two is about env files.", "s1");
  await settle(d, { expect: "run", ok: true, runIds: ["s1"] });
  assert.match(readFileSync(join(d.personal, "starting-apps.md"), "utf8"), /version: 3[\s\S]*Zebra[\s\S]*Quokka[\s\S]*v3: zebra lesson number one is about ports; Quokka/, "every lesson of one start is kept");
});

// ---- the whole start, with a fake brain that calls the real start tools ----

const freePort = () => new Promise<number>((r) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as { port: number }).port;
    s.close(() => r(p));
  });
});

async function fixture(name: string): Promise<{ root: string; project: ProjectInfo; port: number }> {
  const root = join(tmp, name);
  mkdirSync(root, { recursive: true });
  const port = await freePort();
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-app", scripts: { dev: "node server.mjs" } }));
  writeFileSync(join(root, "server.mjs"), `import http from "node:http";\nhttp.createServer((q, r) => r.end("<title>Fixture</title>hello")).listen(${port}, "127.0.0.1", () => console.log("listening on ${port}"));\n`);
  return { root, port, project: { root, name: "fixture-app", devCommand: "node server.mjs", routes: [], processes: [{ name: "app", command: "npm run dev" }], expectedPlaces: [] } };
}

async function runStart(scenario: string, f: Awaited<ReturnType<typeof fixture>>, d: SkillDirs & { project: string }, runner: Runner) {
  const bin = join(tmp, "claude");
  copyFileSync(join(here, "fake-brain.mjs"), bin);
  chmodSync(bin, 0o755);
  const log = join(tmp, `calls-${scenario}.jsonl`);
  Object.assign(process.env, { SHRIKE_CLAUDE_BIN: bin, FAKE_START: scenario, FAKE_PORT: String(f.port), FAKE_LOG: log });
  const plans: StartPlan[] = [];
  const proposals: string[] = [];
  const { recipes, lessons } = await discoverRecipes({ root: f.root, name: f.project.name, personal: d.personal, claude: d.claude, builtin: d.builtin });
  const register = join(tmp, "register.mjs");
  writeFileSync(register, "");
  const session = new StartSession({
    project: f.project,
    runner,
    runEnv: async () => ({ nodeAgentRegister: register, ingestUrl: "http://127.0.0.1:1", token: "t" }),
    skillDirs: () => d,
    emit: (ch, p) => {
      if (ch === "start:plan") plans.push(p as StartPlan);
      if (ch === "skill:proposal") proposals.push((p as { id: string }).id);
    },
    recipes,
    lessons,
    always: new Set(),
    pageCheck: async () => ({ title: "Fixture", text: "hello" }),
  });
  const mcp = await startMcpServer({ projectRoot: () => f.root } as unknown as ShrikeHost, { start: session });
  const ended = new Promise<void>((r) => {
    const t = setInterval(() => session.quest.done && (clearInterval(t), r()), 50);
  });
  runStartBrain({ brain: "claude-code", project: f.project, session, recipes, lessons, setupFiles: ["package.json"], mcp, promptsDir: join(repo, "prompts/agent") });
  await ended;
  await mcp.close();
  const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { resume: string | null; effort: string; tools: string; system: string; call?: string }).filter((c) => !c.call);
  return { session, plans, proposals, calls };
}

test("a whole start: plan, refused push, a failed service fixed, ready, Skill Acquired; services outlive the agent; next Run follows the skill", { timeout: 60_000 }, async () => {
  const f = await fixture("whole");
  const d = dirsFor(f.root, "whole");
  const statuses: string[] = [];
  const runner = new Runner({ onStatus: (s) => statuses.push(s.state), onOutput: () => {} });
  try {
    const first = await runStart("first", f, d, runner);
    const plan = first.session.quest.plan;
    assert.equal(plan.state, "ready", JSON.stringify(plan, null, 1));
    assert.equal(first.calls[0]!.effort, "max");
    assert.equal(first.calls[0]!.tools, "", "Claude Code's own tools stay off");
    assert.match(first.calls[0]!.system, /start agent inside Shrike/);
    assert.match(first.calls[0]!.system, /scanner guesses \(hints only[\s\S]*npm run dev/);
    assert.deepEqual(plan.steps.map((s) => s.id), ["explore-how-this-project-starts", "look", "web", "push-the-code", "skill"]);
    assert.deepEqual(plan.steps.map((s) => s.state), ["done", "done", "fixed", "skipped", "done"]);
    assert.match(plan.steps.find((s) => s.id === "push-the-code")!.detail ?? "", /won't run this.*push/);
    assert.equal(plan.steps.find((s) => s.id === "web")!.fix, "Started server.mjs, the file that exists");
    assert.deepEqual(plan.rewards?.map((r) => [r.kind, r.skillId]), [["acquired", "run-fixture-app"], ["proposed", "starting-apps"]]);
    assert.equal(plan.skillId, "run-fixture-app");
    assert.match(readFileSync(join(f.root, ".shrike/skills/run-fixture-app.md"), "utf8"), /kind: run[\s\S]*node server\.mjs/);
    assert.equal(first.proposals.length, 0, "no Keep card: learnings are drafts");
    assert.deepEqual((await listDrafts(d)).filter((x) => x.status === "pending").map((x) => [x.skillId, x.expect]), [["starting-apps", "run"]]);
    assert.equal(runner.status.state, "running");
    assert.equal(runner.status.url, `http://127.0.0.1:${f.port}/`);
    // the agent run is over; the service it started is still answering
    const web = runner.services().findLast((s) => s.name === "web")!;
    assert.equal(web.state, "running");
    assert.equal(await fetch(`http://127.0.0.1:${f.port}/`).then((r) => r.text()), "<title>Fixture</title>hello");

    // Next Run: the run skill comes first, Claude follows it and marks it used.
    await runner.stop();
    assert.ok(await groupGone(web.pid!), "stop kills the service's whole process group");
    const again = await runStart("again", f, d, runner);
    assert.equal(again.session.quest.plan.state, "ready");
    assert.equal(again.session.quest.plan.recipes![0]!.id, "shrike:run-fixture-app");
    assert.match(again.calls[0]!.system, /Your playbook[\s\S]*Run fixture-app[\s\S]*node server\.mjs/);
    assert.deepEqual(again.session.quest.plan.rewards?.map((r) => r.kind), ["used"]);
    await runner.stop();

    // Learned something: a proposal (Level up after Keep).
    const learned = await runStart("learned", f, d, runner);
    assert.deepEqual(learned.session.quest.plan.rewards?.map((r) => [r.kind, r.level]), [["proposed", 2]]);
    await runner.stop();
  } finally {
    await runner.stop();
  }
});

test("no skill at the end: nudged once in the same session; a start that can't get up fails and says why", { timeout: 60_000 }, async () => {
  const f = await fixture("nudge");
  const d = dirsFor(f.root, "nudge");
  const runner = new Runner({ onStatus: () => {}, onOutput: () => {} });
  try {
    const r = await runStart("noskill", f, d, runner);
    assert.equal(r.calls.length, 2);
    assert.equal(r.calls[1]!.resume, "fake-session");
    assert.equal(r.session.quest.plan.state, "ready");
    assert.equal(r.session.quest.plan.rewards?.[0]?.kind, "acquired");
    assert.ok(NUDGE.includes("save_run_skill"));
    await runner.stop();

    const bad = await fixture("bad");
    const failed = await runStart("fail", bad, dirsFor(bad.root, "bad"), runner);
    assert.equal(failed.session.quest.plan.state, "failed");
    assert.match(failed.session.quest.plan.error ?? "", /missing\.mjs|Cannot find|code 1/);
    assert.ok(!existsSync(join(bad.root, ".shrike/skills/run-fixture-app.md")), "no run skill from a start that didn't work");
    assert.equal(failed.calls.length, 2, "a failed start is nudged once to end with a lesson");
    assert.ok(failed.session.lessoned);
    assert.equal(runner.status.state, "error");
  } finally {
    await runner.stop();
  }
});

test("asks wait inline on the step; Always allow covers the category for later commands", async () => {
  const f = await fixture("ask");
  const always = new Set<never>();
  const plans: StartPlan[] = [];
  const runner = new Runner({ onStatus: () => {}, onOutput: () => {} });
  const s = new StartSession({
    project: f.project,
    runner,
    runEnv: async () => ({ nodeAgentRegister: "/x.mjs", ingestUrl: "http://127.0.0.1:1", token: "t" }),
    skillDirs: () => dirsFor(f.root, "ask"),
    emit: (ch, p) => ch === "start:plan" && plans.push(p as StartPlan),
    recipes: [],
    lessons: [],
    always,
    saveAlways: () => {},
  });
  const pending = s.runCommand({ title: "Seed the database", command: "npm run db:seed" });
  await new Promise((r) => setTimeout(r, 50));
  const step = s.quest.plan.steps.find((x) => x.state === "waiting_approval")!;
  assert.equal(step.ask?.category, "migrate");
  assert.equal(step.ask?.command, "npm run db:seed");
  assert.ok(s.answer(step.ask!.id, { allow: true, always: true }));
  await pending.catch(() => {}); // npm run db:seed has no script here; it ran, that's the point
  assert.ok((always as Set<string>).has("migrate"));
  assert.equal(s.quest.plan.steps.find((x) => x.id === step.id)!.ask, undefined);
  const env = s.writeEnv({ file: ".env", values: { PORT: String(f.port) }, ask: ["API_KEY"], reason: "The API needs its key" });
  await new Promise((r) => setTimeout(r, 50));
  const envStep = s.quest.plan.steps.find((x) => x.ask?.kind === "env")!;
  assert.deepEqual(envStep.ask?.keys, ["API_KEY"]);
  s.answer(envStep.ask!.id, { allow: true, values: { API_KEY: "sk-secret" } });
  const said = await env;
  assert.doesNotMatch(said, /sk-secret/);
  assert.equal(readFileSync(join(f.root, ".env"), "utf8"), `PORT=${f.port}\nAPI_KEY=sk-secret\n`);
  assert.match(await s.envStatus({}), /keys set in \.env: API_KEY, PORT/);
  // review: a service command Shrike can't read asks first, and "Always allow" isn't offered for it
  const canary = join(f.root, "canary.txt");
  const svc = s.startService({ name: "canary", command: `bash -lc 'echo bypassed > canary.txt; sleep 300'` });
  await new Promise((r) => setTimeout(r, 50));
  const svcStep = s.quest.plan.steps.find((x) => x.state === "waiting_approval")!;
  assert.equal(svcStep.ask?.command, `bash -lc 'echo bypassed > canary.txt; sleep 300'`);
  assert.ok(!existsSync(canary), "nothing ran before the user answered");
  s.answer(svcStep.ask!.id, { allow: false });
  await assert.rejects(svc, /said no/);
  await assert.rejects(s.startService({ name: "rm", command: "/bin/rm -rf ~" }), /Not allowed/);
  assert.ok(!existsSync(canary));
  // a retried start_service (same name and command) reports on the running one instead of refusing (seen on xyne-spaces)
  const infra = { name: "infra", command: "sleep 30", instrument: false, waitSec: 1 };
  const first = await s.startService(infra);
  assert.match(first, /Started "infra"/);
  assert.match(await s.startService(infra), /already (starting|running) from your earlier start_service/);
  assert.equal(runner.services().filter((x) => x.name === "infra" && (x.state === "starting" || x.state === "running")).length, 1);
  await runner.stopService("infra");
  // a question outlives a tool call (Claude Code gives up after ~5 min): the call returns, the question stays, a re-call waits on it
  s.askWaitMs = 100;
  const note = { title: "Write a note", command: "echo hi > note.txt" };
  await assert.rejects(s.runCommand(note), /hasn't answered "Write a note\?" yet; it stays on screen and nothing ran/);
  const open = s.quest.plan.steps.find((x) => x.ask?.command === note.command)!;
  assert.ok(open.ask && !existsSync(join(f.root, "note.txt")));
  s.askWaitMs = 5000;
  const again = s.runCommand(note);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.quest.plan.steps.filter((x) => x.ask).length, 1, "the same question, not a second one");
  assert.ok(s.answer(open.ask.id, { allow: true }));
  assert.equal(s.quest.plan.steps.find((x) => x.id === open.id)!.ask, undefined, "answered: gone from the screen at once");
  await again;
  assert.ok(existsSync(join(f.root, "note.txt")));
  s.stop();
});

test("W2: in a worktree a declared port is moved by the offset, and a moved one isn't moved again", async () => {
  const f = await fixture("wt");
  const runner = new Runner({ onStatus: () => {}, onOutput: () => {} });
  runner.offsetFor = () => 100;
  const s = new StartSession({
    project: { ...f.project, appUrl: `http://localhost:${f.port}` },
    runner,
    runEnv: async () => ({ nodeAgentRegister: "/x.mjs", ingestUrl: "http://127.0.0.1:1", token: "t" }),
    skillDirs: () => dirsFor(f.root, "wt"),
    emit: () => {},
    recipes: [],
    lessons: [],
    always: new Set(),
    saveAlways: () => {},
  });
  const moved = `localhost:${f.port + 100}`;
  assert.match(await s.checkHealth({ target: `http://localhost:${f.port}/`, timeoutSec: 1 }), new RegExp(moved));
  assert.match(await s.checkHealth({ target: `tcp:${f.port}`, timeoutSec: 1 }), new RegExp(`${f.port + 100}`));
  assert.doesNotMatch(await s.checkHealth({ target: `http://${moved}/`, timeoutSec: 1 }), new RegExp(`${f.port + 200}`));
  s.stop();
});

test("project switch: the last project's services, killed by Shrike, don't fail the next start's app_ready; reset forgets them", { timeout: 30_000 }, async () => {
  const runner = new Runner({ onStatus: () => {}, onOutput: () => {} });
  const session = async (name: string) => {
    const f = await fixture(name);
    return new StartSession({ project: f.project, runner, runEnv: async () => ({ nodeAgentRegister: "/x.mjs", ingestUrl: "http://127.0.0.1:1", token: "t" }), skillDirs: () => dirsFor(f.root, name), emit: () => {}, recipes: [], lessons: [], always: new Set(), saveAlways: () => {} });
  };
  const a = await session("switch-a");
  await a.startService({ name: "cron", command: "sleep 30", instrument: false, waitSec: 1 });
  a.stop();
  await runner.stop();
  assert.deepEqual(runner.services().map((s) => [s.name, s.state, s.exitCode]), [["cron", "stopped", null]], "killed by a signal: no exit code");
  const b = await session("switch-b");
  await b.startService({ name: "api", command: "sleep 30", instrument: false, waitSec: 1 });
  assert.doesNotMatch(await b.appReady({}).catch((e: Error) => e.message), /cron/);
  b.stop();
  await runner.stop();
  runner.reset();
  assert.deepEqual(runner.services(), []);
  assert.deepEqual(runner.status, { state: "idle" });
});
