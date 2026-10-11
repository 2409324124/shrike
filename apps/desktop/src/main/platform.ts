import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { cpSync, symlinkSync } from "node:fs";

// Phase D: the one place that knows macOS, Linux and Windows apart. No Electron imports, so node:test can drive every branch.

type Os = NodeJS.Platform;

export const isMac = process.platform === "darwin";
export const isWin = process.platform === "win32";
export const isLinux = process.platform === "linux";
/** Voice runs in ShrikeVoice.app (Swift, MLX): macOS only for now. */
export const voiceSupported = isMac;
/** A GUI app on macOS or Linux starts with a minimal PATH, so tools come from the login shell's. Windows has no login shell. */
export const loginPathNeeded = (os: Os = process.platform): boolean => os !== "win32";

export function defaultShell(os: Os = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  return os === "win32" ? env.ComSpec || "cmd.exe" : env.SHELL || (os === "darwin" ? "/bin/zsh" : "/bin/sh"); // NixOS has no /bin/zsh
}

/** The shell and its args that run `cmd`: a login shell on macOS and Linux, cmd.exe on Windows. */
export function shellArgs(cmd: string, os: Os = process.platform, env: NodeJS.ProcessEnv = process.env): [string, string[]] {
  // cmd.exe /s strips the outer quotes and runs the rest as typed; Node passes them through with windowsVerbatimArguments.
  return os === "win32" ? [defaultShell(os, env), ["/d", "/s", "/c", `"${cmd}"`]] : [defaultShell(os, env), ["-lc", cmd]];
}

/** Spawns `cmd` in the shell. `detached` makes a process group on macOS and Linux (killTree takes the whole group); on Windows it would open a console, so taskkill /T takes the tree instead. */
export function spawnShell(cmd: string, opts: SpawnOptions = {}): ChildProcess {
  const [file, args] = shellArgs(cmd);
  return spawn(file, args, isWin ? { ...opts, detached: false, windowsHide: true, windowsVerbatimArguments: true } : opts);
}

/** Kills pid and everything under it. Errors (already gone) are swallowed. */
export function killTree(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM", os: Os = process.platform, run: typeof execFile = execFile): void {
  if (!pid) return;
  if (os === "win32") return void run("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
  try {
    process.kill(-pid, signal);
  } catch {}
}

/** Links a folder (a junction on Windows, which needs no admin rights); copies it when linking isn't allowed. */
export function linkDir(from: string, to: string, os: Os = process.platform): void {
  try {
    symlinkSync(from, to, os === "win32" ? "junction" : "dir");
  } catch {
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  }
}
