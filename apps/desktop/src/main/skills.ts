import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type { AgentRunInfo, AgentStep, Flow, Skill, SkillDraft, SkillEvent, SkillOutcome, SkillProposal, ShrikeEvents, StartPlan, StartReward } from "@shrike/schema";
import { frontMatter, OUTCOME, outcomeOf, parseSkill, skillSteps, type SkillDoc, type SkillHost } from "@shrike/mcp-server";
import { rankOf } from "../renderer/src/system/ranks.ts";
import { questDone } from "./progress.ts";
import { readJson, writeAtomic as atomicWrite } from "./state-file.ts";

// S1–S5: skills from four places, merged. Electron-free so it tests with node:test; ipc.ts calls configureSkills.
//   builtin  prompts/skills/*.md            (ships with Shrike)
//   project  <project>/.shrike/skills/*.md   (wins over personal and builtin)
//   personal ~/.shrike/skills/*.md           (also holds evolving copies of Claude skills: `from: claude`)
//   claude   ~/.claude/skills/*/SKILL.md and ~/.claude/skills/*.md, read-only, only after the user says yes (S2)

export interface SkillDirs {
  builtin: string;
  project?: string; // project root
  personal: string;
  claude: string;
  state: string; // userData: skills.json holds the import choice, use counts and proficiency; skill-log.json the System's log (SL6)
}

export interface LoadedSkill extends SkillDoc {
  raw: string; // whole file text
}

type Emit = <K extends keyof ShrikeEvents>(channel: K, payload: ShrikeEvents[K]) => void;

interface State {
  claude?: boolean;
  uses: Record<string, number>;
  wins: Record<string, number>; // SL4 proficiency: successful uses
  seen?: Record<string, Record<string, number>>; // SL1/SL2: per scope, skill id → version last seen
}

const SOURCE_RANK = { builtin: 0, personal: 1, project: 2 } as const;
const MAX_BYTES = 256 * 1024;

const statePath = (d: SkillDirs) => join(d.state, "skills.json");
const projectSkills = (root: string) => join(root, ".shrike", "skills");

async function readState(d: SkillDirs): Promise<State> {
  try {
    const s = ((await readJson(statePath(d))) ?? {}) as Partial<State>;
    const obj = <T>(v: T | undefined) => (v && typeof v === "object" && !Array.isArray(v) ? v : undefined);
    return { ...(typeof s.claude === "boolean" ? { claude: s.claude } : {}), uses: obj(s.uses) ?? {}, wins: obj(s.wins) ?? {}, ...(obj(s.seen) ? { seen: s.seen } : {}) };
  } catch {
    return { uses: {}, wins: {} };
  }
}


let chain: Promise<unknown> = Promise.resolve(); // serialize state read-modify-write
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
};

const updateState = (d: SkillDirs, fn: (s: State) => void) =>
  serial(async () => {
    const s = await readState(d);
    fn(s);
    await atomicWrite(statePath(d), JSON.stringify(s, null, 2));
    return s;
  });

async function readOne(id: string, file: string, source: NonNullable<Skill["source"]>): Promise<LoadedSkill | null> {
  try {
    if ((await stat(file)).size > MAX_BYTES) return null;
    const raw = await readFile(file, "utf8");
    const doc = parseSkill(id, raw);
    if (!doc) return null;
    return { ...doc, raw, source, path: file, readOnly: source === "claude", steps: skillSteps(doc.body) };
  } catch {
    return null;
  }
}

async function readDir(dir: string, source: "builtin" | "project" | "personal"): Promise<LoadedSkill[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const docs = await Promise.all(names.filter((f) => f.endsWith(".md") && !f.startsWith(".")).map((f) => readOne(f.slice(0, -3), join(dir, f), source)));
  return docs.filter((d) => d !== null);
}

/** ~/.claude/skills: one folder per skill with SKILL.md, or a loose <id>.md. Only reads. */
export async function readClaudeSkills(dir: string): Promise<LoadedSkill[]> {
  const ents = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const docs = await Promise.all(
    ents
      .filter((e) => !e.name.startsWith("."))
      .map((e) => (e.isDirectory() ? readOne(e.name, join(dir, e.name, "SKILL.md"), "claude") : e.name.endsWith(".md") ? readOne(e.name.slice(0, -3), join(dir, e.name), "claude") : null)),
  );
  return docs.filter((d) => d !== null);
}

/** Every skill, deduped by id: project over personal over builtin; Claude skills after them (when imported), each replaced by its evolving copy if there is one. */
export async function loadSkills(d: SkillDirs): Promise<LoadedSkill[]> {
  const state = await readState(d);
  const [builtin, personal, project, claude] = await Promise.all([
    readDir(d.builtin, "builtin"),
    readDir(d.personal, "personal"),
    d.project ? readDir(projectSkills(d.project), "project") : [],
    state.claude ? readClaudeSkills(d.claude) : [],
  ]);
  const copies = new Map(personal.filter((p) => p.from === "claude").map((p) => [p.id, p]));
  const own = new Map<string, LoadedSkill>();
  for (const s of [...builtin, ...personal.filter((p) => p.from !== "claude" || !claude.some((c) => c.id === p.id)), ...project]) {
    const had = own.get(s.id);
    if (!had || SOURCE_RANK[s.source as keyof typeof SOURCE_RANK] >= SOURCE_RANK[had.source as keyof typeof SOURCE_RANK]) own.set(s.id, s);
  }
  const theirs = claude.filter((c) => !own.has(c.id)).map((c) => {
    const copy = copies.get(c.id);
    return copy ? { ...copy, source: "claude" as const, readOnly: false } : c;
  });
  const byName = (a: LoadedSkill, b: LoadedSkill) => a.name.localeCompare(b.name);
  return [...[...own.values()].sort(byName), ...theirs.sort(byName)].map((s) => ({ ...s, uses: state.uses[s.id] ?? 0, proficiency: state.wins[s.id] ?? 0 }));
}

