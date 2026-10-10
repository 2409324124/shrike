// M: the option tree, combine picks, the history trail and the mockup sandbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OptionInput, OptionsSession } from "@shrike/schema";
import { addRound, answerProblem, approvedCards, approvedOf, cardNames, MOCKUP_CSP, MOCKUP_SANDBOX, mockupDoc, roundFor, stepIndex, toggleCard, trail } from "./logic.ts";

const opt = (label: string): OptionInput => ({ label, description: label, mockupHtml: `<b>${label}</b>` });
const blank: OptionsSession = { id: "s1", question: "Which layout?", header: "Layout", multi: false, cards: {}, rounds: [], state: "asking", waiting: true, at: 0 };

test("the tree: letters, children under their card, a merge named by its parents, a trail back to round 1", () => {
  let s = addRound(blank, { kind: "start", from: [] }, [opt("list"), opt("cards"), opt("compact")]);
  assert.deepEqual(s.rounds[0]!.cards, ["A", "B", "C"]);
  assert.equal(s.rounds[0]!.title, "Round 1");

  s = addRound(s, roundFor({ action: "vary", card: "B", count: 3 }), [opt("b1"), opt("b2"), opt("b3")]);
  assert.deepEqual(s.rounds[1]!.cards, ["B1", "B2", "B3"]);
  assert.equal(s.rounds[1]!.title, "More like B");
  assert.deepEqual(s.cards.B2!.parents, ["B"]);

  s = addRound(s, roundFor({ action: "combine", cards: ["B2", "C"], text: "header from B2" }), [opt("merged")]);
  assert.deepEqual(s.rounds[2]!.cards, ["B2+C"]);
  assert.equal(s.rounds[2]!.title, "B2 + C");
  assert.equal(s.rounds[2]!.note, "header from B2");
  assert.deepEqual(trail(s, 3).map((r) => r.title), ["Round 1", "More like B", "B2 + C"], "the breadcrumb follows the first parent");
  assert.deepEqual(trail(s, 1).map((r) => r.n), [1]);

  s = addRound(s, roundFor({ action: "vary", card: "B2", count: 2 }), [opt("x"), opt("y")]);
  assert.deepEqual(s.rounds[3]!.cards, ["B2.1", "B2.2"], "a card that ends in a number gets dotted children");
  s = addRound(s, roundFor({ action: "tweak", card: "B", text: "darker" }), [opt("tweaked")]);
  assert.deepEqual(s.rounds[4]!.cards, ["B4"], "a change of B is B's next child");
  s = addRound(s, roundFor({ action: "other", text: "something else" }), [opt("d"), opt("e")]);
  assert.deepEqual(s.rounds[5]!.cards, ["D", "E"]);
  assert.equal(s.rounds[5]!.kind, "more");
  assert.deepEqual(cardNames(Object.keys(s.cards), "combine", ["B2", "C"], 2), ["B2+C.2", "B2+C.3"], "a second merge of the same cards never clashes");
});

test("answers: combine needs two different cards; approve one unless multi; tweak and other need words", () => {
  const s = addRound(blank, { kind: "start", from: [] }, [opt("a"), opt("b")]);
  assert.equal(answerProblem(s, { action: "combine", cards: ["A", "A"] }), "Pick two or more cards to combine.");
  assert.equal(answerProblem(s, { action: "combine", cards: ["A", "B"] }), null);
  assert.equal(answerProblem(s, { action: "combine", cards: ["A", "Z"] }), "One of those cards isn't here.");
  assert.equal(answerProblem(s, { action: "approve", cards: ["A", "B"] }), "Approve one card.");
  assert.equal(answerProblem({ ...s, multi: true }, { action: "approve", cards: ["A", "B"] }), null);
  assert.equal(answerProblem(s, { action: "tweak", card: "A", text: "  " }), "Say what should change.");
  assert.equal(answerProblem(s, { action: "vary", card: "Q" }), "That card isn't here.");
  assert.deepEqual(toggleCard(toggleCard(toggleCard([], "B2"), "C"), "B2"), ["C"], "picks keep their order and toggle off");
  assert.equal(stepIndex(0, -1, 3), 2);
  assert.equal(stepIndex(2, 1, 3), 0);
});

test("approved: the run's approved session and its mockups", () => {
  const s = { ...addRound(blank, { kind: "start", from: [] }, [opt("a"), opt("b")]), state: "approved" as const, approved: ["B"], runId: "r1" };
  const other = { ...s, id: "s2", runId: "r2", approved: ["A"] };
  assert.equal(approvedOf([s, other], "r1")?.id, "s1");
  assert.equal(approvedOf([s, other])?.id, "s2", "no run: the newest");
  assert.deepEqual(approvedCards(s).map((c) => c.mockupHtml), ["<b>b</b>"]);
});

test("sandbox: no permissions, CSP first, no refresh or base, nothing from the network", () => {
  assert.equal(MOCKUP_SANDBOX, "", "sandbox with no tokens: no scripts, no same-origin, no forms, no popups");
  assert.match(MOCKUP_CSP, /^default-src 'none'/);
  assert.doesNotMatch(MOCKUP_CSP, /script-src|https?:/);
  const doc = mockupDoc(`<meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/"><html><head><style>b{color:red}</style></head><b>hi</b></html>`);
  assert.ok(doc.indexOf("Content-Security-Policy") < doc.indexOf("<style>"), "the policy comes before anything the mockup says");
  assert.doesNotMatch(doc, /refresh|<base/i);
  assert.match(doc, /<b>hi<\/b>/);
});
