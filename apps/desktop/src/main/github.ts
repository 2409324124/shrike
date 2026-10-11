import type { Flow, GhIssue, PullRequest } from "@shrike/schema";

// G*: everything Shrike asks GitHub goes through the `gh` CLI behind this interface, so tests use a fake.
// The pure helpers at the bottom have no runtime imports, so the renderer (hud/Ship.tsx) imports them too.

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Exec = (cmd: string, args: string[], o: { cwd: string; input?: string; timeoutMs?: number }) => Promise<ExecResult>;

export interface Gh {
  run(args: string[], o: { cwd: string; input?: string; timeoutMs?: number }): Promise<ExecResult>;
}

// gh has no timeout of its own: on a network that drops packets it waits forever, and so would the panel asking it.
export const GH_TIMEOUT = 30_000;

/** SHRIKE_GH_BIN points at another gh (tests use a fake, so nothing reaches GitHub). */
export const makeGh = (exec: Exec): Gh => ({ run: (args, o) => exec(globalThis.process?.env.SHRIKE_GH_BIN || "gh", args, { timeoutMs: GH_TIMEOUT, ...o }) });

export type GhProblem = "missing" | "signed-out" | "offline";

export const GH_SETUP: Record<GhProblem, string> = {
  missing: "Install GitHub's command line tool: open Terminal and run brew install gh, then sign in with gh auth login.",
  "signed-out": "Sign in to GitHub: open Terminal and run gh auth login, then come back here.",
  offline: "Shrike can't reach GitHub right now. Check your internet connection; Shrike tries again by itself.",
};

export async function ghStatus(gh: Gh, cwd: string): Promise<{ ready: boolean; problem?: GhProblem }> {
  const v = await gh.run(["--version"], { cwd });
  if (v.code !== 0) return { ready: false, problem: "missing" };
  const a = await gh.run(["auth", "status"], { cwd });
  if (a.code === 0) return { ready: true };
  // Offline, gh auth status says the token is invalid; one API call tells a dead network from a dead token.
  const probe = await gh.run(["api", "rate_limit", "--silent"], { cwd, timeoutMs: 10_000 });
  return { ready: false, problem: ghTrouble(probe) === "offline" ? "offline" : "signed-out" };
}

const json = <T>(s: string): T | undefined => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
};

interface RawPr {
  number: number;
  title: string;
  url: string;
  state: string;
  body?: string;
  headRefName?: string;
  baseRefName?: string;
}

const PR_FIELDS = "number,title,url,state,headRefName,baseRefName";

export function toPr(raw: RawPr, checks: PullRequest["checks"] = []): PullRequest {
  const s = raw.state.toLowerCase();
  return { number: raw.number, title: raw.title, url: raw.url, state: s === "merged" ? "merged" : s === "closed" ? "closed" : "open", checks };
}

const BUCKET: Record<string, PullRequest["checks"][number]["state"]> = { pass: "pass", fail: "fail", cancel: "fail", pending: "pending", skipping: "skipped" };

/** gh exits non-zero while checks fail or wait, but still prints the JSON. */
export async function prChecks(gh: Gh, cwd: string, n: number): Promise<PullRequest["checks"]> {
  const r = await gh.run(["pr", "checks", String(n), "--json", "name,bucket,link"], { cwd });
  const list = json<{ name: string; bucket: string; link?: string }[]>(r.stdout) ?? [];
  return list.map((c) => ({ name: c.name, state: BUCKET[c.bucket] ?? "pending", ...(c.link ? { url: c.link } : {}) }));
}

export type PrDetail = PullRequest & { body: string; head?: string; base?: string };

export async function prView(gh: Gh, cwd: string, ref: string | number): Promise<PrDetail | undefined> {
  const r = await gh.run(["pr", "view", String(ref), "--json", `${PR_FIELDS},body`], { cwd });
  const raw = r.code === 0 ? json<RawPr>(r.stdout) : undefined;
  if (!raw) return undefined;
  return { ...toPr(raw, await prChecks(gh, cwd, raw.number)), body: raw.body ?? "", head: raw.headRefName, base: raw.baseRefName };
}

export async function listPrs(gh: Gh, cwd: string): Promise<PullRequest[]> {
  const r = await gh.run(["pr", "list", "--json", PR_FIELDS, "--limit", "30"], { cwd });
  if (r.code !== 0) throw new Error(ghError(r, "Couldn't list pull requests"));
  return (json<RawPr[]>(r.stdout) ?? []).map((p) => toPr(p));
}

export async function prDiff(gh: Gh, cwd: string, n: number): Promise<string> {
  const r = await gh.run(["pr", "diff", String(n)], { cwd });
  if (r.code !== 0) throw new Error(ghError(r, `Couldn't read pull request #${n}`));
  return r.stdout;
}

