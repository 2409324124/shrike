import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRunInfo, AgentStep, ShrikeHost } from "@shrike/schema";
import {
  ASIDE_RULE,
  branchFinding,
  branchName,
  branchQuestion,
  isLatest,
  branchTarget,
  bringBackText,
  claudeArgs,
  nextColor,
  sliceHistory,
  startAgentRun,
  worktreeName,
  type AnthropicLike,
  type BrainMessage,
  type WorktreeApi,
} from "../src/index.ts";
import { startMcpServer } from "../../mcp-server/src/index.ts";

const promptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../prompts/agent");
const mcp = { url: "http://127.0.0.1:1/mcp", token: "t" };

test("C1 fork args: resume plus --fork-session, so the parent session is never changed", () => {
  const fork = claudeArgs("q", mcp, "sys", "sess-1", undefined, true);
  assert.deepEqual(fork.slice(0, 3), ["--resume", "sess-1", "--fork-session"]);
  const resume = claudeArgs("q", mcp, "sys", "sess-1");
  assert.deepEqual(resume.slice(0, 2), ["--resume", "sess-1"]);
  assert.ok(!resume.includes("--fork-session"));
  assert.ok(!claudeArgs("q", mcp, "sys", undefined, undefined, true).includes("--fork-session")); // nothing to fork
  const ro = claudeArgs("q", mcp, "sys", "sess-1", undefined, true, ["propose_patch", "app_click"]);
  assert.equal(ro[ro.indexOf("--disallowedTools") + 1], "mcp__shrike__propose_patch,mcp__shrike__app_click");
  assert.ok(!claudeArgs("q", mcp, "sys").includes("--disallowedTools"));
});

test("C1 a branch from an earlier step is told to set aside what came after it, quoting the step", () => {
  assert.equal(branchQuestion("  What about the cache? ", { text: "x", latest: true }), "What about the cache?");
  assert.equal(branchQuestion("What about the cache?"), "What about the cache?");
  const q = branchQuestion("What about the cache?", { text: "Reading   server/todos.controller.ts", latest: false });
  assert.equal(q, 'Set aside everything after this point of our conversation ("Reading server/todos.controller.ts"), as if it never happened, and think about it differently from there: What about the cache?');
  assert.ok(branchQuestion("q", { text: "y".repeat(500), latest: false }).length < 300);
  const run = [step("message", "a"), step("findings", "b"), step("done", "Done")];
  assert.ok(isLatest(run, 1)); // forking from the findings card: only "Done" follows
  assert.ok(!isLatest(run, 0));
  const real = [step("message", "a"), { ...step("findings", "b"), tool: "report_findings" }, { ...step("tool_result", "ok"), tool: "report_findings" }, step("message", "Found it: line 18"), step("done", "Done")];
  assert.ok(isLatest(real, 1)); // a real run answers the findings call and says a closing line
  assert.ok(!isLatest([...real.slice(0, 3), { ...step("tool_call", "read"), tool: "read_file" }, ...real.slice(3)], 1));
});

test("C1 names and colours: given name wins, else 3–4 telling words; next free colour, then repeat", () => {
  assert.equal(branchName("What if it's the cache instead?"), "cache");
  assert.equal(branchName("Maybe the userId is sent as a string by the form", "  try strings "), "try strings");
  assert.equal(branchName("Maybe the userId is sent as a string by the form"), "userid sent as string");
  assert.equal(branchName("??"), "branch");
  assert.equal(nextColor([]), "violet");
  assert.equal(nextColor(["violet", undefined, "amber"]), "cyan");
  assert.equal(nextColor(["violet", "cyan", "amber", "magenta"]), "teal");
  assert.equal(nextColor(["violet", "cyan", "amber", "magenta", "teal"]), "violet");
  assert.match(worktreeName("Try the CACHE, maybe!", "ab"), /^branch-try-the-cache-maybe-ab$/);
  assert.ok(/^[a-z0-9][a-z0-9-]{0,39}$/.test(worktreeName("x".repeat(80), "ab")));
});

test("C1 built-in slicing: keep the parent's messages up to the step's turn, then the question (still alternating)", () => {
  const h: BrainMessage[] = [
    { role: "user", content: "goal" },
    { role: "assistant", content: [{ type: "tool_use", id: "u1", name: "get_action", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: "r1" }] },
    { role: "assistant", content: [{ type: "text", text: "final" }] },
  ];
  const mid = sliceHistory(h, 3, "Q");
  assert.equal(mid.length, 3);
  assert.deepEqual(mid[2], { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: "r1" }, { type: "text", text: "Q" }] });
  assert.equal(h[2]!.content.length, 1); // the parent's history is not touched
  const end = sliceHistory(h, undefined, "Q");
  assert.equal(end.length, 5);
  assert.deepEqual(end[4], { role: "user", content: "Q" });
});

