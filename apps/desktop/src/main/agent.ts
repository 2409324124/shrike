import { app } from "electron";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { AgentOptions, AgentRunInfo, AgentStep, BrainId, BrainInfo, ConnectInfo, Finding, ShrikeEvents, Skill } from "@shrike/schema";
import {
  ASIDE_RULE,
  bindHost,
  branchFinding,
  branchName,
  branchQuestion,
  branchTarget,
  bringBackText,
  detectBrains as detect,
  effortFor,
  goalWithOptions,
  isLatest,
  nextColor,
  READ_ONLY_RULE,
  sliceHistory,
  startAgentRun,
  type BrainMessage,
  type WorktreeApi,
} from "@shrike/agent";
import { formatActionTree } from "@shrike/correlator";
import { redactText } from "@shrike/redact";
import { listSkills as readSkillList, startMcpServer } from "@shrike/mcp-server";
import { addCommand, configCommand, denySettings, readSaved, saveConfig } from "./connect.ts";
import { getMemory, getProject, host, rejectWithFeedback, requireProject, runner, store } from "./host.ts";
import { noteAgentStep } from "./issue.ts";
import { notify } from "./notify.ts";
import { getPatch } from "./patches.ts";
import { paths } from "./paths.ts";
import { sdlc } from "./sdlc.ts";
import { SERVER_OUTPUT_ID } from "./store.ts";
import { adoptWorktreeFix, createWorktree, listWorktrees, removeWorktree, worktreeAgentTarget } from "./race.ts"; // worktrees: W1 agent runs in a worktree, C6 branches
import { randomHex } from "./store.ts";
import * as wt from "./worktrees.ts";
import { listAll as allSkills, noteSkillStep, skillHost } from "./skills.ts"; // skills: S1–S5

type Emit = <K extends keyof ShrikeEvents>(channel: K, payload: ShrikeEvents[K]) => void;

const skillsDir = join(paths.promptsDir, "../skills");
let mcp: ReturnType<typeof startMcpServer> | undefined;
const runs = new Map<string, { stop(): void }>();
// A13: the last run's brain and Claude Code session, so a revision can continue the same conversation.
let last: { runId: string; brain: BrainId; goal: string; session?: string } | undefined;

export function detectBrains(): Promise<BrainInfo[]> {
  return detect();
}

// MCP6: the servers a run gets (Claude Code's and Shrike's own, this project's switches), set by ipc.ts
let myMcp: ((root: string) => Promise<Record<string, Record<string, unknown>>>) | undefined;
export const useMcpHub = (fn: typeof myMcp): void => void (myMcp = fn);

export const listSkills = (): Promise<Skill[]> => allSkills().catch(() => readSkillList(skillsDir)); // skills: every source, merged

/** One MCP server per app session, on the address and token saved in <userData>/mcp.json, so outside clients keep working (A11, MCP9). */
export function ensureMcp(): ReturnType<typeof startMcpServer> {
  if (!mcp) {
    mcp = readSaved(mcpFile()).then((saved) => startMcpServer(host, { skillsDir, skills: skillHost, ...saved, onClient: sawClient }));
    mcp.then((s) => saveConfig(mcpFile(), s.url, s.token), () => (mcp = undefined)).catch(() => {});
  }
  return mcp;
}

// MCP9: outside clients by name and their last call, since Shrike opened.
const mcpFile = () => join(app.getPath("userData"), "mcp.json");
const clients = new Map<string, number>();
let pushConnect: () => void = () => {};
export const useConnectPush = (fn: () => void): void => void (pushConnect = fn);
function sawClient(name: string): void {
  const before = clients.get(name);
  clients.set(name, Date.now());
  if (!before || Date.now() - before > 30_000) pushConnect();
}

export async function connectInfo(): Promise<ConnectInfo> {
  const s = await ensureMcp();
  return {
    url: s.url,
    token: s.token,
    command: addCommand(s.url, s.token),
    configCommand: configCommand(mcpFile()),
    skill: await readFile(join(paths.repo, "prompts/connect/SKILL.md"), "utf8"),
    settings: denySettings(),
    clients: [...clients].map(([name, at]) => ({ name, at })).sort((a, b) => b.at - a.at),
    ...(s.movedFrom ? { movedFrom: s.movedFrom } : {}),
  };
}

