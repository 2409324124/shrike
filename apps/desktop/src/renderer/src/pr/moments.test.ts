import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrCheck, PrInfo, PrView } from "@shrike/schema";
import { prMoment } from "./moments.ts";

const now = Date.parse("2026-10-09T12:00:00Z");
const pr = (p: Partial<PrInfo> = {}): PrInfo => ({ id: "P", number: 42, title: "t", url: "u", state: "open", author: "you", base: "main", head: "fix", updatedAt: "2026-10-09T11:58:00Z", ...p });
const ck = (state: PrCheck["state"], name: string = state): PrCheck => ({ name, state });
const v = (p: PrInfo | undefined, checks: PrCheck[] = [], branch = "fix"): PrView => ({ ghReady: true, branch, viewer: "you", ...(p ? { pr: p } : {}), checks, threads: [], comments: [], reviews: [], at: now });

test("PR13: opened, green and merged only on a change this panel saw", () => {
  assert.equal(prMoment(null, v(pr()), now), null, "first load");
  assert.deepEqual(prMoment(v(undefined), v(pr()), now), { kind: "opened", n: 42 });
  assert.equal(prMoment(v(undefined), v(pr({ updatedAt: "2026-10-01T00:00:00Z" })), now), null, "an old PR just found");
  assert.equal(prMoment(v(undefined), v(pr({ head: "other" })), now), null, "picked someone else's PR");
  assert.deepEqual(prMoment(v(pr()), v(pr({ state: "merged" })), now), { kind: "merged", n: 42, base: "main" });
  assert.equal(prMoment(v(pr()), v(pr({ number: 7, state: "merged" })), now), null, "another PR");
  assert.deepEqual(prMoment(v(pr(), [ck("pass", "a"), ck("pending", "b")]), v(pr(), [ck("pass", "a"), ck("pass", "b"), ck("skipped")]), now), { kind: "green", passed: 2, n: 42 });
  assert.equal(prMoment(v(pr(), [ck("pass")]), v(pr(), [ck("pass")]), now), null, "already green");
  assert.equal(prMoment(v(pr(), [ck("fail")]), v(pr(), [ck("pass"), ck("fail")]), now), null, "still failing");
  assert.deepEqual(prMoment(v(undefined, [ck("fail")]), v(undefined, [ck("pass")]), now), { kind: "green", passed: 1 }, "branch runs before a PR");
  assert.equal(prMoment(v(pr(), [ck("fail")]), v(pr(), [ck("pass")], "main"), now), null, "switched branch");
});
