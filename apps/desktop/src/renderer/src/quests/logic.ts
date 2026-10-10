import type { Flow, Quest, QuestObjective, SdlcState } from "@shrike/schema";

// QB: the quest board's pure parts. No runtime imports: tests run them with node:test.

/** "Plan this: edit a todo" from the composer: the idea, or null for an ordinary ask. */
export function planThis(text: string): string | null {
  const m = /^\s*plan this\s*:\s*([\s\S]+)$/i.exec(text);
  const idea = m?.[1]?.trim();
  return idea ? idea : null;
}

/** The ask that starts plan-feature; the run finds the quest by its id. */
export const planGoal = (q: Quest): string => `Plan this feature as Shrike quest ${q.id}: ${q.idea}\n\nLoad the plan-feature playbook with load_skill first and follow it.`;

/** The idea under the title, in plain words: no repeat of the title, no markdown marks. */
export function ideaPreview(q: Quest): string {
  const lines = q.idea.split("\n");
  const rest = lines[0]!.trim().toLowerCase() === q.title.trim().toLowerCase() ? lines.slice(1) : lines;
  return rest.join(" ").replace(/^#+\s*|\s#+\s/g, " ").replace(/[*+-]\s+\[[ x]\]\s+/gi, "· ").replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
}

export const liveObjectives = (q: Quest): QuestObjective[] => q.objectives.filter((o) => o.state !== "dropped");

/** QB4: only the next objective shows its buttons: the first that isn't done (a broken one first). */
export function nextObjective(q: Quest): QuestObjective | undefined {
  if (q.state !== "active") return undefined;
  const live = liveObjectives(q);
  return live.find((o) => o.state === "failed") ?? live.find((o) => o.state !== "done");
}

export type Look = "ghost" | "next" | "passed" | "failed" | "dropped";
/** QB-thread: how an objective's thread is drawn. */
export function lookOf(q: Quest, o: QuestObjective): Look {
  if (o.state === "dropped") return "dropped";
  if (o.state === "done") return "passed";
  if (o.state === "failed") return "failed";
  return nextObjective(q)?.id === o.id ? "next" : "ghost";
}

export const progressOf = (q: Quest): { done: number; total: number } => {
  const live = liveObjectives(q);
  return { done: live.filter((o) => o.state === "done").length, total: live.length };
};

/** QB5: the one that glows: the user's pick while it's on the board, else the newest focused open quest. */
export function focusedQuest(list: Quest[], pick: string | null): Quest | undefined {
  const shown = list.filter((q) => q.state !== "dropped");
  return shown.find((q) => q.id === pick) ?? [...shown].sort((a, b) => rank(b) - rank(a) || (b.focusAt ?? b.createdAt) - (a.focusAt ?? a.createdAt))[0];
}
const rank = (q: Quest) => (q.state === "complete" ? 0 : 1);

/** P1: what goes to the agent's up next for one objective. */
export function objectivePrompt(q: Quest, o: QuestObjective, flow?: Flow): string {
  return `Quest "${q.title}" (${q.id}), objective ${o.id}: ${o.text}.\nDone when: ${o.doneWhen}.${flow ? `\nIts flow "${flow.name}" proves it; run the app and make that flow pass.` : "\nThere's no flow for it yet: record one with link_flow first."}\nBuild only this objective, with propose_patch.`;
}

export const recordPrompt = (q: Quest, o: QuestObjective): string =>
  `For quest ${q.id}, record a flow that proves objective ${o.id} ("${o.text}", done when: ${o.doneWhen}). Use link_flow with steps that click and type by the visible names in the app.`;

/** WS2: a workspace name for one objective. */
export const workspaceName = (o: QuestObjective): string =>
  o.text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 5).join("-").slice(0, 40) || o.id;

export type RailMode = "fix" | "build";
/** L-mode: a broken trip in focus shows Fix, a quest in flight shows Build; a pick holds until what's in flight changes. */
export function railMode(s: SdlcState | null, pick: { mode: RailMode; key: string } | null, focusBroken: boolean): RailMode | null {
  const fix = !!s?.actionId;
  const build = !!s?.build;
  if (!fix && !build) return null;
  if (pick && pick.key === inFlight(s) && (pick.mode === "fix" ? fix : build)) return pick.mode;
  if (fix && build) return focusBroken ? "fix" : "build";
  return fix ? "fix" : "build";
}
export const inFlight = (s: SdlcState | null): string => `${s?.actionId ?? ""}|${s?.build?.questId ?? ""}`;