export const toSkill = ({ body: _b, raw: _r, from: _f, ...s }: LoadedSkill): Skill => s;

/** S2: how many Claude Code skills there are to offer, or null once the user has answered (or there are none). */
export async function claudeOffer(d: SkillDirs): Promise<number | null> {
  if ((await readState(d)).claude !== undefined) return null;
  const n = (await readClaudeSkills(d.claude)).length;
  return n || null;
}

export const setClaudeImport = (d: SkillDirs, enable: boolean) => updateState(d, (s) => void (s.claude = enable));
export const noteUse = (d: SkillDirs, id: string) => updateState(d, (s) => void (s.uses[id] = (s.uses[id] ?? 0) + 1));

/** Front matter with these keys set (replaced in place, else appended), everything else as the author wrote it. */
export function setFields(raw: string, fields: Record<string, string | number>): string {
  let out = raw;
  for (const [k, v] of Object.entries(fields)) {
    const line = `${k}: ${v}`;
    const re = new RegExp(`^${k}:.*$`, "m");
    out = re.test(out) ? out.replace(re, line) : `${out.replace(/\s*$/, "")}${out.trim() ? "\n" : ""}${line}`;
  }
  return out;
}

/** Where an improvement or an edit lands: project and personal skills in place; built-in and Claude skills get a personal copy. ~/.claude is never written. */
export function evolvingPath(d: SkillDirs, s: LoadedSkill): string {
  if (s.source === "builtin" && d.project && frontMatter(s.raw)?.fields.scope === "project") return join(projectSkills(d.project), `${s.id}.md`); // M5: taste is per app
  if ((s.source === "project" || s.source === "personal" || (s.source === "claude" && !s.readOnly)) && s.path) return s.path;
  return join(d.personal, `${s.id}.md`);
}

// ---- S4: drafts, kept when their outcome is verified (evolve-on-outcome) ----
// A learning is a draft tied to its run, in userData/skill-drafts.json (so it survives a restart); the skill file is untouched.
// When the run's expected outcome is verified, settle() writes it: version + 1, a changelog line, and the previous file kept in
// versions/ next to it (userData for built-in and Claude skills, whose first improvement is a new personal copy). Undo puts it back.

interface DraftRec extends SkillDraft {
  project?: string; // project skills: the root they live in
  root?: string; // the project it was drafted in: only that project's outcomes settle it
  before: string;
  after: string;
  target?: string; // applied: the file written
  backup?: string; // applied: the previous version
  created?: boolean; // applied: the target was new, so Undo removes it
  editPath?: string; // "Edit before keeping": the editable copy
  wrote?: string; // applied: sha1 of what apply wrote, so Undo never loses a later hand edit
}

const draftsPath = (d: SkillDirs) => join(d.state, "skill-drafts.json");
const MAX_DRAFTS = 200;
const normBody = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();

async function readDrafts(d: SkillDirs): Promise<DraftRec[]> {
  try {
    const v = await readJson(draftsPath(d));
    return Array.isArray(v) ? v.filter((x): x is DraftRec => !!x && typeof x === "object" && typeof (x as DraftRec).id === "string" && typeof (x as DraftRec).skillId === "string" && typeof (x as DraftRec).after === "string") : [];
  } catch {
    return [];
  }
}

const withDrafts = <T>(d: SkillDirs, fn: (all: DraftRec[]) => Promise<T>) =>
  serial(async () => {
    const all = await readDrafts(d);
    const out = await fn(all);
    await atomicWrite(draftsPath(d), JSON.stringify(all.slice(-MAX_DRAFTS), null, 1));
    return out;
  });

const CHANGELOG = /^## Changelog[ \t]*$/m;
const splitLog = (b: string) => {
  const m = CHANGELOG.exec(b);
  return m ? [b.slice(0, m.index).trimEnd(), b.slice(m.index + m[0].length).trim()] : [b.trimEnd(), ""];
};
/** The body without its "## Changelog" section, to compare what a skill says. */
export const withoutChangelog = (b: string): string => splitLog(b)[0]!;
/** The new body with "- v3: <lesson>, learned on run of 9 Oct" on top of its changelog (the old one carries over if Claude dropped it). */
export function withChangelog(before: string, after: string, line: string): string {
  const [main, log] = splitLog(after);
  const old = log || splitLog(before)[1];
  return `${main}\n\n## Changelog\n\n- ${line}${old ? `\n${old}` : ""}`;
}

const lesson = (r: string) => r.replace(/\s+/g, " ").trim().replace(/^learned( something)?:\s*/i, "").replace(/[.\s]+$/, "");
const day = (at: number) => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

