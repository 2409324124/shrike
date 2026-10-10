#!/usr/bin/env node
// A fake gh for e2e/lessons.test.ts (SHRIKE_GH_BIN): your PRs and their reviews from fixtures/gh/review-lessons-search.json,
// growing by stage ($SHRIKE_FAKE_GH_DIR/stage: 2 adds an approved PR, 3 a PR where the loading state comes up again, 4 five clean PRs).
// Reads only: anything that writes fails. Every call is one JSON line in $SHRIKE_FAKE_GH_DIR/calls.log.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const a = process.argv.slice(2);
const dir = process.env.SHRIKE_FAKE_GH_DIR;
appendFileSync(join(dir, "calls.log"), JSON.stringify(a) + "\n");
const out = (o) => process.stdout.write(typeof o === "string" ? o : JSON.stringify(o));
const fail = (msg) => (process.stderr.write(msg + "\n"), process.exit(1));
const query = a.find((x) => x.startsWith("query="))?.slice(6) ?? "";
const k = a.slice(0, 2).join(" ");

const URL = "https://github.com/e2e/todo-app/pull/";
const stage = existsSync(join(dir, "stage")) ? Number(readFileSync(join(dir, "stage"), "utf8")) : 1;
const file = join(dir, "lessons-state.json");
const s = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { nodes: JSON.parse(readFileSync(join(import.meta.dirname, "../../../fixtures/gh/review-lessons-search.json"), "utf8").replaceAll('"sam"', '"e2e"').replaceAll("acme/todo-app", "e2e/todo-app")).data.search.nodes, stages: [1] };
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
const au = (login) => ({ login, __typename: "User" });
const pr = (n, title, threads = [], approved = true) => ({ number: n, title, url: URL + n, state: "MERGED", createdAt: iso(n), updatedAt: iso(n), reviewThreads: { nodes: threads }, reviews: { nodes: [{ id: `PRR_${n}`, state: approved ? "APPROVED" : "COMMENTED", body: "", submittedAt: iso(n + 1000), author: au("ana") }] }, commits: { nodes: [] } });
for (let st = 2; st <= stage; st++) {
  if (s.stages.includes(st)) continue;
  s.stages.push(st);
  if (st === 2) s.nodes.push(pr(7, "Clear completed"));
  if (st === 3) s.nodes.push(pr(8, "Filter todos", [{ id: "PRRT_8a", isResolved: false, path: "web/src/Filter.tsx", line: 9, originalLine: 9, resolvedBy: null, comments: { nodes: [{ id: "PRRC_8a", body: "🟡 **W08: Still no loading state on the filter**", createdAt: iso(500), url: `${URL}8#c8`, diffHunk: "@@ -1 +1 @@", author: au("ana") }] } }], false));
  if (st === 4) for (const n of [9, 10, 11, 12, 13]) s.nodes.push(pr(n, `Small change ${n}`));
}
writeFileSync(file, JSON.stringify(s));

const PANEL = 3; // this branch's pull request
const node = s.nodes.find((n) => n.number === PANEL);
const rg = [];
const panelPr = () => ({
  id: "PR_3", number: node.number, title: node.title, url: node.url, state: "OPEN", isDraft: false, updatedAt: node.updatedAt, headRefName: "feature/save", baseRefName: "main", reviewDecision: "CHANGES_REQUESTED", author: au("e2e"),
  reviewThreads: { nodes: node.reviewThreads.nodes.map((t) => ({ ...t, isOutdated: false, comments: { nodes: t.comments.nodes.map((c) => ({ ...c, reactionGroups: rg })) } })) },
  comments: { nodes: [] },
  reviews: { nodes: node.reviews.nodes },
});

if (a[0] === "--version") out("gh version 2.99.0 (fake-gh-lessons)\n");
else if (k === "auth status") out("Logged in to github.com as e2e (fake)\n");
else if (k === "repo view") out({ nameWithOwner: "e2e/todo-app" });
else if (k === "api graphql" && /^\s*query\b/.test(query) && query.includes("search(query:$q")) {
  const n = Number(a[a.indexOf("-F") + 1].slice(2));
  const after = Number(a.find((x) => x.startsWith("after="))?.slice(6) ?? 0);
  const sorted = [...s.nodes].sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt));
  out({ data: { viewer: { login: "e2e" }, search: { pageInfo: { hasNextPage: after + n < sorted.length, endCursor: String(after + n) }, nodes: sorted.slice(after, after + n) } } });
} else if (k === "api graphql" && /^\s*query\b/.test(query) && query.includes("pullRequest(number:$n)")) out({ data: { viewer: { login: "e2e" }, repository: { pullRequest: panelPr() } } });
else if (a[0] === "api" && /^repos\/e2e\/todo-app\/commits\/[0-9a-f]+$/.test(a[1] ?? "") && a.length === 2) out({ files: [{ filename: "web/src/TodoForm.tsx", patch: "@@ -30 +30 @@\n-<button>\n+<button disabled={saving}>{saving ? <Spinner /> : \"Save\"}</button>" }] });
else if (k === "pr view") out({ number: PANEL, title: node.title, url: node.url, state: "OPEN", body: "", headRefName: "feature/save", baseRefName: "main" });
else if (k === "pr checks" || k === "run list" || k === "pr list") out([]);
else fail(`fake-gh-lessons: refused ${a.slice(0, 3).join(" ")}`);