export async function resetConnectToken(): Promise<ConnectInfo> {
  const s = await ensureMcp();
  await s.rotateToken();
  clients.clear();
  await saveConfig(mcpFile(), s.url, s.token);
  return connectInfo();
}
void app.whenReady().then(() => ensureMcp());

// Shrike's own runs get a server per folder whose tools refuse once another workspace is open (outside clients follow the open one).
const folderMcp = new Map<string, ReturnType<typeof startMcpServer>>();
async function runMcp(root: string): Promise<{ url: string; token: string }> {
  let s = folderMcp.get(root);
  if (!s) folderMcp.set(root, (s = startMcpServer(bindHost(host, root, () => getProject()?.root), { skillsDir, skills: skillHost })));
  s.catch(() => folderMcp.delete(root));
  const { url, internalToken } = await s;
  return { url, token: internalToken };
}

function recentActions(): string {
  const views = store.listActions().filter((a) => a.id !== SERVER_OUTPUT_ID).slice(-5);
  return views.map((v) => formatActionTree(v, { includeIds: true }).split("\n").slice(0, 4).join("\n")).join("\n\n");
}

async function memoryText(): Promise<string> {
  const notes = await getMemory().catch(() => []);
  return notes.map((n) => `- ${n.text}${n.file ? ` (${n.file}${n.line ? `:${n.line}` : ""})` : ""}`).join("\n");
}

async function skillsText(): Promise<string> {
  return (await listSkills()).map((s) => `  - ${s.id}: ${s.name}. ${s.when}`).join("\n");
}

/** A Shrike worktree by name (W1): its folder and its own MCP server, so patches land in that copy, not your checkout. */
async function worktreeTarget(name: string): Promise<{ cwd: string; mcp: { url: string; token: string } } | undefined> {
  const w = (await listWorktrees()).find((x) => x.name === name || x.branch === name);
  if (!w) throw new Error(`There's no worktree called ${name}.`);
  return w.current ? undefined : worktreeAgentTarget(w.name);
}

export interface RunExtras {
  resume?: string;
  opts?: AgentOptions;
  quiet?: { onStep(step: AgentStep): void; onEnd(status: AgentRunInfo["status"]): void; onUsage?(u: ShrikeEvents["agent:usage"]): void }; // review runs: kept off the agent panel
  // C: conversation branches
  fork?: boolean;
  history?: BrainMessage[];
  cwd?: string; // a fork resumes from the parent's folder (Claude Code keeps sessions per folder)
  mcp?: { url: string; token: string }; // C6: the branch's worktree tools
  readOnly?: boolean; // C3/C6: an aside, or a branch without its own copy, can't call write tools
  branch?: Pick<AgentRunInfo, "parentRunId" | "branchFromStepId" | "name" | "color" | "aside" | "worktree" | "continues">;
}

