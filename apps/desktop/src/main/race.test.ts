import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProjectInfo, Race } from "@shrike/schema";
import { sendRequest } from "./http-send.ts";
import { proposePatch } from "./patches.ts";
import * as race from "./race.ts";
import { Runner } from "./runner.ts";
import { Store } from "./store.ts";
import { git, listWorktrees } from "./worktrees.ts";

const until = async (ok: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  assert.ok(ok(), "timed out");
};

test("trips survive a worktree switch; a re-run request leaves redacted headers out", async () => {
  const a = new Store({ projectRoot: () => "/p", onUpdate: () => {} });
  const s = createServer((q, r) => r.writeHead(q.url === "/bad" ? 500 : 200).end("x")).listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  const base = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  try {
    await sendRequest(a, { method: "POST", url: "/bad", headers: { authorization: "Bearer secret-token-123", "x-kind": "demo" }, body: "{}" }, base, "explorer").catch(() => {});
    await until(() => a.listActions().some((v) => v.complete));
    const before = a.listActions();
    const b = new Store({ projectRoot: () => "/p", onUpdate: () => {} });
    race.restoreTrips(b, race.tripEvents(before));
    await until(() => b.listActions().every((v) => v.complete));
    const after = b.listActions();
    assert.deepEqual(after.map((v) => [v.id, v.label, v.status, v.tree.length]), before.map((v) => [v.id, v.label, v.status, v.tree.length]));
    assert.deepEqual(race.firstRequest(after[0]!), { method: "POST", url: "/bad", headers: { "x-kind": "demo", "content-type": "application/json" }, body: "{}" });
    assert.match(race.candidateGoal(after[0]!, race.APPROACHES[1]!.hint, 1), /one of 2 agents[\s\S]*at the callee[\s\S]*POST \/bad/);
  } finally {
    s.close();
  }
  assert.equal(race.clickedName('Clicked "Pay now"'), "Pay now");
});

