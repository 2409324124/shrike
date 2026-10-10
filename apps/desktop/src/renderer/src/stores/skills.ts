import { useEffect } from "react";
import { create } from "zustand";
import type { AgentRunInfo, AgentStep, Skill, SkillProposal } from "@shrike/schema";
import { api, call } from "../lib/api.ts";
import { skillReady } from "../mcp/store.ts"; // mcp: MCP7
import { useAgent } from "./agent.ts";
import { useProject } from "./project.ts";
import { useRun } from "./run.ts";
import { toast, useUi } from "./ui.ts";
import { runChain } from "../chains/store.ts";

export type ItemState = "done" | "active" | "todo" | "failed";

/** S3: checklist status from the run's steps. */
// ponytail: one item ticks per finished tool step, in order, and the last waits for the run to end. Upgrade: let the agent say which step it is on.
export function checklist(items: string[], steps: AgentStep[], status: AgentRunInfo["status"] | undefined): ItemState[] {
  if (status === "done") return items.map(() => "done");
  const cur = Math.min(steps.filter((s) => s.kind === "tool_result" || s.kind === "patch").length, items.length - 1);
  const stuck = status === "failed" || status === "stopped";
  return items.map((_, i) => (i < cur ? "done" : i === cur ? (stuck ? "failed" : "active") : "todo"));
}

