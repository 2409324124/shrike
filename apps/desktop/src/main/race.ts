// W1–W5 orchestration: per-worktree runs (W2), switching (W1), fix race (W3), sandbox fix (W4), clean up (W5).
// No Electron imports: index wiring passes the Electron bits in through init().
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionView, AgentRunInfo, ApprovalRequest, BrainId, DebugEvent, IngestMessage, Patch, ProjectInfo, Race, RunStatus, ShrikeEvents, ShrikeHost, TimelineNode, Worktree } from "@shrike/schema";
import { detectBrains, startAgentRun } from "@shrike/agent";
import { formatActionTree } from "@shrike/correlator";
import { startMcpServer } from "@shrike/mcp-server";
import { detectProject } from "@shrike/scanner";
import * as files from "./files.ts";
import { sendRequest as sendHttp } from "./http-send.ts";
import { startIngest, type Ingest } from "./ingest.ts";
import { applyEdits, checkPatchPath, getPatch, settle, type Edit } from "./patches.ts";
import { responds, Runner, shiftUrl } from "./runner.ts";
import { randomHex, SERVER_OUTPUT_ID, Store } from "./store.ts";
import * as wt from "./worktrees.ts";

type Emit = <K extends keyof ShrikeEvents>(channel: K, payload: ShrikeEvents[K]) => void;

export interface PageView {
  load(url?: string): Promise<void>;
  snapshot(): ReturnType<ShrikeHost["appSnapshot"]>;
  click(ref: string): Promise<string | null>;
  type(ref: string, text: string, submit?: boolean): Promise<string | null>;
  currentUrl(): string | undefined;
}

export interface RaceDeps {
  emit: Emit;
  getProject(): ProjectInfo | null;
  openProject(root: string): Promise<ProjectInfo>;
  run(): Promise<RunStatus>;
  runner: Runner; // the run shown in the app pane
  store: Store; // its trips
  requestApproval(req: Omit<ApprovalRequest, "id">): Promise<boolean>;
  rejectWithFeedback(patchId: string, text: string): boolean;
  makeView(onMessage: (msg: IngestMessage) => void): Promise<{ view: PageView; close(): void }>; // a hidden page for a worktree's app
  nodeAgentRegister: string;
  pythonAgent?: string;
  promptsDir: string;
  skillsDir: string;
}

/** A worktree's app running in the background, with its own trips and its own MCP server for agents working there. */
interface Session {
  name: string;
  main: string; // the repo's main checkout: sessions of another repo stop when it opens
  root: string;
  project: ProjectInfo;
  serverUrl?: string;
  runner: Runner;
  store: Store;
  ingest: Ingest;
  page?: { view: PageView; close(): void };
  mcp?: { url: string; token: string; close(): Promise<void> };
  helloAt: number;
}

let d: RaceDeps | undefined;
const sessions = new Map<string, Session>(); // by worktree project path, so two repos' "try-a" never mix
const stash = new Map<string, DebugEvent[]>(); // trips of worktrees not on screen, by worktree path
const offsets = new Map<string, number>(); // worktree path -> port offset
const races = new Map<string, Race>();

export function init(deps: RaceDeps): void {
  d = deps;
  // W2: the shown run uses the offset of whichever worktree is open.
  deps.runner.offsetFor = (root) => offsets.get(root) ?? 0;
}

const deps = (): RaceDeps => {
  if (!d) throw new Error("Worktrees aren't ready yet.");
  return d;
};

function project(): ProjectInfo {
  const p = deps().getProject();
  if (!p) throw new Error("No project is open.");
  return p;
}

/** The repo's main checkout, and where the project sits in it ("" at the root, "apps/web" in a monorepo). */
async function repo(): Promise<{ main: string; sub: string }> {
  const root = project().root;
  const main = await wt.mainRoot(root);
  const sub = (await wt.git(root, ["rev-parse", "--show-prefix"])).trim().replace(/\/$/, "");
  return { main, sub };
}
const mainOf = async () => (await repo()).main;
const inSub = <T extends { path: string }>(w: T, sub: string): T => (sub ? { ...w, path: join(w.path, sub) } : w);
const alive = (s: RunStatus) => s.state === "starting" || s.state === "running";

