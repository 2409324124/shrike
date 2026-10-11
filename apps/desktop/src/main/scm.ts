import { watch, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { BrainId, ScmCommit, ScmDiff, ScmDiffLine, ScmFile, ScmState, ScmTarget } from "@shrike/schema";
import { redactText } from "@shrike/redact";
import { ghError, type Exec } from "./github.ts";
import { gitMissing, readGit } from "./git.ts";
import { resolveRecipe } from "./recipes.ts";

// SC1–SC7: the Changes dock. Local git only (no gh); Electron-free. Commit and undo are a click (local, undoable);
// discard and push wait on an approval; never a force-push.

// ---- parsing ----

type Letter = ScmFile["letter"];
const LETTER: Record<string, Letter> = { M: "M", T: "M", A: "A", D: "D", R: "R", C: "C" };

export interface Porcelain {
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: ScmFile[];
}

/** `git status --porcelain=v2 -b -z`: index changes are Staged, worktree changes are Changes, `u` is a conflict, `?` untracked. */
export function parsePorcelainV2(out: string): Porcelain {
  const parts = out.split("\0");
  const s: Porcelain = { ahead: 0, behind: 0, files: [] };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (!p) continue;
    if (p.startsWith("# branch.head ")) {
      const h = p.slice(14);
      if (h !== "(detached)") s.branch = h;
    } else if (p.startsWith("# branch.upstream ")) s.upstream = p.slice(18);
    else if (p.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(p);
      s.ahead = Number(m?.[1] ?? 0);
      s.behind = Number(m?.[2] ?? 0);
    } else if (p.startsWith("? ")) s.files.push({ path: p.slice(2), letter: "U", area: "untracked" });
    else if (p.startsWith("u ")) s.files.push({ path: p.split(" ").slice(10).join(" "), letter: "!", area: "conflicts" });
    else if (p.startsWith("1 ") || p.startsWith("2 ")) {
      const f = p.split(" ");
      const [x, y] = [f[1]![0]!, f[1]![1]!];
      const path = f.slice(p[0] === "1" ? 8 : 9).join(" ");
      const oldPath = p[0] === "2" ? parts[++i] : undefined;
      if (x !== ".") s.files.push({ path, ...(oldPath && (x === "R" || x === "C") ? { oldPath } : {}), letter: LETTER[x] ?? "M", area: "staged" });
      if (y !== ".") s.files.push({ path, letter: LETTER[y] ?? "M", area: "changes" });
    }
  }
  return s;
}

/** `git diff --numstat -z`: added/removed per path (renames keyed by the new path); binary files have neither. */
export function parseNumstat(out: string): Map<string, { added?: number; removed?: number }> {
  const m = new Map<string, { added?: number; removed?: number }>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const t = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(p);
    if (!t) continue;
    let path = t[3]!;
    if (!path) {
      i++; // rename: old path, then new path
      path = parts[++i] ?? "";
    }
    m.set(path, t[1] === "-" ? {} : { added: Number(t[1]), removed: Number(t[2]) });
  }
  return m;
}

/** `git diff --name-status -z` → files, for Committed on this branch and a commit's files. */
export function parseNameStatus(out: string, area: ScmFile["area"]): ScmFile[] {
  const parts = out.split("\0");
  const files: ScmFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]!;
    if (!code) continue;
    const l = code[0]!;
    if (l === "R" || l === "C") {
      const oldPath = parts[++i]!;
      files.push({ path: parts[++i]!, oldPath, letter: l, area });
    } else files.push({ path: parts[++i]!, letter: LETTER[l] ?? "M", area });
  }
  return files.filter((f) => f.path);
}