test("W2+W4: a sandbox fix runs in its own worktree on shifted ports, goes green, comes over on approval and cleans up", async (t) => {
  const main = realpathSync(mkdtempSync(join(tmpdir(), "shrike-race-")));
  const probe = createServer().listen(0, "127.0.0.1");
  await new Promise((r) => probe.once("listening", r));
  const port = (probe.address() as { port: number }).port;
  probe.close();
  mkdirSync(join(main, ".shrike"));
  writeFileSync(join(main, ".shrike/config.json"), JSON.stringify({ processes: [{ name: "api", command: "node server.mjs", url: `http://127.0.0.1:${port}/health` }] }));
  writeFileSync(join(main, "calc.mjs"), "export const ok = false;\n");
  writeFileSync(join(main, "server.mjs"), `import http from "node:http"; import { ok } from "./calc.mjs";\nhttp.createServer((q, r) => r.writeHead(q.url === "/health" || ok ? 200 : 500).end(process.env.API_PORT)).listen(Number(process.env.API_PORT), "127.0.0.1");\n`);
  writeFileSync(join(main, "none.mjs"), "");
  await git(main, ["init", "-q"]);
  await git(main, ["add", "-A"]);
  await git(main, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);

  const races: Race[] = [];
  const store = new Store({ projectRoot: () => main, onUpdate: () => {} });
  const runner = new Runner({ onStatus: () => {}, onOutput: () => {} });
  const project: ProjectInfo = { root: main, name: "t", devCommand: "x", routes: [], processes: [{ name: "api", command: "node server.mjs", url: `http://127.0.0.1:${port}/health` }], expectedPlaces: [] };
  const asked: string[] = [];
  race.init({
    emit: (ch, payload) => void (ch === "race:update" && races.push(payload as Race)),
    getProject: () => project,
    openProject: async () => project,
    run: () => runner.start(project, { nodeAgentRegister: join(main, "none.mjs"), ingestUrl: "http://127.0.0.1:1", token: "t" }),
    runner,
    store,
    requestApproval: async (req) => (asked.push(req.title), true),
    rejectWithFeedback: () => true,
    makeView: () => Promise.reject(new Error("no page")),
    nodeAgentRegister: join(main, "none.mjs"),
    promptsDir: "/none",
    skillsDir: "/none",
  });
  t.after(async () => {
    await race.stopAllSessions();
    await runner.stop();
  });

  await runner.start(project, { nodeAgentRegister: join(main, "none.mjs"), ingestUrl: "http://127.0.0.1:1", token: "t" });
  await until(() => runner.status.state === "running");
  const broke = await sendRequest(store, { method: "GET", url: "/pay" }, `http://127.0.0.1:${port}`, "explorer");
  assert.equal(broke.response.status, 500);
  await until(() => !!store.getAction(broke.actionId)?.complete);

  let sandbox: Race | undefined;
  await proposePatch(
    { root: main, waitForServerHello: async () => true, onUpdate: () => {}, requestApproval: async (req) => ((sandbox = await race.trySandbox(req.patch!.id, broke.actionId)), false) },
    [{ path: "calc.mjs", edits: [{ oldText: "false", newText: "true" }] }],
    "ok must be true",
  );
  assert.equal(sandbox?.kind, "sandbox");
  const name = sandbox!.candidates[0]!.worktree;
  await until(() => races.at(-1)?.candidates[0]?.state === "green" || races.at(-1)?.candidates[0]?.state === "red" || races.at(-1)?.candidates[0]?.state === "failed", 40_000);
  const done = races.at(-1)!.candidates[0]!;
  assert.equal(done.state, "green", done.summary);
  assert.equal(done.rerun?.status, "ok");
  assert.equal(await (await fetch(`http://127.0.0.1:${port + 100}/pay`)).text(), String(port + 100), "the sandbox app answers on its own port");
  assert.equal((await fetch(`http://127.0.0.1:${port}/pay`)).status, 500, "your own run is untouched");
  assert.equal(readFileSync(join(main, "calc.mjs"), "utf8"), "export const ok = false;\n");

  const list = await race.listWorktrees();
  assert.deepEqual(list.map((w) => [w.name, w.current, w.running, w.portOffset]), [["main", true, true, 0], [name, false, true, 100]]);

  await race.adoptWorktreeFix(name);
  assert.match(asked.at(-1)!, new RegExp(`Bring the fix from ${name}`));
  assert.equal(readFileSync(join(main, "calc.mjs"), "utf8"), "export const ok = true;\n");

  const n = asked.length;
  await race.removeWorktree(name);
  assert.equal(asked.length, n, "nothing unmerged, so no question");
  assert.deepEqual((await listWorktrees(main)).map((w) => w.name), ["main"]);
});

test("W1: a project in a subfolder of its repo (monorepo) keeps that subfolder in every worktree tab", async () => {
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "shrike-mono-")));
  const root = join(repoRoot, "todo-app");
  mkdirSync(root);
  writeFileSync(join(root, "a.js"), "1\n");
  await git(repoRoot, ["init", "-q"]);
  await git(repoRoot, ["add", "-A"]);
  await git(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  const project: ProjectInfo = { root, name: "t", devCommand: "x", routes: [], processes: [], expectedPlaces: [] };
  const runner = new Runner({ onStatus: () => {}, onOutput: () => {} });
  race.init({
    emit: () => {},
    getProject: () => project,
    openProject: async () => project,
    run: async () => runner.status,
    runner,
    store: new Store({ projectRoot: () => root, onUpdate: () => {} }),
    requestApproval: async () => true,
    rejectWithFeedback: () => true,
    makeView: () => Promise.reject(new Error("no page")),
    nodeAgentRegister: "/none",
    promptsDir: "/none",
    skillsDir: "/none",
  });
  const w = await race.createWorktree("try-a");
  assert.equal(w.path, join(repoRoot, ".shrike/worktrees/try-a/todo-app"));
  assert.deepEqual((await race.listWorktrees()).map((x) => [x.name, x.current, x.path]), [["main", true, root], ["try-a", false, w.path]]);
  await race.removeWorktree("try-a");
});
