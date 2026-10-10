import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ReviewLessonsView } from "@shrike/schema";
import { redactText } from "@shrike/redact";
import type { ExecResult } from "./github.ts";
import { checkList, codeowners, createReviewLessons, emptyCache, itemsOf, lessonStats, parseCluster, parseSearch, type RawSearch } from "./review-lessons.ts";
import { configureSkills, listDrafts, type SkillDirs } from "./skills.ts";
import { checkLine, chipText, severity } from "../renderer/src/lessons/review/logic.ts";

const repo = join(import.meta.dirname, "../../../..");
const RECORDED = JSON.parse(readFileSync(join(repo, "fixtures/gh/review-lessons-search.json"), "utf8")) as RawSearch;
const ok = (stdout: unknown): ExecResult => ({ code: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "" });
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();

type Node = NonNullable<NonNullable<RawSearch["data"]>["search"]>["nodes"][number];
const clean = (n: number, at = iso()): Node => ({ number: n, title: `PR ${n}`, url: `https://github.com/acme/todo-app/pull/${n}`, state: "MERGED", createdAt: at, updatedAt: at, reviewThreads: { nodes: [] }, reviews: { nodes: [{ id: `PRR_${n}`, state: "APPROVED", body: "", submittedAt: iso(1000), author: { login: "ana", __typename: "User" } }] }, commits: { nodes: [] } });
const flagged = (n: number, text: string): Node => ({
  ...clean(n),
  reviews: { nodes: [{ id: `PRR_${n}`, state: "COMMENTED", body: "", submittedAt: iso(), author: { login: "ana", __typename: "User" } }] },
  reviewThreads: { nodes: [{ id: `PRRT_${n}`, isResolved: false, path: "web/src/Filter.tsx", line: 9, originalLine: 9, resolvedBy: null, comments: { nodes: [{ id: `PRRC_${n}`, body: text, createdAt: iso(500), url: `https://github.com/acme/todo-app/pull/${n}#c`, author: { login: "ana", __typename: "User" } }] } }] },
});