export async function startAgent(goal: string, brain: BrainId, emit: Emit, resumeOrExtras?: string | RunExtras): Promise<AgentRunInfo> {
  const extras: RunExtras = typeof resumeOrExtras === "string" ? { resume: resumeOrExtras } : (resumeOrExtras ?? {});
  const { resume, opts = {}, quiet } = extras;
  const isBranch = !!(extras.branch?.parentRunId || extras.branch?.aside);
  const project = requireProject();
  const [memory, skills, target] = await Promise.all([memoryText(), skillsText(), opts.worktree ? worktreeTarget(opts.worktree) : undefined]);
  let summary = "";
  const continues = extras.branch?.continues ?? (resume && !extras.fork ? [...registry.values()].findLast((r) => r.session === resume)?.info.id : undefined);
  const cwd = extras.cwd ?? target?.cwd ?? project.root;
  const run = startAgentRun({
    goal: goalWithOptions(goal, opts),
    brain,
    cwd,
    effort: effortFor(opts.thinking),
    mcp: extras.mcp ?? target?.mcp ?? (await runMcp(project.root)),
    useMyMcp: opts.useMyMcp, // B4
    ...(myMcp ? { myMcp: () => myMcp!(project.root) } : {}), // MCP6
    resume,
    fork: extras.fork,
    history: extras.history,
    readOnly: extras.readOnly,
    branch: { ...extras.branch, ...(continues ? { continues } : {}) },
    onHistory: (messages, cuts) => {
      const r = registry.get(run.info.id);
      if (r) Object.assign(r, { history: messages, cuts });
    },
    context: {
      frontend: project.frontend,
      backend: project.backend,
      appUrl: runner.status.state === "running" ? runner.status.url : project.appUrl,
      routeCount: project.routes.length,
      recentActions: recentActions(),
      memory,
      skills,
    },
    onStep: (raw: AgentStep) => {
      const step = /^mcp__/.test(raw.tool ?? "") ? { ...raw, text: redactText(raw.text), ...(raw.detail ? { detail: redactText(raw.detail) } : {}) } : raw; // MCP5: a user's own server's calls and output, redacted like everything else
      if (quiet) return quiet.onStep(step);
      registry.get(step.runId)?.steps.push(step);
      if (isBranch) return emit("agent:step", step);
      if (step.kind === "done") summary = step.summary ?? step.detail ?? "";
      else if (step.kind === "findings" && step.summary) summary = step.summary;
      noteAgentStep(step);
      noteSkillStep(step, goal); // skills: S5 drafts from this run
      emit("agent:step", step);
    },
    onStatus: (info) => {
      if (quiet) {
        if (info.status !== "running") (runs.delete(info.id), quiet.onEnd(info.status));
        return;
      }
      emit("agent:status", info);
      noteStatus(info, emit);
      if (isBranch) {
        if (info.status !== "running") (runs.delete(info.id), void branchEnded(info, emit));
        return;
      }
      if (info.status === "running") return;
      runs.delete(info.id);
      emit("agent:cursor", null);
      if (info.status === "done") notify("Your agent is done", summary.split("\n")[0] || "It finished. Open Shrike to see what it found.");
      else if (info.status === "failed") notify("Your agent stopped", "It ran into a problem. Open Shrike to see what happened.");
    },
    onUsage: (u) => (quiet ? quiet.onUsage?.(u) : emit("agent:usage", u)),
    onSession: (session) => {
      if (last?.runId === run.info.id) last.session = session;
      const r = registry.get(run.info.id);
      if (r) r.session = session;
    },
    promptsDir: paths.promptsDir,
  });
  if (!quiet) registry.set(run.info.id, { info: { ...run.info }, root: project.root, cwd, session: extras.fork ? undefined : resume, steps: [] });
  if (!quiet && !isBranch) last = { runId: run.info.id, brain, goal, session: resume };
  if (run.info.status === "running") runs.set(run.info.id, run);
  return run.info;
}

// ---- sdlc: hidden moves (Plan first, Think harder, skill, worktree) and Review this fix ----

export const startAgentWith = (goal: string, brain: BrainId, opts: AgentOptions, emit: Emit): Promise<AgentRunInfo> => startAgent(goal, brain, emit, { opts });

const REVIEW_ASK = `Review this proposed change before it's applied. Do not propose or apply patches and do not change any file: only read code and trips.
Look for bugs it introduces, cases it misses, and security problems. Call report_findings once: one finding per real concern with file and line,
confidence "observed" or "likely" for real problems and "possible" for nits. If it looks right, call report_findings with no findings and a summary that starts with "Looks good".`;

let reviewing: string | undefined;