test("C1 built-in brain end to end: each step gets its cut, and a branch starts from exactly those messages", async () => {
  const host = { projectRoot: () => os.tmpdir(), listActions: () => [], getAction: () => undefined } as unknown as ShrikeHost;
  const server = await startMcpServer(host);
  try {
    const go = (anthropic: AnthropicLike, history?: BrainMessage[], readOnly?: boolean) => {
      const steps: AgentStep[] = [];
      let cuts: ReadonlyMap<string, number> = new Map();
      let msgs: BrainMessage[] = [];
      let end!: () => void;
      const done = new Promise<void>((r) => (end = r));
      startAgentRun({
        goal: "Why?", brain: "builtin", cwd: os.tmpdir(), mcp: server, promptsDir, anthropic, history, readOnly,
        context: { routeCount: 0, recentActions: "" },
        onStep: (s) => steps.push(s),
        onStatus: (i) => i.status !== "running" && end(),
        onHistory: (m, c) => ((msgs = m), (cuts = c)),
      });
      return done.then(() => ({ steps, cuts, msgs }));
    };
    const replies = [
      { stop_reason: "tool_use", content: [{ type: "text", text: "Looking" }, { type: "tool_use", id: "u1", name: "list_actions", input: {} }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Nothing broke." }] },
    ];
    const parent = await go({ messages: { create: async () => replies.shift() as any } });
    assert.deepEqual(parent.steps.map((s) => parent.cuts.get(s.id)), [3, 3, 3, 4, 4]); // message, tool_call, tool_result | message, done
    const first = parent.steps[1]!;

    const bodies: any[] = [];
    const history = sliceHistory(parent.msgs, parent.cuts.get(first.id), "What about the cache?");
    await go({ messages: { create: async (b) => (bodies.push(structuredClone(b)), { stop_reason: "end_turn", content: [{ type: "text", text: "No cache." }] }) as any } }, history);
    const sent = bodies[0].messages;
    assert.equal(sent.length, 3);
    assert.equal(sent[0].content, "Why?");
    assert.deepEqual(sent[2].content.at(-1), { type: "text", text: "What about the cache?" });
    assert.ok(!JSON.stringify(sent).includes("Nothing broke.")); // the later turn is gone

    // C3/C6: a read-only run never sees write tools, and a call to one is refused, not run
    const ro: any[] = [];
    const roReplies = [
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "u2", name: "propose_patch", input: { files: [] } }] },
      { stop_reason: "end_turn", content: [] },
    ];
    const roRun = await go({ messages: { create: async (b) => (ro.push(b), roReplies.shift()) as any } }, undefined, true);
    const names = ro[0].tools.map((t: { name: string }) => t.name);
    assert.ok(names.includes("read_file") && !names.includes("propose_patch") && !names.includes("app_click"));
    assert.match(roRun.steps.find((x) => x.kind === "tool_result")?.detail ?? roRun.steps.find((x) => x.kind === "tool_result")?.text ?? "", /read-only/);
  } finally {
    await server.close();
  }
});

test("C1 branch fields ride on the run info from the first status", async () => {
  const statuses: AgentRunInfo[] = [];
  const r = startAgentRun({
    goal: "q", brain: "builtin", cwd: os.tmpdir(), mcp, promptsDir, context: { routeCount: 0, recentActions: "" },
    anthropic: { messages: { create: async () => ({ stop_reason: "end_turn", content: [] }) as any } },
    branch: { parentRunId: "p", branchFromStepId: "s", name: "cache", color: "cyan" },
    onStep: () => {},
    onStatus: (i) => statuses.push(i),
  });
  assert.equal(r.info.parentRunId, "p");
  r.stop();
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual({ ...statuses[0], id: "" }, { id: "", goal: "q", brain: "builtin", status: "stopped", parentRunId: "p", branchFromStepId: "s", name: "cache", color: "cyan" });
});

const step = (kind: AgentStep["kind"], text: string, extra: Partial<AgentStep> = {}): AgentStep => ({ id: Math.random().toString(16), runId: "b", kind, text, createdAt: 1, ...extra });

test("C5 bring back: one short message from the branch's finding, else its last words", () => {
  assert.equal(branchFinding([]), undefined);
  assert.equal(branchFinding([step("message", "Looking at the cache"), step("done", "Done", { detail: "The cache keeps the old user." })]), "The cache keeps the old user.");
  const f = [step("findings", "Found it", { summary: "Stale cache entry.", findings: [{ confidence: "likely", claim: "x" }] }), step("done", "Done", { summary: "Fixed and verified" })];
  assert.equal(branchFinding(f), "Stale cache entry.");
  assert.equal(bringBackText("Stale cache entry."), "Another line of thinking found: Stale cache entry.");
  assert.ok(bringBackText("a ".repeat(900)).length <= 440);
});

test("C6 routing: a branch gets its own worktree; an aside, or a project without one, stays read-only", async () => {
  const calls: string[] = [];
  const api = (fail?: "create" | "target"): WorktreeApi => ({
    create: async (n) => (calls.push(`create ${n}`), fail === "create" ? Promise.reject(new Error("not a git repo")) : undefined),
    target: async (n) => (calls.push(`target ${n}`), fail === "target" ? Promise.reject(new Error("app didn't start")) : { cwd: `/wt/${n}`, mcp: { url: `http://wt/${n}`, token: "k" } }),
    remove: async (n) => void calls.push(`remove ${n}`),
  });
  assert.deepEqual(await branchTarget({ name: "cache" }, api(), "ab"), { worktree: "branch-cache-ab", mcp: { url: "http://wt/branch-cache-ab", token: "k" }, readOnly: false });
  assert.deepEqual(calls, ["create branch-cache-ab", "target branch-cache-ab"]);

  calls.length = 0;
  assert.deepEqual(await branchTarget({ name: "q", aside: true }, api(), "ab"), { readOnly: true });
  assert.deepEqual(calls, []); // an aside never makes a copy

  assert.deepEqual(await branchTarget({ name: "cache" }, api("create"), "cd"), { readOnly: true, why: "not a git repo" });
  calls.length = 0;
  assert.deepEqual(await branchTarget({ name: "cache" }, api("target"), "cd"), { readOnly: true, why: "app didn't start" });
  assert.deepEqual(calls, ["create branch-cache-cd", "target branch-cache-cd", "remove branch-cache-cd"]);
  assert.match(ASIDE_RULE, /Don't propose or apply patches/);
});
