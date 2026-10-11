// WS1/WS2: every project Shrike knows and all of its worktrees, grouped by status, and the Create workspace flow.
// No Electron imports (tested with node:test): index wiring passes the Electron bits in.
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, sep } from "node:path";
import type { ApprovalRequest, CreateWorkspace, RunStatus, ShrikeEvents, Workspace, WorkspaceSources } from "@shrike/schema";
import { groupOf, parsePorcelain, parseSmart, slugName } from "../renderer/src/workspaces/logic.ts";
import * as wt from "./worktrees.ts";

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WorkspaceDeps {
  file: string; // <userData>/workspaces.json
  gh(args: string[], cwd: string): Promise<ExecResult>; // read-only calls, plus `pr checkout` inside a new worktree
  current(): string | null; // the open project's root
  status(path: string): RunStatus | undefined; // the shown run or a background one
  portsOf(root: string): Promise<number[]>;
  requestApproval(req: Omit<ApprovalRequest, "id">): Promise<boolean>;
  stopBackground(path: string): Promise<void>;
  emit<K extends keyof ShrikeEvents>(channel: K, payload: ShrikeEvents[K]): void;
}

interface Saved {
  projects: string[]; // project roots, most recent first
  labels: Record<string, string>; // workspace path -> the user's own name
}

type Pr = NonNullable<Workspace["pr"]> & { branch: string };
const PR_TTL = 60_000;
const NOT_SHRIKE = ":(exclude).shrike";

