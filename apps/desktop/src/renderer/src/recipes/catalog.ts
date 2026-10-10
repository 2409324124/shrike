import type { ActionRecipe, RecipeSettings } from "@shrike/schema";

// S8: the action catalogue and its pure helpers, shared by main/recipes.ts, the Recipes screen and the mock. Electron-free.

/** One pass: {name} becomes vars[name]; a variable nobody gave stays as typed, so a typo is visible in the prompt. */
export const renderTemplate = (template: string, vars: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? vars[k]! : m));

const FLAGS = new Set(["--model", "--fallback-model"]);
const VALUE = /^[\w.:[\]-]{1,80}$/;

/** CLI arguments for Claude Code: only flags that change the model, never tools or permissions. Throws with plain words. */
export function parseArgs(text: string): string[] {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const [flag, inline] = parts[i]!.split(/=(.*)/s);
    const value = inline ?? parts[++i];
    if (!FLAGS.has(flag!)) throw new Error(`Shrike only passes ${[...FLAGS].join(" and ")} to the agent. "${flag}" isn't allowed.`);
    if (!value || !VALUE.test(value)) throw new Error(`${flag} needs a model name after it.`);
    out.push(flag!, value);
  }
  return out;
}

const V = {
  basePrompt: "The skill's steps",
  context: "What Shrike gathered for this action",
  project: "Project name",
  branch: "Current branch",
  baseBranch: "Branch it merges into",
  stagedFiles: "Files staged for the commit",
  stagedPatch: "The staged diff",
  changedFiles: "Files this branch changes",
  commitSummary: "This branch's commits, one per line",
  linkedIssue: "The issue it fixes",
  trip: "The trip, in one line",
  failingStep: "The step that failed",
  flow: "The saved flow's name",
} as const;
export type Var = keyof typeof V;

export interface Action {
  id: string;
  name: string;
  description: string;
  skillId?: string;
  vars: Var[];
  template: string;
  wired?: boolean;
}

// Wired actions default to {context}: the agent loads the skill itself through load_skill, which is what counts its uses.
export const ACTIONS: Action[] = [
  { id: "get-running", name: "Get it running", description: "Start every service and load the app, following the run skill", skillId: "starting-apps", vars: ["basePrompt", "project", "context"], template: "{context}" },
  { id: "what-happened", name: "What happened", description: "Explain a trip in plain words", vars: ["trip", "failingStep", "project", "context"], template: "Explain what happened in {trip} in plain words.\n\n{context}" },
  { id: "fix", name: "Fix", description: "Find the cause of a broken trip and propose the smallest fix", vars: ["trip", "failingStep", "project", "context"], template: "{trip} broke at {failingStep}. Find the cause and fix it.\n\n{context}" },
  { id: "flow-review", name: "Flow review", description: "Replay a saved flow and check every trip came back clean", vars: ["flow", "project", "context"], template: "Replay the flow {flow} and check every trip came back clean.\n\n{context}" },
  { id: "commit-message", name: "Commit message", description: "Write the commit message for what's staged", skillId: "commit-message", vars: ["basePrompt", "branch", "stagedFiles", "stagedPatch", "trip", "linkedIssue"], template: "{basePrompt}\n\nBranch: {branch}\nStaged files:\n{stagedFiles}\n\n<patch>\n{stagedPatch}\n</patch>", wired: true },
  { id: "pr-details", name: "Pull request details", description: "Write the pull request's title and description", skillId: "pr-details", vars: ["basePrompt", "branch", "baseBranch", "changedFiles", "commitSummary", "linkedIssue", "trip"], template: "{basePrompt}\n\n{branch} into {baseBranch}.\nCommits:\n{commitSummary}\nChanged files:\n{changedFiles}\nIssue: {linkedIssue}" },
  { id: "branch-name", name: "Branch name", description: "Name the branch for a fix", skillId: "branch-name", vars: ["basePrompt", "trip", "linkedIssue", "baseBranch"], template: "{basePrompt}\n\nWhat it's for: {trip}\nIssue: {linkedIssue}\nBase: {baseBranch}" },
  { id: "commit-failure", name: "Commit failure fixes", description: "Fix what a pre-commit hook refused", skillId: "commit-failure", vars: ["basePrompt", "branch", "stagedFiles", "context"], template: "{basePrompt}\n\nThe commit on {branch} was refused.\nStaged files:\n{stagedFiles}\n\n{context}" },
  { id: "push-failure", name: "Push failure fixes", description: "Fix a refused push without force-pushing", skillId: "push-failure", vars: ["basePrompt", "branch", "baseBranch", "context"], template: "{basePrompt}\n\nPushing {branch} failed.\n\n{context}" },
  { id: "broken-checks", name: "Broken checks", description: "Explain why a check on the pull request failed", skillId: "explain-ci", vars: ["basePrompt", "branch", "failingStep", "context"], template: "{context}", wired: true },
  { id: "conflict-resolution", name: "Conflict resolution", description: "Propose a resolution for every conflicted file", skillId: "fix-conflicts", vars: ["basePrompt", "branch", "baseBranch", "changedFiles", "context"], template: "{context}", wired: true },
  { id: "merge-when-green", name: "Merge when green", description: "Merge once every check and flow is green", skillId: "merge-when-green", vars: ["basePrompt", "branch", "baseBranch", "context"], template: "{basePrompt}\n\nMerge {branch} into {baseBranch} once every check is green.\n\n{context}" },
  { id: "sync-main", name: "Sync main", description: "Bring the branch up to date with main", skillId: "sync-main", vars: ["basePrompt", "branch", "baseBranch", "context"], template: "{basePrompt}\n\nBring {branch} up to date with {baseBranch}.\n\n{context}" },
  { id: "review-pr", name: "Review PR", description: "Review a pull request without posting anything", skillId: "review-pr", vars: ["basePrompt", "branch", "baseBranch", "changedFiles", "context"], template: "{context}", wired: true },
];

/** Same id as main/start/runskill.ts runSkillId (recipes.test checks they agree). */
export const runSkillFor = (projectName: string) => `run-${projectName.replace(/^@[^/]+\//, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "app"}`;

/** What a save keeps: only fields that differ from what that scope inherits (built-in for personal, personal for project). */
export function changedFrom(base: ActionRecipe, s: RecipeSettings): RecipeSettings {
  const args = s.args?.trim();
  return {
    ...(s.agent !== undefined && s.agent !== base.agent ? { agent: s.agent } : {}),
    ...(args !== undefined && args !== base.args ? { args } : {}),
    ...(s.template?.trim() && s.template !== base.template ? { template: s.template } : {}),
  };
}

/** Built-in < personal < project, per field. */
export function merged(a: Action, personal: Record<string, RecipeSettings> | null, project: Record<string, RecipeSettings> | null): ActionRecipe {
  const me = personal?.[a.id] ?? {};
  const here = project?.[a.id] ?? {};
  const set = (s: RecipeSettings) => s.agent !== undefined || s.args !== undefined || s.template !== undefined;
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    ...(a.skillId ? { skillId: a.skillId } : {}),
    vars: a.vars.map((name) => ({ name, hint: V[name] })),
    defaultTemplate: a.template,
    agent: here.agent ?? me.agent ?? "default",
    args: here.args ?? me.args ?? "",
    template: here.template ?? me.template ?? a.template,
    from: set(here) ? "project" : set(me) ? "personal" : "builtin",
    wired: !!a.wired,
  };
}

