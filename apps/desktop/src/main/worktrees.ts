// W1–W5: git worktrees under <main>/.shrike/worktrees/<name>, on branch shrike/<name>. No Electron imports (tested with node:test).
import { execFile } from "node:child_process";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Worktree } from "@shrike/schema";
import { linkDir } from "./platform.ts";
import { readJsonSync, writeAtomicSync } from "./state-file.ts";

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const STEP = 100; // W2: port offset between worktrees
const NOT_SHRIKE = ":(glob,exclude)**/.shrike/**"; // Shrike's own state (flows, memory) is never part of a fix
const IDENTITY = ["-c", "user.name=Shrike", "-c", "user.email=shrike@localhost", "-c", "commit.gpgsign=false"];

interface Meta {
  portOffset: number;
  note?: string;
  base: string; // commit the worktree started from (with your uncommitted changes, if any); fixes are diffed against it
  createdAt: number;
}

// GIT_OPTIONAL_LOCKS: the rail polls status in every project; it must not hold index.lock against the user's own git.
export function git(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((res, rej) => {
    const child = execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } }, (err, stdout, stderr) => {
      if (err) rej(new Error(String(stderr || err.message).trim().split("\n").slice(-3).join("\n")));
      else res(stdout);
    });
    child.stdin?.on("error", () => {}); // git can exit before reading it: EPIPE on Linux
    child.stdin?.end(input ?? "");
  });
}

/** The main checkout of the repo `anyPath` is in (also when `anyPath` is one of its worktrees). */
export async function mainRoot(anyPath: string): Promise<string> {
  const out = await git(anyPath, ["worktree", "list", "--porcelain"]).catch(() => {
    throw new Error("This project isn't a git repository, so it can't have worktrees. Run git init first.");
  });
  return realpathSync(out.split("\n")[0]!.replace(/^worktree /, ""));
}

const commonDir = async (main: string) => resolve(main, (await git(main, ["rev-parse", "--git-common-dir"])).trim());

export async function readMeta(main: string): Promise<Record<string, Meta>> {
  try {
    const v = readJsonSync(join(await commonDir(main), "shrike-worktrees.json"));
    return v && typeof v === "object" ? (v as Record<string, Meta>) : {};
  } catch {
    return {};
  }
}

async function writeMeta(main: string, meta: Record<string, Meta>): Promise<void> {
  writeAtomicSync(join(await commonDir(main), "shrike-worktrees.json"), JSON.stringify(meta, null, 2));
}

// Creating and removing read-modify-write the metadata file; a race starts several at once.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

export const worktreePath = (main: string, name: string) => join(main, ".shrike", "worktrees", name);

/** Main first (as "main", offset 0), then Shrike's worktrees. Worktrees made outside Shrike are left out. */
export async function listWorktrees(main: string): Promise<Omit<Worktree, "current" | "running">[]> {
  const meta = await readMeta(main);
  const blocks = (await git(main, ["worktree", "list", "--porcelain"])).trim().split(/\n\n+/);
  const out: Omit<Worktree, "current" | "running">[] = [];
  for (const [i, b] of blocks.entries()) {
    const path = /^worktree (.+)$/m.exec(b)?.[1];
    if (!path || /^prunable/m.test(b)) continue;
    const branch = /^branch refs\/heads\/(.+)$/m.exec(b)?.[1] ?? "detached";
    if (i === 0) {
      out.push({ name: "main", path: realpathSync(path), branch, portOffset: 0 });
      continue;
    }
    const rel = relative(join(main, ".shrike", "worktrees"), existsSync(path) ? realpathSync(path) : path);
    const m = meta[rel];
    if (!NAME_RE.test(rel) || !m) continue;
    out.push({ name: rel, path: worktreePath(main, rel), branch, portOffset: m.portOffset, ...(m.note ? { note: m.note } : {}) });
  }
  return out;
}

async function ensureExcluded(main: string): Promise<void> {
  const file = join(await commonDir(main), "info", "exclude");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const want = [".shrike/worktrees/", "node_modules"].filter((l) => !text.split("\n").includes(l));
  if (!want.length) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}# Shrike worktrees (W1)\n${want.join("\n")}\n`);
}

/**
 * A new worktree from the main checkout as it is now: HEAD plus your uncommitted and untracked files (committed there as one snapshot).
 * node_modules folders are linked, not installed; root .env files are copied.
 */
export function createWorktree(main: string, name: string, note?: string, ports: number[] = [], opts: CreateOpts = {}): Promise<Omit<Worktree, "current" | "running">> {
  return serial(() => create(main, name, note, ports, opts));
}

/** WS2: start from an existing branch, a detached HEAD (a PR checked out by `after`), or a base branch instead of your code as it is now. */
export interface CreateOpts {
  branch?: string; // local, "origin/x", or a remote-only "x"
  detach?: boolean;
  base?: string;
  after?: (path: string) => Promise<void>; // runs in the new folder before its start point is recorded
  copyEnv?: boolean; // default true
  portOffset?: number;
}