export function createWorkspaces(d: WorkspaceDeps) {
  const agent = new Map<string, Workspace["agent"]>(); // by workspace path
  const runRoot = new Map<string, string>(); // agent run id -> the folder it started in
  const before = new Map<string, Workspace["agent"]>(); // the dot to go back to once an approval is answered
  const prs = new Map<string, { at: number; list: Pr[] }>(); // by main checkout
  let last: Workspace[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const read = (): Saved => {
    try {
      const v = JSON.parse(readFileSync(d.file, "utf8")) as Partial<Saved>;
      return { projects: Array.isArray(v.projects) ? v.projects.filter((p): p is string => typeof p === "string") : [], labels: v.labels && typeof v.labels === "object" ? v.labels : {} };
    } catch {
      return { projects: [], labels: {} };
    }
  };
  const write = (s: Saved) => writeFileSync(d.file, JSON.stringify(s, null, 2));

  /** A project folder, remembered by its main checkout (plus the monorepo subfolder), most recent first. */
  async function remember(root: string): Promise<string> {
    const real = realpathSync(root);
    const { main, sub } = await where(real).catch(() => ({ main: real, sub: "" }));
    const key = sub ? join(main, sub) : main;
    const s = read();
    if (s.projects[0] !== key) write({ ...s, projects: [key, ...s.projects.filter((p) => p !== key)].slice(0, 30) });
    return key;
  }

  async function where(root: string): Promise<{ main: string; sub: string }> {
    const main = await wt.mainRoot(root);
    const sub = (await wt.git(root, ["rev-parse", "--show-prefix"])).trim().replace(/\/$/, "");
    return { main, sub };
  }

  async function pullRequests(main: string): Promise<Pr[]> {
    const hit = prs.get(main);
    if (hit && Date.now() - hit.at < PR_TTL) return hit.list;
    let list: Pr[] = [];
    try {
      const r = await d.gh(["pr", "list", "--state", "all", "--limit", "50", "--json", "number,state,headRefName,url,isDraft"], main);
      const raw = r.code === 0 ? (JSON.parse(r.stdout) as { number: number; state: string; headRefName: string; url: string; isDraft?: boolean }[]) : [];
      list = raw.map((p) => ({ number: p.number, url: p.url, branch: p.headRefName, draft: !!p.isDraft, state: p.state === "MERGED" ? "merged" : p.state === "CLOSED" ? "closed" : "open" }));
    } catch {}
    prs.set(main, { at: Date.now(), list });
    return list;
  }

  const count = (s: string) => s.split("\n").filter(Boolean).length;

  async function rowsOf(project: string, labels: Saved["labels"], cur: string | null): Promise<Workspace[]> {
    const name = basename(project);
    const loc = await where(project).catch(() => null);
    const port = (path: string) => {
      const u = d.status(path)?.url;
      return u ? Number(new URL(u).port) || undefined : undefined;
    };
    const alive = (path: string) => ["starting", "running"].includes(d.status(path)?.state ?? "");
    if (!loc) {
      const a = agent.get(project) ?? "idle";
      return [{ path: project, projectRoot: project, project: name, name: "main", kind: "main", branch: "", current: cur === project, running: alive(project), port: port(project), portOffset: 0, agent: a, group: groupOf({ agent: a }), ...(labels[project] ? { label: labels[project] } : {}) }];
    }
    const { main, sub } = loc;
    const [meta, list, open] = await Promise.all([wt.readMeta(main), wt.git(main, ["worktree", "list", "--porcelain"]), pullRequests(main)]);
    const out: Workspace[] = [];
    for (const [i, w] of parsePorcelain(list).entries()) {
      if (w.prunable || !existsSync(w.path)) continue;
      const real = realpathSync(w.path);
      const path = sub ? join(real, sub) : real;
      if (!existsSync(path)) continue;
      const shrikeName = real.startsWith(join(main, ".shrike", "worktrees") + sep) ? basename(real) : undefined;
      const kind: Workspace["kind"] = i === 0 ? "main" : shrikeName && meta[shrikeName] ? "shrike" : "git";
      const [lr, st] = await Promise.all([
        wt.git(real, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]).catch(() => ""),
        wt.git(real, ["status", "--porcelain", "--", ".", NOT_SHRIKE]).catch(() => ""),
      ]);
      const [ahead, behind] = lr.trim() ? lr.trim().split(/\s+/).map(Number) : [];
      const pr = w.branch ? open.find((p) => p.branch === w.branch) : undefined;
      const a = agent.get(path) ?? "idle";
      const m = shrikeName ? meta[shrikeName] : undefined;
      out.push({
        path,
        projectRoot: sub ? join(main, sub) : main,
        project: name,
        name: i === 0 ? "main" : basename(real),
        kind,
        branch: w.branch || (w.head ? w.head.slice(0, 7) : "detached"),
        current: cur === path,
        running: alive(path),
        port: port(path),
        portOffset: m?.portOffset ?? 0,
        agent: a,
        ...(pr ? { pr: { number: pr.number, state: pr.state, url: pr.url, ...(pr.draft ? { draft: true } : {}) } } : {}),
        ...(ahead !== undefined ? { ahead, behind } : {}),
        changes: count(st),
        group: groupOf({ agent: a, pr }),
        ...(m?.note ? { note: m.note } : {}),
        ...(labels[path] ? { label: labels[path] } : {}),
      });
    }
    return out;
  }

  async function list(): Promise<Workspace[]> {
    const cur = d.current();
    if (cur) await remember(cur).catch(() => {});
    const s = read();
    const rows = await Promise.all(s.projects.filter((p) => existsSync(p)).map((p) => rowsOf(p, s.labels, cur).catch(() => [] as Workspace[])));
    last = rows.flat();
    return last;
  }

  const publish = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void list().then((l) => d.emit("workspaces:update", l), () => {}), 400);
  };

  /** A path the renderer sent must be one of the rows Shrike listed (the trust boundary for every action below). */
  async function known(path: string): Promise<Workspace> {
    const w = last.find((x) => x.path === path) ?? (await list()).find((x) => x.path === path);
    if (!w) throw new Error("Shrike doesn't know that workspace anymore. It may have been removed.");
    return w;
  }

  async function sources(project: string): Promise<WorkspaceSources> {
    const { main } = await where(project);
    const current = (await wt.git(main, ["branch", "--show-current"])).trim() || "detached";
    const refs = (await wt.git(main, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes"])).split("\n").filter(Boolean);
    const branches = refs
      .filter((r) => !r.endsWith("/HEAD") && !r.startsWith("refs/heads/shrike/"))
      .map((r) => (r.startsWith("refs/heads/") ? { name: r.slice(11), remote: false } : { name: r.slice(13), remote: true }));
    let open: WorkspaceSources["prs"] = [];
    let prsError: string | undefined;
    const r = await d.gh(["pr", "list", "--state", "open", "--limit", "50", "--json", "number,title,headRefName,author,isDraft"], main).catch((e: Error) => ({ code: 1, stdout: "", stderr: e.message }));
    if (r.code === 0) {
      try {
        open = (JSON.parse(r.stdout) as { number: number; title: string; headRefName: string; author?: { login?: string }; isDraft?: boolean }[]).map((p) => ({ number: p.number, title: p.title, branch: p.headRefName, ...(p.author?.login ? { author: p.author.login } : {}), ...(p.isDraft ? { draft: true } : {}) }));
      } catch {}
    } else prsError = /auth|login/i.test(r.stderr) ? "Sign in to GitHub to see pull requests: run gh auth login in Terminal." : /ENOENT|not found/i.test(r.stderr) ? "Install GitHub's command line tool (brew install gh) to see pull requests." : "This project has no GitHub pull requests Shrike can see.";
    return { current, branches, prs: open, ...(prsError ? { prsError } : {}), location: join(main, ".shrike", "worktrees") };
  }

  async function checkoutPr(path: string, n: number): Promise<void> {
    const r = await d.gh(["pr", "checkout", String(n)], path).catch((e: Error) => ({ code: 1, stdout: "", stderr: e.message }));
    if (r.code === 0) return;
    try {
      await wt.git(path, ["fetch", "origin", `pull/${n}/head`]);
      await wt.git(path, ["checkout", "-q", "-B", `pr-${n}`, "FETCH_HEAD"]);
    } catch {
      throw new Error(`Couldn't get pull request #${n}. ${r.stderr.trim().split("\n")[0] ?? ""}`.trim());
    }
  }

  async function create(opts: CreateWorkspace): Promise<Workspace> {
    const step = (s: string, state: "running" | "done" | "failed" = "running") => d.emit("workspace:progress", { step: s, state });
    const project = await remember(opts.project);
    const { main, sub } = await where(project);
    let from = opts.from;
    let note: string | undefined;
    if (from.kind === "smart") {
      const branches = (await sources(project).catch(() => null))?.branches.map((b) => b.name) ?? [];
      const s = parseSmart(from.text, branches);
      if (!s) throw new Error("Type a name, a pull request number like #12, a branch, or a link.");
      from = s.kind === "pr" ? { kind: "pr", number: s.number } : s.kind === "branch" ? { kind: "branch", branch: s.branch } : { kind: "name", name: s.name };
      if (s.kind === "name") note = s.note;
    }
    const name = from.kind === "pr" ? `pr-${from.number}` : slugName(from.kind === "branch" ? from.branch.replace(/^origin\//, "") : from.name);
    if (!name) throw new Error("Give the workspace a name with some letters or digits.");
    if (from.kind === "branch") {
      const b = from.branch.replace(/^origin\//, "");
      const open = (await list()).find((w) => w.projectRoot === project && w.branch === b);
      if (open) throw new Error(`${b} is already open in ${open.label ?? open.name}. Open that one instead.`);
    }
    const base = { copyEnv: opts.copyEnv, ...(opts.portOffset !== undefined ? { portOffset: opts.portOffset } : {}) };
    step(from.kind === "pr" ? `Getting pull request #${from.number}` : from.kind === "branch" ? `Checking out ${from.branch}` : opts.base ? `Starting from ${opts.base}` : "Copying your code as it is now");
    try {
      const ports = await d.portsOf(project).catch(() => []);
      const pr = from.kind === "pr" ? from.number : undefined;
      const w =
        from.kind === "pr"
          ? await wt.createWorktree(main, name, note ?? `PR #${pr}`, ports, { ...base, detach: true, after: (p) => checkoutPr(p, pr!) })
          : from.kind === "branch"
            ? await wt.createWorktree(main, name, note, ports, { ...base, branch: from.branch })
            : await wt.createWorktree(main, name, note, ports, { ...base, ...(opts.base ? { base: opts.base } : {}) });
      step("Linked your packages and copied .env files", "done");
      prs.delete(main);
      const path = sub ? join(w.path, sub) : w.path;
      const row = (await list()).find((x) => x.path === path);
      publish();
      step(`${name} is ready`, "done");
      if (!row) throw new Error(`${name} was made, but Shrike can't see it.`);
      return row;
    } catch (err) {
      step((err as Error).message, "failed");
      throw err;
    }
  }

  async function remove(path: string): Promise<boolean> {
    const w = await known(path);
    if (w.kind === "main") throw new Error("Your main checkout can't be deleted here.");
    if (d.current() === w.path) throw new Error(`You're looking at ${w.label ?? w.name}. Switch to another workspace first.`);
    const { main } = await where(w.path);
    const folder = (await wt.git(w.path, ["rev-parse", "--show-toplevel"])).trim();
    const meta = w.kind === "shrike" ? (await wt.readMeta(main))[w.name] : undefined;
    const branch = (await wt.git(folder, ["branch", "--show-current"])).trim();
    const own = branch ? [`--exclude=${branch}`] : [];
    const only = Number((await wt.git(folder, ["rev-list", "--count", "HEAD", "--not", ...own, "--branches", "--remotes", ...(meta ? [meta.base] : [])]).catch(() => "0")).trim()) || 0;
    const changed = count(await wt.git(folder, ["status", "--porcelain", "--", ".", NOT_SHRIKE])); // now, not the last listing
    if (changed || only) {
      const what = [changed ? `${changed} changed ${changed === 1 ? "file" : "files"}` : "", only ? `${only} ${only === 1 ? "commit" : "commits"} that exist nowhere else` : ""].filter(Boolean).join(" and ");
      const ok = await d.requestApproval({ kind: "request", title: `Delete ${w.label ?? w.name}? It has work that would be lost.`, reason: `${what[0]!.toUpperCase()}${what.slice(1)} would be lost. The folder is deleted; your main checkout and other workspaces aren't touched.` });
      if (!ok) return false;
    }
    await d.stopBackground(w.path);
    if (w.kind === "shrike") await wt.removeWorktree(main, w.name);
    else (await wt.git(main, ["worktree", "remove", "--force", folder]), await wt.git(main, ["worktree", "prune"]));
    const s = read();
    delete s.labels[w.path];
    write(s);
    agent.delete(w.path);
    publish();
    return true;
  }

  function rename(path: string, label: string): void {
    const s = read();
    const t = label.trim().slice(0, 60);
    if (t) s.labels[path] = t;
    else delete s.labels[path];
    write(s);
    publish();
  }

  /** Agent dots per folder: a run belongs to the folder that was open when it started; race candidates to their worktree. */
  function observe(channel: string, payload: unknown): void {
    const set = (path: string | undefined | null, a: Workspace["agent"]) => path && agent.get(path) !== a && (agent.set(path, a), publish());
    if (channel === "agent:status") {
      const r = payload as { id: string; status: string };
      if (!runRoot.has(r.id)) runRoot.set(r.id, d.current() ?? "");
      set(runRoot.get(r.id), r.status === "running" ? "working" : "done");
    } else if (channel === "approval:request") {
      const cur = d.current() ?? "";
      if (agent.get(cur) !== "waiting") before.set(cur, agent.get(cur) ?? "idle");
      set(cur, "waiting");
    } else if (channel === "approval:resolved") {
      const cur = d.current() ?? "";
      if (agent.get(cur) === "waiting") set(cur, before.get(cur) ?? "idle");
    }
    else if (channel === "race:update") {
      const cur = d.current();
      if (!cur) return;
      void where(cur).then(({ main, sub }) => {
        for (const c of (payload as { candidates: { worktree: string; state: string }[] }).candidates) {
          const p = join(wt.worktreePath(main, c.worktree), sub);
          set(p, ["thinking", "patched", "rerunning"].includes(c.state) ? "working" : "done");
        }
      }, () => {});
    } else if (channel === "run:status" || channel === "worktrees:update" || channel === "git:update" || channel === "project:opened") publish();
  }

  return { list, remember, sources, create, remove, rename, known, observe, publish };
}

export type Workspaces = ReturnType<typeof createWorkspaces>;