/** Clusters by keyword like a careful reviewer would; a lesson with a newer comment gets new fix steps. */
function fakeBrain(prompt: string): string {
  const lines = [...prompt.matchAll(/^\[(c\d+)\]( LEARN)? #\d+ \S+ @\S+ \S+ [^:]*(?::\d+)?: (.*)$/gm)];
  const has = (id: string) => prompt.includes(`- id: ${id} `);
  const pick = (re: RegExp) => lines.filter((m) => re.test(m[3]!)).map((m) => m[1]!);
  const loading = pick(/loading state|spinner/i);
  const lessons = [
    { id: "missing-loading-state", title: "Missing loading state", spot: "A button or list that fetches with no pending state", fix: has("missing-loading-state") && loading.length ? ["Disable the control and show a spinner from the click until the answer", "Add a test that clicks twice"] : ["Show a spinner while it loads"], comments: loading },
    { id: "unvalidated-input", title: "Unvalidated input", spot: "A request body used without a schema check", fix: ["Parse the body with zod first"], comments: pick(/validat/i) },
    { id: "clear-names", title: "Clear names", spot: "Names like loading2", fix: ["Name booleans isX"], comments: lines.filter((m) => m[2] && !/loading state|validat/i.test(m[3]!)).map((m) => m[1]!) },
  ].filter((l) => l.comments.length || has(l.id));
  return `Here you go.\n\`\`\`json\n${JSON.stringify({ lessons, reviewers: [{ login: "ana", style: ["Numbers findings W01 (blocks) and N01 (nit) with a severity dot"], habit: "Blocks on missing states" }] })}\n\`\`\``;
}

function setup() {
  const base = mkdtempSync(join(tmpdir(), "shrike-rl-"));
  const proj = join(base, "proj");
  mkdirSync(join(proj, ".github"), { recursive: true });
  writeFileSync(join(proj, ".github/CODEOWNERS"), "# owners\n*       @bo\nweb/    @ana\n");
  const dirs: SkillDirs = { builtin: join(base, "builtin"), project: proj, personal: join(base, "personal"), claude: join(base, "claude"), state: join(base, "state") };
  for (const d of [dirs.builtin, dirs.personal, dirs.state]) mkdirSync(d, { recursive: true });
  configureSkills(() => dirs, () => {});
  const nodes: Node[] = [...RECORDED.data!.search!.nodes];
  const calls: string[][] = [];
  const asks: string[] = [];
  const goals: string[] = [];
  const mastered: string[] = [];
  const views: ReviewLessonsView[] = [];
  const gh = {
    async run(args: string[]): Promise<ExecResult> {
      calls.push(args);
      if (args[0] === "--version" || args.join(" ") === "auth status") return ok("");
      if (args[0] === "repo") return ok({ nameWithOwner: "acme/todo-app" });
      if (args[0] === "api" && args[1] === "graphql") {
        const n = Number(args[args.indexOf("-F") + 1]!.slice(2));
        const after = args.find((a) => a.startsWith("after="))?.slice(6);
        const sorted = [...nodes].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        const from = after ? Number(after) : 0;
        return ok({ data: { viewer: { login: "sam" }, search: { pageInfo: { hasNextPage: from + n < sorted.length, endCursor: String(from + n) }, nodes: sorted.slice(from, from + n) } } });
      }
      if (args[0] === "api" && /^repos\/acme\/todo-app\/commits\//.test(args[1]!)) return ok({ files: [{ filename: "web/src/TodoForm.tsx", patch: "@@ -30 +30 @@\n-<button>\n+<button disabled={saving}>" }] });
      return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
    },
  };
  const DIFF = "diff --git a/web/src/TodoForm.tsx b/web/src/TodoForm.tsx\n+  <button onClick={save}>Save</button>\n";
  const exec = async (_cmd: string, args: string[]): Promise<ExecResult> => {
    const k = args.join(" ");
    if (k === "rev-parse --show-toplevel") return ok(`${proj}\n`);
    if (args[0] === "show") return args.includes("a1b0000000000000000000000000000000000001") ? ok("@@ -1 +1 @@\n+{loading ? <Spinner /> : list}") : { code: 128, stdout: "", stderr: "bad object" };
    if (args[0] === "symbolic-ref") return ok("origin/main\n");
    if (args[0] === "merge-base") return ok("base0\n");
    if (k.startsWith("diff --name-only")) return ok("web/src/TodoForm.tsx\n");
    if (args[0] === "ls-files") return ok("");
    if (args[0] === "diff") return ok(DIFF);
    if (args[0] === "rev-parse") return ok("head1\n");
    return { code: 1, stdout: "", stderr: "" };
  };
  const svc = createReviewLessons({
    root: () => proj,
    gh,
    exec,
    dir: join(base, "state", "review-lessons"),
    skills: () => dirs,
    skillsChanged: async () => {},
    guide: async () => readFileSync(join(repo, "prompts/skills/review-lessons.md"), "utf8"),
    ask: async (p) => (asks.push(p), /^Check this change/.test(p) ? "FOUND L1: web/src/TodoForm.tsx:40 the save button has no spinner\nCLEAN L2" : fakeBrain(p)),
    startAgent: async (goal) => (goals.push(goal), { id: "run1", goal, brain: "claude-code", status: "running" }),
    redact: redactText,
    emit: (v) => void views.push(v),
    mastered: (m) => void mastered.push(m.lessonId),
  });
  return { proj, dirs, nodes, calls, asks, goals, mastered, views, svc };
}

const skillText = (proj: string) => readFileSync(join(proj, ".shrike/skills/review-lessons.md"), "utf8");
const version = (proj: string) => Number(/^version: (\d+)$/m.exec(skillText(proj))?.[1]);

test("recorded gh JSON: items per reviewer thread and review, yours and bot noise left out, fixes from the next commit", () => {
  const { prs, viewer } = parseSearch(RECORDED, redactText);
  assert.equal(viewer, "sam");
  assert.equal(prs.length, 6);
  const items = itemsOf(prs, "sam");
  assert.deepEqual(items.map((i) => i.id).sort(), ["PRRC_1a", "PRRC_1b", "PRRC_2a", "PRRC_2b", "PRRC_3a", "PRRC_4a", "PRRC_6a", "PRR_3"].sort());
  const first = items.find((i) => i.id === "PRRC_1a")!;
  assert.equal(first.fix?.headline, "Add a spinner while todos load");
  assert.equal(first.severity, "blocking");
  assert.equal(items.find((i) => i.id === "PRRC_3a")!.severity, "nit");
  assert.equal(items.find((i) => i.id === "PRRC_1b")!.severity, "question");
  assert.equal(items.find((i) => i.id === "PRRC_4a")!.reply, "Good catch, will do.");
  assert.equal(items.find((i) => i.id === "PRRC_6a")!.fix, undefined, "an open thread has no fix yet");
});

test("mine, cluster, profile, the gate and mastery on one repo (fake gh, fake brain, real skills)", async () => {
  const t = setup();

  // RL1–RL4: the first mine writes v1
  let v = await t.svc.refresh();
  assert.equal(v.problem, undefined);
  assert.equal(v.viewer, "sam");
  assert.equal(v.prs, 6);
  const loading = () => v.lessons.find((l) => l.id === "missing-loading-state")!;
  const input = () => v.lessons.find((l) => l.id === "unvalidated-input")!;
  assert.equal(loading().count, 4);
  assert.deepEqual(loading().prs, [6, 3, 2, 1]);
  assert.equal(loading().rank, "E");
  assert.equal(input().count, 3);
  assert.equal(input().clean, 2, "#5 and #6 came after its last time (#4)");
  assert.equal(input().rank, "C");
  assert.deepEqual(input().reviewers.sort(), ["bo", "coderabbitai"]);
  assert.equal(chipText(v.byComment.PRRC_6a!.nth, v.byComment.PRRC_6a!.title), "4th time: missing loading state");
  const ana = v.reviewers.find((r) => r.login === "ana")!;
  assert.equal(ana.comments, 5);
  assert.equal(ana.approvals, 4);
  assert.equal(ana.changes, 1);
  assert.deepEqual(ana.concerns[0], { lessonId: "missing-loading-state", title: "Missing loading state", count: 4 });
  assert.match(ana.style[0]!, /W01/);
  assert.equal(v.burn.length, 6);
  assert.match(t.asks[0]!, /## How Shrike clusters/);
  assert.match(t.asks[0]!, /fixed by a1b0000 "Add a spinner while todos load"\n {4}patch: .*Spinner/);
  const text = skillText(t.proj);
  assert.equal(version(t.proj), 1);
  assert.match(text, /^when: Before you change code or open a pull request/m);
  assert.match(text, /## Lesson: Missing loading state\n<!-- lesson:missing-loading-state -->\nFlagged 4 times in 4 PRs by @ana\. Last in #6\./);
  assert.match(text, /Fix it:\n1\. Show a spinner while it loads/);
  assert.match(text, /## Reviewer: @ana\n.*Raises most: Missing loading state \(4\)/);
  assert.equal(v.skill, undefined);

  // nothing new: no brain call, no draft
  const before = t.asks.length;
  v = await t.svc.refresh();
  assert.equal(t.asks.length, before);
  assert.equal((await listDrafts(t.dirs)).length, 0);

  // RL8 Learn from this: a lone nit gets its own lesson, as a draft (the file stays v1)
  v = await t.svc.learn({ commentId: "PRRC_3a", pr: 3, author: "ana", body: "🔵 **N03: Name it `isLoading`, not `loading2`**", at: "2026-08-10T12:00:00Z" });
  assert.equal(v.lessons.find((l) => l.id === "clear-names")?.pending, true);
  assert.match(t.asks.at(-1)!, /\[c\d+\] LEARN #3/);
  assert.equal(version(t.proj), 1);
  assert.deepEqual((await listDrafts(t.dirs)).map((d) => [d.skillId, d.expect, d.status]), [["review-lessons", "reviewed", "pending"]]);

  // RL4 the gate: an approval after the draft, nothing came back: kept (v2)
  t.nodes.push(clean(7));
  v = await t.svc.refresh();
  assert.equal(version(t.proj), 2);
  assert.match(skillText(t.proj), /## Lesson: Clear names/);
  assert.match(skillText(t.proj), /## Changelog\n\n- v2: a new lesson: Clear names/);

  // flagged again after its fix was written: not working yet, the fix is rewritten (a new draft)
  t.nodes.push(flagged(8, "🟡 **W08: Still no loading state on the filter**"));
  v = await t.svc.refresh();
  assert.equal(loading().status, "not-working");
  assert.deepEqual(loading().fix, ["Disable the control and show a spinner from the click until the answer", "Add a test that clicks twice"]);
  assert.equal(loading().pending, true);
  assert.equal(version(t.proj), 2);

  // RL6 self-check before a PR: CODEOWNERS (web/ is ana's) and recent reviewers, once per change
  const check = (await t.svc.selfCheck())!;
  assert.deepEqual(check.reviewers, ["ana", "bo"]);
  assert.equal(checkLine(check), "Checked 3 repeat issues for @ana and @bo: 1 found (missing loading state)");
  assert.match(t.asks.at(-1)!, /^Check this change[\s\S]*\[L1\] Missing loading state[\s\S]*TodoForm\.tsx/);
  const n = t.asks.length;
  await t.svc.selfCheck();
  assert.equal(t.asks.length, n, "the same change isn't checked twice");
  await t.svc.fixSelfCheck();
  assert.match(t.goals[0]!, /Missing loading state at web\/src\/TodoForm\.tsx:40[\s\S]*call self_review/);
  // RL5 the MCP tool
  assert.match(await t.svc.selfReview(), /missing-loading-state: Missing loading state \(5 times, not working yet\)[\s\S]*Changed files: web\/src\/TodoForm\.tsx/);
  assert.equal(await t.svc.selfReview([{ lesson: "missing-loading-state", found: true, fixed: true, where: "web/src/TodoForm.tsx:40" }, { lesson: "Unvalidated input", found: false }]), "Saved. The user sees: Checked 3 repeat issues for @ana and @bo: 1 found (missing loading state), fixed.");

  // flagged again while the rewrite waits: Not learned, still v2
  t.nodes.push(flagged(9, "🟡 **W09: The export button has no loading state**"));
  v = await t.svc.refresh();
  assert.equal(version(t.proj), 2);
  assert.ok((await listDrafts(t.dirs)).some((d) => d.status === "pending" && d.missed === "the same issue was flagged again"));

  // RL9: five reviewed PRs without it after Shrike learned it: mastered once, and the draft is kept
  for (const k of [10, 11, 12, 13, 14]) t.nodes.push(clean(k, iso(k * 1000)));
  v = await t.svc.refresh();
  assert.deepEqual(t.mastered.sort(), ["clear-names", "missing-loading-state", "unvalidated-input"]);
  assert.equal(loading().status, "mastered");
  assert.equal(loading().rank, "S");
  assert.equal(version(t.proj), 3);
  await t.svc.refresh();
  assert.equal(t.mastered.length, 3, "once per lesson");

  // read only: nothing that writes ever reached gh
  for (const a of t.calls) assert.ok(!a.some((x) => /mutation|^-X$|^--method$|^(create|merge|comment|review|edit|close|ready)$/.test(x)), `a write: ${a.join(" ")}`);
  assert.ok(t.views.some((x) => x.busy === "thinking"));
});

test("brain answers that aren't JSON, or name unknown comments, change nothing", () => {
  const alias = new Map([["c1", "X1"]]);
  assert.equal(parseCluster("no idea", alias), null);
  const out = parseCluster('```json\n{"lessons":[{"title":"A","comments":["c1","c9"]}]}\n```', alias)!;
  assert.deepEqual(out.lessons[0]!.comments, ["X1"]);
});

test("CODEOWNERS: the last matching rule wins; severity reads the reviewer's own markers", () => {
  const text = "*  @all\n/apps/backend/ @be\n*.md @docs\napps/dashboard @fe @org/ui\n";
  assert.deepEqual(codeowners(text, ["apps/backend/src/a.ts"]), ["be"]);
  assert.deepEqual(codeowners(text, ["apps/backend/README.md"]), ["docs"]);
  assert.deepEqual(codeowners(text, ["apps/dashboard/x/y.tsx"]), ["fe", "org/ui"]);
  assert.deepEqual(codeowners(text, ["package.json"]), ["all"]);
  assert.equal(severity("🔵 **N01 — collapse the duplicate**"), "nit");
  assert.equal(severity("Scope note, not a blocker: the token is org-wide"), "nit");
  assert.equal(severity("🟡 **W01 — Timeline events are duplicated**"), "blocking");
  assert.equal(severity("What is this migration for?"), "question");
  assert.equal(severity("Looks fine", "CHANGES_REQUESTED"), "blocking");
  assert.equal(severity("**[Must fix]** the flag never clears"), "blocking");
  assert.equal(severity("[Minor] a stale comment, not a blocker"), "nit");
});

test("a lesson learned from a PR outside the cache (a teammate's) counts from the comment, not as long quiet", () => {
  const c = emptyCache("acme/todo-app");
  c.viewer = "me";
  const prs = parseSearch({ data: { search: { pageInfo: { hasNextPage: false }, nodes: [1, 2, 3, 4, 5, 6].map((n) => clean(n, iso(-86_400_000 * (10 - n)))) } } }, (x) => x).prs;
  for (const p of prs) c.prs[p.number] = p;
  const item = { id: "IC_1", pr: 999, kind: "thread" as const, reviewer: "bo", bot: false, at: iso(), body: "Name it isLoading", severity: "nit" as const };
  c.lessons = [{ id: "clear-names", title: "Clear names", spot: "", fix: [], items: ["IC_1"], since: Date.now(), learnedAt: Date.now() }];
  const [l] = lessonStats(c, new Map([["IC_1", item]]));
  assert.equal(l!.clean, 0);
  assert.equal(l!.status, "learning");
});

test("first mine: an old quiet lesson isn't mastered yet, and the self-check keeps a mastered one that came up lately", () => {
  const c = emptyCache("acme/todo-app");
  c.viewer = "me";
  const prs = parseSearch({ data: { search: { pageInfo: { hasNextPage: false }, nodes: [1, 2, 3, 4, 5, 6, 7].map((n) => clean(n, iso(-86_400_000 * (10 - n)))) } } }, (x) => x).prs;
  for (const p of prs) c.prs[p.number] = p;
  const item = { id: "IC_1", pr: 1, kind: "thread" as const, reviewer: "bo", bot: false, at: iso(-86_400_000 * 9), body: "Don't log raw input", severity: "blocking" as const };
  c.lessons = [{ id: "log-injection", title: "Log injection", spot: "", fix: [], items: ["IC_1"], since: Date.now(), learnedAt: Date.now() }];
  const [l] = lessonStats(c, new Map([["IC_1", item]]));
  assert.equal(l!.clean, 6);
  assert.equal(l!.status, "learning", "quiet before Shrike learned it doesn't count");
  assert.deepEqual(checkList([l!], new Set()).map((x) => x.id), ["log-injection"]);
  const old = { ...l!, id: "old", status: "mastered" as const, spark: l!.spark.map(() => 0) };
  const recent = { ...l!, id: "recent", status: "mastered" as const };
  assert.deepEqual(checkList([recent, old, l!], new Set()).map((x) => x.id), ["log-injection", "recent"], "mastered but flagged lately: checked last; long quiet: dropped");
});
