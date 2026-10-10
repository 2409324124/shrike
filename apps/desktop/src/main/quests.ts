import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Flow, FlowStep, GhIssue, Quest, QuestAct, QuestHost, QuestObjective } from "@shrike/schema";
import { createIssue, issueView, listIssues, type Gh } from "./github.ts";
export { focused } from "./sdlc.ts";

// QB1–QB9: quests. An idea, objectives in plain words, each proven by a flow. Pure state machine (tested) plus a small
// service over <project>/.shrike/quests/<id>.json. Electron-free: ipc.ts wires approvals, flows, gh and the outcome in.

export type Plan = { title: string; objectives: { text: string; doneWhen: string; flowId?: string }[] };

const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};
const touch = (q: Quest, at = Date.now()): Quest => ({ ...q, updatedAt: at });
const nextId = (q: Quest) => `o${Math.max(0, ...q.objectives.map((o) => Number(o.id.slice(1)) || 0)) + 1}`;
const live = (q: Quest) => q.objectives.filter((o) => o.state !== "dropped");

export function newQuest(idea: string, o: { title?: string; issue?: Quest["issue"]; at?: number } = {}): Quest {
  const at = o.at ?? Date.now();
  const text = idea.trim();
  return { id: randomBytes(4).toString("hex"), title: clip(o.title ?? text.split("\n")[0]!, 80) || "New quest", idea: text.slice(0, 4000), state: "planning", objectives: [], ...(o.issue ? { issue: o.issue } : {}), createdAt: at, updatedAt: at, focusAt: at };
}

/** QB3: the agent's plan, shown ghosted while it waits for the user. */
export function proposePlan(q: Quest, p: Plan, runId?: string): Quest {
  if (q.state !== "planning") throw new Error(`The quest "${q.title}" is already ${q.state === "active" ? "under way" : q.state}.`);
  const objectives: QuestObjective[] = p.objectives.slice(0, 8).map((x, i) => ({ id: `o${i + 1}`, text: clip(x.text, 160), doneWhen: clip(x.doneWhen, 200), ...(x.flowId ? { flowId: x.flowId, linkedAt: Date.now() } : {}), state: "todo" }));
  return touch({ ...q, title: clip(p.title, 80) || q.title, objectives, waiting: true, ...(runId ? { runId } : {}) });
}

export function answerPlan(q: Quest, approved: boolean): Quest {
  const { waiting: _w, ...rest } = q;
  return touch(approved ? { ...rest, state: "active" } : { ...rest, objectives: [] });
}

export function editObjective(q: Quest, id: string | undefined, patch: { text?: string; doneWhen?: string; state?: "todo" | "working" | "dropped" }, at = Date.now()): Quest {
  if (q.state === "complete" || q.state === "dropped") throw new Error(`The quest "${q.title}" is ${q.state === "complete" ? "complete" : "dropped"}.`);
  if (!id) {
    if (!patch.text?.trim() || !patch.doneWhen?.trim()) throw new Error("A new objective needs text and doneWhen.");
    return touch({ ...q, objectives: [...q.objectives, { id: nextId(q), text: clip(patch.text, 160), doneWhen: clip(patch.doneWhen, 200), state: "todo" }] });
  }
  if (!q.objectives.some((o) => o.id === id)) throw new Error(`No objective "${id}" in "${q.title}". It has ${q.objectives.map((o) => o.id).join(", ") || "none"}.`);
  return touch({
    ...q,
    objectives: q.objectives.map((o) => {
      if (o.id !== id) return o;
      const text = patch.text?.trim() ? clip(patch.text, 160) : o.text;
      const doneWhen = patch.doneWhen?.trim() ? clip(patch.doneWhen, 200) : o.doneWhen;
      const { runAt: _r, ...unproven } = o;
      const reworded = (text !== o.text || doneWhen !== o.doneWhen) && (o.state === "done" || o.state === "failed");
      return {
        ...(reworded ? { ...unproven, state: "todo" as const, linkedAt: at } : o), // new words need a new passing run
        text,
        doneWhen,
        ...(patch.state && o.state !== "done" ? { state: patch.state } : {}), // done comes only from a passing flow (QB6)
      };
    }),
  });
}

