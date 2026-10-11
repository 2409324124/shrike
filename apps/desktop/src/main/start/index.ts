import { app } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import type { ShrikeEvents, StartCategory, StartPlan, StartSettings } from "@shrike/schema";
import { detectBrains } from "@shrike/agent";
import { startMcpServer, type StartHost } from "@shrike/mcp-server";
import { setupFiles } from "@shrike/scanner";
import { appView, beforeProjectSwitch, getServerUrl, host, requireProject, runner, store } from "../host.ts";
import { startIngest, type Ingest } from "../ingest.ts";
import { inspector } from "../inspector.ts";
import { notify } from "../notify.ts";
import { paths } from "../paths.ts";
import * as skills from "../skills.ts";
import { adoptUserPath } from "../platform.ts";
import { runStartBrain } from "./brain.ts";
import { discoverRecipes } from "./recipes.ts";
import { StartSession, type StartAnswer } from "./session.ts";
import { checkTools } from "./tools.ts";

// R: Run is Claude-driven from the first click. ipc.ts registers getStartPlan / startApp / stopApp / answerStart.

type Emit = <K extends keyof ShrikeEvents>(channel: K, payload: ShrikeEvents[K]) => void;

let emit: Emit = () => {};
let session: StartSession | undefined;
let brain: { runId: string; stop(): void } | undefined;
let server: ReturnType<typeof startMcpServer> | undefined;
let ingestP: Promise<Ingest> | undefined;
let starting: Promise<StartPlan> | undefined;

export function configureStart(send: Emit): void {
  emit = send;
  beforeProjectSwitch.push(stopApp);
}

// The start tools act on whichever start is current.
const current = (): StartSession => {
  if (!session || session.quest.done) throw new Error("No start is in progress. Stop here.");
  return session;
};
const proxy: StartHost = {
  readRecipe: (id) => current().readRecipe(id),
  plan: (p) => current().plan(p),
  updateStep: (p) => current().updateStep(p),
  runCommand: (p) => current().runCommand(p),
  startService: (p) => current().startService(p),
  stopService: (p) => current().stopService(p),
  serviceLogs: (p) => current().serviceLogs(p),
  checkHealth: (p) => current().checkHealth(p),
  envStatus: (p) => current().envStatus(p),
  writeEnv: (p) => current().writeEnv(p),
  appReady: (p) => current().appReady(p),
  saveRunSkill: (p) => current().saveRunSkill(p),
  markSkillUsed: (p) => current().markSkillUsed(p),
  proposeLesson: (p) => current().proposeLesson(p),
  say: (t) => session?.say(t),
};

const startServer = () => (server ??= startMcpServer(host, { skillsDir: join(paths.promptsDir, "../skills"), skills: skills.skillHost, start: proxy }).catch((e) => ((server = undefined), Promise.reject(e))));
// ponytail: its own ingest endpoint into the same store; host.ts keeps its own for the old run(). Upgrade: export host's.
const ingest = () => (ingestP ??= startIngest((msg) => store.handle(msg), inspector));

const policyFile = () => join(app.getPath("userData"), "start-policy.json");
function readAlways(root: string): Set<StartCategory> {
  try {
    const all = JSON.parse(readFileSync(policyFile(), "utf8")) as Record<string, StartCategory[]>;
    return new Set(Array.isArray(all[root]) ? all[root].filter((c) => typeof c === "string") : []);
  } catch {
    return new Set();
  }
}
function saveAlways(root: string, cats: StartCategory[]): void {
  let all: Record<string, StartCategory[]> = {};
  try {
    all = JSON.parse(readFileSync(policyFile(), "utf8")) as Record<string, StartCategory[]>;
  } catch {}
  all[root] = cats;
  try {
    writeFileSync(policyFile(), JSON.stringify(all, null, 2), { mode: 0o600 });
  } catch {}
}

const settingsFile = () => join(app.getPath("userData"), "start-settings.json");
export function getStartSettings(): StartSettings {
  try {
    return { autoKeep: (JSON.parse(readFileSync(settingsFile(), "utf8")) as Partial<StartSettings>).autoKeep === true };
  } catch {
    return { autoKeep: false };
  }
}
export function setStartSettings(s: StartSettings): void {
  writeFileSync(settingsFile(), JSON.stringify({ autoKeep: s.autoKeep === true }), { mode: 0o600 });
}

