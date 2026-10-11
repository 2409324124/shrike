import { app } from "electron";
import { join, resolve } from "node:path";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { isMac, linkDir } from "./platform.ts";

// Packaged, electron-builder's extraResources mirror the repo layout under Resources (apps/desktop/electron-builder.yml).
const repo = app.isPackaged ? process.resourcesPath : resolve(app.getAppPath(), "../..");

export const paths = {
  repo,
  nodeAgentRegister: join(repo, "packages/node-agent/src/register.mjs"),
  pythonAgent: join(repo, "packages/python-agent/src"), // sitecustomize.py: first on PYTHONPATH
  browserAgentBundle: join(repo, "packages/browser-agent/dist/browser-agent.js"),
  promptsDir: join(repo, "prompts/agent"),
  sampleProject: join(repo, "fixtures/todo-app"),
  voiceDir: join(repo, "apps/desktop/native/voice"),
};

/**
 * The sample opens as a fresh copy in userData, so fixing it in Shrike never edits the repo's fixture (and the demo bug is back
 * every time). Its .shrike (run skill, memory) is kept between opens. node_modules is linked in dev; packaged, it is copied
 * once and kept, since vite writes its cache there and the app bundle must stay untouched.
 */
export async function sampleCopy(): Promise<string> {
  const src = paths.sampleProject;
  const dst = join(app.getPath("userData"), "sample", "todo-app");
  await mkdir(dst, { recursive: true });
  const keepShrike = existsSync(join(dst, ".shrike"));
  for (const f of await readdir(dst)) if (f !== ".shrike" && !(f === "node_modules" && app.isPackaged)) await rm(join(dst, f), { recursive: true, force: true });
  for (const f of await readdir(src)) if (f !== "node_modules" && f !== ".shrike") await cp(join(src, f), join(dst, f), { recursive: true });
  if (!keepShrike) await cp(join(src, ".shrike/config.json"), join(dst, ".shrike/config.json")); // config only: no notes that give the demo away
  const mods = join(dst, "node_modules");
  if (existsSync(mods)) return dst;
  if (!app.isPackaged) linkDir(join(src, "node_modules"), mods);
  else {
    await cp(join(src, "node_modules"), mods, { recursive: true, verbatimSymlinks: true });
    // A downloaded app's files carry quarantine; copied out of the bundle, esbuild would hit Gatekeeper on its own.
    if (isMac) await new Promise((ok) => execFile("xattr", ["-dr", "com.apple.quarantine", mods], ok));
  }
  return dst;
}
