import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrComment, PrThread } from "@shrike/schema";
import { ago, checkCounts, checkLine, feed, fileComments, groupChecks, parseReplies, reviewProgress, ringParts, took, whoCounts } from "./logic.ts";
import { prMarkdown, safeHref, stripHtml } from "./markdown.ts";

const cm = (id: string, author: string, bot: boolean, at: string): PrComment => ({ id, author, bot, body: id, at, reactions: [] });
const th = (id: string, path: string, resolved: boolean, first: PrComment): PrThread => ({ id, path, line: 3, resolved, outdated: false, comments: [first] });

test("checks: counts, the summary line, failing first, ring parts, durations", () => {
  const checks = [
    { name: "lint", state: "pass" as const },
    { name: "e2e", state: "fail" as const },
    { name: "build", state: "pass" as const },
    { name: "deploy", state: "pending" as const, startedAt: "2026-10-08T10:00:00Z" },
  ];
  const n = checkCounts(checks);
  assert.equal(checkLine(n), "2 passing · 1 failing · 1 running");
  assert.equal(checkLine(checkCounts([])), "No checks yet");
  assert.deepEqual(groupChecks(checks).map((g) => [g.state, g.checks.map((c) => c.name)]), [["fail", ["e2e"]], ["pending", ["deploy"]], ["pass", ["build", "lint"]]]);
  assert.deepEqual(ringParts(n), [{ state: "fail", from: 0, to: 0.25 }, { state: "pending", from: 0.25, to: 0.5 }, { state: "pass", from: 0.5, to: 1 }]);
  assert.equal(took(checks[3]!, Date.parse("2026-10-08T10:02:05Z")), "2m 05s");
  assert.equal(took({ state: "pass", startedAt: "2026-10-08T10:00:00Z", completedAt: "2026-10-08T10:00:48Z" }), "48s");
  assert.equal(took({ state: "pass" }), undefined);
  assert.equal(ago("2026-10-08T10:00:00Z", Date.parse("2026-10-08T13:10:00Z")), "3 h ago");
});

test("comments: people and bots split, time order, progress, per-file counts", () => {
  const v = {
    threads: [th("T1", "apps/web/a.ts", false, cm("C1", "ana", false, "2026-10-08T10:02:00Z")), th("T2", "apps/web/b.ts", true, cm("C2", "coderabbitai", true, "2026-10-08T10:01:00Z")), th("T3", "server/c.ts", false, cm("C3", "bo", false, "2026-10-08T10:05:00Z"))],
    comments: [cm("C4", "vercel[bot]", true, "2026-10-08T10:00:00Z"), cm("C5", "ana", false, "2026-10-08T10:04:00Z")],
    reviews: [{ id: "R1", author: "ana", bot: false, state: "changes" as const, body: "", at: "2026-10-08T10:03:00Z" }],
  };
  assert.deepEqual(feed(v, "all").map((i) => (i.kind === "thread" ? i.thread.id : i.kind === "comment" ? i.comment.id : i.review.id)), ["C4", "T2", "T1", "R1", "C5", "T3"]);
  assert.deepEqual(whoCounts(v), { all: 6, people: 4, bots: 2 });
  assert.deepEqual(reviewProgress(v.threads), { resolved: 1, open: 2, total: 3 });
  assert.deepEqual(fileComments(v.threads, "apps/web/"), { "a.ts": { open: 1, resolved: 0 }, "b.ts": { open: 0, resolved: 1 } });
  assert.deepEqual(fileComments(v.threads)["server/c.ts"], { open: 1, resolved: 0 });
});

test("reply drafts come out of the agent's last message, known threads only", () => {
  const text = "I fixed both.\n\nREPLY T1: Renamed it to userId.\nIt now matches the form.\n- REPLY T9: not a thread\nREPLY `T3`: Good catch, added a test.\n\nThanks!";
  assert.deepEqual(parseReplies(text, ["T1", "T3"]), { T1: "Renamed it to userId.\nIt now matches the form.", T3: "Good catch, added a test." });
  assert.deepEqual(parseReplies("REPLY T1:", ["T1"]), {});
});

test("markdown: headings, emphasis, code, lists, tables, links", () => {
  const b = prMarkdown("## CodeQL\n\nThis **may** fail\n\n- one\n- two\n\n| a | b |\n|---|:-:|\n| 1 | x \\| y |\n\n```ts\nconst a = 1 | 2;\n```\n\nSee [docs](https://x.dev)");
  assert.deepEqual(b.map((x) => x.t), ["h", "p", "ul", "table", "code", "p"]);
  assert.deepEqual(b[3], { t: "table", head: ["a", "b"], rows: [["1", "x | y"]] });
  assert.deepEqual(b[4], { t: "code", lang: "ts", text: "const a = 1 | 2;" });
  assert.deepEqual(prMarkdown("~~~\n<b>kept</b>\n~~~"), [{ t: "code", lang: "", text: "<b>kept</b>" }]);
});

test("markdown safety: no raw HTML, no scripts, no remote image loads, only web links", () => {
  const md = prMarkdown('<!-- hidden -->Hi <script>alert(1)</script><b onclick="x()">bold</b><img src="https://evil.test/p.png" alt="pic"><iframe src="https://evil.test"></iframe><details><summary>More</summary>inside</details>');
  const text = JSON.stringify(md);
  assert.doesNotMatch(text, /<|script|alert|onclick|iframe|hidden/);
  assert.match(text, /bold/);
  assert.match(text, /inside/);
  assert.match(text, /!\[pic\]\(https:\/\/evil\.test\/p\.png\)/); // becomes an image placeholder the renderer never fetches
  assert.equal(stripHtml("a<br/>b"), "a\nb");
  assert.equal(safeHref("javascript:alert(1)"), undefined);
  assert.equal(safeHref(" JaVaScRiPt:alert(1)"), undefined);
  assert.equal(safeHref("data:text/html,<script>"), undefined);
  assert.equal(safeHref("file:///etc/passwd"), undefined);
  assert.equal(safeHref("../a.ts"), undefined);
  assert.equal(safeHref("https://github.com/o/r"), "https://github.com/o/r");
  assert.equal(safeHref("mailto:a@b.c"), "mailto:a@b.c");
});
