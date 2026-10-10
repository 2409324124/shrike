import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { StartPlan } from "@shrike/schema";
import { frontMatter, whenOf } from "@shrike/mcp-server";

// R1: known recipes first. Read-only: nothing here writes anywhere, least of all a .claude folder.
// Order (best first):
//   1. <project>/.shrike/skills/run-*.md          Shrike's own run skill (shrike-skill)
//   2. ~/.shrike/skills/run-<project>.md           a personal one for this project (shrike-skill)
//   3. <project>/.claude/skills/run-*, then other project skills about starting (project-skill)
//   4. ~/.claude/skills matching the project's name, or a run-* skill naming its stack (claude-skill)
//   5. README / CONTRIBUTING / docs setup sections (readme)
// Lessons that every start reads: ~/.shrike/skills/starting-apps.md, else the built-in seed.

export interface Recipe {
  id: string; // "shrike:run-xyne-spaces", "project:run-xyne-spaces", "readme:README.md"
  name: string;
  source: StartPlan["source"] | "lessons";
  path: string; // absolute
  when: string;
  body: string;
  files?: string[]; // other files in the skill's folder (smoke.mjs), absolute
  skillId?: string; // the Shrike skill id, for shrike-skill recipes
}

export interface RecipeDirs {
  root: string;
  name: string; // project name
  stack?: string[]; // "vite-react", "express", …
  personal: string; // ~/.shrike/skills
  claude: string; // ~/.claude/skills
  builtin: string; // prompts/skills
}