/** "Review this fix": a review-only run on a proposed diff. Its steps stay off the agent panel; the SDLC rail's Review stage shows the outcome. */
export async function reviewFix(patchId: string, emit: Emit): Promise<AgentRunInfo> {
  const patch = getPatch(patchId);
  if (!patch) throw new Error("That fix isn't in this session anymore.");
  if (reviewing && runs.has(reviewing)) throw new Error("A review is already running.");
  const brain = last?.brain ?? (await detectBrains()).find((b) => b.available)?.id;
  if (!brain) throw new Error("No agent is set up. Install Claude Code, or set ANTHROPIC_API_KEY.");
  const diff = patch.files.map((f) => `--- ${f.path} (before)\n${f.before}\n+++ ${f.path} (after)\n${f.after}`).join("\n\n").slice(0, 24_000);
  const found: Finding[] = [];
  let summary = "";
  sdlc.noteReview({ state: "running", at: Date.now(), summary: "Your agent is reviewing the fix.", findings: [], patchId });
  const info = await startAgent(`${REVIEW_ASK}\n\nWhy the change was made: ${patch.rationale}\n\n<diff>\n${diff}\n</diff>`, brain, emit, {
    opts: { thinking: "deep" },
    quiet: {
      onStep: (s) => {
        if (s.kind === "findings") {
          found.push(...(s.findings ?? []));
          summary = s.summary ?? s.text;
        }
      },
      onEnd: (status) => {
        const concerns = found.filter((f) => f.confidence !== "possible");
        const state = status === "done" ? (concerns.length ? "concerns" : "passed") : "concerns";
        const text = status !== "done" ? "The review didn't finish. Try again, or skip it." : summary || (concerns.length ? `${concerns.length} concern${concerns.length === 1 ? "" : "s"} about this fix.` : "Looks good.");
        sdlc.noteReview({ state, at: Date.now(), summary: text, findings: found, patchId });
      },
    },
  });
  reviewing = info.id;
  return info;
}

/**
 * A13: send diff comments back. A run still waiting on this patch gets them as the rejection reason and revises in place.
 * Otherwise the last Claude Code session is resumed with the comments; the built-in brain starts over with them.
 */
export async function reviseFix(patchId: string, comments: { line: number; file: string; text: string }[], emit: Emit): Promise<void> {
  const text = comments.map((c) => `${c.file}:${c.line}: ${c.text.trim()}`).join("\n");
  if (!text.trim()) throw new Error("Add a comment to a line first.");
  const waiting = rejectWithFeedback(patchId, text);
  if (!last) throw new Error("There's no agent run to send this to. Ask again.");
  if (runs.has(last.runId)) {
    if (waiting) return;
    throw new Error("Your agent is still working. Send your comments when it stops.");
  }
  const patch = getPatch(patchId);
  const ask = `I rejected your patch and left comments on its diff:\n<comments>\n${text}\n</comments>\nPropose a revised patch with propose_patch that addresses every comment.`;
  if (last.brain === "claude-code" && last.session) {
    await startAgent(ask, "claude-code", emit, last.session);
    return;
  }
  const diff = patch?.files.map((f) => `--- ${f.path} (proposed)\n${f.after}`).join("\n\n") ?? "";
  await startAgent(`${last.goal}\n\n${ask}${diff ? `\n\nThe rejected version:\n<patch>\n${diff.slice(0, 8000)}\n</patch>` : ""}`, last.brain, emit);
}

/** M1: the newest run on the agent panel still working (the one an ask_options call comes from). ponytail: upgrade to the MCP session's run id. */
export const liveRun = (): string | undefined => [...runs.keys()].findLast((id) => registry.has(id) && !registry.get(id)!.info.aside);

export function stopAgent(runId: string): void {
  runs.get(runId)?.stop();
  runs.delete(runId);
  if (registry.get(runId)?.info.aside) registry.delete(runId); // C3: dismissing an aside discards it
}

export async function stopAllAgents(): Promise<void> {
  for (const r of runs.values()) r.stop();
  runs.clear();
  await (await mcp?.catch(() => undefined))?.close();
  for (const s of folderMcp.values()) await (await s.catch(() => undefined))?.close();
}

// ---- C: conversation branches (C1 branch, C3 aside, C5 bring back, C6 own worktree), kept per project for relaunch ----

interface RunRec {
  info: AgentRunInfo;
  root: string; // project it belongs to
  cwd: string; // where its brain ran (a Claude Code fork must resume from the same folder)
  session?: string; // Claude Code session id
  steps: AgentStep[];
  history?: BrainMessage[]; // built-in brain only; ponytail: in memory, so after a relaunch a built-in branch starts over
  cuts?: ReadonlyMap<string, number>;
}

