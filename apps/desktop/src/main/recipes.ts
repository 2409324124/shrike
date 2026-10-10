import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { ActionRecipe, BrainId, RecipeAgent, RecipeSettings } from "@shrike/schema";
import { ACTIONS, changedFrom, merged, parseArgs, renderTemplate, runSkillFor, type Var } from "../renderer/src/recipes/catalog.ts";
import { loadSkills, services, type SkillDirs } from "./skills.ts";

// S8 action recipes: each action's prompt template, agent and CLI arguments, Orca-style.
// Built-in < personal (~/.shrike/recipes.json) < project (<project>/.shrike/recipes.json), per field. {basePrompt} is the skill's body.
// Electron-free; ipc.ts handles listRecipes/saveRecipe/resetRecipe and call sites use resolveRecipe.

const LAUNCHABLE: readonly RecipeAgent[] = ["default", "claude-code", "builtin"];
const AGENTS = ["default", "claude-code", "builtin", "claude-teams", "codex", "opencode"] as const;

const settings = z.object({ agent: z.enum(AGENTS).optional(), args: z.string().max(500).optional(), template: z.string().max(20_000).optional() }).strict();
const file = z.object({ recipes: z.record(z.string(), settings) });
type Saved = Record<string, RecipeSettings>;

export const recipeFiles = (d: SkillDirs) => ({ personal: join(dirname(d.personal), "recipes.json"), ...(d.project ? { project: join(d.project, ".shrike", "recipes.json") } : {}) });

/** null when there's no file; throws when it's there but not ours to read, so a save never overwrites it. */
async function readSaved(path: string): Promise<Saved | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const ok = file.safeParse(parsed);
  if (!ok.success) throw new Error(`${path} isn't a recipes file Shrike can read. Fix it or delete it.`);
  return ok.data.recipes;
}
const readQuiet = (path: string | undefined) => (path ? readSaved(path).catch(() => null) : Promise.resolve(null));

let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
};

async function update(path: string, fn: (s: Saved) => void): Promise<void> {
  await serial(async () => {
    const s = (await readSaved(path)) ?? {};
    fn(s);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ recipes: s }, null, 2)}\n`);
    await rename(tmp, path);
  });
}

const action = (id: string) => {
  const a = ACTIONS.find((x) => x.id === id);
  if (!a) throw new Error(`There's no action called "${id}".`);
  return a;
};

export async function listRecipes(d: SkillDirs): Promise<ActionRecipe[]> {
  const f = recipeFiles(d);
  const [personal, project] = await Promise.all([readQuiet(f.personal), readQuiet(f.project)]);
  return ACTIONS.map((a) => merged(a, personal, project));
}

/** Saves only what differs from what the scope inherits, so an evolving built-in (or your default) still reaches it. */
export async function saveRecipe(d: SkillDirs, id: string, s: RecipeSettings, scope: "project" | "personal"): Promise<ActionRecipe[]> {
  const a = action(id);
  const f = recipeFiles(d);
  const path = scope === "project" ? f.project : f.personal;
  if (!path) throw new Error("Open a project first.");
  if (s.agent && !LAUNCHABLE.includes(s.agent)) throw new Error("Shrike can't start that agent yet. Pick Claude, Built-in or the default.");
  if (s.args) parseArgs(s.args);
  const keep = changedFrom(merged(a, scope === "project" ? await readQuiet(f.personal) : null, null), s);
  await update(path, (all) => {
    if (Object.keys(keep).length) all[id] = keep;
    else delete all[id];
  });
  return listRecipes(d);
}

/** One step back: clears this project's recipe if it has one (back to your default), otherwise your default (back to built-in). */
export async function resetRecipe(d: SkillDirs, id: string): Promise<ActionRecipe[]> {
  action(id);
  const f = recipeFiles(d);
  for (const p of [f.project, f.personal]) {
    if (p && (await readQuiet(p))?.[id]) {
      await update(p, (all) => void delete all[id]);
      break;
    }
  }
  return listRecipes(d);
}

export interface Resolved {
  prompt: string;
  skillId?: string;
  brain?: BrainId; // absent: the caller's default
  args: string[]; // allowlisted Claude Code flags
}

/** The prompt an action hands the brain. Never throws: anything wrong falls back to the built-in template. */
export async function resolveRecipe(id: string, vars: Partial<Record<Var, string>> & Record<string, string>, d?: SkillDirs): Promise<Resolved> {
  const a = ACTIONS.find((x) => x.id === id);
  if (!a) return { prompt: vars.context ?? "", args: [] };
  let r: ActionRecipe = merged(a, null, null);
  let base = "";
  let skillId = a.skillId;
  try {
    const dirs = d ?? services.dirs();
    r = (await listRecipes(dirs)).find((x) => x.id === id) ?? r;
    const skills = await loadSkills(dirs);
    const own = id === "get-running" && vars.project ? skills.find((s) => s.id === runSkillFor(vars.project!)) : undefined;
    if (own) skillId = own.id;
    base = (own ?? skills.find((s) => s.id === skillId))?.body ?? "";
  } catch {
    // not configured (tests) or unreadable: built-in template, no skill body
  }
  let args: string[] = [];
  try {
    args = parseArgs(r.args);
  } catch {}
  const prompt = renderTemplate(r.template, { basePrompt: base, ...vars }).trim();
  return { prompt: prompt || (vars.context ?? ""), ...(skillId ? { skillId } : {}), ...(r.agent === "claude-code" || r.agent === "builtin" ? { brain: r.agent } : {}), args };
}