/** Claude Code skills are named like slugs ("navigate-xyne-spaces"); show them as words. */
export function filterSkills(list: Skill[], q: string): Skill[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((s) => {
    const hay = `${s.id} ${s.name} ${s.when}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function improvedAgo(at: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)} days ago`;
}

export const sourceLabel = (s: Skill): string =>
  s.source === "claude" ? (s.readOnly === false ? "Claude · your copy" : "Claude") : s.source === "project" ? "This project" : s.source === "personal" ? "Yours" : "Built in";

interface SkillsState {
  list: Skill[];
  offer: number | null; // S2: Claude Code skills to offer, until answered
  query: string;
  active: { runId: string; skillId: string; name: string; items: string[] } | null; // S3
  proposals: SkillProposal[]; // S4, oldest first; the first one shows
  load(): Promise<void>;
  run(s: Skill, input?: string): Promise<void>;
  edit(s: Skill): Promise<void>;
  answer(id: string, keep: boolean): Promise<void>;
  importClaude(enable: boolean): Promise<void>;
  saveAsSkill(from: { actionId?: string; runId?: string; flowId?: string; name?: string }): Promise<Skill | undefined>;
  saveAsCommand(name: string, prompt: string): Promise<boolean>;
}

const setList = (list: Skill[]) => {
  useSkills.setState({ list });
  useAgent.setState({ skills: list }); // A4 chips and the lit playbook read the same list
};

// G*: built-in git skills run the git flows (approvals stay in those flows), not a plain agent run.
async function runGit(s: Skill): Promise<AgentRunInfo | null | undefined> {
  const a = api();
  const pr = async () => {
    const p = (await a.gitState()).pr;
    if (!p) throw new Error("There's no pull request for this branch yet. Ship the fix first.");
    return p;
  };
  switch (s.id) {
    case "ship-fix": {
      const p = await a.shipFix({});
      toast(`Opened pull request #${p.number}`, "ok");
      return null;
    }
    case "review-pr":
      return a.reviewPullRequest((await pr()).number);
    case "fix-conflicts":
      return a.resolveConflicts();
    case "explain-ci": {
      const p = await pr();
      const bad = p.checks.find((c) => c.state === "fail");
      if (!bad) throw new Error("No check has failed on this pull request.");
      return a.explainCheck(p.number, bad.name);
    }
    case "merge-when-green":
      await a.mergePullRequest((await pr()).number);
      toast("Merged", "ok");
      return null;
    case "sync-main":
      await a.syncWithMain();
      toast("Up to date with main", "ok");
      return null;
    default:
      return undefined; // not a known git flow: run it as a playbook
  }
}

export const useSkills = create<SkillsState>((set, get) => ({
  list: [],
  offer: null,
  query: "",
  active: null,
  proposals: [],
  async load() {
    const [list, offer] = await Promise.all([call((a) => a.listSkills(), "Couldn't load skills"), api().claudeSkillsOffer().catch(() => null)]);
    if (list) setList(list);
    set({ offer });
  },
  async run(s, input) {
    closeShelf();
    if (!(await skillReady(s, () => void get().run({ ...s, usesMcp: [] }, input)))) return; // MCP7: offers to add a tool it uses first
    if (s.kind === "run") return void (await useRun.getState().start()); // R4: a run skill is the start quest
    if (s.kind === "chain") return void (await runChain(`${s.id} ${input ?? ""}`)); // P4: a chain skill starts the chain
    let info: AgentRunInfo | null | undefined;
    try {
      info = s.kind === "git" ? await runGit(s) : undefined;
      if (s.kind === "git" && info !== undefined) creditGit(s.id, info?.id); // SL3: git skills don't load a playbook, so they say they ran
      if (info === undefined) info = await api().runSkill(s.id, input);
    } catch (e) {
      toast(`Couldn't run ${s.name}: ${e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, "") : String(e)}`, "error");
      return;
    }
    if (!info) return;
    const run = info;
    useAgent.setState((st) => ({ steps: [], approvals: [], answered: {}, usage: null, revising: null, sentNotes: [], run: st.run?.id === run.id ? { ...run, status: st.run.status } : run }));
    set({ active: s.steps?.length ? { runId: run.id, skillId: s.id, name: s.name, items: s.steps } : null });
  },
  async edit(s) {
    const path = await call((a) => a.editSkill(s.id), "Couldn't open the skill");
    if (!path) return;
    closeShelf();
    if (s.source !== "project") toast(`Made a copy in ${path} for this project. Edit it there.`, "info");
    useUi.getState().openFile({ path, line: 1 });
  },
  async answer(id, keep) {
    const p = get().proposals.find((x) => x.id === id);
    set((st) => ({ proposals: st.proposals.filter((x) => x.id !== id) }));
    const ok = await call((a) => a.answerSkillProposal(id, keep).then(() => true), keep ? "Couldn't keep the improvement" : "Couldn't discard it");
    if (!ok && p) set((st) => ({ proposals: [p, ...st.proposals] }));
    else if (ok && keep) toast("Kept. The skill is better next time.", "ok");
  },
  async importClaude(enable) {
    set({ offer: null });
    const list = await call((a) => a.importClaudeSkills(enable), "Couldn't change that");
    if (list) setList(list);
  },
  async saveAsSkill(from) {
    const s = await call((a) => a.saveAsSkill(from), "Couldn't save it as a skill");
    if (!s) return undefined;
    toast(`Saved the skill "${s.name}". Check its steps.`, "ok");
    const root = useProject.getState().project?.root;
    const rel = s.path && root && s.path.startsWith(`${root}/`) ? s.path.slice(root.length + 1) : `.shrike/skills/${s.id}.md`;
    useUi.getState().openFile({ path: rel, line: 1 });
    return s;
  },
  async saveAsCommand(name, prompt) {
    const ok = await call((a) => a.saveAsCommand(name, prompt).then(() => true), "Couldn't save the command");
    if (ok) toast(`Saved. Type /${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")} in Ask to use it again.`, "ok");
    return !!ok;
  },
}));

/** A git flow that finished now counts; one that started an agent run counts when that run ends done. */
function creditGit(id: string, runId?: string): void {
  const note = () => void api().noteSkillUse(id).catch(() => {});
  if (!runId) return note();
  const off = useAgent.subscribe((st) => {
    if (st.run?.id !== runId || st.run.status === "running") return;
    off();
    if (st.run.status === "done") note();
  });
}

/** S1: the shelf is the "skills" panel (K, bound by the sdlc engineer). */
export const toggleSkillShelf = (): void => useUi.getState().togglePanel("skills");
const closeShelf = () => {
  if (useUi.getState().panel === "skills") useUi.setState({ panel: null });
  useSkills.setState({ query: "" });
};

/** Subscribes the skill channels; reloads when the project changes or a project skill file is edited. Mount once (SkillsOverlay does). */
export function useSkillsBridge(): void {
  useEffect(() => {
    const a = api();
    const offs = [
      a.on("skills:update", (list) => Array.isArray(list) && setList(list)),
      a.on("skill:proposal", (p) => p && typeof p.id === "string" && useSkills.setState((st) => ({ proposals: [...st.proposals.filter((x) => x.id !== p.id), p] }))),
      a.on("file:changed", (f) => void (f?.path?.startsWith(".shrike/skills/") && useSkills.getState().load())),
      useProject.subscribe((st, prev) => void (st.project?.root !== prev.project?.root && useSkills.getState().load())),
    ];
    void useSkills.getState().load();
    return () => offs.forEach((off) => off());
  }, []);
}