export const getStartPlan = (): StartPlan | null => (session ? structuredClone(session.quest.plan) : null);

export function startApp(): Promise<StartPlan> {
  starting ??= begin().finally(() => (starting = undefined));
  return starting;
}

async function begin(): Promise<StartPlan> {
  const project = requireProject();
  if (session && session.quest.plan.projectRoot === project.root && (!session.quest.done || (session.quest.plan.state === "ready" && runner.status.state === "running"))) return getStartPlan()!;
  brain?.stop();
  session?.stop();
  if (runner.status.state !== "idle" && runner.status.state !== "stopped") await runner.stop();
  const dirs = { ...skills.services.dirs(), project: project.root };
  const [{ recipes, lessons }, files, brains] = await Promise.all([
    discoverRecipes({ root: project.root, name: project.name, stack: [project.frontend, project.backend].filter((x): x is string => !!x), personal: dirs.personal, claude: join(homedir(), ".claude", "skills"), builtin: dirs.builtin }),
    setupFiles(project.root),
    detectBrains(),
  ]);
  const s = new StartSession({
    project,
    runner,
    runEnv: async () => {
      const { url, token } = await ingest();
      return { nodeAgentRegister: paths.nodeAgentRegister, pythonAgent: paths.pythonAgent, ingestUrl: url, token, serverUrl: getServerUrl() };
    },
    skillDirs: () => ({ ...skills.services.dirs(), project: project.root }),
    emit: (ch, p) => emit(ch, p),
    recipes,
    lessons,
    always: readAlways(project.root),
    saveAlways: (cats) => saveAlways(project.root, cats),
    pageCheck: async () => {
      const snap = await appView.snapshot();
      return { title: snap.title, text: snap.text };
    },
    notify,
    pushSkills: () => skills.pushUpdate(),
    outcome: (o) => skills.settleNow({ ...o, expect: "run" }, { ...skills.services.dirs(), project: project.root }),
  });
  session = s;
  await adoptUserPath(); // Check again: a tool installed since Shrike opened counts
  const tools = await checkTools(project.root, files);
  if (tools.length) s.quest.set({ tools });
  const blocking = tools.filter((t) => t.blocking);
  if (blocking.length) {
    s.quest.update(s.recipeStep, { detail: "Waits for what's missing below" });
    s.finishFailed(blocking.length === 1 ? `${blocking[0]!.message} Install it, then press Check again.` : `Your app needs ${blocking.map((t) => t.name).join(" and ")}, and they aren't on this computer. Install them, then press Check again.`);
    return getStartPlan()!;
  }
  const pick = brains.find((b) => b.id === "claude-code" && b.available) ?? brains.find((b) => b.available);
  if (!pick) {
    s.finishFailed("Shrike starts your app with Claude, and Claude isn't set up yet. Install Claude Code, open a terminal, run claude and type /login. Or set ANTHROPIC_API_KEY.");
    return getStartPlan()!;
  }
  try {
    const mcp = await startServer();
    const goal = `Get ${project.name} running`;
    brain = runStartBrain({
      brain: pick.id,
      project,
      session: s,
      recipes,
      lessons,
      setupFiles: files,
      portOffset: runner.offsetFor(project.root),
      tools,
      mcp: { url: mcp.url, token: mcp.token },
      promptsDir: paths.promptsDir,
      // SL: the System sees the start run like any agent run (credit, Save as skill)
      onStep: (st) => (skills.noteSkillStep(st, goal), void skills.observe("agent:step", st)),
      onStatus: (info) => void skills.observe("agent:status", info),
    });
  } catch (e) {
    s.finishFailed(`Couldn't start Claude: ${(e as Error).message}`);
  }
  return getStartPlan()!;
}

export async function stopApp(): Promise<void> {
  brain?.stop();
  brain = undefined;
  session?.stop();
  session?.quest.stopped();
  await runner.stop();
}

export function answerStart(askId: string, a: StartAnswer): void {
  if (!session?.answer(askId, a)) throw new Error("That question isn't waiting anymore.");
}

export async function shutdownStart(): Promise<void> {
  brain?.stop();
  session?.stop();
  await (await server?.catch(() => undefined))?.close();
  await (await ingestP?.catch(() => undefined))?.close();
}
