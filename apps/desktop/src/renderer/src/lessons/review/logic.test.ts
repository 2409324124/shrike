import assert from "node:assert/strict";
import { test } from "node:test";
import { burnSummary, checkLine, chipText, nth, rankOfClean, sparkPath, trendOf } from "./logic.ts";

test("chips, ranks and the self-check line in plain words", () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(nth), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st"]);
  assert.equal(chipText(4, "Loading state"), "4th time: loading state");
  assert.equal(chipText(2, "N+1 queries"), "2nd time: N+1 queries");
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(rankOfClean), ["E", "D", "C", "B", "A", "S", "S"]);
  const c = { state: "done" as const, checked: 6, reviewers: ["ana"], found: [{ lessonId: "a", title: "Loading state" }] };
  assert.equal(checkLine(c), "Checked 6 repeat issues for @ana: 1 found (loading state)");
  assert.equal(checkLine({ ...c, found: [{ ...c.found[0]!, fixed: true }] }), "Checked 6 repeat issues for @ana: 1 found (loading state), fixed");
  assert.equal(checkLine({ ...c, found: [] }), "Checked 6 repeat issues for @ana: none found");
  assert.equal(checkLine({ ...c, state: "checking", checked: 1, reviewers: [] }), "Checking 1 repeat issue");
});

test("sparkline, trend and burn-down", () => {
  assert.equal(sparkPath([0, 2, 1], 40, 10), "M0.0,9.0 L20.0,1.0 L40.0,5.0");
  assert.equal(sparkPath([], 40, 10), "");
  assert.equal(trendOf([3, 2, 0, 0]), "down");
  assert.equal(trendOf([0, 0, 1, 2]), "up");
  assert.equal(trendOf([1, 1]), "flat");
  assert.deepEqual(burnSummary([{ pr: 1, flagged: 4 }, { pr: 2, flagged: 2 }, { pr: 3, flagged: 1 }, { pr: 4, flagged: 0 }]), { before: 3, lately: 0.5, verdict: "fewer" });
});