/** A unified patch → hunks with old/new line numbers. */
export function parseUnifiedDiff(patch: string): Pick<ScmDiff, "binary" | "hunks"> {
  const hunks: ScmDiff["hunks"] = [];
  let cur: ScmDiff["hunks"][number] | undefined;
  let o = 0;
  let n = 0;
  let binary = false;
  for (const line of patch.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      cur = { header: h[3]!.trim(), lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) {
      if (/^Binary files |^GIT binary patch/.test(line)) binary = true;
      continue;
    }
    const c = line[0];
    const text = line.slice(1);
    let l: ScmDiffLine | undefined;
    if (c === "+") l = { kind: "add", text, new: n++ };
    else if (c === "-") l = { kind: "del", text, old: o++ };
    else if (c === " ") l = { kind: "ctx", text, old: o++, new: n++ };
    else if (c === "\\") continue; // "\ No newline at end of file"
    else if (line.startsWith("diff ")) cur = undefined;
    if (l) cur?.lines.push(l);
  }
  return { binary, hunks };
}

const US = "\x1f";
const RS = "\x1e";
export const LOG_FORMAT = `--format=%H${US}%h${US}%an${US}%at${US}%s${RS}`;

export function parseLog(out: string, mine: Set<string>, unpushed: Set<string>): ScmCommit[] {
  return out
    .split(RS)
    .map((r) => r.replace(/^\s+/, ""))
    .filter(Boolean)
    .map((r) => {
      const [sha, short, author, at, ...subject] = r.split(US);
      return { sha: sha!, short: short!, author: author ?? "", at: Number(at) * 1000, subject: subject.join(US).trim(), mine: mine.has(sha!), pushed: !unpushed.has(sha!) };
    });
}