const registry = new Map<string, RunRec>(); // insertion order = start order
const loaded = new Set<string>();
const MAX_RUNS = 40;
const MAX_SAVED_STEPS = 300;

const runsFile = (root: string) => join(app.getPath("userData"), "runs", `${createHash("sha1").update(root).digest("hex").slice(0, 16)}.json`);
const projectRuns = (root: string) => [...registry.values()].filter((r) => r.root === root && !r.info.aside);

async function ensureLoaded(root: string): Promise<void> {
  if (loaded.has(root)) return;
  loaded.add(root);
  try {
    const saved = JSON.parse(await readFile(runsFile(root), "utf8")) as { runs?: Omit<RunRec, "root">[] };
    const fresh = new Map(registry); // runs of this app session go after the saved ones
    registry.clear();
    for (const r of saved.runs ?? []) {
      if (!r?.info?.id || fresh.has(r.info.id) || !Array.isArray(r.steps)) continue;
      registry.set(r.info.id, { ...r, root, info: { ...r.info, status: r.info.status === "running" ? "stopped" : r.info.status } }); // the app quit mid-run
    }
    for (const [k, v] of fresh) registry.set(k, v);
  } catch {} // nothing saved yet
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSave(root: string): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(root).catch(() => {}), 800);
}

async function save(root: string): Promise<void> {
  const keep = projectRuns(root).slice(-MAX_RUNS).map(({ info, cwd, session, steps }) => ({
    info,
    cwd,
    session,
    steps: steps.slice(-MAX_SAVED_STEPS).map((s) => (s.detail && s.detail.length > 4000 ? { ...s, detail: `${s.detail.slice(0, 4000)}…` } : s)),
  }));
  const file = runsFile(root);
  await mkdir(join(file, ".."), { recursive: true });
  const tmp = `${file}.${randomHex(3)}.tmp`;
  await writeFile(tmp, JSON.stringify({ runs: keep }), { mode: 0o600 });
  await rename(tmp, file);
}

function noteStatus(info: AgentRunInfo, emit: Emit): void {
  const r = registry.get(info.id);
  if (!r) return;
  r.info = { ...info };
  if (info.aside) return; // asides never reach the map or the disk
  emit("runs:update", projectRuns(r.root).map((x) => x.info));
  if (info.status !== "running") scheduleSave(r.root);
}

async function recOf(runId: string): Promise<RunRec> {
  await ensureLoaded(requireProject().root);
  const r = registry.get(runId);
  if (!r) throw new Error("That agent run isn't in this session anymore.");
  return r;
}

/** The main run a branch grew from (a branch of a branch counts its root). */
function mainOf(r: RunRec): RunRec {
  for (let i = 0; i < 20 && r.info.parentRunId; i++) {
    const p = registry.get(r.info.parentRunId);
    if (!p) break;
    r = p;
  }
  return r;
}

/** The newest run of main's conversation (main resumed after a revision or a bring-back continues it). */
function lineHead(r: RunRec): RunRec {
  for (let i = 0; i < 50; i++) {
    const next = [...registry.values()].findLast((x) => x.info.continues === r.info.id);
    if (!next) break;
    r = next;
  }
  return r;
}

/** The first run of main's conversation: branches of one conversation share their colours. */
function lineRoot(r: RunRec): string {
  let m = mainOf(r);
  for (let i = 0; i < 50; i++) {
    const p = m.info.continues ? registry.get(m.info.continues) : undefined;
    if (!p) break;
    m = p;
  }
  return m.info.id;
}

const worktreeApi: WorktreeApi = {
  create: (name, note) => createWorktree(name, note).then(() => {}),
  target: (name) => worktreeAgentTarget(name),
  remove: (name) => removeWorktree(name),
};

export async function listRuns(): Promise<AgentRunInfo[]> {
  const root = requireProject().root;
  await ensureLoaded(root);
  return projectRuns(root).map((r) => r.info);
}