const has = (main: string, ref: string) => git(main, ["rev-parse", "--verify", "--quiet", ref]).then(() => true, () => false);

/** The `git worktree add` arguments for a branch: check out a local one, or track a remote one under its own name. */
async function branchArgs(main: string, branch: string, path: string): Promise<{ args: string[]; created?: string }> {
  if (await has(main, `refs/heads/${branch}`)) return { args: [path, branch] };
  const remotes = (await git(main, ["remote"])).split("\n").filter(Boolean);
  const r = remotes.find((x) => branch.startsWith(`${x}/`));
  const local = r ? branch.slice(r.length + 1) : branch;
  if (r && (await has(main, `refs/heads/${local}`))) return { args: [path, local] };
  for (const remote of r ? [branch] : remotes.map((x) => `${x}/${branch}`)) if (await has(main, `refs/remotes/${remote}`)) return { args: ["--track", "-b", local, path, remote], created: local };
  throw new Error(`There's no branch called ${branch}.`);
}

/** W2: the smallest multiple of STEP whose shifted ports hit no port of main or another worktree (ports 3000 and 3100 rule out +100). */
export function pickOffset(used: number[], ports: number[]): number {
  const gaps = new Set([0, ...ports.flatMap((p) => ports.map((q) => Math.abs(p - q)))]);
  const taken = [0, ...used];
  let k = STEP;
  while (taken.some((o) => gaps.has(Math.abs(k - o)))) k += STEP;
  return k;
}

async function create(main: string, name: string, note: string | undefined, ports: number[], opts: CreateOpts): Promise<Omit<Worktree, "current" | "running">> {
  if (!NAME_RE.test(name) || name === "main") throw new Error("Use a short name with lowercase letters, digits and dashes, like fix-cents.");
  const meta = await readMeta(main);
  const path = worktreePath(main, name);
  if (meta[name] || existsSync(path)) throw new Error(`There's already a worktree called ${name}.`);
  const used = Object.values(meta).map((m) => m.portOffset);
  if (opts.portOffset !== undefined && (opts.portOffset < 0 || [0, ...used].includes(opts.portOffset))) throw new Error(`Port offset +${opts.portOffset} is taken. Leave it empty and Shrike picks a free one.`);
  await ensureExcluded(main);
  const { args, created } = opts.branch ? await branchArgs(main, opts.branch, path) : opts.detach ? { args: ["--detach", path, "HEAD"] } : { args: ["-b", `shrike/${name}`, path, opts.base ?? "HEAD"], created: `shrike/${name}` };
  await git(main, ["worktree", "add", ...args]).catch((err: Error) => {
    const at = /(?:already checked out at|already used by worktree at) '([^']+)'/.exec(err.message)?.[1];
    throw new Error(at ? `${opts.branch} is already open in another workspace (${at}). Open that one instead.` : err.message);
  });
  try {
    if (opts.after) await opts.after(path);
    const fresh = !!(opts.branch || opts.detach || opts.base); // only "your code as it is now" brings your uncommitted files along
    const dirty = fresh ? "" : await git(main, ["diff", "HEAD", "--binary"]);
    if (dirty.trim()) await git(path, ["apply", "--binary", "--whitespace=nowarn", "-"], dirty);
    for (const f of fresh ? [] : (await git(main, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean)) {
      if (f.endsWith("/")) continue; // ponytail: a nested git repo stays out of the copy. Upgrade: clone it in.
      const from = join(main, f);
      const to = join(path, f);
      mkdirSync(dirname(to), { recursive: true });
      if (lstatSync(from).isSymbolicLink()) {
        try {
          symlinkSync(readlinkSync(from), to); // also a link to nowhere
        } catch {
          cpSync(from, to, { recursive: true, dereference: true }); // Windows without symlink rights
        }
      }
      else copyFileSync(from, to);
    }
    if ((await git(path, ["status", "--porcelain"])).trim()) {
      await git(path, ["add", "-A"]);
      await git(path, [...IDENTITY, "commit", "-q", "--no-verify", "-m", "Shrike: your uncommitted changes"]);
    }
    linkDeps(main, path);
    if (opts.copyEnv !== false) for (const f of readdirSync(main)) if (/^\.env/.test(f) && !existsSync(join(path, f))) copyFileSync(join(main, f), join(path, f));
  } catch (err) {
    await git(main, ["worktree", "remove", "--force", path]).catch(() => {});
    if (created) await git(main, ["branch", "-D", created]).catch(() => {});
    throw new Error(`Couldn't copy your code into ${name}, so Shrike didn't make it. Nothing was changed. (${(err as Error).message.split("\n")[0]})`);
  }

  const portOffset = opts.portOffset ?? pickOffset(used, ports);
  meta[name] = { portOffset, ...(note ? { note } : {}), base: (await git(path, ["rev-parse", "HEAD"])).trim(), createdAt: Date.now() };
  await writeMeta(main, meta);
  const branch = (await git(path, ["branch", "--show-current"])).trim() || "detached";
  return { name, path, branch, portOffset, ...(note ? { note } : {}) };
}