async function draft(d: SkillDirs, p: { skillId: string; reason: string; after: string; runId?: string }): Promise<DraftRec> {
  const skill = (await loadSkills(d)).find((s) => s.id === p.skillId);
  if (!skill) throw new Error(`No skill "${p.skillId}".`);
  const rec: DraftRec = {
    id: randomBytes(6).toString("hex"),
    skillId: skill.id,
    name: skill.name,
    reason: lesson(p.reason).slice(0, 300),
    expect: outcomeOf(skill),
    ...(p.runId ? { runId: p.runId } : {}),
    at: Date.now(),
    status: "pending",
    ...(skill.source === "project" && d.project ? { project: d.project } : {}),
    ...(d.project ? { root: d.project } : {}),
    before: skill.body,
    after: p.after.trim().slice(0, 20_000),
  };
  await withDrafts(d, async (all) => {
    for (const x of all) if (x.status === "pending" && x.skillId === rec.skillId && x.runId === rec.runId && x.project === rec.project) x.status = "superseded"; // one draft per run and skill: the latest
    all.push(rec);
  });
  return rec;
}

/** The pending draft a new one for this run and skill would replace, so a second lesson builds on the first. */
export async function pendingDraft(d: SkillDirs, skillId: string, runId?: string): Promise<{ reason: string; after: string } | undefined> {
  return (await readDrafts(d)).findLast((x) => x.status === "pending" && x.skillId === skillId && x.runId === runId && here(d, x));
}

const here = (d: SkillDirs, x: DraftRec) => {
  const home = x.root ?? x.project;
  return !home || home === d.project;
};

export async function proposeUpdate(d: SkillDirs, p: { skillId: string; reason: string; after: string; runId?: string }): Promise<SkillProposal> {
  const x = await draft(d, p);
  return { id: x.id, skillId: x.skillId, reason: `Learned: ${x.reason}`, before: x.before, after: x.after };
}

/** Writes one draft (inside withDrafts). A draft written against an older body is out of date: superseded, never forced over. */
async function apply(d: SkillDirs, x: DraftRec): Promise<boolean> {
  const dd = x.project ? { ...d, project: x.project } : d;
  const skill = (await loadSkills(dd)).find((s) => s.id === x.skillId);
  if (!skill || normBody(skill.body) !== normBody(x.before)) {
    x.status = "superseded";
    return false;
  }
  const edited = x.editPath ? await readFile(x.editPath, "utf8").catch(() => undefined) : undefined;
  const body = edited?.trim() ? (frontMatter(edited)?.body ?? edited).trim() : x.after;
  const version = (skill.version ?? 1) + 1;
  const target = evolvingPath(dd, skill);
  const prev = await readFile(target).catch(() => undefined);
  const text = `---\n${setFields(frontMatter(skill.raw)?.raw ?? "", { version, improved: Date.now(), ...(skill.source === "claude" ? { from: "claude" } : {}) })}\n---\n\n${withChangelog(skill.body, body, `v${version}: ${x.reason.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())}, learned on run of ${day(x.at)}`)}\n`;
  const backup = join(prev ? join(dirname(target), "versions") : join(d.state, "skill-versions"), `${skill.id}.v${version - 1}.md`);
  await atomicWrite(backup, prev ?? skill.raw);
  await atomicWrite(target, text);
  if (x.editPath) await rm(x.editPath, { force: true }).catch(() => {});
  delete x.editPath;
  Object.assign(x, { status: "applied", version, target, backup, created: !prev, wrote: sha(text) });
  learned.set(x.skillId, { reason: x.reason, draftId: x.id }); // SL2: the next rescan's [Level Up] says what it learned
  return true;
}

export interface Outcome {
  expect: SkillOutcome | SkillOutcome[];
  ok: boolean;
  runIds?: string[]; // drafts from these runs
  skillIds?: string[]; // and earlier pending drafts for these skills (their own runs over)
  why?: string; // not ok: shown as "Not learned: <why>"
}

/** The gate: a verified outcome applies the matching drafts (newest per skill); a missed one leaves them pending with why. None given: every draft of that kind drafted in this project. */
export async function settle(d: SkillDirs, o: Outcome): Promise<{ applied: SkillDraft[]; missed: SkillDraft[] }> {
  const kinds = [o.expect].flat();
  const runs = new Set(o.runIds ?? []);
  const ids = new Set((o.skillIds ?? []).map((s) => s.toLowerCase()));
  const all = !o.runIds && !o.skillIds;
  const applied: DraftRec[] = [];
  const missed: DraftRec[] = [];
  if (!(await readDrafts(d)).some((x) => x.status === "pending" && kinds.includes(x.expect))) return { applied: [], missed: [] }; // git polls this often
  await withDrafts(d, async (list) => {
    const mine = list.filter(
      (x) =>
        x.status === "pending" &&
        kinds.includes(x.expect) &&
        here(d, x) &&
        (all || (x.runId !== undefined && runs.has(x.runId)) || (ids.has(x.skillId.toLowerCase()) && !(x.runId && agentRuns.has(x.runId)))),
    );
    if (!o.ok) {
      const why = o.why ?? OUTCOME[kinds[0]!].missed;
      for (const x of mine) if (x.missed !== why) (x.missed = why, missed.push(x));
      return;
    }
    const seen = new Set<string>();
    for (const x of mine.sort((a, b) => b.at - a.at)) {
      if (seen.has(x.skillId)) x.status = "superseded";
      else if ((seen.add(x.skillId), await apply(d, x).catch(() => false))) applied.push(x);
    }
  });
  return { applied: applied.map(publicDraft), missed: missed.map(publicDraft) };
}

const sha = (t: string) => createHash("sha1").update(t).digest("hex");
const publicDraft = ({ project: _p, root: _r, before: _b, after: _a, target: _t, backup: _k, created: _c, editPath: _e, wrote: _w, ...x }: DraftRec): SkillDraft => x;

