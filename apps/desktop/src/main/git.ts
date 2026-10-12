import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { AgentOptions, AgentRunInfo, BrainId, Flow, GitState, PullRequest } from "@shrike/schema";
import * as hub from "./github.ts";
import type { Exec, Gh, PrDetail } from "./github.ts";
import { resolveRecipe } from "./recipes.ts";
import { defaultShell, loginPathNeeded } from "./platform.ts";
import { noteOutcome } from "./skills.ts";

// G1–G6: git on the user's machine through the git CLI (and GitHub through gh, see github.ts).
// Anything that leaves the machine or merges goes through an approval first. Never a force-push.

let loginPathP: Promise<string | undefined> | undefined;
/** GUI apps on macOS and Linux start with a minimal PATH; git and gh live where the login shell says. Windows apps get the full one. */
function loginPath(): Promise<string | undefined> {
  return (loginPathP ??= new Promise((done) => {
    if (!loginPathNeeded()) return done(undefined);
    execFile(defaultShell(), ["-lc", 'printf "__SHRIKE__%s" "$PATH"'], { timeout: 5000 }, (err, out) => done(err ? undefined : out.split("__SHRIKE__").pop()?.trim() || undefined));
  }));
}

export const exec: Exec = async (cmd, args, o) => {
  const PATH = await loginPath();
  const env = { ...process.env, ...(PATH ? { PATH } : {}), GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
  const timeout = o.timeoutMs ?? 180_000;
  return new Promise((done) => {
    const child = execFile(cmd, args, { cwd: o.cwd, env, maxBuffer: 64 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      const late = err?.killed && err.signal ? `${basename(cmd)} didn't answer in ${Math.round(timeout / 1000)} seconds.` : "";
      done({ code: err ? (typeof err.code === "number" ? err.code : 127) : 0, stdout: String(stdout), stderr: late || String(stderr) || (err?.message ?? "") });
    });
    child.stdin?.on("error", () => {}); // git can exit before reading it: EPIPE on Linux
    child.stdin?.end(o.input ?? "");
  });
};

export const realGh: Gh = hub.makeGh(exec);

const tryGit = (cwd: string, args: string[]) => exec("git", args, { cwd });

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await tryGit(cwd, args);
  if (r.code !== 0) throw new Error(hub.ghError(r, `git ${args[0]} didn't work`));
  return r.stdout;
}

// ---- reading the repo ----

const CONFLICT = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/** `git status --porcelain=v1 -b -z` → branch, upstream, ahead/behind, changed files, conflicts. */
export function parseStatus(out: string): Pick<GitState, "branch" | "upstream" | "ahead" | "behind" | "changed" | "conflicts"> {
  const parts = out.split("\0");
  const s: ReturnType<typeof parseStatus> = { ahead: 0, behind: 0, changed: [], conflicts: [] };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (!p) continue;
    if (p.startsWith("## ")) {
      const h = p.slice(3).replace(/^(No commits yet on|Initial commit on) /, "");
      if (h.startsWith("HEAD (no branch)")) continue;
      const m = /^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(h);
      if (!m) continue;
      s.branch = m[1];
      if (m[2]) s.upstream = m[2];
      s.ahead = Number(/ahead (\d+)/.exec(m[3] ?? "")?.[1] ?? 0);
      s.behind = Number(/behind (\d+)/.exec(m[3] ?? "")?.[1] ?? 0);
      continue;
    }
    const xy = p.slice(0, 2);
    const path = p.slice(3);
    if (xy[0] === "R" || xy[0] === "C") i++; // -z: the old path follows as its own entry
    if (CONFLICT.has(xy)) s.conflicts.push(path);
    s.changed.push({ path, status: xy.trim() });
  }
  return s;
}

interface Local {
  state: Omit<GitState, "ghReady">;
  remote?: string;
}

/** git itself didn't run: not installed, or macOS's stand-in that asks for the developer tools. */
export const gitMissing = (r: { code: number; stderr: string }): boolean => r.code === 127 || /xcrun: error|command not found|not recognized|ENOENT/.test(r.stderr);

