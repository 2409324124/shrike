import { app, dialog, type BrowserWindow } from "electron";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ProcessSpec, ProjectInfo } from "@shrike/schema";
import { detectProject, plannedPlaces } from "@shrike/scanner";
import { runSkillId, runSkillPath } from "./start/runskill.ts";
import { writeAtomicSync } from "./state-file.ts";

// ponytail: remembered only; not auto-reopened, so launch always starts on the welcome screen.
const stateFile = () => join(app.getPath("userData"), "state.json");

export async function loadProject(root: string): Promise<{ info: ProjectInfo; serverUrl?: string }> {
  let real: string;
  try {
    real = realpathSync(root);
    if (!statSync(real).isDirectory()) throw new Error();
  } catch {
    throw new Error(`That folder doesn't exist: ${root}`);
  }
  const info = await detectProject(real);
  // Lanes-from-plan: a run skill that names the services beats the package.json guess.
  try {
    const places = plannedPlaces([], readFileSync(runSkillPath(info.root, runSkillId(info.name)), "utf8"), info);
    if (places.length) (info.expectedPlaces = places), (info.placesFrom = "skill");
  } catch {}
  try {
    writeAtomicSync(stateFile(), JSON.stringify({ lastProject: info.root }));
  } catch {}
  // A project with no web page sends explorer requests straight to its first process that listens.
  const serverUrl = readConfig(info.root).serverUrl;
  return { info, serverUrl: typeof serverUrl === "string" ? serverUrl : info.appUrl ? undefined : info.processes.find((p) => p.url)?.url };
}

function readConfig(root: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(readFileSync(join(root, ".shrike/config.json"), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** D12: write `processes` into .shrike/config.json, keeping every other key. */
export function saveProcesses(root: string, processes: ProcessSpec[]): void {
  const file = join(root, ".shrike", "config.json");
  let config: Record<string, unknown> = {};
  if (existsSync(file)) {
    const v: unknown = (() => {
      try {
        return JSON.parse(readFileSync(file, "utf8"));
      } catch {
        return undefined;
      }
    })();
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Shrike can't read .shrike/config.json, so it didn't change it. Fix that file, then try again.");
    config = v as Record<string, unknown>;
  }
  writeAtomicSync(file, JSON.stringify({ ...config, processes }, null, 2) + "\n");
}

export async function pickFolder(win: BrowserWindow | undefined): Promise<string | undefined> {
  // ponytail: test-only stand-in for the native folder picker, like SHRIKE_EDITOR_LOG.
  if (process.env.SHRIKE_OPEN_FOLDER) return process.env.SHRIKE_OPEN_FOLDER;
  const opts = { title: "Open a project", properties: ["openDirectory" as const] };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? undefined : r.filePaths[0];
}