export const listDrafts = async (d: SkillDirs): Promise<SkillDraft[]> => (await readDrafts(d)).filter((x) => here(d, x)).map(publicDraft).reverse();

/** Older callers: discard drops the draft. Keep is refused; only a verified outcome applies a draft. */
export async function answerProposal(d: SkillDirs, id: string, keep: boolean): Promise<string | null> {
  if (keep) throw new Error("Shrike keeps it by itself once the action reaches its outcome.");
  return withDrafts(d, async (all) => {
    const x = all.find((y) => y.id === id && y.status === "pending");
    if (!x) throw new Error("That suggestion isn't there anymore.");
    x.status = "discarded";
    return null;
  });
}

/** [Level Up] Undo: the previous version's bytes come back (a first copy is removed), and the level can be earned again. */
export async function undoDraft(d: SkillDirs, id: string): Promise<SkillDraft> {
  const x = await withDrafts(d, async (all) => {
    const y = all.find((z) => z.id === id);
    if (!y || y.status !== "applied" || !y.target) throw new Error("There's nothing to undo there.");
    const cur = await readFile(y.target, "utf8").catch(() => "");
    const now = parseSkill(y.skillId, cur);
    if (y.wrote ? sha(cur) !== y.wrote : (now?.version ?? 1) !== y.version) throw new Error("This skill changed again since, so Undo would lose that. Edit it instead.");
    if (y.created) await rm(y.target, { force: true });
    else await atomicWrite(y.target, await readFile(y.backup!));
    y.status = "undone";
    return y;
  });
  learned.delete(x.skillId);
  await updateState(d, (st) => {
    for (const sc of Object.values(st.seen ?? {})) if (sc[x.skillId] !== undefined) sc[x.skillId] = Math.min(sc[x.skillId]!, (x.version ?? 2) - 1);
  });
  return publicDraft(x);
}

/** "Edit before keeping": a copy of the draft in <project>/.shrike/skill-drafts/ for the file view; what's there is what gets kept. */
export async function editDraft(d: SkillDirs, id: string): Promise<string> {
  const root = d.project;
  if (!root) throw new Error("Open a project first.");
  return withDrafts(d, async (all) => {
    const x = all.find((y) => y.id === id && y.status === "pending");
    if (!x) throw new Error("That draft isn't waiting anymore.");
    const file = x.editPath ?? join(root, ".shrike", "skill-drafts", `${slug(x.skillId) || "skill"}-${x.id}.md`);
    if (!(await exists(file))) await atomicWrite(file, `${x.after}\n`);
    x.editPath = file;
    return relative(root, file).split(sep).join("/");
  });
}

// ---- S5: save as a skill ----

const runs = new Map<string, { goal: string; steps: AgentStep[] }>();
const readyPlans = new Map<string, StartPlan>(); // start runs don't feed noteSkillStep, so Save as skill drafts from the plan
const MAX_RUNS = 20;

/** main/agent.ts feeds every step here so a verified fix can become a skill draft. */
export function noteSkillStep(step: AgentStep, goal: string): void {
  let r = runs.get(step.runId);
  if (!r) {
    r = { goal, steps: [] };
    runs.set(step.runId, r);
    if (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value!);
  }
  if (r.steps.length < 300) r.steps.push(step);
}