/** Linking a new flow starts that objective's proof over. */
export function linkObjective(q: Quest, id: string, flowId: string | null, at = Date.now()): Quest {
  if (!q.objectives.some((o) => o.id === id)) throw new Error(`No objective "${id}".`);
  return touch({
    ...q,
    objectives: q.objectives.map((o) => {
      if (o.id !== id || o.flowId === (flowId ?? undefined)) return o;
      const { flowId: _f, runAt: _r, linkedAt: _l, ...rest } = o;
      return { ...rest, ...(flowId ? { flowId, linkedAt: at } : {}), state: o.state === "dropped" ? "dropped" : "todo" };
    }),
  });
}

export const mark = (q: Quest, id: string, p: Partial<Pick<QuestObjective, "sentAt" | "workspace">>): Quest => touch({ ...q, objectives: q.objectives.map((o) => (o.id === id ? { ...o, ...p } : o)) });

/** QB6: a linked flow that ran since it was linked (and the quest began) decides its objective. All green: the quest completes. */
export function settleFlows(q: Quest, flows: Flow[], at = Date.now()): { quest: Quest; changed: boolean; completed: boolean } {
  if (q.state !== "active") return { quest: q, changed: false, completed: false };
  let reds = q.reds ?? 0;
  let changed = false;
  const objectives = q.objectives.map((o) => {
    const run = o.flowId && o.state !== "dropped" ? flows.find((f) => f.id === o.flowId)?.lastRun : undefined;
    if (!run || run.at < Math.max(q.createdAt, o.linkedAt ?? 0) || run.at === o.runAt) return o;
    changed = true;
    if (!run.ok) reds++;
    return { ...o, runAt: run.at, state: run.ok ? ("done" as const) : ("failed" as const) };
  });
  if (!changed) return { quest: q, changed: false, completed: false };
  const next: Quest = { ...q, objectives, reds, updatedAt: at };
  const completed = live(next).length > 0 && live(next).every((o) => o.state === "done");
  return { quest: completed ? { ...next, state: "complete", completedAt: at } : next, changed, completed };
}

// ---- QB1: a GitHub issue as a quest ----

/** Markdown to one plain line: no code ticks, links keep their words, no emphasis marks. */
export const plain = (s: string): string =>
  s.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/`([^`]*)`/g, "$1").replace(/(\*\*|__|~~)(.*?)\1/g, "$2").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

/** The idea the plan-feature run reads: the issue's words (its task list kept, as a start for objectives) without HTML comments or images. */
export function issueIdea(i: GhIssue): { title: string; idea: string } {
  const body = i.body.replace(/<!--[\s\S]*?-->/g, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const title = plain(i.title) || `Issue #${i.number}`;
  return { title, idea: `${title}\n\nFrom GitHub issue #${i.number}${body ? `:\n${clip3500(body)}` : "."}` };
}
const clip3500 = (s: string) => (s.length > 3500 ? `${s.slice(0, 3499)}…` : s);

/** QB8: the issue Shrike would open, as the approval card shows it. */
export function issueBody(q: Quest): string {
  const objectives = live(q).map((o) => `- [${o.state === "done" ? "x" : " "}] ${o.text} (done when: ${o.doneWhen})`);
  return `${q.idea}${objectives.length ? `\n\n### Objectives\n\n${objectives.join("\n")}` : ""}\n\n_Planned in Shrike._`;
}

// ---- storage ----

const ID = /^[0-9a-f]{8}$/;
export const questsDir = (root: string) => join(root, ".shrike", "quests");

const objectiveSchema = z.object({
  id: z.string().regex(/^o\d{1,3}$/),
  text: z.string().max(400),
  doneWhen: z.string().max(400),
  flowId: z.string().max(80).optional(),
  state: z.enum(["todo", "working", "done", "failed", "dropped"]),
  runAt: z.number().optional(),
  linkedAt: z.number().optional(),
  sentAt: z.number().optional(),
  workspace: z.string().max(400).optional(),
});
const questSchema = z.object({
  id: z.string().regex(ID),
  title: z.string().max(200),
  idea: z.string().max(8000),
  state: z.enum(["planning", "active", "complete", "dropped"]),
  objectives: z.array(objectiveSchema).max(20),
  issue: z.object({ number: z.number().int(), url: z.string().max(400), imported: z.boolean().optional() }).optional(),
  runId: z.string().max(80).optional(),
  waiting: z.boolean().optional(),
  reds: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  focusAt: z.number().optional(),
  completedAt: z.number().optional(),
});

