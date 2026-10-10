import { test } from "node:test";
import assert from "node:assert/strict";
import { BY_ID } from "../../actions/registry.ts";
import { hint, hintsFor } from "./hints.ts";

test("what can I say: the panel's commands first, then the global ones, all from the registry", () => {
  const changes = hintsFor("changes");
  assert.ok(changes.here.some((h) => h.id === "git.commit"));
  assert.ok(changes.anywhere.length >= 5);
  assert.ok(!changes.anywhere.some((h) => h.id === "git.push"), "a panel command isn't listed twice");
  for (const h of [...changes.here, ...changes.anywhere]) assert.ok(h.say && h.does && !h.does.includes("{"), h.id);
});

test("a hint says it in English and in Roman Hinglish, never Devanagari", () => {
  const h = hint(BY_ID.get("step.next")!);
  assert.equal(h.say, "next step");
  assert.equal(h.also, "agla step");
  assert.equal(hint(BY_ID.get("pr.open")!).also, "PR 42 kholo");
  for (const w of ["thread", "pr", "api", "skills"] as const) for (const x of [...hintsFor(w).here, ...hintsFor(w).anywhere]) assert.match(`${x.say} ${x.also ?? ""}`, /^[\x20-\x7e]+$/, x.id);
});