let flowLookup: ((id: string) => Flow | undefined | Promise<Flow | undefined>) | undefined;
/** The flows module registers how to find a saved flow by id (B1). */
export function setFlowLookup(fn: typeof flowLookup): void {
  flowLookup = fn;
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
const oneLine = (s: string, max = 120) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

export interface Draft {
  name: string;
  when: string;
  kind: "debug" | "flow" | "run";
  intro: string;
  steps: string[];
}

export function draftFromRun(goal: string, steps: AgentStep[]): Draft {
  const done: string[] = [];
  for (const s of steps) {
    if (s.kind !== "tool_call" || !s.text.trim()) continue;
    const t = oneLine(s.text.replace(/…$/, ""));
    if (done.at(-1) !== t) done.push(t);
  }
  const findings = steps.findLast((s) => s.kind === "findings");
  const fixed = steps.some((s) => s.kind === "patch" && s.text === "Fix applied");
  const verified = steps.some((s) => s.kind === "done" && s.summary === "Fixed and verified");
  const out = done.slice(0, 10);
  for (const f of findings?.findings?.slice(0, 2) ?? []) out.push(`Check: ${oneLine(f.claim)}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}`);
  if (fixed) out.push("Propose the smallest fix with propose_patch");
  if (verified || fixed) out.push("Run it again and compare, to prove it works");
  const g = oneLine(goal.split("\n")[0] ?? goal, 80);
  return {
    name: oneLine(g.replace(/[.?!]$/, ""), 48) || "My fix",
    when: `Something like this happens again: ${g}`,
    kind: "debug",
    intro: findings?.summary ? `Last time: ${oneLine(findings.summary, 240)}` : `Saved from a run that ${verified ? "fixed and verified" : "worked on"} this.`,
    steps: out.length ? out : ["Reproduce it in the app", "Read the trip and find the first wrong value", "Propose the smallest fix"],
  };
}

export function draftFromFlow(flow: Flow): Draft {
  const say = (s: Flow["steps"][number]) =>
    s.type === "click" ? `Click "${s.name ?? "it"}"`
    : s.type === "type" ? `Type ${s.secret ? "the secret" : `"${s.text ?? ""}"`} into "${s.name ?? "the field"}"${s.submit ? " and press Enter" : ""}`
    : s.type === "navigate" ? `Open ${s.url ?? "the page"}`
    : s.type === "wait" ? `Wait ${s.ms ?? 500}ms`
    : `Send ${s.request?.method ?? "GET"} ${s.request?.url ?? s.url ?? ""}`.trim();
  return {
    name: flow.name,
    when: `You want to check that "${flow.name}" still works`,
    kind: "flow",
    intro: "Replay these steps in the app with app_snapshot, app_click and app_type, then check each trip worked.",
    steps: [...flow.steps.map(say).slice(0, 20), "Check every trip came back without errors"],
  };
}

/** R4: a start that ended ready but wrote no run skill still leaves one: its steps, exact commands and the fixes it needed. */
export function draftFromPlan(plan: StartPlan): Draft {
  const app = (plan.name ?? basename(plan.projectRoot)).replace(/^@[^/]+\//, "");
  const steps = plan.steps
    .filter((s) => s.state === "done" || s.state === "fixed")
    .map((s) => `${oneLine(s.title, 80)}${s.command ? `: \`${oneLine(s.command, 300)}\`` : ""}${s.cwd && s.cwd !== "." ? ` (in ${s.cwd})` : ""}${s.fix ? `. Gotcha: ${oneLine(s.fix, 160)}` : ""}`);
  for (const v of plan.services) if (v.url || v.health || v.port) steps.push(`Check ${v.name} answers at \`${v.health ?? v.url ?? `localhost:${v.port}`}\``);
  return {
    name: `Run ${app}`,
    when: `Start ${app} locally: every service, in order, with health checks`,
    kind: "run",
    intro: "Saved from a start that got it running. Follow these in order.",
    steps: steps.length ? steps : ["Start it the way the README says, then check every service answers"],
  };
}

export function formatDraft(d: Draft): string {
  const q = (s: string) => s.replace(/\n/g, " ");
  return `---\nname: ${q(d.name)}\nwhen: ${q(d.when)}\nkind: ${d.kind}\nversion: 1\n---\n\n# ${d.name}\n\n${d.intro}\n\n${d.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n`;
}

const exists = (f: string) => stat(f).then(() => true, () => false);

/** S5: writes .shrike/skills/<id>.md (never over an existing one) and returns the new skill. */
export async function saveAsSkill(d: SkillDirs, from: { actionId?: string; runId?: string; flowId?: string; name?: string }): Promise<LoadedSkill> {
  if (!d.project) throw new Error("Open a project first.");
  let draft: Draft;
  if (from.flowId) {
    const flow = await flowLookup?.(from.flowId);
    if (!flow) throw new Error("That flow isn't saved anymore.");
    draft = draftFromFlow(flow);
  } else {
    const run = from.runId ? runs.get(from.runId) : [...runs.values()].reverse().find((r) => r.steps.some((s) => s.actionIds?.includes(from.actionId ?? "")));
    const plan = from.runId ? readyPlans.get(from.runId) : undefined;
    if (plan && !run) draft = draftFromPlan(plan);
    else if (!run) throw new Error(from.runId ? "That agent run isn't in this session anymore." : "There's no agent run for this trip yet. Ask your agent about it first.");
    else draft = draftFromRun(run.goal, run.steps);
  }
  if (from.name?.trim()) draft.name = oneLine(from.name, 60);
  const base = slug(draft.name) || "skill";
  const dir = projectSkills(d.project);
  let id = base;
  for (let n = 2; await exists(join(dir, `${id}.md`)); n++) id = `${base}-${n}`;
  const file = join(dir, `${id}.md`);
  await atomicWrite(file, formatDraft(draft));
  const saved = await readOne(id, file, "project");
  if (!saved) throw new Error("Couldn't read the new skill back.");
  return saved;
}

/** Edit: the repo-relative file to open in the in-app file view. Skills outside the project get a project copy first. */
// ponytail: the file view only reads project files, so editing a built-in, personal or Claude skill edits a project copy. Upgrade: let the file view open ~/.shrike.
export async function editablePath(d: SkillDirs, id: string): Promise<string> {
  if (!d.project) throw new Error("Open a project first.");
  const s = (await loadSkills(d)).find((x) => x.id === id);
  if (!s) throw new Error(`No skill "${id}".`);
  const rel = (abs: string) => relative(d.project!, abs).split(sep).join("/");
  if (s.source === "project" && s.path) return rel(s.path);
  const file = join(projectSkills(d.project), `${slug(id) || "skill"}.md`);
  if (!(await exists(file))) await atomicWrite(file, s.raw);
  return rel(file);
}

// ---- Save as command ----

export async function saveAsCommand(root: string, name: string, prompt: string): Promise<string> {
  const id = slug(name).slice(0, 40);
  if (!id) throw new Error("Give the command a name with letters or numbers.");
  if (!prompt.trim()) throw new Error("The command is empty.");
  const file = join(root, ".shrike", "commands", `${id}.md`);
  await atomicWrite(file, `---\ndescription: ${oneLine(prompt, 80)}\n---\n\n${prompt.trim()}\n`);
  return file;
}

// ---- SL: the System (acquired, leveled, used, quest complete) ----
// Acquired and leveled come from one place: a rescan that compares every skill's version with what was last seen.
// So any new skill file counts, whoever wrote it (run skills, save as skill, flows, seeds, a teammate's git pull).

const logPath = (d: SkillDirs) => join(d.state, "skill-log.json");
const MAX_LOG = 500;
const SHRIKE = "shrike"; // builtin, personal and Claude skills; project skills are seen per project
const learned = new Map<string, { reason: string; draftId: string }>(); // skill id → the applied draft, for the next level up and its Undo

export async function readLog(d: SkillDirs): Promise<SkillEvent[]> {
  try {
    const v = await readJson(logPath(d));
    return Array.isArray(v) ? v.filter((e): e is SkillEvent => !!e && typeof e === "object" && typeof (e as SkillEvent).kind === "string" && typeof (e as SkillEvent).at === "number") : [];
  } catch {
    return [];
  }
}

const appendLog = (d: SkillDirs, evs: SkillEvent[]) =>
  serial(async () => {
    const log = [...(await readLog(d)), ...evs].slice(-MAX_LOG);
    await atomicWrite(logPath(d), JSON.stringify(log));
  });

export function skillEvent(kind: SkillEvent["kind"], s: { id: string; name: string; version?: number }, proficiency: number, extra: Partial<SkillEvent> = {}): SkillEvent {
  const r = rankOf(s.version, proficiency);
  return { kind, skillId: s.id, name: s.name, level: r.level, rank: r.rank, proficiency: r.proficiency, ...(r.nextRankAt !== undefined ? { nextRankAt: r.nextRankAt } : {}), at: Date.now(), ...extra };
}

const scopeOf = (d: SkillDirs, s: LoadedSkill) => (s.source === "project" && d.project ? `project:${d.project}` : SHRIKE);

/** SL1/SL2: new skills are acquired, higher versions leveled. The first look at a scope only records what's there. */
export async function rescan(d: SkillDirs): Promise<SkillEvent[]> {
  const skills = await loadSkills(d);
  const out: SkillEvent[] = [];
  const scopes = [SHRIKE, ...(d.project ? [`project:${d.project}`] : [])];
  await updateState(d, (st) => {
    const seen = (st.seen ??= {});
    const known = new Map<string, number>(); // highest version seen in any scope: a project copy of a built-in skill isn't new
    for (const sc of scopes) for (const [id, v] of Object.entries(seen[sc] ?? {})) known.set(id, Math.max(known.get(id) ?? 0, v));
    // Highest version ever seen, never forgotten: a checkout that drops or downgrades a skill and brings it back isn't news.
    const next = Object.fromEntries(scopes.map((sc) => [sc, { ...seen[sc] }]));
    for (const s of skills) {
      const sc = scopeOf(d, s);
      const v = s.version ?? 1;
      next[sc]![s.id] = Math.max(v, next[sc]![s.id] ?? 0);
      if (!seen[sc]) continue;
      const was = known.get(s.id);
      const prof = st.wins[s.id] ?? 0;
      if (was === undefined) {
        if (s.source === "project" || s.source === "personal") out.push(skillEvent("acquired", s, prof, s.when ? { when: s.when } : {}));
      } else if (v > was) {
        const why = learned.get(s.id);
        learned.delete(s.id);
        out.push(skillEvent("leveled", s, prof, why ? { learned: why.reason, draftId: why.draftId } : {}));
      }
    }
    for (const sc of scopes) seen[sc] = next[sc]!;
  });
  if (out.length) await appendLog(d, out);
  return out;
}

/** SL3: one successful use: proficiency + 1 (and a use, when nothing counted it yet). */
export async function credit(d: SkillDirs, id: string, opts: { use?: boolean } = {}): Promise<SkillEvent | null> {
  const want = id.trim().toLowerCase();
  const s = (await loadSkills(d)).find((x) => x.id.toLowerCase() === want);
  if (!s) return null;
  const st = await updateState(d, (st) => {
    st.wins[s.id] = (st.wins[s.id] ?? 0) + 1;
    if (opts.use) st.uses[s.id] = (st.uses[s.id] ?? 0) + 1;
  });
  const e = skillEvent("used", s, st.wins[s.id]!);
  await appendLog(d, [e]);
  return e;
}

const reward = (e: SkillEvent): StartReward => ({ kind: e.kind === "quest_complete" || e.kind === "not_learned" ? "used" : e.kind, skillId: e.skillId, name: e.name, level: e.level, ...(e.learned && e.kind === "leveled" ? { learned: e.learned } : {}) });

/** SL5: the quest's window lists what it earned: given rewards, else every acquired, leveled or used event since it began. */
export async function questComplete(d: SkillDirs, q: { quest: string; since: number; skillId?: string; runId?: string; rewards?: StartReward[] }): Promise<SkillEvent> {
  const log = await readLog(d);
  const mine = log.filter((e) => e.at >= q.since && e.kind !== "quest_complete" && e.kind !== "not_learned");
  // what was earned on the way, plus the plan's own rewards, one per kind and skill; drafts that didn't apply aren't rewards
  const rewards = [...new Map([...mine.map(reward), ...(q.rewards ?? []).filter((r) => r.kind !== "proposed")].map((r) => [`${r.kind}:${r.skillId}`, r])).values()];
  if (q.runId && !runs.has(q.runId) && !readyPlans.has(q.runId)) delete q.runId; // Save as skill would have nothing to draft from
  const mainId = q.skillId ?? rewards.find((r) => r.kind === "acquired")?.skillId ?? rewards[0]?.skillId;
  const all = await loadSkills(d);
  const main = mainId ? all.find((s) => s.id === mainId) : undefined;
  const e = main
    ? skillEvent("quest_complete", main, main.proficiency ?? 0, { quest: q.quest, rewards, ...(q.runId ? { runId: q.runId } : {}) })
    : { kind: "quest_complete" as const, skillId: "", name: q.quest, level: 0, rank: "E" as const, proficiency: 0, at: Date.now(), quest: q.quest, rewards, ...(q.runId ? { runId: q.runId } : {}) };
  await appendLog(d, [e]);
  return e;
}

// ---- wiring (ipc.ts configures; main/agent.ts and the MCP server use it) ----

let dirsOf: (() => SkillDirs) | undefined;
let emit: Emit = () => {};

export function configureSkills(dirs: () => SkillDirs, send: Emit): void {
  dirsOf = dirs;
  emit = send;
}

const dirs = (): SkillDirs => {
  if (!dirsOf) throw new Error("Skills aren't ready yet.");
  return dirsOf();
};

export const listAll = async (): Promise<Skill[]> => (await loadSkills(dirs())).map(toSkill);
export const pushUpdate = async (): Promise<void> => {
  emit("skills:update", await listAll().catch(() => []));
  await rescanNow();
};

const send = (e: SkillEvent | null) => void (e && emit("skill:event", e));
/** SL1/SL2 from anywhere: a new or improved skill file shows its System window. */
export const rescanNow = async (): Promise<void> => (await rescan(dirs()).catch(() => [])).forEach(send);
/** SL3 for skills that run outside an agent run (git skills): call when one worked. */
export const noteSkillUse = async (id: string): Promise<void> => {
  send(await credit(dirs(), id, { use: true }));
  await pushUpdate();
};
export const getSkillLog = (): Promise<SkillEvent[]> => readLog(dirs());

/** The gate, wired: applied drafts play [Level Up] (via the rescan); a missed outcome says "Not learned" once, quietly. Returns the level ups as rewards. */
export async function settleNow(o: Outcome, dd: SkillDirs = dirs()): Promise<StartReward[]> {
  const r = await settle(dd, o);
  const x = r.missed[0];
  if (x) {
    const s = (await loadSkills(dd)).find((k) => k.id === x.skillId);
    const e = skillEvent("not_learned", { id: x.skillId, name: x.name, ...(s?.version ? { version: s.version } : {}) }, s?.proficiency ?? 0, { learned: x.missed ?? OUTCOME[x.expect].missed });
    await appendLog(dd, [e]);
    send(e);
  }
  if (r.applied.length) await pushUpdate();
  return r.applied.map((a) => ({ kind: "leveled", skillId: a.skillId, name: a.name, level: a.version ?? 2, learned: a.reason }));
}

/** Outcome hooks outside an agent run (git.ts): ship, conflicts, CI. A no-op until skills are configured. */
export const noteOutcome = (expect: SkillOutcome[], ok: boolean, why?: string): void => void (dirsOf && settleNow({ expect, ok, ...(why ? { why } : {}) }).catch(() => {}));
export const getSkillDrafts = (): Promise<SkillDraft[]> => listDrafts(dirs());
export const undoSkillLevel = async (id: string): Promise<void> => {
  await undoDraft(dirs(), id);
  emit("skills:update", await listAll().catch(() => []));
};
export const editSkillDraft = (id: string): Promise<string> => editDraft(dirs(), id);

// What the System watches: every main event passes through observe (ipc.ts emit).
const agentRuns = new Map<string, { goal: string; skills: Set<string>; verified: boolean; at: number; patches: number; applied?: boolean }>();
const designRuns = new Set<string>(); // M5: runs asked to build a mockup the user approved
/** M5: the user approved a mockup in this run; its design-taste drafts are kept once a patch of the run is applied. */
export const noteDesignApproved = (runId: string | undefined): void => void (runId && designRuns.add(runId));
const startRuns = new Set<string>(); // the start agent's runs: their outcome is the start's (main/start), not a fix
const creditedKeys = new Set<string>(); // "<run>:<skill>": the agent run and the start plan can both report one use
let quest: { root: string; at: number; done: boolean } | undefined;
const flowRuns = new Map<string, number>();
let rescanTimer: ReturnType<typeof setTimeout> | undefined;
let lookedAt: string | undefined | null = null; // the project the last rescan saw; null before the first event

/** One credit per run and skill; none for a skill written during that same run (it wasn't used, it was made). */
async function creditOnce(key: string, id: string, use: boolean, since?: number): Promise<void> {
  const k = `${key}:${id.toLowerCase()}`;
  if (creditedKeys.has(k)) return;
  if (since !== undefined && (await readLog(dirs())).some((e) => e.kind === "acquired" && e.skillId === id && e.at >= since)) return;
  creditedKeys.add(k);
  if (creditedKeys.size > 500) creditedKeys.delete(creditedKeys.values().next().value!);
  send(await credit(dirs(), id, { use }));
}

export async function observe(channel: string, payload: unknown): Promise<void> {
  if (!dirsOf || !payload || typeof payload !== "object") return;
  try {
    // The UI's openProject emits no project:opened, so a project's quiet first look happens on the first event after it changes,
    // before the start lane can write its run skill (which then shows [Skill Acquired]).
    const root = dirs().project;
    if (root !== lookedAt) {
      lookedAt = root;
      if (root) await rescanNow();
    }
    if (channel === "agent:step") {
      const s = payload as AgentStep;
      const r = agentRuns.get(s.runId);
      if (!r) return;
      if (s.skill) r.skills.add(s.skill);
      if (s.kind === "done" && s.summary === "Fixed and verified") r.verified = true;
      if (s.kind === "patch") r.patches++; // XP: fixes tried
      if (s.kind === "patch" && s.text === "Fix applied") r.applied = true;
    } else if (channel === "agent:status") {
      const info = payload as AgentRunInfo;
      if (info.status === "running") {
        if (!agentRuns.has(info.id)) agentRuns.set(info.id, { goal: info.goal, skills: new Set(), verified: false, at: Date.now(), patches: 0 });
        return;
      }
      const r = agentRuns.get(info.id);
      agentRuns.delete(info.id);
      if (!r) return;
      if (info.status === "done") for (const id of r.skills) await creditOnce(info.id, id, false, r.at); // load_skill already counted the use
      if (!startRuns.has(info.id)) {
        // evolve-on-outcome: a fix's drafts need "Fixed and verified"; a review's need the run done. The start judges its own.
        const o = { runIds: [info.id], skillIds: [...r.skills] };
        await settleNow({ ...o, expect: "fix", ok: info.status === "done" && r.verified, ...(info.status === "done" ? {} : { why: "the run stopped before the fix was verified" }) });
        await settleNow({ ...o, expect: "review", ok: info.status === "done" });
        if (designRuns.delete(info.id)) await settleNow({ runIds: [info.id], skillIds: [...r.skills, "design-taste"], expect: "design", ok: info.status === "done" && !!r.applied, ...(r.applied ? {} : { why: "the approved design wasn't built" }) });
      }
      if (info.status !== "done") return;
      if (r.verified) {
        const e = await questComplete(dirs(), { quest: `Fix: ${oneLine(r.goal.split("\n")[0] ?? r.goal, 60)}`, since: r.at, runId: info.id });
        send(e);
        void questDone({ kind: "fix", quest: e.quest ?? e.name, root: dirs().project, key: info.id, ms: Date.now() - r.at, firstTry: r.patches <= 1, fixes: Math.max(0, r.patches - 1), skillsUsed: r.skills.size, verified: true, rewards: e.rewards ?? [] }); // XP3
      }
      await pushUpdate();
    } else if (channel === "start:plan") {
      const plan = payload as StartPlan;
      if (plan.runId && !startRuns.has(plan.runId)) {
        startRuns.add(plan.runId);
        if (startRuns.size > 100) startRuns.delete(startRuns.values().next().value!);
      }
      if (plan.state === "planning" || plan.state === "running") {
        if (!quest || quest.root !== plan.projectRoot || quest.done) quest = { root: plan.projectRoot, at: Date.now(), done: false };
      } else if (plan.state === "ready" && quest && quest.root === plan.projectRoot && !quest.done) {
        quest.done = true;
        const key = plan.runId ?? `start-${quest.at}`;
        readyPlans.set(key, plan);
        if (readyPlans.size > MAX_RUNS) readyPlans.delete(readyPlans.keys().next().value!);
        await rescanNow(); // the run skill it just wrote: [Skill Acquired] before [Quest Complete]
        if (plan.skillId) await creditOnce(key, plan.skillId, true, quest.at);
        const e = await questComplete(dirs(), { quest: `Get ${plan.name ?? basename(plan.projectRoot)} running`, since: quest.at, ...(plan.skillId ? { skillId: plan.skillId } : {}), runId: key, ...(plan.rewards?.length ? { rewards: plan.rewards } : {}) });
        send(e);
        const rewards = e.rewards ?? [];
        void questDone({ kind: "start", quest: e.quest ?? e.name, root: plan.projectRoot, ...(plan.name ? { project: plan.name } : {}), key, ms: Date.now() - quest.at, fixes: plan.steps.filter((x) => x.state === "fixed").length, skillsUsed: rewards.filter((x) => x.kind === "used").length, verified: !plan.steps.some((x) => x.kind === "health" && x.state !== "done"), rewards }); // XP3
        await pushUpdate();
      } else if (plan.state === "failed" || plan.state === "stopped") quest = undefined;
    } else if (channel === "flows:update" && Array.isArray(payload)) {
      const skills = await loadSkills(dirs());
      for (const f of payload as Flow[]) {
        const at = f.lastRun?.at;
        if (!at) continue;
        const prev = flowRuns.get(f.id);
        flowRuns.set(f.id, at);
        if (prev === undefined || at <= prev) continue;
        const s = skills.find((x) => x.kind === "flow" && (x.id === slug(f.name) || x.name === f.name));
        if (!s) continue;
        await settleNow({ expect: "flow", skillIds: [s.id], ok: !!f.lastRun?.ok }); // all steps green
        if (f.lastRun?.ok) await creditOnce(`flow:${f.id}:${at}`, s.id, true);
      }
    } else if (channel === "file:changed") {
      if (!(payload as { path?: string }).path?.startsWith(".shrike/skills/")) return;
      clearTimeout(rescanTimer);
      rescanTimer = setTimeout(() => void rescanNow(), 400);
      rescanTimer.unref?.();
    } else if (channel === "project:opened") quest = undefined;
  } catch {
    // the System never breaks the event it watches
  }
}

export const skillHost: SkillHost = {
  list: () => loadSkills(dirs()),
  used: (id) => void noteUse(dirs(), id).then(pushUpdate, () => {}),
  async propose(p) {
    const runId = [...agentRuns.keys()].at(-1); // ponytail: the newest live run; upgrade: the MCP session's run id
    const x = await draft(dirs(), { ...p, ...(runId ? { runId } : {}) });
    return `Saved as a draft of ${x.name}. Shrike keeps it by itself once ${OUTCOME[x.expect].done}; until then the skill file stays as it is.`;
  },
};

export const services = {
  dirs,
  emit: (...a: Parameters<Emit>) => emit(...a),
};