/** W2: the project's own ports, so worktree offsets never land on one of them. */
function portsOf(p: ProjectInfo): number[] {
  const server = readConfig(p.root).serverUrl;
  const port = (u: string | undefined) => {
    try {
      return u ? Number(new URL(u).port) : 0;
    } catch {
      return 0;
    }
  };
  return [p.appUrl, ...(p.processes ?? []).map((q) => q.url), typeof server === "string" ? server : undefined].map(port).filter((n) => n > 0);
}

export async function listWorktrees(): Promise<Worktree[]> {
  const root = project().root;
  const { main, sub } = await repo();
  const list = (await wt.listWorktrees(main)).map((w) => inSub(w, sub));
  for (const w of list) offsets.set(w.path, w.portOffset);
  return list.map((w) => {
    const current = w.path === root;
    const s = sessions.get(w.path);
    return { ...w, current, running: current ? alive(deps().runner.status) : !!s && alive(s.runner.status) };
  });
}

/** A folder opened in the app pane: its own background run steps aside. Other projects' runs keep going (the workspaces rail shows and stops them). */
export async function projectOpened(root: string): Promise<void> {
  const s = sessions.get(root);
  if (s) await stopSession(s);
}

/** WS1: the background run of a folder, for the rail's dots. */
export const backgroundStatus = (path: string): RunStatus | undefined => sessions.get(path)?.runner.status;

export async function stopBackground(path: string): Promise<void> {
  const s = sessions.get(path);
  if (s) await stopSession(s);
}

/** WS2: a project's own ports, so a new worktree's offset never lands on one. */
export const portsFor = async (root: string): Promise<number[]> => portsOf(await detectProject(root));

async function publish(): Promise<void> {
  try {
    deps().emit("worktrees:update", await listWorktrees());
  } catch {} // not a git repo: no tabs
}

export async function createWorktree(name: string, note?: string): Promise<Worktree> {
  const { main, sub } = await repo();
  const w = inSub(await wt.createWorktree(main, name, note, portsOf(project())), sub);
  offsets.set(w.path, w.portOffset);
  void publish();
  return { ...w, current: false, running: false };
}

// ---- trips per worktree ----

export function tripEvents(views: ActionView[]): DebugEvent[] {
  const out: DebugEvent[] = [];
  const walk = (n: TimelineNode[]) => n.forEach((x) => (out.push(x.event), walk(x.children)));
  for (const v of views) if (v.id !== SERVER_OUTPUT_ID) (out.push(v.root), walk(v.tree));
  return out;
}

export function restoreTrips(store: Store, events: DebugEvent[]): void {
  if (!events.length) return;
  store.handle({ type: "events", events });
  for (const e of events) if (e.kind === "user_action" && !e.parentId) store.handle({ type: "action_end", actionId: e.id, at: Date.now() });
}

/** W1: show another worktree: its code, its run and its trips. A running worktree you leave keeps running in the background. */
export async function switchWorktree(name: string): Promise<ProjectInfo> {
  const to = (await listWorktrees()).find((w) => w.name === name);
  if (!to) throw new Error(`There's no worktree called ${name}.`);
  return switchTo(to.path, to.portOffset);
}

