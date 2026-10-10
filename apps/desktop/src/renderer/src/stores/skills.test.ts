import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentStep, Skill } from "@shrike/schema";
import { checklist, filterSkills, improvedAgo, sourceLabel } from "./skills.ts";

const step = (kind: AgentStep["kind"]): AgentStep => ({ id: Math.random().toString(16), runId: "r", kind, text: "x", createdAt: 1 });

test("S3 checklist ticks one item per finished tool step, the last waits for the run to end", () => {
  const items = ["Attach", "Log in", "Open the page"];
  assert.deepEqual(checklist(items, [], "running"), ["active", "todo", "todo"]);
  assert.deepEqual(checklist(items, [step("message"), step("tool_call"), step("tool_result")], "running"), ["done", "active", "todo"]);
  const many = Array.from({ length: 9 }, () => step("tool_result"));
  assert.deepEqual(checklist(items, many, "running"), ["done", "done", "active"]);
  assert.deepEqual(checklist(items, [step("tool_result")], "failed"), ["done", "failed", "todo"]);
  assert.deepEqual(checklist(items, [], "done"), ["done", "done", "done"]);
  assert.deepEqual(checklist([], many, "running"), []);
});

test("shelf helpers: slug names read as words, search matches every word, plain source badges", () => {
  const list: Skill[] = [
    { id: "auth", name: "Auth", when: "Logins fail", source: "builtin" },
    { id: "xyne-ci-check", name: "xyne-ci-check", when: "Use when the user asks to check CI", source: "claude", readOnly: true },
    { id: "nav", name: "nav", when: "x", source: "claude", readOnly: false },
  ];
  assert.deepEqual(filterSkills(list, " ci  CHECK ").map((s) => s.id), ["xyne-ci-check"]);
  assert.equal(filterSkills(list, "").length, 3);
  assert.deepEqual(list.map(sourceLabel), ["Built in", "Claude", "Claude · your copy"]);
  assert.deepEqual([0, 5, 180, 3 * 1440].map((m) => improvedAgo(1e9 - m * 60_000, 1e9)), ["just now", "5 min ago", "3h ago", "3 days ago"]);
});
