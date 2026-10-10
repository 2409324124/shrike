import { realpathSync } from "node:fs";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative } from "node:path";
import type { ActionView, AgentStep, Finding, Patch } from "@shrike/schema";
import { failingLocation, issueMarkdown, type IssueInput } from "../renderer/src/hud/logic.ts";

// O6: a trip as a GitHub/Linear-ready issue, saved under .shrike/issues with its clip next to it.

export interface IssueDeps {
  root: string;
  project: string;
  view: ActionView;
  actions: ActionView[];
  appUrl?: string;
  readFile(rel: string): Promise<string>;
  clipDir?: string; // where saveClip puts clips; defaults to SHRIKE_SAVE_DIR or ~/Movies
}

// What the agent said about each trip, fed by noteAgentStep/notePatch (main/agent.ts and host.ts call them).
const agentByAction = new Map<string, { summary?: string; findings: Finding[]; patchId?: string }>();
const runActions = new Map<string, Set<string>>();
const patches = new Map<string, Patch>();

export function noteAgentStep(step: AgentStep): void {
  const ids = runActions.get(step.runId) ?? new Set<string>();
  runActions.set(step.runId, ids);
  for (const id of step.actionIds ?? []) ids.add(id);
  if (step.kind === "findings" || step.patchId) {
    for (const id of ids) {
      const a = agentByAction.get(id) ?? { findings: [] };
      if (step.kind === "findings") Object.assign(a, { summary: step.summary ?? a.summary, findings: step.findings ?? a.findings });
      if (step.patchId) a.patchId = step.patchId;
      agentByAction.set(id, a);
    }
  }
}

export function notePatch(p: Patch): void {
  patches.set(p.id, p);
}

const safeName = (s: string) => s.replace(/[^\w.-]+/g, "-") || "app";
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "trip";

/** The newest clip of this project saved after the trip started. */
// ponytail: saveClip doesn't say which trip a clip shows, so this goes by name and time. Upgrade: pass the actionId to saveClip.
export async function findClip(dir: string, project: string, sinceMs: number): Promise<string | undefined> {
  const prefix = `shrike-${safeName(project)}-`;
  let best: { path: string; at: number } | undefined;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.startsWith(prefix) || !/\.(webm|mp4)$/.test(name)) continue;
    const at = (await stat(join(dir, name)).catch(() => undefined))?.mtimeMs ?? 0;
    if (at >= sinceMs && (!best || at > best.at)) best = { path: join(dir, name), at };
  }
  return best?.path;
}

async function excerpt(deps: IssueDeps): Promise<IssueInput["excerpt"]> {
  const loc = failingLocation(deps.view);
  if (!loc || isAbsolute(loc.file)) return undefined;
  const text = await deps.readFile(loc.file).catch(() => undefined);
  if (text === undefined) return undefined;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const start = Math.max(1, loc.line - 3);
  return { file: loc.file, line: loc.line, start, lines: lines.slice(start - 1, Math.min(lines.length, loc.line + 3)) };
}

function pagePath(deps: IssueDeps): string | undefined {
  const nav = deps.actions.filter((a) => a.trigger === "navigation" && a.startMs <= deps.view.startMs).at(-1);
  return nav?.label.replace(/^Opened /, "");
}

export async function exportIssue(deps: IssueDeps): Promise<{ markdown: string; clipPath?: string }> {
  const { view, root } = deps;
  const dir = join(root, ".shrike", "issues");
  await mkdir(dir, { recursive: true });
  const d = new Date(view.startMs);
  const base = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}-${slug(view.label)}-${view.id.slice(0, 6)}`;

  const clipDir = deps.clipDir ?? process.env.SHRIKE_SAVE_DIR ?? (await import("electron")).app.getPath("videos");
  const found = await findClip(clipDir, deps.project, view.startMs);
  let clipPath: string | undefined;
  if (found) {
    clipPath = join(dir, base + extname(found));
    await copyFile(found, clipPath).catch(() => (clipPath = undefined));
  }

  const noted = agentByAction.get(view.id);
  const agent = noted ? { summary: noted.summary, findings: noted.findings, patch: noted.patchId ? patches.get(noted.patchId) : undefined } : undefined;
  const markdown = issueMarkdown({ view, appUrl: deps.appUrl, pagePath: pagePath(deps), excerpt: await excerpt(deps), agent, clipName: clipPath ? base + extname(clipPath) : undefined });
  await writeFile(join(dir, `${base}.md`), markdown, "utf8");
  return { markdown, ...(clipPath ? { clipPath } : {}) };
}

/** Reveals a file Shrike wrote under the project's .shrike folder; nothing else. */
export async function showInFolder(root: string, path: string): Promise<void> {
  const allowed = realpathSync(join(root, ".shrike"));
  const r = relative(allowed, realpathSync(path));
  if (!r || r.startsWith("..") || isAbsolute(r)) throw new Error("Shrike only shows files it saved in this project's .shrike folder.");
  (await import("electron")).shell.showItemInFolder(path);
}