/** WS1: show any folder (a worktree of this repo or another project). The one you leave keeps running in the background on its own ports. */
export async function switchTo(path: string, portOffset = 0): Promise<ProjectInfo> {
  const x = deps();
  const cur = x.getProject();
  if (cur?.root === path) return cur;
  offsets.set(path, portOffset);
  const from = cur && { name: cur.root.split("/").pop()!, path: cur.root, portOffset: offsets.get(cur.root) ?? 0 };
  const to = { path };
  const wasRunning = alive(x.runner.status);
  if (from) stash.set(from.path, tripEvents(x.store.listActions()));
  const bg = sessions.get(to.path);
  const targetRunning = !!bg && alive(bg.runner.status);
  if (bg) {
    stash.set(to.path, [...(stash.get(to.path) ?? []), ...tripEvents(bg.store.listActions())]);
    await stopSession(bg);
  }
  const p = await x.openProject(to.path);
  restoreTrips(x.store, stash.get(to.path) ?? []);
  stash.delete(to.path);
  if (from && wasRunning) void startSession(from).catch(() => {});
  if (targetRunning) void x.run();
  void publish();
  return p;
}

// ---- background runs (W2) ----

async function startSession(w: Pick<Worktree, "name" | "path" | "portOffset">): Promise<Session> {
  const x = deps();
  const have = sessions.get(w.path);
  if (have) return have;
  const main = await wt.mainRoot(w.path).catch(() => w.path); // WS1: a project that isn't a git repo runs in the background too
  const p = await detectProject(w.path);
  const config = readConfig(w.path);
  const serverUrl = typeof config.serverUrl === "string" ? config.serverUrl : p.appUrl ? undefined : p.processes.find((q) => q.url)?.url;
  const declared = p.declaredPlaces && Object.fromEntries(Object.entries(p.declaredPlaces).map(([k, v]) => [shiftUrl(`http://${k}`, w.portOffset)!.slice(7), v]));
  const s = { name: w.name, main, root: w.path, project: p, serverUrl: shiftUrl(serverUrl, w.portOffset), helloAt: 0 } as Session;
  const onHello = (m: Extract<IngestMessage, { type: "hello" }>) => {
    if (m.source !== "server") return;
    s.helloAt = Date.now();
    s.runner.setInstrumented(m.place?.id);
  };
  s.store = new Store({ projectRoot: () => w.path, projectName: () => p.name, declaredPlaces: () => declared, onUpdate: () => {}, onHello });
  s.ingest = await startIngest((m) => s.store.handle(m));
  let was: RunStatus["state"] = "idle";
  const onStatus = (st: RunStatus) => {
    if (st.state === was) return;
    was = st.state;
    void publish();
  };
  s.runner = new Runner({ onStatus, onOutput: () => {} });
  s.runner.offsetFor = () => w.portOffset;
  sessions.set(w.path, s);
  try {
    await s.runner.start(p, { nodeAgentRegister: x.nodeAgentRegister, pythonAgent: x.pythonAgent, ingestUrl: s.ingest.url, token: s.ingest.token, serverUrl });
    const deadline = Date.now() + 60_000;
    while (s.runner.status.state === "starting" && Date.now() < deadline) await sleep(250);
    if (s.runner.status.state !== "running") throw new Error(`${w.name} didn't start: ${s.runner.status.error ?? "it took too long"}`);
    if (s.runner.status.url) {
      s.page = await x.makeView((m) => s.store.handle(m));
      const url = s.runner.status.url;
      await Promise.race([s.page.view.load(url), sleep(30_000).then(() => Promise.reject(new Error(`${w.name}'s page didn't open at ${url} within 30 seconds.`)))]);
    }
  } catch (err) {
    await stopSession(s);
    throw err;
  }
  return s;
}

async function stopSession(s: Session): Promise<void> {
  if (sessions.get(s.root) === s) sessions.delete(s.root);
  s.page?.close();
  await Promise.allSettled([s.runner.stop(), s.ingest.close(), s.mcp?.close()]);
  void publish();
}

export async function stopAllSessions(): Promise<void> {
  await Promise.allSettled([...sessions.values()].map(stopSession));
}

export function killAllSessions(): void {
  for (const s of sessions.values()) s.runner.killNow();
}