// Each node_modules entry is linked, not the folder, so every worktree keeps its own caches (node_modules/.vite); a shared one broke the other apps' pages.
// ponytail: node_modules at the root and two folders down (apps/web, packages/x) only. Upgrade: read the workspace globs.
function linkDeps(main: string, wt: string): void {
  const dirs = ["."];
  for (const a of readdirSync(main, { withFileTypes: true })) {
    if (!a.isDirectory() || a.name.startsWith(".") || a.name === "node_modules") continue;
    dirs.push(a.name);
    for (const b of readdirSync(join(main, a.name), { withFileTypes: true })) if (b.isDirectory() && b.name !== "node_modules" && !b.name.startsWith(".")) dirs.push(join(a.name, b.name));
  }
  for (const d of dirs) {
    const from = join(main, d, "node_modules");
    const to = join(wt, d, "node_modules");
    if (!existsSync(from) || !existsSync(join(wt, d)) || existsSync(to)) continue;
    mkdirSync(to);
    for (const e of readdirSync(from)) if (!/^\.(vite|cache)/.test(e)) linkDir(join(from, e), join(to, e));
  }
}

async function metaOf(main: string, name: string): Promise<Meta> {
  const m = (await readMeta(main))[name];
  if (!m || !existsSync(worktreePath(main, name))) throw new Error(`There's no worktree called ${name}.`);
  return m;
}

/** W5: files that differ from where the worktree started, i.e. what would be lost by removing it. */
export async function changedFiles(main: string, name: string): Promise<string[]> {
  const { base } = await metaOf(main, name);
  const path = worktreePath(main, name);
  const tracked = (await git(path, ["diff", "--name-only", base, "--", ".", NOT_SHRIKE])).split("\n");
  const untracked = (await git(path, ["ls-files", "--others", "--exclude-standard", "--", ".", NOT_SHRIKE])).split("\n");
  return [...new Set([...tracked, ...untracked].filter(Boolean))].sort();
}

/** W5: changed files whose content your main checkout doesn't have yet (what removing the worktree would lose). */
export async function unmergedFiles(main: string, name: string): Promise<string[]> {
  const path = worktreePath(main, name);
  const same = (f: string) => {
    const a = join(main, f);
    const b = join(path, f);
    return existsSync(a) === existsSync(b) && (!existsSync(a) || readFileSync(a).equals(readFileSync(b)));
  };
  return (await changedFiles(main, name)).filter((f) => !same(f));
}

/** The worktree's fix as a binary patch against where it started: only `only` (repo-relative) when given, never .shrike state. */
export async function fixDiff(main: string, name: string, only?: string[]): Promise<string> {
  const { base } = await metaOf(main, name);
  const path = worktreePath(main, name);
  await git(path, ["add", "-A"]);
  return git(path, ["diff", "--cached", "--binary", base, "--", ...(only?.length ? only : ["."]), NOT_SHRIKE]);
}

/** W3/W4: apply the worktree's fix to the main checkout's files (uncommitted, nothing staged). All or nothing. */
export async function adoptFix(main: string, name: string, only?: string[]): Promise<string[]> {
  const diff = await fixDiff(main, name, only);
  if (!diff.trim()) throw new Error(`${name} has no changes to bring over.`);
  try {
    await git(main, ["apply", "--binary", "--whitespace=nowarn", "--check", "-"], diff);
  } catch {
    throw new Error(`Your code changed in the same places as the fix in ${name}, so Shrike didn't bring it over. Nothing was changed.`);
  }
  await git(main, ["apply", "--binary", "--whitespace=nowarn", "-"], diff);
  return (await git(main, ["apply", "--numstat", "-"], diff)).split("\n").filter(Boolean).map((l) => l.split("\t")[2]!);
}

/** Removes the folder and its shrike/<name> branch. Callers ask first when changedFiles isn't empty. */
export function removeWorktree(main: string, name: string): Promise<void> {
  return serial(() => remove(main, name));
}

async function remove(main: string, name: string): Promise<void> {
  if (name === "main") throw new Error("Your main checkout can't be removed.");
  const meta = await readMeta(main);
  const path = worktreePath(main, name);
  if (!meta[name] && !existsSync(path)) throw new Error(`There's no worktree called ${name}.`); // a folder without metadata is a half-made one: remove it too
  if (existsSync(path)) await git(main, ["worktree", "remove", "--force", path]);
  await git(main, ["worktree", "prune"]);
  await git(main, ["branch", "-D", `shrike/${name}`]).catch(() => {});
  delete meta[name];
  await writeMeta(main, meta);
}
