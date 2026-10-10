import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ACTIONS, AGENT_ONLY_TOOLS, BY_ID, EMPTY_CONTEXT, type LiveContext } from "./registry.ts";
import { SLASH } from "../hud/logic.ts";
import { parse } from "../voice/understand/parse.ts";

// "Generated from every app action" is enforced here, not by a code generator (docs/16 §5).

const here = import.meta.dirname;
const logic = readFileSync(join(here, "../hud/logic.ts"), "utf8");
const union = (name: string): string[] => {
  const m = new RegExp(`export type ${name} =([^;]+);`).exec(logic);
  assert.ok(m, `${name} not found in hud/logic.ts`);
  return [...m[1]!.matchAll(/"([\w-]+)"/g)].map((x) => x[1]!);
};
const bound = (kind: "command" | "slash" | "move" | "mcp") => new Set(ACTIONS.flatMap((a) => a.binds?.[kind] ?? []));

test("every keyboard command has a registry row", () => {
  const missing = union("Command").filter((c) => !bound("command").has(c));
  assert.deepEqual(missing, []);
});

test("every slash command has a registry row", () => {
  const missing = SLASH.map((s) => s.id).filter((s) => !bound("slash").has(s));
  assert.deepEqual(missing, []);
});

test("every hidden-move button has a registry row", () => {
  const missing = union("MoveId").filter((m) => !bound("move").has(m));
  assert.deepEqual(missing, []);
});

test("every Shrike MCP tool is either reachable by voice or named as the agent's own", () => {
  const dir = join(here, "../../../../../../packages/mcp-server/src");
  const names = new Set<string>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) for (const m of readFileSync(join(dir, f), "utf8").matchAll(/\btool\(\s*"([a-z_]+)"/g)) names.add(m[1]!);
  assert.ok(names.size > 40, `found ${names.size} tools`);
  const missing = [...names].filter((n) => !bound("mcp").has(n) && !AGENT_ONLY_TOOLS.has(n));
  assert.deepEqual(missing, [], "a new MCP tool needs a registry row or a place in AGENT_ONLY_TOOLS");
  const stale = [...AGENT_ONLY_TOOLS].filter((n) => !names.has(n));
  assert.deepEqual(stale, [], "AGENT_ONLY_TOOLS names a tool that no longer exists");
});

test("every action has a run binding (actions/run.ts), a title, help and examples", () => {
  const run = readFileSync(join(here, "run.ts"), "utf8");
  for (const a of ACTIONS) {
    assert.ok(a.title && a.help && a.examples.length, a.id);
    if (!a.meta) assert.ok(run.includes(`"${a.id}":`) || new RegExp(`\\n  ${a.id.replace(".", "\\.")}:`).test(run), `${a.id} has no binding in run.ts`);
  }
  assert.equal(BY_ID.size, ACTIONS.length, "ids are unique");
});

test("risk tiers: push, PR writes and CI reruns are outward; discard is destructive", () => {
  for (const id of ["git.push", "pr.create", "pr.merge", "pr.approve", "ci.rerun"]) assert.equal(BY_ID.get(id)?.risk, "outward", id);
  assert.equal(BY_ID.get("git.discard")?.risk, "destructive");
  for (const a of ACTIONS) assert.ok(["safe", "undoable", "outward", "destructive"].includes(a.risk), a.id);
});

test("each action is reachable by voice: one of its own examples parses to it", () => {
  const ctx: LiveContext = {
    ...EMPTY_CONTEXT,
    prs: [{ number: 42, title: "Fix checkout" }, { number: 57, title: "Dark mode" }, { number: 61, title: "Bump deps" }],
    checks: [{ name: "lint", state: "pass" }, { name: "e2e (chromium)", state: "fail" }],
    branches: ["main", "fix-cart"],
    workspaces: [{ name: "admin" }, { name: "docs" }],
    worktrees: ["fix-a"],
    files: ["src/lib/cart.ts", "server/todos.controller.ts", "README.md", "src/components/Checkout.tsx"],
    routes: [{ method: "GET", path: "/api/todos" }],
    chains: ["polish"],
    skills: [{ id: "deploy", name: "deploy" }],
    flows: [{ id: "f1", name: "checkout" }],
  };
  // plan.stop: "stop" / "ruko" parse as app.stop; the router turns them into a plan stop while something runs (router.test.ts)
  const unreachable = ACTIONS.filter((a) => a.id !== "plan.stop" && !a.examples.some((e) => {
    const p = parse(e, ctx);
    return p.kind === "plan" && p.steps.length === 1 && p.steps[0]!.action === a.id;
  })).map((a) => a.id);
  assert.deepEqual(unreachable, []);
});