function readConfig(root: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(`${root}/.shrike/config.json`, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- the worktree's own MCP host: tools act on that copy only ----

function worktreeHost(s: Session, failing: ActionView | undefined, onPatched: (patchId: string, paths: string[]) => void): ShrikeHost {
  const page = () => {
    if (!s.page) throw new Error("This worktree's app has no page.");
    return s.page.view;
  };
  return {
    projectRoot: () => s.root,
    listActions: () => [...(failing ? [failing] : []), ...s.store.listActions()],
    getAction: (id) => s.store.getAction(id) ?? (id === failing?.id ? failing : undefined),
    getEvent: (id) => s.store.getEvent(id) ?? (failing ? tripEvents([failing]).find((e) => e.id === id) : undefined),
    searchEvents: (q) => s.store.searchEvents(q),
    listFiles: () => files.listFiles(s.root),
    readFile: (path) => files.readFile(s.root, path),
    searchCode: (q, glob) => files.searchCode(s.root, q, glob),
    listRoutes: () => s.project.routes,
    sendRequest: (req) => sendHttp(s.store, req, s.serverUrl ?? s.runner.status.url, "agent"),
    appSnapshot: () => page().snapshot(),
    appClick: async (ref) => ({ actionId: await page().click(ref) }),
    appType: async (ref, text, submit) => ({ actionId: await page().type(ref, text, submit) }),
    appNavigate: async (url) => {
      const base = s.runner.status.url;
      if (!base) throw new Error("This worktree's app isn't running.");
      const target = new URL(url, page().currentUrl() ?? base);
      if (target.origin !== new URL(base).origin) throw new Error(`Only pages of this app (${new URL(base).origin}) can be opened.`);
      const next = s.store.nextAction((r) => r.trigger === "navigation", 10_000);
      await page().load(target.href);
      return { actionId: await next };
    },
    waitForAction: (id, ms) => s.store.waitForAction(id, ms),
    requestApproval: async () => true, // pre-approved by "Let both try": only this worktree's own copy of the app
    proposePatch: async (list) => {
      const paths = await applyInWorktree(s, list);
      const patchId = randomHex(8);
      onPatched(patchId, paths);
      return { patchId, status: "applied" };
    },
    revertPatch: async () => {
      throw new Error("In a race, propose a new patch instead of reverting.");
    },
    reportFindings: () => {},
    remember: async (note) => ({ id: randomHex(8), ...note, createdAt: Date.now(), by: "agent" }), // ponytail: not saved; the worktree is temporary
    noteWatch: () => {},
  };
}

async function applyInWorktree(s: Session, list: { path: string; edits: Edit[] }[]): Promise<string[]> {
  const changes: { path: string; after: string }[] = [];
  for (const f of list) {
    const path = f.path.replace(/\\/g, "/").replace(/^\.\//, "");
    checkPatchPath(path);
    changes.push({ path, after: applyEdits(path, await files.readFile(s.root, path), f.edits) });
  }
  const since = Date.now();
  for (const c of changes) await files.writeFile(s.root, c.path, c.after);
  await settle({ waitForServerHello: (t, ms) => waitHello(s, t, ms) }, changes.map((c) => c.path), since);
  return changes.map((c) => c.path);
}

async function waitHello(s: Session, since: number, ms: number): Promise<boolean> {
  const deadline = since + ms;
  while (s.helloAt <= since && Date.now() < deadline) await sleep(100);
  const url = s.serverUrl ?? s.project.processes.map((p) => shiftUrl(p.url, offsets.get(s.root) ?? 0)).find(Boolean);
  while (url && Date.now() < deadline && !(await responds(url))) await sleep(100);
  return s.helloAt > since;
}

/** For startAgentWith(opts.worktree): the folder and MCP server an agent working in that worktree should use. Starts its app. */
export async function worktreeAgentTarget(name: string): Promise<{ cwd: string; mcp: { url: string; token: string } }> {
  const w = (await listWorktrees()).find((x) => x.name === name);
  if (!w) throw new Error(`There's no worktree called ${name}.`);
  const s = await startSession(w);
  s.mcp ??= await startMcpServer(worktreeHost(s, undefined, () => {}), { skillsDir: deps().skillsDir });
  return { cwd: s.root, mcp: s.mcp };
}

// ---- re-run the broken trip in a worktree ----

const CLEAN = /^(traceparent|host|content-length|connection)$/i;

/** The request a trip started with, ready to send again (redacted headers left out). */
export function firstRequest(view: ActionView): { method: string; url: string; headers: Record<string, string>; body?: string } | undefined {
  const e = tripEvents([view]).find((x) => x.kind === "http_request" && x.http);
  if (!e?.http) return undefined;
  const headers = Object.fromEntries(Object.entries(e.http.reqHeaders ?? {}).filter(([k, v]) => !CLEAN.test(k) && !v.startsWith("[redacted")));
  return { method: e.http.method, url: e.http.url, headers, ...(e.http.reqBody !== undefined ? { body: e.http.reqBody } : {}) };
}

/** What a click trip clicked: `Clicked "Pay now"` -> "Pay now". */
export const clickedName = (label: string) => /"(.+)"/.exec(label)?.[1];

async function rerun(s: Session, view: ActionView): Promise<ActionView | undefined> {
  const page = s.page?.view;
  let id: string | null = null;
  if ((view.trigger === "click" || view.trigger === "submit") && page) {
    const name = clickedName(view.label)?.toLowerCase();
    // A page loaded while a patched server restarts may not render the button yet: load again, up to 3 times.
    for (let load = 0; load < 3 && !id; load++) {
      await page.load(s.runner.status.url);
      for (let i = 0; i < 40 && !id; i++) {
        const el = (await page.snapshot().catch(() => undefined))?.elements.find((e) => e.name.toLowerCase() === name);
        if (el) id = await page.click(el.ref);
        else await sleep(250);
      }
    }
  } else if (view.trigger === "navigation" && page) {
    const next = s.store.nextAction((r) => r.trigger === "navigation", 10_000);
    await page.load(s.runner.status.url);
    id = await next;
  } else {
    const req = firstRequest(view);
    if (req) id = (await sendHttp(s.store, req, s.serverUrl ?? s.runner.status.url, "agent").catch(() => undefined))?.actionId ?? null;
  }
  return id ? s.store.waitForAction(id, 20_000) : undefined;
}

// ---- W3 fix race ----

export const APPROACHES = [
  { tab: "try-sender", label: "fix where the value is sent", hint: "Fix it at the caller: change the code that sends or passes the bad value, so it sends what the receiving side expects." },
  { tab: "try-receiver", label: "fix where the value is received", hint: "Fix it at the callee: change the code that receives the value, so it accepts or converts what it gets." },
  { tab: "try-source", label: "fix where the value is made", hint: "Fix it where the value is made or stored, so every reader gets the right thing." },
];

export function candidateGoal(view: ActionView, hint: string, others: number): string {
  return [
    `The trip "${view.label}" broke. You are one of ${others + 1} agents each trying a different fix in its own copy of the code (a git worktree), so try exactly this approach:`,
    hint,
    "Your patches are applied in your copy right away, and nothing touches the user's own code. Read the code, call propose_patch once with the smallest fix for this approach, then re-run the trip with run_scenario (or send_request for an API call) to check it, and finish with one line saying whether it worked.",
    `The broken trip:\n${formatActionTree(view, { includeIds: true })}`,
  ].join("\n\n");
}

function emitRace(r: Race): void {
  deps().emit("race:update", structuredClone(r));
}

async function pickBrain(): Promise<BrainId> {
  const brains = await detectBrains();
  const b = brains.find((x) => x.id === "claude-code" && x.available) ?? brains.find((x) => x.available);
  if (!b) throw new Error("No agent is available. Install Claude Code, or set ANTHROPIC_API_KEY.");
  return b.id;
}

export async function startRace(actionId: string, n = 2): Promise<Race> {
  const x = deps();
  const view = x.store.getAction(actionId);
  if (!view) throw new Error("That trip isn't in this session anymore.");
  const count = Math.max(2, Math.min(APPROACHES.length, Math.round(n)));
  const { main, sub } = await repo();
  const ports = portsOf(project());
  const brain = await pickBrain();
  const tag = randomHex(2);
  const picks = APPROACHES.slice(0, count);
  const ok = await x.requestApproval({
    kind: "request",
    title: count === 2 ? "Let both try?" : `Let all ${count} try?`,
    reason: `Shrike makes ${count} copies of your code (worktrees) and your agent tries a different fix in each: ${picks.map((p) => p.label).join(", then ")}. Their changes and requests stay in those copies. Your own code isn't touched until you pick one.`,
  });
  if (!ok) throw new Error("Okay, no race. Nothing was changed.");
  const race: Race = { id: randomHex(8), actionId, candidates: picks.map((p) => ({ worktree: `${p.tab}-${tag}`, approach: p.label, state: "thinking" })) };
  races.set(race.id, race);
  emitRace(race);
  for (const [i, c] of race.candidates.entries()) void runCandidate(race, c, { main, sub, ports }, view, brain, candidateGoal(view, picks[i]!.hint, count - 1));
  return structuredClone(race);
}

async function runCandidate(race: Race, c: Race["candidates"][number], r: { main: string; sub: string; ports: number[] }, view: ActionView, brain: BrainId, goal: string): Promise<void> {
  const x = deps();
  const set = (patch: Partial<typeof c>) => (Object.assign(c, patch), emitRace(race));
  try {
    const w = inSub(await wt.createWorktree(r.main, c.worktree, `race: ${c.approach}`, r.ports), r.sub);
    offsets.set(w.path, w.portOffset);
    void publish();
    const s = await startSession(w);
    let patched = false;
    s.mcp = await startMcpServer(worktreeHost(s, view, (patchId, paths) => ((patched = true), set({ state: "patched", patchId, files: paths }))), { skillsDir: x.skillsDir });
    const finished = new Promise<AgentRunInfo["status"]>((resolve) => {
      startAgentRun({
        goal,
        brain,
        cwd: s.root,
        mcp: { url: s.mcp!.url, token: s.mcp!.token },
        context: { frontend: s.project.frontend, backend: s.project.backend, appUrl: s.runner.status.url, routeCount: s.project.routes.length, recentActions: formatActionTree(view, { includeIds: true }) },
        onStep: (step) => {
          x.emit("race:step", step); // X7 (xray): the card's live X-ray; kept off "agent:step" so the agent column ignores it
          if (step.kind === "done") set({ summary: (step.summary ?? step.text).split("\n")[0] });
        },
        onStatus: (info) => (info.status === "running" ? c.runId !== info.id && set({ runId: info.id }) : resolve(info.status)),
        promptsDir: x.promptsDir,
      });
    });
    const status = await finished;
    if (!patched) return set({ state: "failed", summary: c.summary ?? (status === "failed" ? "The agent ran into a problem." : "The agent didn't propose a fix.") });
    set({ state: "rerunning" });
    const again = await rerun(s, view);
    set({ state: again && again.status !== "error" ? "green" : "red", rerunActionId: again?.id, rerun: again });
  } catch (err) {
    set({ state: "failed", summary: (err as Error).message });
  }
}

// ---- W4 sandbox fix ----

export async function trySandbox(patchId: string, actionId?: string): Promise<Race> {
  const x = deps();
  const patch = getPatch(patchId);
  if (!patch) throw new Error("That fix isn't here anymore.");
  const view = actionId ? x.store.getAction(actionId) : x.store.listActions().findLast((v) => v.status === "error" && v.id !== SERVER_OUTPUT_ID);
  const { main, sub } = await repo();
  const name = `sandbox-${randomHex(2)}`;
  const w = inSub(await wt.createWorktree(main, name, "sandbox fix", portsOf(project())), sub);
  offsets.set(w.path, w.portOffset);
  for (const f of patch.files) {
    if ((await files.readFile(w.path, f.path).catch(() => "")) !== f.before) {
      await wt.removeWorktree(main, name);
      throw new Error(`${f.path} isn't the same in the sandbox as when the fix was written, so Shrike didn't try it.`);
    }
    await files.writeFile(w.path, f.path, f.after);
  }
  x.rejectWithFeedback(patchId, "The user is trying this fix in a sandbox worktree first and will bring it over if it works. Don't propose it again; stop here.");
  const race: Race = { id: randomHex(8), kind: "sandbox", actionId: view?.id ?? "", candidates: [{ worktree: name, approach: "sandbox", state: "patched", patchId, files: patch.files.map((f) => f.path) }] };
  races.set(race.id, race);
  emitRace(race);
  void publish();
  const c = race.candidates[0]!;
  void (async () => {
    try {
      const s = await startSession(w);
      if (!view) return (Object.assign(c, { state: "green", summary: "Applied in the sandbox. There was no broken trip to re-run." }), emitRace(race));
      Object.assign(c, { state: "rerunning" });
      emitRace(race);
      const again = await rerun(s, view);
      Object.assign(c, { state: again && again.status !== "error" ? "green" : "red", rerunActionId: again?.id, rerun: again });
    } catch (err) {
      Object.assign(c, { state: "failed", summary: (err as Error).message });
    }
    emitRace(race);
  })();
  return structuredClone(race);
}

// ---- adopt (W3/W4) and remove (W5) ----

function preview(main: string, path: string, rel: string[]): Patch["files"] {
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  return rel.slice(0, 20).map((f) => ({ path: f, before: read(`${main}/${f}`), after: read(`${path}/${f}`) }));
}

export async function adoptWorktreeFix(name: string): Promise<void> {
  const x = deps();
  const { main, sub } = await repo();
  // a race or sandbox fix brings over only the files its patch changed, not what the app wrote while it ran there
  const fixed = [...races.values()].flatMap((r) => r.candidates).find((c) => c.worktree === name)?.files?.map((f) => (sub ? `${sub}/${f}` : f));
  const rel = (await wt.unmergedFiles(main, name)).filter((f) => !fixed || fixed.includes(f));
  if (!rel.length) throw new Error(`${name} has nothing your code doesn't already have.`);
  const patch: Patch = { id: `adopt-${name}`, files: preview(main, wt.worktreePath(main, name), rel), rationale: `The fix from ${name}.`, status: "proposed" };
  const ok = await x.requestApproval({ kind: "patch", title: `Bring the fix from ${name} into your code?`, reason: `Shrike changes ${rel.join(", ")} in your own checkout. Nothing is committed or pushed.`, patch });
  if (!ok) return;
  await wt.adoptFix(main, name, fixed);
  for (const r of races.values()) {
    if (!r.candidates.some((c) => c.worktree === name)) continue;
    r.adopted = name;
    emitRace(r);
  }
  void publish();
}

export async function removeWorktree(name: string): Promise<void> {
  const x = deps();
  const main = await mainOf();
  const w = (await listWorktrees()).find((v) => v.name === name);
  if (!w) throw new Error(`There's no worktree called ${name}.`);
  if (w.current) throw new Error(`You're looking at ${name}. Switch to another tab first.`);
  const lost = await wt.unmergedFiles(main, name);
  if (lost.length) {
    const more = lost.length > 5 ? ` and ${lost.length - 5} more` : "";
    const ok = await x.requestApproval({ kind: "request", title: `Remove ${name}? It has changes your code doesn't have.`, reason: `These changes would be lost: ${lost.slice(0, 5).join(", ")}${more}. Use "Use this fix" first to keep them.` });
    if (!ok) return;
  }
  const s = sessions.get(w.path);
  if (s) await stopSession(s);
  await wt.removeWorktree(main, name);
  offsets.delete(w.path);
  stash.delete(w.path);
  void publish();
}