/** github.com remotes in https, ssh or scp form → https://github.com/owner/repo. */
export function githubWeb(url: string): string | undefined {
  const m = /^(?:https:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `https://github.com/${m[1]}/${m[2]}` : undefined;
}

/** Plain-text line counts for untracked files: small and not binary, else undefined. */
async function lineCount(abs: string): Promise<number | undefined> {
  const st = await stat(abs).catch(() => undefined);
  if (!st?.isFile() || st.size > 1024 * 1024) return undefined;
  const buf = await readFile(abs).catch(() => undefined);
  if (!buf || buf.includes(0)) return undefined;
  const text = buf.toString("utf8");
  return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
}

// ---- the service ----

export interface ScmDeps {
  root(): string | undefined;
  exec: Exec;
  approve(title: string, reason: string): Promise<boolean>;
  writeText(prompt: string, brain?: BrainId): Promise<string>; // a quiet, read-only agent run's answer
  emit(s: ScmState): void;
  changed(): void; // other git views (Ship, the rail) refresh
  used(skillId: string): void; // SL3: a skill that ran outside an agent run worked
}

const MAX_PATCH = 400_000;
const lit = (p: string) => `:(literal)${p}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const EMPTY: ScmState = { isRepo: false, ahead: 0, behind: 0, baseAhead: 0, baseBehind: 0, pull: "ff-only", files: [], commits: [] };

export function createScm(deps: ScmDeps) {
  let lastCommit: string | undefined; // SC4: the commit Shrike made, undoable until it's pushed or moved
  let written: string | undefined; // the last message the agent wrote
  let watched: { root: string; stop(): void } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSent = "";
  let chain: Promise<unknown> = Promise.resolve();

  // Reads never take git's optional locks, so watching .git can't feed itself.
  const run = (cwd: string, args: string[], input?: string) => deps.exec("git", ["--no-optional-locks", "-c", "core.quotepath=off", ...args], { cwd, ...(input !== undefined ? { input } : {}) });
  const git = async (cwd: string, args: string[], what = `git ${args[0]} didn't work`, input?: string) => {
    const r = await run(cwd, args, input);
    if (r.code !== 0) throw new Error(ghError(r, what));
    return r.stdout;
  };
  const need = () => {
    const r = deps.root();
    if (!r) throw new Error("No project is open.");
    return r;
  };
  const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

  async function baseRef(cwd: string, remote: string | undefined, base: string | undefined): Promise<string | undefined> {
    if (!base) return undefined;
    for (const ref of remote ? [`refs/remotes/${remote}/${base}`, `refs/heads/${base}`] : [`refs/heads/${base}`])
      if ((await run(cwd, ["rev-parse", "--verify", "--quiet", ref])).code === 0) return ref.replace(/^refs\/(remotes|heads)\//, "");
    return undefined;
  }

  async function read(): Promise<ScmState> {
    const cwd = deps.root();
    if (!cwd) return EMPTY;
    const top = await run(cwd, ["rev-parse", "--show-prefix"]);
    if (top.code !== 0) return gitMissing(top) ? { ...EMPTY, gitMissing: true } : EMPTY;
    const prefix = top.stdout.trim();
    const [{ state: g, remote }, status, unstagedN, stagedN, rebase, head] = await Promise.all([
      readGit(cwd),
      git(cwd, ["status", "--porcelain=v2", "-b", "-z", "--untracked-files=all", "--", "."]),
      run(cwd, ["diff", "--numstat", "-z", "-M", "--relative"]),
      run(cwd, ["diff", "--cached", "--numstat", "-z", "-M", "--relative"]),
      run(cwd, ["config", "--get", "pull.rebase"]),
      run(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]),
    ]);
    const p = parsePorcelainV2(status);
    const strip = (x: string) => (prefix && x.startsWith(prefix) ? x.slice(prefix.length) : x);
    const nums = { changes: parseNumstat(unstagedN.stdout), staged: parseNumstat(stagedN.stdout) };
    const files: ScmFile[] = [];
    let counted = 0;
    for (const f0 of p.files) {
      const f: ScmFile = { ...f0, path: strip(f0.path), ...(f0.oldPath ? { oldPath: strip(f0.oldPath) } : {}) };
      if (f.area === "staged" || f.area === "changes") Object.assign(f, nums[f.area].get(f.path) ?? {});
      else if (f.area === "untracked" && counted++ < 200) {
        const n = await lineCount(join(cwd, f.path));
        if (n !== undefined) Object.assign(f, { added: n, removed: 0 });
      }
      files.push(f);
    }
    const sha = head.code === 0 ? head.stdout.trim() : undefined;
    const ref = await baseRef(cwd, remote, g.base);
    const onBase = !p.branch || p.branch === g.base;
    let baseAhead = 0;
    let baseBehind = 0;
    const mine = new Set<string>();
    let unpushed = new Set<string>();
    let commits: ScmCommit[] = [];
    if (sha) {
      const cmp = onBase ? (p.upstream ? "@{upstream}" : undefined) : ref;
      const [lr, mineL, unp, log, mb] = await Promise.all([
        cmp && !onBase ? run(cwd, ["rev-list", "--left-right", "--count", `${cmp}...HEAD`]) : undefined,
        cmp ? run(cwd, ["rev-list", "-n", "500", `${cmp}..HEAD`]) : undefined,
        remote ? run(cwd, ["rev-list", "-n", "500", "HEAD", "--not", "--remotes"]) : undefined,
        run(cwd, ["log", "-n", "30", LOG_FORMAT, "HEAD"]),
        cmp ? run(cwd, ["merge-base", "HEAD", cmp]) : undefined,
      ]);
      if (lr?.code === 0) [baseBehind, baseAhead] = lr.stdout.trim().split(/\s+/).map(Number) as [number, number];
      if (mineL?.code === 0) lines(mineL.stdout).forEach((s) => mine.add(s));
      unpushed = remote ? new Set(unp?.code === 0 ? lines(unp.stdout) : []) : new Set(lines((await run(cwd, ["rev-list", "-n", "500", "HEAD"])).stdout));
      commits = log.code === 0 ? parseLog(log.stdout, mine, unpushed) : [];
      const from = mb?.code === 0 ? mb.stdout.trim() : undefined;
      if (from && from !== sha) {
        const [ns, num] = await Promise.all([run(cwd, ["diff", "--name-status", "-z", "-M", "--relative", from, "HEAD"]), run(cwd, ["diff", "--numstat", "-z", "-M", "--relative", from, "HEAD"])]);
        const counts = parseNumstat(num.stdout);
        files.push(...parseNameStatus(ns.stdout, "branch").map((f) => ({ ...f, ...(counts.get(f.path) ?? {}) })));
      }
    }
    let web = false;
    if (remote) web = !!githubWeb((await run(cwd, ["remote", "get-url", remote])).stdout);
    const undo = lastCommit && lastCommit === sha && unpushed.has(lastCommit) ? commits.find((c) => c.sha === lastCommit)?.subject : undefined;
    return {
      isRepo: true,
      ...(p.branch ? { branch: p.branch } : {}),
      ...(p.upstream ? { upstream: p.upstream } : {}),
      ahead: p.ahead,
      behind: p.behind,
      ...(g.base ? { base: g.base } : {}),
      baseAhead: onBase ? p.ahead : baseAhead,
      baseBehind: onBase ? p.behind : baseBehind,
      ...(remote ? { remote } : {}),
      web,
      pull: rebase.stdout.trim() === "true" || rebase.stdout.trim() === "merges" ? "rebase" : "ff-only",
      files,
      commits,
      ...(undo ? { undo } : {}),
      ...(g.operation ? { operation: g.operation } : {}),
    };
  }

  /** Fresh state, one read at a time; pushed to the dock only when it changed. */
  function state(): Promise<ScmState> {
    const cwd = deps.root();
    if (cwd && watched?.root !== cwd) startWatch(cwd);
    const next = chain.then(read);
    chain = next.catch(() => {});
    return next.then((s) => {
      const j = JSON.stringify(s);
      if (j !== lastSent) (lastSent = j), deps.emit(s);
      return s;
    });
  }

  const after = async (): Promise<ScmState> => {
    deps.changed();
    return state();
  };

  /** fs watch on the project and its .git (it may live above the project), debounced, so agent edits and terminal commits show up. */
  function startWatch(cwd: string): void {
    watched?.stop();
    const ws: FSWatcher[] = [];
    const poke = (name: string | null) => {
      const n = name?.toString() ?? "";
      if (/(^|\/)(node_modules|\.shrike)\/|\.git\/objects\/|\.lock$/.test(n)) return;
      clearTimeout(timer);
      timer = setTimeout(() => void state().catch(() => {}), 350);
    };
    const add = (dir: string) => {
      try {
        const w = watch(dir, { recursive: true }, (_e, n) => poke(n));
        w.on("error", () => {});
        ws.push(w);
      } catch {}
    };
    add(cwd);
    void run(cwd, ["rev-parse", "--absolute-git-dir"]).then((r) => {
      const dir = r.stdout.trim();
      if (r.code === 0 && dir && relative(cwd, dir).startsWith("..") && watched?.root === cwd) add(dir);
    });
    watched = { root: cwd, stop: () => (ws.forEach((w) => w.close()), clearTimeout(timer)) };
  }

  /** Only paths git reported in this area, so a renderer can never point git anywhere else. */
  async function known(paths: string[], areas: ScmFile["area"][]): Promise<{ cwd: string; s: ScmState; picked: ScmFile[] }> {
    const cwd = need();
    const s = await read();
    if (!s.isRepo) throw new Error("This folder isn't saved in git yet. Open Terminal in it and run git init.");
    const inArea = s.files.filter((f) => areas.includes(f.area));
    const want = new Set(paths);
    const picked = paths.length ? inArea.filter((f) => want.has(f.path)) : inArea;
    const missing = paths.filter((p) => !inArea.some((f) => f.path === p));
    if (missing.length) throw new Error(`${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} in that list anymore.`);
    return { cwd, s, picked };
  }

  async function stage(paths: string[]): Promise<ScmState> {
    const { cwd, picked } = await known(paths, ["changes", "untracked", "conflicts"]);
    if (picked.length) await git(cwd, ["add", "-A", "--", ...picked.map((f) => lit(f.path))], "Couldn't stage");
    return after();
  }

  async function unstage(paths: string[]): Promise<ScmState> {
    const { cwd, picked } = await known(paths, ["staged"]);
    if (!picked.length) return after();
    const specs = [...new Set(picked.flatMap((f) => [f.path, ...(f.oldPath ? [f.oldPath] : [])]))].map(lit);
    const hasHead = (await run(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;
    await git(cwd, hasHead ? ["restore", "--staged", "--", ...specs] : ["rm", "--cached", "-r", "--quiet", "--", ...specs], "Couldn't unstage");
    return after();
  }

  async function discard(paths: string[]): Promise<ScmState> {
    const { cwd, picked } = await known(paths, ["changes", "untracked"]);
    if (!picked.length) return after();
    const tracked = picked.filter((f) => f.area === "changes");
    const fresh = picked.filter((f) => f.area === "untracked");
    const name = picked.length === 1 ? picked[0]!.path : plural(picked.length, "file");
    const ok = await deps.approve(
      `Throw away your changes to ${name}?`,
      [
        tracked.length ? `${tracked.length === 1 ? "It goes" : `${plural(tracked.length, "file")} go`} back to how ${tracked.length === 1 ? "it was" : "they were"} at your last commit (or what you staged).` : "",
        fresh.length ? `${plural(fresh.length, "new file")} ${fresh.length === 1 ? "is" : "are"} deleted.` : "",
        "This can't be undone. Staged changes and commits are not touched.",
      ]
        .filter(Boolean)
        .join(" "),
    );
    if (!ok) throw new Error("Not thrown away. Your changes are still there.");
    if (tracked.length) await git(cwd, ["restore", "--worktree", "--", ...tracked.map((f) => lit(f.path))], "Couldn't throw the changes away");
    if (fresh.length) await git(cwd, ["clean", "-f", "-q", "--", ...fresh.map((f) => lit(f.path))], "Couldn't delete the new files");
    return after();
  }

  async function commit(message: string): Promise<ScmState> {
    const cwd = need();
    const msg = message.replace(/\r\n?/g, "\n").trim();
    if (!msg) throw new Error("Write what you changed first, or press Write it for me.");
    const s = await read();
    if (!s.isRepo) throw new Error("This folder isn't saved in git yet. Open Terminal in it and run git init.");
    if (s.files.some((f) => f.area === "conflicts") || s.operation) throw new Error("Fix the conflicts first: some files still have them.");
    if (!s.files.some((f) => f.area === "staged")) {
      if (!s.files.some((f) => f.area === "changes" || f.area === "untracked")) throw new Error("There's nothing to commit. Every change is already saved.");
      await git(cwd, ["add", "-A", "--", "."], "Couldn't stage your changes");
    }
    await git(cwd, ["commit", "--quiet", "-F", "-"], "git didn't make the commit", `${msg}\n`);
    lastCommit = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    if (written && msg === written.trim()) deps.used("commit-message");
    written = undefined;
    return after();
  }

  async function undoCommit(): Promise<ScmState> {
    const cwd = need();
    const s = await read();
    if (!lastCommit || !s.undo) throw new Error("There's no commit from Shrike to undo here. A commit that's on GitHub stays.");
    const parent = await run(cwd, ["rev-parse", "--verify", "--quiet", `${lastCommit}^`]);
    await git(cwd, parent.code === 0 ? ["reset", "--soft", "HEAD~1"] : ["update-ref", "-d", "HEAD"], "Couldn't undo the commit");
    lastCommit = undefined;
    return after();
  }

  async function writeMessage(): Promise<string> {
    const cwd = need();
    const s = await read();
    if (!s.isRepo) throw new Error("This folder isn't saved in git yet.");
    const staged = s.files.some((f) => f.area === "staged");
    const pick = s.files.filter((f) => (staged ? f.area === "staged" : f.area === "changes" || f.area === "untracked"));
    if (!pick.length) throw new Error("There's nothing to describe yet. Change something first.");
    const patch = staged ? await git(cwd, ["diff", "--cached", "--no-color", "--no-ext-diff", "-M", "--relative"]) : await run(cwd, ["diff", "HEAD", "--no-color", "--no-ext-diff", "-M", "--relative"]).then((r) => r.stdout);
    const fresh = pick.filter((f) => f.area === "untracked").map((f) => `new file ${f.path}`);
    const all = redactText([patch, ...fresh].join("\n")); // the agent never sees secrets from the patch
    const r = await resolveRecipe("commit-message", {
      branch: s.branch ?? "",
      stagedFiles: pick.map((f) => `${f.letter} ${f.oldPath ? `${f.oldPath} -> ` : ""}${f.path}`).join("\n") + (staged ? "" : "\n(nothing is staged, so the commit takes every change above)"),
      stagedPatch: all.length > 30_000 ? `${all.slice(0, 30_000)}\n…(cut at 30000 characters)` : all,
      context: "",
    });
    const text = cleanMessage(await deps.writeText(r.prompt, r.brain));
    if (!text) throw new Error("Your agent didn't write a message. Try again, or write your own.");
    written = text;
    return text;
  }

  async function sync(): Promise<ScmState> {
    const cwd = need();
    let s = await read();
    if (!s.isRepo) throw new Error("This folder isn't saved in git yet.");
    if (!s.remote) throw new Error("This project isn't connected to GitHub yet, so there's nothing to sync with.");
    if (!s.branch) throw new Error("You're not on a branch right now, so there's nothing to sync.");
    if (s.operation || s.files.some((f) => f.area === "conflicts")) throw new Error("Fix the conflicts first: some files still have them.");
    await git(cwd, ["fetch", "--quiet", s.remote], "Couldn't reach GitHub");
    s = await read();
    if (s.upstream && s.behind) {
      const r = await run(cwd, s.pull === "rebase" ? ["pull", "--rebase", "--autostash", "--quiet"] : ["pull", "--ff-only", "--quiet"]);
      if (r.code !== 0) {
        if (s.pull === "ff-only" && /not possible to fast-forward|diverg/i.test(r.stderr)) throw new Error("GitHub and this computer both have new commits on this branch. Use Sync with main in Ship, or set git config pull.rebase true to sync by rebasing.");
        throw new Error(ghError(r, "Couldn't bring GitHub's commits in"));
      }
      s = await read();
    }
    const unsent = s.upstream ? s.ahead : s.commits.filter((c) => !c.pushed).length;
    if (!s.upstream && !unsent) throw new Error(`${s.branch} has no commits of its own yet, so there's nothing to send.`);
    if (unsent) {
      const ok = await deps.approve(
        s.upstream ? `Send ${plural(unsent, "commit")} to GitHub?` : `Send ${s.branch} to GitHub?`,
        `Shrike pushes ${s.branch} to ${s.remote}${s.upstream ? "" : " as a new branch"}. Nothing is merged and nothing is force-pushed.`,
      );
      if (!ok) throw new Error("Not sent. Your commits stay on this computer.");
      await git(cwd, s.upstream ? ["push", "--quiet"] : ["push", "--quiet", "-u", s.remote!, s.branch!], "GitHub didn't take the push"); // ponytail: never --force
    }
    return after();
  }

  async function diff(t: ScmTarget): Promise<ScmDiff> {
    const cwd = need();
    if (isAbsolute(t.path) || relative(cwd, resolve(cwd, t.path)).startsWith("..")) throw new Error("That file isn't in this project.");
    const s = await read();
    const f = t.area === "commit" ? undefined : s.files.find((x) => x.area === t.area && x.path === t.path);
    if (t.area !== "commit" && !f) throw new Error(`${t.path} has no ${t.area === "branch" ? "commits on this branch" : "changes"} anymore.`);
    const specs = ["--", lit(t.path), ...(f?.oldPath ? [lit(f.oldPath)] : [])];
    const opts = ["--no-color", "--no-ext-diff", "-M", "--relative"];
    let r;
    if (t.area === "staged") r = await run(cwd, ["diff", "--cached", ...opts, ...specs]);
    else if (t.area === "changes") r = await run(cwd, ["diff", ...opts, ...specs]);
    else if (t.area === "conflicts") r = await run(cwd, ["diff", "HEAD", ...opts, ...specs]);
    else if (t.area === "untracked") r = await run(cwd, ["diff", "--no-index", "--no-color", "--", "/dev/null", t.path]);
    else if (t.area === "branch") {
      const ref = s.branch === s.base ? (s.upstream ? "@{upstream}" : undefined) : await baseRef(cwd, s.remote, s.base);
      const mb = ref ? (await git(cwd, ["merge-base", "HEAD", ref])).trim() : "";
      r = await run(cwd, ["diff", ...opts, mb, "HEAD", ...specs]);
    } else {
      if (!/^[0-9a-f]{7,40}$/.test(t.sha ?? "")) throw new Error("That commit isn't in this repo.");
      r = await run(cwd, ["show", "--format=", ...opts, t.sha!, ...specs]);
    }
    if (r.code > 1) throw new Error(ghError(r, `Couldn't show the changes to ${t.path}`));
    const tooBig = r.stdout.length > MAX_PATCH;
    return { path: t.path, ...(f?.oldPath ? { oldPath: f.oldPath } : {}), ...parseUnifiedDiff(tooBig ? "" : r.stdout), ...(tooBig ? { tooBig } : {}) };
  }

  async function commitFiles(sha: string): Promise<ScmFile[]> {
    const cwd = need();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("That commit isn't in this repo.");
    const [ns, num] = await Promise.all([
      git(cwd, ["show", "--format=", "--name-status", "-z", "-M", "--relative", sha]),
      git(cwd, ["show", "--format=", "--numstat", "-z", "-M", "--relative", sha]),
    ]);
    const counts = parseNumstat(num);
    return parseNameStatus(ns, "branch").map((f) => ({ ...f, ...(counts.get(f.path) ?? {}) }));
  }

  /** The branch on github.com (the repo when it isn't pushed yet); undefined for other hosts. */
  async function webUrl(): Promise<string | undefined> {
    const cwd = need();
    const s = await read();
    if (!s.remote) return undefined;
    const repo = githubWeb((await run(cwd, ["remote", "get-url", s.remote])).stdout);
    if (!repo) return undefined;
    const up = s.upstream?.startsWith(`${s.remote}/`) ? s.upstream.slice(s.remote.length + 1) : undefined;
    return up ? `${repo}/tree/${up.split("/").map(encodeURIComponent).join("/")}` : repo;
  }

  return { state, stage, unstage, discard, commit, undoCommit, writeMessage, sync, diff, commitFiles, webUrl, stop: () => (watched?.stop(), (watched = undefined)) };
}

/** The agent's answer as a commit message: no code fences, no "Here's the message:" lead-in. */
export function cleanMessage(text: string): string {
  let t = text.replace(/\r\n?/g, "\n").trim();
  const fence = /```[\w-]*\n([\s\S]*?)\n```/.exec(t);
  if (fence) t = fence[1]!;
  t = t.replace(/^(here(?:'s| is) (?:the|a|your) (?:commit )?message:?|commit message:)\s*\n+/i, "");
  return t.trim().slice(0, 5000);
}