export async function createPr(gh: Gh, cwd: string, o: { base: string; head: string; title: string; body: string }): Promise<number> {
  const r = await gh.run(["pr", "create", "--base", o.base, "--head", o.head, "--title", o.title, "--body-file", "-"], { cwd, input: o.body, timeoutMs: 120_000 }); // writes get longer than reads
  const n = /\/pull\/(\d+)/.exec(r.stdout)?.[1];
  if (r.code !== 0 || !n) throw new Error(ghError(r, "GitHub didn't open the pull request"));
  return Number(n);
}

export async function mergePr(gh: Gh, cwd: string, n: number): Promise<void> {
  const r = await gh.run(["pr", "merge", String(n), "--squash", "--delete-branch"], { cwd, timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(ghError(r, `GitHub didn't merge pull request #${n}`));
}

// ---- QB1/QB8: issues (list and view are read only; create only behind the board's approval card) ----

interface RawIssue {
  number: number;
  title: string;
  url: string;
  body?: string;
  labels?: { name: string }[];
}
const ISSUE_FIELDS = "number,title,url,body,labels";

export const toIssue = (r: RawIssue): GhIssue => ({ number: r.number, title: r.title, url: r.url, body: r.body ?? "", labels: (r.labels ?? []).map((l) => l.name) });

export async function listIssues(gh: Gh, cwd: string): Promise<GhIssue[]> {
  const r = await gh.run(["issue", "list", "--state", "open", "--json", ISSUE_FIELDS, "--limit", "30"], { cwd });
  if (r.code !== 0) throw new Error(ghError(r, "Couldn't list issues"));
  return (json<RawIssue[]>(r.stdout) ?? []).filter((i) => typeof i?.number === "number" && typeof i.title === "string").map(toIssue);
}

export async function issueView(gh: Gh, cwd: string, n: number): Promise<GhIssue> {
  const r = await gh.run(["issue", "view", String(n), "--json", ISSUE_FIELDS], { cwd });
  const raw = r.code === 0 ? json<RawIssue>(r.stdout) : undefined;
  if (!raw || typeof raw.number !== "number") throw new Error(ghError(r, `Couldn't read issue #${n}`));
  return toIssue(raw);
}

export async function createIssue(gh: Gh, cwd: string, o: { title: string; body: string }): Promise<{ number: number; url: string }> {
  const r = await gh.run(["issue", "create", "--title", o.title, "--body-file", "-"], { cwd, input: o.body, timeoutMs: 120_000 }); // writes get longer than reads
  const url = /https:\/\/\S+\/issues\/\d+/.exec(r.stdout)?.[0];
  if (r.code !== 0 || !url) throw new Error(ghError(r, "GitHub didn't open the issue"));
  return { number: Number(/(\d+)$/.exec(url)![1]), url };
}

// First match wins: the "no GitHub host" message also says gh auth login.
const TROUBLE = {
  offline: /dial tcp|connection refused|no such host|could not resolve|network is unreachable|i\/o timeout|TLS handshake timeout|connection reset|didn't answer in/i,
  "rate-limit": /rate limit/i,
  "no-remote": /no git remotes found|known GitHub host|failed to determine base repo/i,
  "signed-out": /HTTP 401|Bad credentials|gh auth login|not logged in/i,
} as const;
type Trouble = keyof typeof TROUBLE;

const PLAIN: Record<Trouble, string> = {
  offline: "The network didn't answer. Check your internet connection, then try again.", // git's errors come through here too, so no host name
  "rate-limit": "GitHub's rate limit is used up for now. Try again in a few minutes.",
  "signed-out": GH_SETUP["signed-out"],
  "no-remote": "This project isn't connected to a GitHub repo. Add a GitHub remote and push your branch first.",
};

/** The usual ways a gh call fails, read from what it printed. */
export function ghTrouble(r: ExecResult): Trouble | undefined {
  if (r.code === 0) return undefined;
  const text = `${r.stderr}\n${r.stdout}`;
  return (Object.keys(TROUBLE) as Trouble[]).find((k) => TROUBLE[k].test(text));
}

export function ghError(r: ExecResult, what: string): string {
  const t = ghTrouble(r);
  if (t) return `${what}. ${PLAIN[t]}`;
  const line = (r.stderr || r.stdout).split("\n").map((l) => l.trim()).find(Boolean);
  return line ? `${what}: ${line}` : `${what}.`;
}

// ---- G4: the failing lines of a check, in plain words ----

/** Run and job ids from a GitHub Actions check link; undefined for checks from other CI services. */
export function actionsIds(link: string | undefined): { run: string; job?: string } | undefined {
  const m = link ? /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(link) : null;
  return m ? { run: m[1]!, ...(m[2] ? { job: m[2] } : {}) } : undefined;
}

const PREFIX = /^([^\t]*)\t([^\t]*)\t(?:\S+Z ?)?/; // gh run view --log: job \t step \t timestamp message
const BAD = /\berror\b|\bfail(?:ed|ing|ure|s)?\b|✗|✕|×|\bexpected\b|exception|exit code [1-9]|not ok\b/i;
const NOISE = /^(npm (ERR|error)! (A complete log|Log files)|##\[(group|endgroup)\]|Error: Process completed with exit code)/i;

export function failingLines(log: string, max = 8): { lines: string[]; step?: string } {
  let step: string | undefined;
  const out: string[] = [];
  for (const raw of log.split(/\r?\n/)) {
    const m = PREFIX.exec(raw);
    const text = (m ? raw.slice(m[0].length) : raw).replace(/\x1b\[[0-9;]*m/g, "").trim();
    const clean = text.replace(/^##\[error\]/, "").trim();
    if (!clean || NOISE.test(clean) || !(text.startsWith("##[error]") || BAD.test(clean))) continue;
    step ??= m?.[2]?.trim() || undefined;
    const line = clean.length > 300 ? `${clean.slice(0, 299)}…` : clean;
    if (!out.includes(line)) out.push(line);
    if (out.length >= max) break;
  }
  return { lines: out, ...(step ? { step } : {}) };
}

export function checkSummary(name: string, f: { lines: string[]; step?: string }): string {
  const where = f.step ? ` during "${f.step}"` : "";
  if (!f.lines.length) return `The "${name}" check failed${where}, but its log didn't say why in a line Shrike could find.`;
  return `The "${name}" check failed${where}. The first problem it printed: ${f.lines[0]}`;
}

export async function failedLog(gh: Gh, cwd: string, name: string, link: string | undefined): Promise<{ summary: string; lines: string[] }> {
  const ids = actionsIds(link);
  if (!ids) return { summary: `The "${name}" check failed. It runs outside GitHub Actions, so open its page to read the log.`, lines: [] };
  const r = await gh.run(["run", "view", ids.run, ...(ids.job ? ["--job", ids.job] : []), "--log-failed"], { cwd, timeoutMs: 60_000 }); // logs can be big
  if (r.code !== 0) return { summary: `The "${name}" check failed. ${ghError(r, "Couldn't read its log")}`, lines: [] };
  const f = failingLines(r.stdout);
  return { summary: checkSummary(name, f), lines: f.lines };
}

// ---- pure helpers shared with the renderer ----

/** G5: why merging isn't allowed yet, in plain words; undefined when it is. */
export function mergeBlocker(checks: PullRequest["checks"], flows: Pick<Flow, "name" | "lastRun">[]): string | undefined {
  const failed = checks.filter((c) => c.state === "fail");
  if (failed.length) return `${failed.length === 1 ? `The "${failed[0]!.name}" check` : `${failed.length} checks`} failed. Fix ${failed.length === 1 ? "it" : "them"} first.`;
  if (checks.some((c) => c.state === "pending")) return "Checks are still running.";
  const notRun = flows.find((f) => !f.lastRun);
  if (notRun) return `Your flow "${notRun.name}" hasn't run on this change yet.`;
  const red = flows.find((f) => f.lastRun && !f.lastRun.ok);
  if (red) return `Your flow "${red.name}" broke the last time it ran.`;
  return undefined;
}

export interface ConflictHunk {
  line: number; // 1-based line of the <<<<<<< marker
  end: number; // line of the >>>>>>> marker
  ours: string[];
  theirs: string[];
  oursLabel: string;
  theirsLabel: string;
}

/** G3: each conflict block in a file, with both sides. */
export function conflictHunks(text: string): ConflictHunk[] {
  const out: ConflictHunk[] = [];
  let cur: ConflictHunk | null = null;
  let part: "ours" | "base" | "theirs" = "ours";
  text.split(/\r?\n/).forEach((l, i) => {
    if (l.startsWith("<<<<<<<")) {
      cur = { line: i + 1, end: i + 1, ours: [], theirs: [], oursLabel: l.slice(7).trim(), theirsLabel: "" };
      part = "ours";
    } else if (!cur) return;
    else if (l.startsWith("|||||||")) part = "base";
    else if (l === "=======") part = "theirs";
    else if (l.startsWith(">>>>>>>")) {
      out.push({ ...cur, end: i + 1, theirsLabel: l.slice(7).trim() });
      cur = null;
    } else if (part === "ours") cur.ours.push(l);
    else if (part === "theirs") cur.theirs.push(l);
  });
  return out;
}