export async function getRunSteps(runId: string): Promise<AgentStep[]> {
  return (await recOf(runId)).steps;
}

/** C1/C3: a new run from a step of another; the parent run and its session are never changed. */
export async function branchRun(runId: string, fromStepId: string, question: string, emit: Emit, o: { name?: string; aside?: boolean } = {}): Promise<AgentRunInfo> {
  const parent = await recOf(runId);
  const at = o.aside ? parent.steps.length - 1 : parent.steps.findIndex((s) => s.id === fromStepId);
  const step = parent.steps[at];
  if (!o.aside && !step) throw new Error("That step isn't in this run anymore.");
  const name = branchName(question, o.name);
  const root = lineRoot(parent);
  const siblings = [...registry.values()].filter((r) => r.info.parentRunId && !r.info.aside && lineRoot(r) === root);
  const color = o.aside ? undefined : nextColor(siblings.map((r) => r.info.color));
  const target = await branchTarget({ name, aside: o.aside }, worktreeApi, randomHex(2));
  const rule = o.aside ? ASIDE_RULE : target.readOnly ? READ_ONLY_RULE : "";
  const branch = { parentRunId: parent.info.id, ...(step ? { branchFromStepId: step.id } : {}), name, ...(color ? { color } : {}), ...(o.aside ? { aside: true } : {}), ...(target.worktree ? { worktree: target.worktree } : {}) };
  const extras: RunExtras = { branch, cwd: parent.cwd, ...(target.mcp ? { mcp: target.mcp } : { readOnly: true }) };
  const ask = (q: string) => [q, rule].filter(Boolean).join("\n\n");
  const brain = parent.info.brain;
  if (brain === "claude-code" && parent.session) {
    const q = branchQuestion(question, step ? { text: step.text, latest: isLatest(parent.steps, at) } : undefined);
    return startAgent(ask(q), brain, emit, { ...extras, resume: parent.session, fork: true });
  }
  if (brain === "builtin" && parent.history) {
    const history = sliceHistory(parent.history, step ? parent.cuts?.get(step.id) : undefined, ask(question.trim()));
    return startAgent(ask(question.trim()), brain, emit, { ...extras, history });
  }
  // ponytail: no session to fork (never started, or a built-in run from before a relaunch): a branch starts over with the parent's goal,
  // an aside answers from the question alone.
  return startAgent(ask(o.aside ? question.trim() : `${parent.info.goal}\n\n${question.trim()}`), brain, emit, extras);
}

/** C3: a side question forked at the latest point; its answer stays out of every session unless kept. */
export function askAside(runId: string, question: string, emit: Emit): Promise<AgentRunInfo> {
  return branchRun(runId, "", question, emit, { aside: true });
}

/** C3: an aside that turned out to matter becomes a named branch. */
export async function keepAside(asideRunId: string, emit: Emit, name?: string): Promise<AgentRunInfo> {
  const r = await recOf(asideRunId);
  if (!r.info.aside) throw new Error("That isn't a side question.");
  if (runs.has(asideRunId)) throw new Error("Wait for the answer, then keep it as a branch."); // its last status would bring the aside back
  const root = lineRoot(r);
  const used = [...registry.values()].filter((x) => x.info.parentRunId && !x.info.aside && lineRoot(x) === root).map((x) => x.info.color);
  const { aside: _, ...rest } = r.info;
  r.info = { ...rest, name: branchName(r.info.name ?? "", name), color: nextColor(used) };
  emit("agent:status", r.info);
  noteStatus(r.info, emit);
  scheduleSave(r.root);
  return r.info;
}