/** Everything local and cheap: no network, no gh. Paths are relative to `cwd` (the project root). */
export async function readGit(cwd: string): Promise<Local> {
  const top = await tryGit(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "rebase-merge", "--git-path", "rebase-apply", "--git-path", "MERGE_HEAD"]);
  if (top.code !== 0) return { state: { isRepo: false, ahead: 0, behind: 0, changed: [], conflicts: [], ...(gitMissing(top) ? { gitMissing: true } : {}) } };
  const [rebaseMerge, rebaseApply, mergeHead] = top.stdout.split("\n").map((l) => resolve(cwd, l.trim()));
  const [status, remotes, refs, originHead] = await Promise.all([
    git(cwd, ["--no-optional-locks", "status", "--porcelain=v1", "-b", "-z", "--untracked-files=all", "--", "."]), // no index refresh: the Changes dock watches .git
    tryGit(cwd, ["remote"]),
    tryGit(cwd, ["for-each-ref", "--format=%(refname)", "refs/heads/main", "refs/heads/master", "refs/remotes/origin/main", "refs/remotes/origin/master"]),
    tryGit(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
  ]);
  const s = parseStatus(status);
  // status -z paths are relative to the repo top; Shrike works in project-root paths.
  const prefix = (await tryGit(cwd, ["rev-parse", "--show-prefix"])).stdout.trim();
  if (prefix) {
    const strip = (p: string) => (p.startsWith(prefix) ? p.slice(prefix.length) : p);
    s.changed = s.changed.map((c) => ({ ...c, path: strip(c.path) }));
    s.conflicts = s.conflicts.map(strip);
  }
  const names = remotes.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const remote = names.includes("origin") ? "origin" : names[0];
  const have = new Set(refs.stdout.split("\n").map((l) => l.trim()));
  const base = originHead.code === 0 && originHead.stdout.trim() ? originHead.stdout.trim().replace(/^[^/]+\//, "") : ["main", "master"].find((b) => have.has(`refs/heads/${b}`) || have.has(`refs/remotes/origin/${b}`));
  const operation = existsSync(rebaseMerge!) || existsSync(rebaseApply!) ? "rebase" : existsSync(mergeHead!) ? "merge" : undefined;
  let incoming: GitState["incoming"];
  if (remote && base && s.branch) {
    const log = await tryGit(cwd, ["log", "--format=%h%x09%s", "-n", "20", `HEAD..${remote}/${base}`]);
    if (log.code === 0) incoming = log.stdout.split("\n").filter(Boolean).map((l) => ({ sha: l.split("\t")[0]!, subject: l.split("\t").slice(1).join("\t") }));
  }
  let onBranch: number | undefined;
  if (base && s.branch && s.branch !== base) {
    const n = await tryGit(cwd, ["rev-list", "--count", `${have.has(`refs/remotes/origin/${base}`) ? "origin/" : ""}${base}..HEAD`]);
    if (n.code === 0) onBranch = Number(n.stdout.trim()) || 0;
  }
  return { state: { isRepo: true, ...s, ...(base ? { base } : {}), ...(operation ? { operation } : {}), ...(incoming ? { incoming } : {}), ...(onBranch !== undefined ? { onBranch } : {}) }, remote };
}

async function markersLeft(cwd: string, files: string[]): Promise<string[]> {
  const left: string[] = [];
  for (const f of files) {
    const text = await readFile(join(cwd, f), "utf8").catch(() => "");
    if (hub.conflictHunks(text).length) left.push(f);
  }
  return left;
}

// ---- words ----

export function branchName(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40).replace(/-+$/, "");
  return `fix/${slug || "shrike"}`;
}

