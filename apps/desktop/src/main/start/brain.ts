import type { AgentRunInfo, AgentStep, BrainId, ProjectInfo, ToolNeed } from "@shrike/schema";
import { startAgentRun } from "@shrike/agent";
import type { Recipe } from "./recipes.ts";
import { runSkillId } from "./runskill.ts";
import type { StartSession } from "./session.ts";

// R5: every Run is driven by Claude at full effort (owner: "start with Claude, end with Claude; don't save tokens").

export const START_EFFORT = "max" as const;
const PLAYBOOK_MAX = 60_000;

export const NUDGE =
  "The app is up, but you haven't ended with a skill yet. Call save_run_skill now with the whole recipe that worked (or mark_skill_used if you followed the run skill exactly and learned nothing), then propose_lesson for anything generic, then stop.";

const SOURCE_WORDS: Record<Recipe["source"], string> = {
  "shrike-skill": "Shrike run skill",
  "project-skill": "the project's own Claude Code skill (read-only)",
  "claude-skill": "the user's Claude Code skill (read-only)",
  readme: "README setup section",
  explored: "explored",
  lessons: "lessons",
};

export function startVars(o: { project: ProjectInfo; recipes: Recipe[]; lessons: Recipe[]; setupFiles: string[]; portOffset?: number }): Record<string, string> {
  const { project, recipes, lessons } = o;
  const best = recipes[0];
  const id = runSkillId(project.name);
  const hints = [
    ...project.processes.map((p) => `- ${p.name}: \`${p.command}\`${p.cwd ? ` in ${p.cwd}` : ""}${p.url ? ` at ${p.url}` : ""}`),
    ...(project.appUrl ? [`- page probably at ${project.appUrl}`] : []),
    ...(project.notes ?? []).map((n) => `- note: ${n}`),
    ...(o.portOffset ? [`- this is a worktree: Shrike moves every port the project declares by +${o.portOffset} and sets <NAME>_PORT, APP_PORT and PORT to the moved ones, so it runs beside the main checkout. Check the moved ports; Shrike's tools move a declared port for you.`] : []),
  ];
  return {
    project: project.name,
    root: project.root,
    recipes: recipes.length
      ? recipes.map((r, i) => `${i + 1}. \`${r.id}\` · ${SOURCE_WORDS[r.source]} · **${r.name}**: ${r.when || "no description"} (${r.path})${r.files?.length ? `; folder also has ${r.files.map((f) => f.split("/").pop()).join(", ")}` : ""}`).join("\n")
      : "None. There is no run skill, project skill or README setup section: explore first (R2).",
    playbook: best ? `${best.name} (${SOURCE_WORDS[best.source]}, ${best.path})\n\n${best.body.slice(0, PLAYBOOK_MAX)}${best.body.length > PLAYBOOK_MAX ? "\n…(cut: read_recipe for the rest)" : ""}` : "(none: explore the project first, then plan)",
    lessons: lessons[0]?.body ?? "(none yet)",
    setupFiles: o.setupFiles.length ? o.setupFiles.map((f) => `- ${f}`).join("\n") : "- (none of the usual ones)",
    hints: hints.length ? `${hints.join("\n")}\nThese came from reading package.json and folder names, not from running anything. Check them against the recipe and the files before running any of them.` : "(none)",
    runSkill: id,
  };
}

export function startGoal(project: ProjectInfo, recipes: Recipe[], tools: ToolNeed[] = []): string {
  const best = recipes[0];
  const id = runSkillId(project.name);
  const first = best
    ? best.source === "shrike-skill"
      ? `Start with the skill: follow the Shrike run skill ${best.skillId ?? id} (your playbook above) step by step.`
      : `Start with the skill: your playbook is ${best.name} (${SOURCE_WORDS[best.source]}). Follow it; it's read-only, so what you learn goes into Shrike's own run skill ${id}.`
    : "There's no recipe yet: explore the project first (README, scripts, task runner, compose, flake, CI, env templates), then plan.";
  return `Get ${project.name} running in Shrike: every service healthy and the page loaded in the app pane.\n${first}\nThen plan_steps, run each step, fix what fails, app_ready, and end with a skill: save_run_skill (${id}) or mark_skill_used, then propose_lesson for generic lessons.${tools.length ? `\nShrike checked this computer. The user already sees this, and Shrike never installs tools, so don't install or work around them: ${tools.map((t) => t.message).join(" ")}` : ""}`;
}

export const LESSON_NUDGE =
  "The app didn't come up, but every start still ends with a skill. Call propose_lesson with the one thing that blocked it (the error, what you tried, what the user needs to do), so the next start on any project knows. Then tell the user in one plain line what to do next, and stop.";

export interface BrainOpts {
  brain: BrainId;
  project: ProjectInfo;
  session: StartSession;
  recipes: Recipe[];
  lessons: Recipe[];
  setupFiles: string[];
  portOffset?: number; // W2: a worktree's ports
  tools?: ToolNeed[]; // what this computer is missing (notes only: a blocking one never gets here)
  mcp: { url: string; token: string };
  promptsDir: string;
  onStep?(step: AgentStep): void; // also shown in the agent column / X-ray, when wired
  onStatus?(info: AgentRunInfo): void;
  start?: typeof startAgentRun; // tests
}

/** Run the start agent; once the app is up, nudge it once (same Claude Code session) if it didn't end with a skill. */
export function runStartBrain(o: BrainOpts): { runId: string; stop(): void } {
  const start = o.start ?? startAgentRun;
  const vars = startVars(o);
  let session: string | undefined;
  let nudged = false;
  let current: { info: AgentRunInfo; stop(): void };
  const launch = (goal: string, resume?: string) =>
    start({
      goal,
      brain: o.brain,
      cwd: o.project.root,
      mcp: o.mcp,
      effort: START_EFFORT,
      promptsDir: o.promptsDir,
      prompt: { file: "start.md", vars },
      resume,
      context: { frontend: o.project.frontend, backend: o.project.backend, appUrl: o.project.appUrl, routeCount: o.project.routes.length, recentActions: "", memory: "", skills: "" },
      onSession: (id) => (session = id),
      onStep: (step) => {
        if (step.kind === "message" && !step.tool) o.session.say(step.text);
        if (step.kind === "error") o.session.lastError = step.text;
        o.onStep?.(step);
      },
      onStatus: (info) => {
        o.onStatus?.(info);
        if (info.status === "running") return;
        const next = o.session.agentEnded(info.status);
        if ((next === "nudge" || next === "lesson") && !nudged && o.brain === "claude-code" && session) {
          nudged = true;
          current = launch(next === "nudge" ? NUDGE : LESSON_NUDGE, session);
          o.session.quest.set({ runId: current.info.id });
          return;
        }
        if (next === "ready" || next === "nudge") o.session.finishReady(next === "nudge" ? "Claude didn't save a run skill this time." : undefined);
        else if (next === "failed" || next === "lesson") o.session.finishFailed(o.session.lastError ?? "Claude stopped before the app was up.");
        else if (next === "stopped") o.session.stop();
      },
    });
  current = launch(startGoal(o.project, o.recipes, o.tools));
  o.session.quest.set({ runId: current.info.id });
  return {
    get runId() {
      return current.info.id;
    },
    stop: () => current.stop(),
  };
}