/** C5: carry a branch's conclusion into main as one short message, or bring its fix over (the adopt approval card). */
export async function bringBack(branchRunId: string, mode: "summary" | "fix", emit: Emit): Promise<void> {
  const b = await recOf(branchRunId);
  if (!b.info.parentRunId) throw new Error("That run isn't a branch.");
  if (mode === "fix") {
    if (!b.info.worktree || !b.steps.some((s) => s.tool === "worktree_diff")) throw new Error("That branch didn't change any code, so there's no fix to bring over.");
    await adoptWorktreeFix(b.info.worktree);
    const main = await wt.mainRoot(b.root);
    if (!(await wt.unmergedFiles(main, b.info.worktree).catch(() => ["?"])).length) await removeWorktree(b.info.worktree).catch(() => {}); // adopted: the copy has nothing left
    return;
  }
  const finding = branchFinding(b.steps);
  if (!finding) throw new Error("That branch hasn't found anything yet.");
  const head = lineHead(mainOf(b));
  if (runs.has(head.info.id)) throw new Error("Your agent is still working on main. Bring this back when it stops.");
  const text = bringBackText(finding);
  const extras: RunExtras = { branch: { continues: head.info.id }, cwd: head.cwd };
  if (head.info.brain === "claude-code" && head.session) await startAgent(text, "claude-code", emit, { ...extras, resume: head.session });
  else if (head.info.brain === "builtin" && head.history) await startAgent(text, "builtin", emit, { ...extras, history: sliceHistory(head.history, undefined, text) });
  else await startAgent(`${head.info.goal}\n\n${text}`, head.info.brain, emit, extras);
}

/** P1: the next prompt in main's conversation, after `runId` (up next and chains). No session to resume: a fresh run. */
export async function continueRun(runId: string, goal: string, emit: Emit): Promise<AgentRunInfo> {
  const head = lineHead(mainOf(await recOf(runId)));
  if (runs.has(head.info.id)) throw new Error("Your agent is still working on main.");
  const extras: RunExtras = { branch: { continues: head.info.id }, cwd: head.cwd };
  if (head.info.brain === "claude-code" && head.session) return startAgent(goal, "claude-code", emit, { ...extras, resume: head.session });
  if (head.info.brain === "builtin" && head.history) return startAgent(goal, "builtin", emit, { ...extras, history: sliceHistory(head.history, undefined, goal) });
  return startAgent(goal, head.info.brain, emit, extras);
}

/** C6: a branch that worked in its own worktree reports what its patches changed there, for Compare and Bring it back. A copy it didn't change is removed (with its app). */
async function branchEnded(info: AgentRunInfo, emit: Emit): Promise<void> {
  const r = registry.get(info.id);
  if (!r || info.aside) return;
  const mainBusy = runs.has(lineHead(mainOf(r)).info.id);
  if (info.status === "done" && !mainBusy) notify(`Branch "${info.name ?? "branch"}" is done`, branchFinding(r.steps)?.split("\n")[0] ?? "Open Shrike to see what it found.");
  if (!info.worktree) return;
  try {
    const main = await wt.mainRoot(r.root);
    const sub = relative(main, r.root).split(sep).join("/");
    const patched = new Set(r.steps.filter((s) => s.tool === "propose_patch").flatMap((s) => s.files ?? []).filter((f) => f.action === "edit").map((f) => f.path.replace(/^\.\//, "")));
    const changed = (await wt.changedFiles(main, info.worktree)).map((f) => (sub ? (f.startsWith(`${sub}/`) ? f.slice(sub.length + 1) : "") : f)).filter((f) => f && patched.has(f));
    if (!changed.length) {
      // ponytail: only a copy with nothing unmerged goes (removeWorktree would ask about app-written files); others stay for the Worktrees tab
      if (!(await wt.unmergedFiles(main, info.worktree)).length) await removeWorktree(info.worktree);
      return;
    }
    const diff = await wt.fixDiff(main, info.worktree, changed.map((f) => (sub ? `${sub}/${f}` : f)));
    const step: AgentStep = {
      id: randomHex(8),
      runId: info.id,
      kind: "patch",
      tool: "worktree_diff",
      text: `Changed ${changed.join(", ")} in its own copy`,
      detail: diff.slice(0, 20_000),
      files: changed.map((path) => ({ path, action: "edit" as const })),
      createdAt: Date.now(),
    };
    r.steps.push(step);
    emit("agent:step", step);
    scheduleSave(r.root);
  } catch {} // the worktree was removed already
}