export async function readQuests(root: string): Promise<Quest[]> {
  const names = (await readdir(questsDir(root)).catch(() => [] as string[])).filter((f) => ID.test(f.replace(/\.json$/, "")) && f.endsWith(".json"));
  const parse = (t: string) => {
    try {
      return questSchema.safeParse(JSON.parse(t)).data as Quest | undefined;
    } catch {
      return undefined; // a half-written or hand-broken file is skipped, never fatal
    }
  };
  const all = await Promise.all(names.map(async (f) => parse(await readFile(join(questsDir(root), f), "utf8").catch(() => ""))));
  return all.filter((q): q is Quest => !!q).sort((a, b) => a.createdAt - b.createdAt);
}

export async function writeQuest(root: string, q: Quest): Promise<void> {
  const dir = questsDir(root);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${q.id}.${randomBytes(3).toString("hex")}.tmp`);
  await writeFile(tmp, `${JSON.stringify(q, null, 1)}\n`);
  await rename(tmp, join(dir, `${q.id}.json`));
}

// ---- the service ----

export interface QuestDeps {
  root(): string | undefined;
  emit(list: Quest[]): void;
  approve(title: string, reason: string, quest?: string): Promise<boolean>;
  flows(): Promise<Flow[]>;
  saveFlow(name: string, steps: FlowStep[]): Promise<Flow>;
  runFlow(id: string): Promise<unknown>;
  gh: Gh;
  liveRun(): string | undefined;
  completed(q: Quest): void; // QB7: settle plan-feature, [Quest Complete], the result screen
  dropped(q: Quest): void;
}

export function createQuests(d: QuestDeps) {
  let chain: Promise<unknown> = Promise.resolve();
  const need = () => {
    const r = d.root();
    if (!r) throw new Error("No project is open.");
    return r;
  };
  const push = async (root: string) => d.emit(await readQuests(root));
  /** Read, change and write one quest, one change at a time. */
  const change = <T>(id: string, fn: (q: Quest) => Quest | Promise<Quest>, after?: (q: Quest, before: Quest) => T): Promise<Quest> => {
    const run = async () => {
      const root = need();
      const before = (await readQuests(root)).find((q) => q.id === id);
      if (!before) throw new Error(`No quest "${id}". Call list_quests to see them.`);
      const q = await fn(before);
      await writeQuest(root, q);
      await push(root);
      after?.(q, before);
      return q;
    };
    const next = chain.then(run, run);
    chain = next.catch(() => {});
    return next;
  };
  const add = async (q: Quest) => {
    const root = need();
    await writeQuest(root, q);
    await push(root);
    return q;
  };
  const find = async (id: string) => {
    const q = (await readQuests(need())).find((x) => x.id === id);
    if (!q) throw new Error(`No quest "${id}".`);
    return q;
  };
  const resolveFlow = async (ref: { id?: string; name?: string }): Promise<Flow> => {
    const all = await d.flows();
    const f = all.find((x) => x.id === ref.id) ?? all.find((x) => ref.name && x.name.toLowerCase() === ref.name.trim().toLowerCase());
    if (!f) throw new Error(`No saved flow ${ref.id ? `"${ref.id}"` : `named "${ref.name}"`}. Saved flows: ${all.map((x) => `${x.id} (${x.name})`).join(", ") || "none"}. Pass steps to record a new one.`);
    return f;
  };
  /** Only a run after linking counts; this settles one that raced the link. */
  const settleNow = async (id: string) => {
    const flows = await d.flows();
    await change(id, (q) => settleFlows(q, flows).quest, (q, before) => before.state !== "complete" && q.state === "complete" && d.completed(q));
  };

  const host: QuestHost = {
    list: async () => readQuests(need()),
    flows: () => d.flows(),
    async propose(p) {
      const root = need();
      const runId = d.liveRun();
      const list = await readQuests(root);
      const base = (p.questId && list.find((q) => q.id === p.questId)) || list.findLast((q) => q.state === "planning" && (!runId || !q.runId || q.runId === runId));
      const q = await (base ? change(base.id, (x) => proposePlan(x, p, runId)) : add(proposePlan(newQuest(p.title), p, runId)));
      const steps = q.objectives.map((o, i) => `${i + 1}. ${o.text} (done when: ${o.doneWhen})`).join("\n");
      const approved = await d.approve(`Start the quest "${q.title}"?`, `Your agent's plan, ${q.objectives.length} objective${q.objectives.length === 1 ? "" : "s"}. Each one is checked off when its flow passes.\n${steps}`, q.id);
      const quest = await change(q.id, (x) => answerPlan(x, approved));
      if (approved && quest.objectives.some((o) => o.flowId)) await settleNow(quest.id);
      return { approved, quest: approved ? await find(quest.id) : quest };
    },
    async updateObjective(questId, objectiveId, patch) {
      const o = patch.state === "dropped" && objectiveId ? (await find(questId)).objectives.find((x) => x.id === objectiveId && x.state !== "dropped") : undefined;
      // a dropped objective no longer has to pass, so the user decides
      if (o && !(await d.approve(`Drop "${o.text}" from the quest?`, `Your agent wants to stop proving this one. The quest can then complete without it.\nDone when: ${o.doneWhen}`, questId))) throw new Error("The user kept this objective. It still has to pass.");
      return change(questId, (q) => editObjective(q, objectiveId, patch));
    },
    async linkFlow(questId, objectiveId, ref) {
      const flow = ref.steps?.length ? await d.saveFlow(ref.name?.trim() || objectiveId, ref.steps) : await resolveFlow(ref);
      await change(questId, (q) => linkObjective(q, objectiveId, flow.id));
      await settleNow(questId);
      return { quest: await find(questId), flow };
    },
  };

  return {
    host,
    list: async (): Promise<Quest[]> => (d.root() ? readQuests(need()) : []),
    plan: (idea: string) => add(newQuest(idea)),
    issues: () => listIssues(d.gh, need()),
    async importIssue(n: number): Promise<Quest> {
      const root = need();
      const have = (await readQuests(root)).find((q) => q.issue?.number === n && q.state !== "dropped");
      if (have) return change(have.id, (q) => touch({ ...q, focusAt: Date.now() }));
      const i = await issueView(d.gh, root, n);
      const { title, idea } = issueIdea(i);
      return add(newQuest(idea, { title, issue: { number: i.number, url: i.url, imported: true } }));
    },
    async act(id: string, a: QuestAct): Promise<Quest[]> {
      const root = need();
      if (a.kind === "focus") await change(id, (q) => touch({ ...q, focusAt: Date.now() }));
      else if (a.kind === "drop") await change(id, (q) => touch({ ...q, state: "dropped", waiting: false }), (q, before) => before.state !== "dropped" && d.dropped(q));
      else if (a.kind === "link") {
        await change(id, (q) => linkObjective(q, a.objective, a.flowId));
        await settleNow(id);
      } else if (a.kind === "sent") await change(id, (q) => mark(q, a.objective, { sentAt: Date.now(), ...(a.workspace ? { workspace: a.workspace } : {}) }));
      else if (a.kind === "check") {
        const o = (await find(id)).objectives.find((x) => x.id === a.objective);
        if (!o?.flowId) throw new Error("Link a flow to this objective first.");
        await d.runFlow(o.flowId); // flows:update then settles it (observe)
      } else if (a.kind === "open-issue") {
        const q = await find(id);
        if (q.issue) throw new Error(`This quest is already issue #${q.issue.number}.`);
        const body = issueBody(q);
        if (!(await d.approve(`Open "${q.title}" as a GitHub issue?`, `Shrike will post this to GitHub:\n\n${q.title}\n\n${body}`, q.id))) return readQuests(root);
        const made = await createIssue(d.gh, root, { title: q.title, body });
        await change(id, (x) => touch({ ...x, issue: made }));
      }
      return readQuests(root);
    },
    /** Every main→renderer event passes through here (ipc.ts emit). */
    observe(channel: string, payload: unknown): void {
      if (channel === "project:opened") void push(need()).catch(() => {});
      if (channel !== "flows:update" || !Array.isArray(payload) || !d.root()) return;
      const flows = payload as Flow[];
      void readQuests(need())
        .then((list) => Promise.all(list.filter((q) => settleFlows(q, flows).changed).map((q) => change(q.id, (x) => settleFlows(x, flows).quest, (x, before) => before.state !== "complete" && x.state === "complete" && d.completed(x)))))
        .catch(() => {});
    },
  };
}

export type Quests = ReturnType<typeof createQuests>;