const MAX = 256 * 1024;
const STARTING = /\b(run|start|launch|boot|bring (?:it|the \w+) up|dev server|local dev|spin up|serve)\b/i;
const SETUP_HEADING = /^(#{1,3})\s+.*\b(setup|set up|getting started|get started|install|installation|run|running|develop|development|local|quick ?start|usage|prerequisites|requirements|start)\b/i;

const read = async (file: string): Promise<string | undefined> => {
  try {
    if ((await stat(file)).size > MAX) return undefined;
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
};

const words = (s: string) => s.toLowerCase().replace(/^@[^/]+\//, "").split(/[^a-z0-9]+/).filter((w) => w.length > 1);
const slugOf = (s: string) => words(s).join("-");

/** One skill file (Shrike or Claude Code format) as a recipe. */
async function skillRecipe(id: string, file: string, source: Recipe["source"], dir?: string): Promise<Recipe | undefined> {
  const text = await read(file);
  if (!text) return undefined;
  const fm = frontMatter(text);
  const f = fm?.fields ?? {};
  const name = f.name || id;
  const when = f.when || (f.description ? whenOf(f.description) : "");
  const files = dir ? (await readdir(dir).catch(() => [] as string[])).filter((x) => x !== "SKILL.md" && !x.startsWith(".")).map((x) => join(dir, x)) : undefined;
  return { id, name, source, path: file, when, body: (fm?.body ?? text).trim(), ...(files?.length ? { files } : {}) };
}

/** Skills in a Claude Code skills folder: <name>/SKILL.md or <name>.md. */
async function claudeSkills(dir: string, source: Recipe["source"], prefix: string): Promise<Recipe[]> {
  const ents = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out = await Promise.all(
    ents
      .filter((e) => !e.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) =>
        e.isDirectory() ? skillRecipe(`${prefix}:${e.name}`, join(dir, e.name, "SKILL.md"), source, join(dir, e.name)) : e.name.endsWith(".md") ? skillRecipe(`${prefix}:${e.name.slice(0, -3)}`, join(dir, e.name), source) : undefined,
      ),
  );
  return out.filter((r): r is Recipe => !!r);
}

const isRun = (r: Recipe) => /^run[-_]|[-_]run$|^start[-_]/.test(r.id.split(":")[1] ?? "");
const aboutStarting = (r: Recipe) => isRun(r) || STARTING.test(`${r.name} ${r.when}`);

/** README-style docs: only their setup and run sections. */
export function setupSections(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let level = 0;
  let fence = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) fence = !fence;
    const h = fence ? null : /^(#{1,6})\s/.exec(l);
    if (h) {
      const m = SETUP_HEADING.exec(l);
      if (m) level = h[1]!.length;
      else if (level && h[1]!.length <= level) level = 0;
    }
    if (level) out.push(l);
  }
  return out.join("\n").trim();
}

export async function discoverRecipes(d: RecipeDirs): Promise<{ recipes: Recipe[]; lessons: Recipe[] }> {
  const projectSlug = slugOf(d.name);
  const folderSlug = slugOf(basename(d.root));
  const names = [...new Set([projectSlug, folderSlug].filter(Boolean))];
  const recipes: Recipe[] = [];

  // 1. .shrike/skills/run-*
  const shrikeDir = join(d.root, ".shrike", "skills");
  for (const f of (await readdir(shrikeDir).catch(() => [] as string[])).filter((x) => /^run[-_].*\.md$/.test(x)).sort()) {
    const r = await skillRecipe(`shrike:${f.slice(0, -3)}`, join(shrikeDir, f), "shrike-skill");
    if (r) recipes.push({ ...r, skillId: f.slice(0, -3) });
  }
  // 2. ~/.shrike/skills/run-<project>
  for (const n of names) {
    const r = await skillRecipe(`personal:run-${n}`, join(d.personal, `run-${n}.md`), "shrike-skill");
    if (r && !recipes.some((x) => x.skillId === `run-${n}`)) recipes.push({ ...r, skillId: `run-${n}` });
  }
  // 3. the project's own Claude Code skills: run-* first, then any about starting
  const project = await claudeSkills(join(d.root, ".claude", "skills"), "project-skill", "project");
  recipes.push(...project.filter(isRun), ...project.filter((r) => !isRun(r) && aboutStarting(r)));
  // 4. ~/.claude/skills that name this project, or a run-* skill naming its stack
  const mine = await claudeSkills(d.claude, "claude-skill", "claude");
  const named = (r: Recipe) => names.some((n) => (r.id.split(":")[1] ?? "").includes(n) || (n.length > 3 && `${r.name} ${r.when}`.toLowerCase().includes(n.replace(/-/g, " "))) || `${r.name} ${r.when}`.toLowerCase().includes(n));
  const stack = (d.stack ?? []).flatMap(words).filter((w) => w.length > 2 && !["react", "node"].includes(w));
  const forStack = (r: Recipe) => isRun(r) && stack.some((s) => `${r.id} ${r.name} ${r.when}`.toLowerCase().includes(s));
  recipes.push(...mine.filter((r) => named(r) && aboutStarting(r)), ...mine.filter((r) => !(named(r) && aboutStarting(r)) && (forStack(r) || (named(r) && isRun(r)))));
  // 5. README and friends: setup sections only
  for (const f of ["README.md", "readme.md", "README", "CONTRIBUTING.md", "DEVELOPMENT.md", "docs/setup.md", "docs/development.md", "docs/getting-started.md"]) {
    const text = await read(join(d.root, f));
    const body = text && setupSections(text);
    if (body && body.length > 40) recipes.push({ id: `readme:${f}`, name: f, source: "readme", path: join(d.root, f), when: `The setup section of ${f}`, body });
  }

  const lessons: Recipe[] = [];
  const personal = await skillRecipe("lessons:starting-apps", join(d.personal, "starting-apps.md"), "lessons");
  const seed = await skillRecipe("lessons:starting-apps", join(d.builtin, "starting-apps.md"), "lessons");
  if (personal) lessons.push(personal);
  else if (seed) lessons.push(seed);
  return { recipes: dedupe(recipes), lessons };
}

function dedupe(rs: Recipe[]): Recipe[] {
  const seen = new Set<string>();
  // case-insensitive disks (macOS) find README.md as readme.md too
  return rs.filter((r) => (seen.has(r.path.toLowerCase()) ? false : (seen.add(r.path.toLowerCase()), true)));
}
