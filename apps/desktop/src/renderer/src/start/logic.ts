import type { ProjectInfo, SkillEvent, StartCategory, StartPlan, StartStep } from "@shrike/schema";

// R/SL5: pure helpers for the start quest (tested in logic.test.ts).

/** A step update into the plan it belongs to (a new id is added before the closing skill step). */
export function mergeStep(plan: StartPlan | null, step: StartStep): StartPlan | null {
  if (!plan) return plan;
  const i = plan.steps.findIndex((s) => s.id === step.id);
  if (i >= 0) return { ...plan, steps: plan.steps.map((s, j) => (j === i ? step : s)) };
  const end = plan.steps.findIndex((s) => s.id === "skill");
  const steps = [...plan.steps];
  steps.splice(end < 0 ? steps.length : end, 0, step);
  return { ...plan, steps };
}

/** The step the user should look at: waiting on them, then running, then stuck, then the last one that moved. */
export function focusStep(plan: StartPlan | null): StartStep | undefined {
  const steps = plan?.steps ?? [];
  return steps.find((s) => s.state === "waiting_approval") ?? steps.findLast((s) => s.state === "running") ?? steps.findLast((s) => s.state === "failed") ?? steps.findLast((s) => s.state !== "pending");
}

export const questTitle = (plan: Pick<StartPlan, "name" | "projectRoot"> | null, fallback = "your app"): string => `Get ${plan?.name || plan?.projectRoot.split("/").pop() || fallback} running`;

export const SOURCE_WORDS: Record<NonNullable<StartPlan["recipes"]>[number]["source"], string> = {
  "shrike-skill": "your Shrike run skill",
  "project-skill": "the project's own Claude skill",
  "claude-skill": "your Claude skill",
  readme: "the README",
  explored: "exploring the project",
  lessons: "starting-apps lessons",
};

/** "Following run-xyne-spaces (the project's own Claude skill)" or "No recipe yet: Claude explores first". */
export function playbookLine(plan: StartPlan | null): string {
  const best = plan?.recipes?.find((r) => r.source !== "lessons");
  return best ? `Following ${best.name} (${SOURCE_WORDS[best.source]})` : "No recipe yet: Claude explores the project first";
}

export const CATEGORY_LABEL: Record<StartCategory, string> = {
  inspect: "Look around",
  install: "Install packages",
  build: "Build",
  service: "Start a local service",
  health: "Health check",
  env: "Settings (env file)",
  migrate: "Database changes",
  "free-port": "Stop another program",
  outside: "Outside the project",
  write: "Change project files",
  clean: "Delete build output",
  other: "Unrecognised commands",
};

/** The last `n` lines of a step's output. */
export const tailLines = (s: string | undefined, n: number): string => (s ?? "").replace(/\s+$/, "").split("\n").slice(-n).join("\n");

/** Live (Claude is working) vs over. */
export const questLive = (plan: StartPlan | null): boolean => plan?.state === "planning" || plan?.state === "running";

/** Lanes-from-plan: the project with the plan's expected lanes, or the same object when the plan has none or is another project's. */
export function withPlanPlaces(project: ProjectInfo | null, plan: StartPlan | null): ProjectInfo | null {
  if (!project || !plan?.places?.length || plan.projectRoot !== project.root) return project;
  if (project.placesFrom === "plan" && JSON.stringify(project.expectedPlaces) === JSON.stringify(plan.places)) return project;
  return { ...project, expectedPlaces: plan.places, placesFrom: "plan" };
}

/** SL2: a kept improvement plays [Level Up] now: it jumps ahead of a [Quest Complete] window that is still on screen. null = leave the queue alone. */
export function promoteLevelUp(current: SkillEvent | null, queue: readonly SkillEvent[]): { current: SkillEvent; queue: SkillEvent[] } | null {
  const i = queue.findIndex((e) => e.kind === "leveled");
  if (current?.kind !== "quest_complete" || i < 0) return null;
  return { current: queue[i]!, queue: queue.filter((_, j) => j !== i) };
}

/** The improvement waiting for Keep in a finished quest, if any. */
export const toKeep = (plan: StartPlan | null) => (plan?.state === "ready" ? plan.rewards?.find((r) => r.kind === "proposed" && r.proposalId) : undefined);