async function freeBranch(cwd: string, name: string): Promise<string> {
  for (let i = 1; ; i++) {
    const n = i === 1 ? name : `${name}-${i}`;
    if ((await tryGit(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${n}`])).code !== 0) return n;
  }
}

const mdTitle = (md: string | undefined) => md && /^# (.+)$/m.exec(md)?.[1]?.trim();

/** First paragraph under a "## heading" of the issue markdown. */
function mdSection(md: string, heading: string): string | undefined {
  const at = md.indexOf(`## ${heading}\n`);
  if (at < 0) return undefined;
  const rest = md.slice(at + heading.length + 4).split(/\n## /)[0]!;
  const para = rest.trim().split(/\n\s*\n/)[0]?.trim();
  return para ? (para.length > 600 ? `${para.slice(0, 599)}…` : para) : undefined;
}

/** G1: subject from the trip verdict, body from what the agent found (else what happened). */
export function commitMessage(title: string, md?: string): string {
  const subject = `Fix: ${title}`.replace(/\s+/g, " ").trim();
  const short = subject.length > 72 ? `${subject.slice(0, 71).replace(/\s+\S*$/, "")}…` : subject;
  const body = md ? (mdSection(md, "What the agent found") ?? mdSection(md, "What happened")) : undefined;
  return [short, ...(body ? ["", body] : []), "", "Found and fixed with Shrike."].join("\n");
}

const clipText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…(cut at ${n} characters)` : s);

export function reviewGoal(pr: PrDetail, diff: string): string {
  return [
    `Review pull request #${pr.number}: "${pr.title}". This is review mode: do not change any files and do not call propose_patch. Nothing is posted to GitHub.`,
    "Read the diff, open the files it touches when you need more context, and look for bugs, missing error handling, security problems and changes that don't match the description.",
    "Report each real problem with report_findings: a one-sentence plain claim, the file (repo-relative) and the line in the new version, and your confidence. If it looks good, say so in the summary and report no findings.",
    `<description>\n${clipText(pr.body || "(no description)", 4000)}\n</description>`,
    `<diff>\n${clipText(diff, 60_000)}\n</diff>`,
  ].join("\n\n");
}

export function conflictGoal(files: { file: string; hunks: hub.ConflictHunk[] }[], s: Pick<GitState, "operation" | "base" | "branch">): string {
  const sides =
    s.operation === "rebase"
      ? `"ours" (the top side) is ${s.base ?? "main"} and "theirs" (the bottom side) is the user's own change being replayed on it`
      : `"ours" (the top side) is the user's branch${s.branch ? ` ${s.branch}` : ""} and "theirs" (the bottom side) is the incoming change`;
  const body = files
    .map(({ file, hunks }) =>
      hunks.length
        ? `${file}\n${hunks.map((h) => `  conflict at line ${h.line}:\n  <ours ${h.oursLabel}>\n${h.ours.join("\n")}\n  </ours>\n  <theirs ${h.theirsLabel}>\n${h.theirs.join("\n")}\n  </theirs>`).join("\n")}`
        : `${file}\n  (deleted on one side; keep it or remove it, and say which)`,
    )
    .join("\n\n");
  return [
    `Fix the merge conflicts in ${files.length === 1 ? "1 file" : `${files.length} files`}. In each conflict, ${sides}.`,
    "For each file, call propose_patch once with edits that replace every whole conflict block (from the <<<<<<< line through the >>>>>>> line) with the resolved code. Keep what both sides meant; when they truly disagree, prefer the incoming behaviour and say why in the rationale.",
    "Do not touch files without conflicts. Shrike finishes the sync and re-runs the saved flows after the last file is fixed.",
    clipText(body, 60_000),
  ].join("\n\n");
}

export function explainGoal(n: number, name: string, log: { summary: string; lines: string[] }, url?: string): string {
  return [
    `The "${name}" check on pull request #${n} failed${url ? ` (${url})` : ""}. Explain why in plain words for someone who didn't write the code, and point to the file and line to change.`,
    "Use report_findings for the cause. Only propose a patch if the fix is clear and small; the user decides.",
    `What Shrike pulled out of the log: ${log.summary}`,
    log.lines.length ? `<failing-lines>\n${log.lines.join("\n")}\n</failing-lines>` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ---- the service ----

/** Evolve-on-outcome: this project's ship and CI-fix drafts are kept when an open PR's checks turn all green, and left pending when they turn red.
 *  Only a change counts: a PR already green when first seen says nothing about a draft made since. */
const lastChecks = new Map<string, string>();
function checksOutcome(pr: PullRequest | undefined): void {
  if (pr?.state !== "open") return;
  const st = pr.checks.map((c) => c.state).filter((x) => x !== "skipped");
  const v = !st.length || st.includes("pending") ? "pending" : st.every((x) => x === "pass") ? "pass" : "fail";
  const was = lastChecks.get(pr.url);
  lastChecks.set(pr.url, v);
  if (was !== undefined && was !== v && v !== "pending") noteOutcome(["ship", "ci"], v === "pass");
}

export interface GitDeps {
  root(): string | undefined;
  gh: Gh;
  approve(title: string, reason: string): Promise<boolean>;
  startAgent(goal: string, opts: AgentOptions, brain?: BrainId): Promise<AgentRunInfo>; // brain: the action recipe's agent (S8)
  issue(actionId: string): Promise<string | undefined>; // the issue markdown (O6) for a trip
  shrikeFiles(): string[]; // files changed by Shrike-applied patches that are still applied (checkpoints)
  lastFix(): string | undefined; // the newest applied checkpoint's label
  flows(): Promise<Pick<Flow, "id" | "name" | "lastRun">[]>;
  runFlow(id: string): Promise<{ ok: boolean }>;
  emit(s: GitState): void;
}

export type GitService = ReturnType<typeof createGit>;

export function createGit(deps: GitDeps) {
  const gh = deps.gh;
  let ghCache: { at: number; v: Awaited<ReturnType<typeof hub.ghStatus>> } | undefined;
  const logs = new Map<string, { summary: string; lines: string[] }>(); // failed-check logs by link; a failed run's log doesn't change
  let resolving = false; // G3: a Shrike conflict run is in progress; finish the sync once every marker is gone
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: GitState | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  const need = (): string => {
    const r = deps.root();
    if (!r) throw new Error("No project is open.");
    return r;
  };

  async function ghReady(cwd: string) {
    if (!ghCache || Date.now() - ghCache.at > (ghCache.v.ready ? 300_000 : 15_000)) ghCache = { at: Date.now(), v: await hub.ghStatus(gh, cwd) };
    return ghCache.v;
  }

  async function withLogs(cwd: string, pr: PullRequest): Promise<PullRequest> {
    const checks = await Promise.all(
      pr.checks.map(async (c) => {
        if (c.state !== "fail") return c;
        const key = c.url ?? `${pr.number}:${c.name}`;
        const log = logs.get(key) ?? (await hub.failedLog(gh, cwd, c.name, c.url));
        logs.set(key, log);
        return { ...c, ...log };
      }),
    );
    return { ...pr, checks };
  }

  async function state(): Promise<GitState> {
    const cwd = deps.root();
    if (!cwd) return { isRepo: false, ahead: 0, behind: 0, changed: [], conflicts: [], ghReady: false };
    const { state: s, remote } = await readGit(cwd);
    if (!s.isRepo) return { ...s, ghReady: false };
    const g = await ghReady(cwd);
    const pr = g.ready && remote && s.branch && s.branch !== s.base ? await hub.prView(gh, cwd, s.branch) : undefined;
    return { ...s, ghReady: g.ready, ...(g.problem ? { ghProblem: g.problem } : {}), ...(pr ? { pr: await withLogs(cwd, toPlain(pr)) } : {}) };
  }

  const toPlain = ({ number, title, url, state, checks }: PullRequest): PullRequest => ({ number, title, url, state, checks });

  /** Fresh state to the renderer, one at a time; also finishes a Shrike conflict fix once the markers are gone. */
  function refresh(): Promise<GitState | undefined> {
    const next = chain.then(async () => {
      let s = await state();
      if (resolving && s.conflicts.length && !(await markersLeft(need(), s.conflicts)).length) {
        await finish().catch(() => (resolving = false));
        s = await state();
      }
      if (!s.conflicts.length && !s.operation) resolving = false;
      last = s;
      deps.emit(s);
      checksOutcome(s.pr);
      return s;
    });
    chain = next.catch(() => {});
    return next.catch(() => undefined);
  }

  /** The PR panel read this PR's checks: when they moved on (a re-run went green), refresh so the rail and the Ship sheet follow. */
  function prSeen(n: number, checks: { name: string; state: string }[]): Promise<unknown> | undefined {
    const key = (cs: { name: string; state: string }[]) => cs.map((c) => `${c.name}:${c.state}`).sort().join();
    if (last?.pr?.number === n && key(last.pr.checks) !== key(checks)) return refresh();
  }

  /** Debounced refresh, for file changes. */
  function poke(): void {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 400);
  }

  /** G3 end: stage the fixed files, continue the rebase or merge, then re-run the saved flows (L4 Prove). */
  async function finish(): Promise<void> {
    const cwd = need();
    const { state: s } = await readGit(cwd);
    const left = await markersLeft(cwd, s.conflicts);
    if (left.length) throw new Error(`${left.join(", ")} still ${left.length === 1 ? "has" : "have"} conflicts.`);
    if (s.conflicts.length) await git(cwd, ["add", "-A", "--", ...s.conflicts]);
    if (s.operation === "rebase") {
      const r = await tryGit(cwd, ["rebase", "--continue"]);
      if (r.code !== 0 && !(await readGit(cwd)).state.conflicts.length) throw new Error(hub.ghError(r, "git couldn't finish the rebase"));
    } else if (s.operation === "merge") await git(cwd, ["commit", "--no-edit"]);
    const after = (await readGit(cwd)).state;
    if (!after.conflicts.length && !after.operation) {
      resolving = false;
      void prove().then((r) => noteOutcome(["conflicts"], r.ok)); // evolve-on-outcome: merge clean and the tests pass
    }
  }

  async function prove(): Promise<{ ok: boolean; count: number }> {
    const flows = await deps.flows().catch(() => []);
    let ok = true;
    for (const f of flows) ok = (await deps.runFlow(f.id).catch(() => ({ ok: false }))).ok && ok;
    return { ok, count: flows.length };
  }

  async function shipFix(opts: { actionId?: string; title?: string; files?: string[] }): Promise<PullRequest> {
    const cwd = need();
    const { state: s, remote } = await readGit(cwd);
    if (!s.isRepo) throw new Error("This folder isn't saved in git yet, so there's nothing to ship. Run git init in it first.");
    if (s.conflicts.length || s.operation) throw new Error("Finish syncing first: some files still have conflicts.");
    const changed = new Set(s.changed.map((c) => c.path));
    const unknown = opts.files?.filter((f) => !changed.has(f)) ?? [];
    if (unknown.length) throw new Error(`${unknown.join(", ")} ${unknown.length === 1 ? "has" : "have"} no changes to ship.`);
    const files = opts.files?.length ? opts.files : deps.shrikeFiles().filter((f) => changed.has(f));
    const committed = !files.length && !opts.files?.length && s.branch && s.branch !== s.base ? (s.onBranch ?? 0) : 0; // already committed (the Changes dock): push and open the PR
    if (!files.length && !committed) throw new Error("There are no changes from Shrike's fixes to ship. Pick the files to include.");

    const md = opts.actionId ? await deps.issue(opts.actionId).catch(() => undefined) : undefined;
    const title = (opts.title?.trim() || mdTitle(md) || deps.lastFix() || "Fix from Shrike").slice(0, 120);
    const base = s.base ?? "main";
    let branch = s.branch;
    let subject: string;
    let body: string;
    if (committed) {
      branch = s.branch!;
      const log = (await git(cwd, ["log", "--format=%B%x00", `-n${committed}`])).split("\0").map((m) => m.trim()).filter(Boolean);
      subject = log[0]!.split("\n")[0]!; // the newest commit says what this branch is for
      body = md ?? (log.length === 1 ? `${log[0]}\n` : `${log.map((m) => `- ${m.split("\n")[0]}`).join("\n")}\n`);
    } else {
      if (!branch || branch === base || branch === "main" || branch === "master") {
        branch = await freeBranch(cwd, branchName(title));
        await git(cwd, ["switch", "-c", branch]); // your changes come along; main itself is untouched
      }
      await git(cwd, ["add", "-A", "--", ...files]);
      const message = commitMessage(title, md);
      subject = message.split("\n")[0]!;
      body = md ?? `${commitMessage(title)}\n`;
      await git(cwd, ["commit", "--quiet", "-m", message, "--", ...files]);
    }
    const done = (msg: string): never => {
      void refresh();
      throw new Error(msg);
    };
    if (!remote) return done(`Saved your fix as a commit on ${branch}. This project has no GitHub remote, so it stays on this computer.`);

    const g = await ghReady(cwd);
    const open = g.ready ? await hub.prView(gh, cwd, branch) : undefined;
    const existing = open?.state === "open" ? open : undefined;
    const ok = await deps.approve(
      existing ? `Send this fix to pull request #${existing.number}?` : g.ready ? `Send ${branch} to GitHub and open a pull request?` : `Send ${branch} to GitHub?`,
      [
        committed ? `Shrike pushes ${committed === 1 ? `your commit "${subject}"` : `${committed} commits`} on ${branch} to ${remote}.` : `Shrike pushes your commit "${subject}" (${files.length === 1 ? files[0] : `${files.length} files`}) to ${remote}.`,
        existing ? "The pull request updates by itself." : g.ready ? `Then it opens a pull request into ${base} with ${md ? "the issue" : committed ? "your commit message" : "the fix"} as its description. Nothing is merged.` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
    if (!ok) return done(`Not sent. Your fix is saved as a commit on ${branch}.`);
    await git(cwd, ["push", "--quiet", "-u", remote, branch]); // ponytail: never --force; a rejected push surfaces as git's own words
    if (!existsSync(join(cwd, ".github", "workflows"))) noteOutcome(["ship"], true); // no CI: pushed is the outcome
    if (!g.ready) return done(`Sent ${branch} to GitHub. To open the pull request from here: ${hub.GH_SETUP[g.problem ?? "missing"]}`);
    const n = existing?.number ?? (await hub.createPr(gh, cwd, { base, head: branch, title: subject, body }));
    const pr = await hub.prView(gh, cwd, n);
    void refresh();
    if (!pr) throw new Error(`Opened pull request #${n}, but couldn't read it back.`);
    return withLogs(cwd, toPlain(pr));
  }

  async function needGh(cwd: string): Promise<void> {
    const g = await ghReady(cwd);
    if (!g.ready) throw new Error(hub.GH_SETUP[g.problem ?? "missing"]);
  }

  async function listPullRequests(): Promise<PullRequest[]> {
    const cwd = need();
    await needGh(cwd);
    return hub.listPrs(gh, cwd);
  }

  async function reviewPullRequest(n: number): Promise<AgentRunInfo> {
    const cwd = need();
    await needGh(cwd);
    const pr = await hub.prView(gh, cwd, n);
    if (!pr) throw new Error(`Couldn't find pull request #${n}.`);
    const r = await resolveRecipe("review-pr", { context: reviewGoal(pr, await hub.prDiff(gh, cwd, n)), branch: pr.head ?? "", baseBranch: pr.base ?? "main" });
    return deps.startAgent(r.prompt, { skillId: r.skillId ?? "review-pr" }, r.brain);
  }

  async function resolveConflicts(): Promise<AgentRunInfo> {
    const cwd = need();
    const { state: s } = await readGit(cwd);
    if (!s.conflicts.length) throw new Error("There are no conflicts to fix.");
    const files = await Promise.all(s.conflicts.map(async (file) => ({ file, hunks: hub.conflictHunks(await readFile(join(cwd, file), "utf8").catch(() => "")) })));
    resolving = true;
    const r = await resolveRecipe("conflict-resolution", { context: conflictGoal(files, s), branch: s.branch ?? "", baseBranch: s.base ?? "main", changedFiles: s.conflicts.join("\n") });
    return deps.startAgent(r.prompt, { skillId: r.skillId ?? "fix-conflicts" }, r.brain);
  }

  async function explainCheck(n: number, name: string): Promise<AgentRunInfo> {
    const cwd = need();
    await needGh(cwd);
    const c = (await hub.prChecks(gh, cwd, n)).find((x) => x.name === name);
    if (!c) throw new Error(`Pull request #${n} has no check called "${name}".`);
    const key = c.url ?? `${n}:${name}`;
    const log = logs.get(key) ?? (await hub.failedLog(gh, cwd, name, c.url));
    logs.set(key, log);
    const r = await resolveRecipe("broken-checks", { context: explainGoal(n, name, log, c.url), failingStep: name });
    return deps.startAgent(r.prompt, { skillId: r.skillId ?? "explain-ci" }, r.brain);
  }

  async function mergePullRequest(n: number): Promise<void> {
    const cwd = need();
    await needGh(cwd);
    const pr = await hub.prView(gh, cwd, n);
    if (!pr) throw new Error(`Couldn't find pull request #${n}.`);
    if (pr.state !== "open") throw new Error(`Pull request #${n} is already ${pr.state}.`);
    const why = hub.mergeBlocker(pr.checks, await deps.flows().catch(() => []));
    if (why) throw new Error(why);
    const base = pr.base ?? "main";
    const ok = await deps.approve(
      `Merge pull request #${n} into ${base}?`,
      `GitHub squashes "${pr.title}" into one commit on ${base} and deletes its branch${pr.head ? ` ${pr.head}` : ""}. This folder then switches to ${base}.`,
    );
    if (!ok) throw new Error("Not merged.");
    await hub.mergePr(gh, cwd, n);
    noteOutcome(["ship"], true);
    void refresh();
  }

  async function syncWithMain(opts?: { mode?: "preview" | "rebase" | "merge" | "continue" | "abort" }): Promise<GitState> {
    const cwd = need();
    const mode = opts?.mode;
    const { state: s, remote } = await readGit(cwd);
    if (!s.isRepo) throw new Error("This folder isn't saved in git yet.");
    if (mode === "abort") {
      if (s.operation) await git(cwd, [s.operation, "--abort"]);
      resolving = false;
      return (await refresh()) ?? state();
    }
    if (mode === "continue") {
      await finish();
      return (await refresh()) ?? state();
    }
    if (!remote) throw new Error("This project has no remote to sync with.");
    if (s.operation && !(s.operation === "rebase" && mode === "merge")) throw new Error("A sync is already part way through. Fix the conflicts, or undo it.");
    const base = s.base ?? "main";
    await git(cwd, ["fetch", "--quiet", remote, base]);
    if (mode === "preview") return (await refresh()) ?? state();
    if (s.operation === "rebase") await git(cwd, ["rebase", "--abort"]); // mode "merge": the user would rather merge than rebase
    const fresh = (await readGit(cwd)).state;
    if (!fresh.incoming?.length) return (await refresh()) ?? state();
    // Rebasing a branch that's already on GitHub would need a force-push, which Shrike never does: merge instead.
    const how = mode ?? (fresh.upstream ? "merge" : "rebase");
    if (fresh.branch === base) {
      const n = fresh.incoming.length;
      const ok = await deps.approve(`Update your ${base} branch?`, `Shrike brings ${n === 1 ? "1 new change" : `${n} new changes`} from ${remote}/${base} into your local ${base}.`);
      if (!ok) throw new Error(`Not updated. Your ${base} branch is as it was.`);
    }
    const target = `${remote}/${base}`;
    const r = await tryGit(cwd, how === "rebase" ? ["rebase", "--autostash", target] : ["merge", "--no-edit", "--autostash", target]);
    const after = (await refresh()) ?? (await state());
    if (r.code !== 0 && !after.conflicts.length) throw new Error(hub.ghError(r, `git couldn't ${how} onto ${base}`));
    return after;
  }

  return { state, refresh, poke, prSeen, shipFix, listPullRequests, reviewPullRequest, resolveConflicts, explainCheck, mergePullRequest, syncWithMain, prove };
}
