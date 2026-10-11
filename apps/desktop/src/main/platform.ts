import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { cpSync, symlinkSync } from "node:fs";
import { delimiter } from "node:path";

// Phase D: the one place that knows macOS, Linux and Windows apart. No Electron imports, so node:test can drive every branch.

type Os = NodeJS.Platform;

export const isMac = process.platform === "darwin";
export const isWin = process.platform === "win32";
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

/**
 * The PATH the user's terminal has. A login shell (-l) skips ~/.zshrc, where nvm, fnm, asdf and pyenv put theirs, so ask an
 * interactive login shell (-il) first, then a login shell. Undefined on Windows or when neither answers in time.
 */
export function userPath(os: Os = process.platform, env: NodeJS.ProcessEnv = process.env, run: typeof execFile = execFile): Promise<string | undefined> {
  if (!loginPathNeeded(os)) return Promise.resolve(undefined);
  const ask = (flags: string) =>
    new Promise<string | undefined>((done) => {
      const child = run(defaultShell(os, env), [flags, 'printf "__SHRIKE_PATH__%s__SHRIKE_PATH__" "$PATH"'], { env, timeout: 4000 }, (_err, out) => done(/__SHRIKE_PATH__(.+?)__SHRIKE_PATH__/.exec(String(out ?? ""))?.[1]));
      child.stdin?.end(); // an rc file that reads from the terminal gets end of input, not a hang
    });
  return ask("-ilc").then((p) => p ?? ask("-lc"));
}

/** `first`'s entries, then the rest of `rest` (no repeats). */
export const mergePath = (first: string, rest = "", sep = delimiter): string => [...new Set([...first.split(sep), ...rest.split(sep)].filter(Boolean))].join(sep);

/** Every tool Shrike runs (dev commands, git, gh, claude) then finds what the user's terminal finds, even when Shrike was opened from Finder. */
export async function adoptUserPath(): Promise<void> {
  const p = await userPath();
  // ponytail: a login shell later puts the system folders back in front (path_helper), so a Homebrew Node can win over nvm's. Upgrade: run commands with -c and this PATH.
  if (p) process.env.PATH = mergePath(p, process.env.PATH);
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

/** When `pid` started, as `ps` says it (to the second); undefined when it isn't running or on Windows. */
export function startTimeOf(pid: number, os: Os = process.platform, run: typeof execFile = execFile): Promise<string | undefined> {
  if (os === "win32") return Promise.resolve(undefined);
  return new Promise((ok) => void run("ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C" } }, (err, out) => ok(err ? undefined : String(out).trim() || undefined)));
}

/** Links a folder (a junction on Windows, which needs no admin rights); copies it when linking isn't allowed. */
export function linkDir(from: string, to: string, os: Os = process.platform): void {
  try {
    symlinkSync(from, to, os === "win32" ? "junction" : "dir");
  } catch {
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  }
}
