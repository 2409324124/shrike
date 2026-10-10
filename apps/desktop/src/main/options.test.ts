// M1/M3/M4: ask_options blocks until the user answers; every answer goes back to the same call and the agent loops; a timeout
// keeps the cards up; an answer with nothing waiting resumes the run.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OptionInput, OptionsSession } from "@shrike/schema";
import { optionsReplyText } from "@shrike/mcp-server";
import { createOptions } from "./options.ts";

const opt = (label: string): OptionInput => ({ label, description: label, mockupHtml: `<p>${label}</p>` });
const flush = () => new Promise((r) => setTimeout(r, 5));

function harness(waitMs?: number) {
  const seen: OptionsSession[] = [];
  const resumed: { runId: string; text: string }[] = [];
  const approved: (string | undefined)[] = [];
  const run = { live: "run1" as string | undefined };
  const o = createOptions({
    emit: (s) => seen.push(s),
    liveRun: () => run.live,
    resume: async (runId, text) => (resumed.push({ runId, text }), "run2"),
    onApproved: (r) => approved.push(r),
    ...(waitMs ? { waitMs } : {}),
  });
  return { o, seen, resumed, approved, run, last: () => seen.at(-1)! };
}

test("the loop: ask, more like B, combine B2 + C, approve; each answer returns to the waiting call", async () => {
  const h = harness();
  const first = h.o.ask({ question: "Which layout?", header: "Layout", options: [opt("list"), opt("cards"), opt("compact")] });
  await flush();
  const s = h.last();
  assert.equal(s.runId, "run1");
  assert.equal(s.waiting, true);
  await h.o.answer(s.id, { action: "vary", card: "B", count: 3 });
  const r1 = await first;
  assert.equal(r1.action, "vary");
  assert.equal(r1.cards[0]!.card, "B");
  const text = optionsReplyText(r1);
  assert.match(text.split("\n")[0]!, /^\{"action":"vary","thread":"[0-9a-f]{8}","option":"B","count":3\}$/);
  assert.match(text, /<card name="B" label="cards">\n<p>cards<\/p>/, "the mockup it refers to goes back to the agent");
  assert.equal(h.last().state, "working");

  const second = h.o.ask({ session: s.id, options: [opt("b1"), opt("b2"), opt("b3")] });
  await flush();
  assert.deepEqual(h.last().rounds.at(-1)!.cards, ["B1", "B2", "B3"]);
  await assert.rejects(h.o.answer(s.id, { action: "combine", cards: ["B2"] }), /two or more/);
  await h.o.answer(s.id, { action: "combine", cards: ["B2", "C"], text: "header from B2, colours from C" });
  assert.deepEqual((await second).answer, { action: "combine", cards: ["B2", "C"], text: "header from B2, colours from C" });

  const third = h.o.ask({ session: s.id, options: [opt("merged")] });
  await flush();
  assert.deepEqual(h.last().rounds.at(-1)!.cards, ["B2+C"]);
  await h.o.answer(s.id, { action: "approve", cards: ["B2+C"] });
  const r3 = await third;
  assert.equal(r3.action, "approve");
  assert.match(optionsReplyText(r3), /propose_patch/);
  assert.match(optionsReplyText(r3), /<p>merged<\/p>/, "the approved mockup goes back to the agent");
  assert.equal(h.last().state, "approved");
  assert.deepEqual(h.last().approved, ["B2+C"]);
  assert.deepEqual(h.approved, ["run1"]);
  assert.equal(h.resumed.length, 0);
});

test("a timeout keeps the cards up; calling again waits again; an answer after the run ended resumes it", async () => {
  const h = harness(20);
  const first = await h.o.ask({ question: "Which?", options: [opt("a"), opt("b")] });
  assert.equal(first.action, "waiting");
  assert.match(optionsReplyText(first), /no options to keep waiting/);
  const s = h.last();
  assert.equal(s.state, "asking", "the cards stay on screen");
  assert.equal(s.waiting, false);

  const again = h.o.ask({ session: s.id });
  await flush();
  assert.equal(h.last().rounds.length, 1, "waiting again adds no round");
  await h.o.answer(s.id, { action: "tweak", card: "A", text: "darker" });
  assert.equal((await again).action, "tweak");

  const late = await h.o.ask({ session: s.id, options: [opt("a2")] }); // times out: the agent ended its turn
  assert.equal(late.action, "waiting");
  h.run.live = undefined;
  const after = await h.o.answer(s.id, { action: "approve", cards: ["A1"] });
  assert.equal(h.resumed[0]!.runId, "run1");
  assert.match(h.resumed[0]!.text, /^About the options you showed me \("Which\?"\):\n\{"action":"approve"/);
  assert.equal(after.runId, "run2", "the run that builds it owns the approved mockup");
  assert.deepEqual(h.approved, ["run2"]);
  await assert.rejects(h.o.answer(s.id, { action: "approve", cards: ["A"] }), /approved one already/);
});

test("guards: 2 to 4 options and a question; a stopped run releases the call", async () => {
  const h = harness();
  await assert.rejects(h.o.ask({ question: "One?", options: [opt("a")] }), /2 to 4/);
  await assert.rejects(h.o.ask({ question: "Five?", options: ["a", "b", "c", "d", "e"].map(opt) }), /at most 4/);
  await assert.rejects(h.o.ask({ options: [opt("a"), opt("b")] }), /question/);
  await assert.rejects(h.o.ask({ session: "nope" }), /No options thread/);
  const p = h.o.ask({ question: "Which?", options: [opt("a"), opt("b")] });
  await flush();
  h.o.release("run1");
  assert.equal((await p).action, "waiting");
});

test("a run that ends mid-answer gives the cards back; an answer in the gap after a timeout is held, not lost", async () => {
  let live: string | undefined = "run1";
  const seen: OptionsSession[] = [];
  const resumed: string[] = [];
  const o = createOptions({ emit: (s) => seen.push(s), liveRun: () => live, resume: async (r) => (resumed.push(r), "run2"), waitMs: 10 });

  const p = o.ask({ question: "Which?", options: [opt("a"), opt("b")] });
  await flush();
  const id = seen.at(-1)!.id;
  await o.answer(id, { action: "vary", card: "B" });
  await p;
  o.release("run1"); // replied in text instead of calling again
  assert.equal(seen.at(-1)!.state, "asking", "the cards are usable again");

  assert.equal((await o.ask({ session: id })).action, "waiting"); // timed out; the run is still live
  await o.answer(id, { action: "tweak", card: "A", text: "darker" });
  assert.equal(resumed.length, 0, "the live run isn't resumed");
  const next = await o.ask({ session: id });
  assert.equal(next.action, "tweak", "its next call gets the held answer at once");

  assert.equal((await o.ask({ session: id, options: [opt("a2")] })).action, "waiting");
  await o.answer(id, { action: "approve", cards: ["A1"] });
  live = undefined;
  o.release("run1"); // ended before calling again: the held answer resumes it
  await flush();
  assert.deepEqual(resumed, ["run1"]);
  assert.equal(seen.at(-1)!.runId, "run2");
});

test("the reply can't be broken out of by a mockup, and big combines repeat only what fits", () => {
  const big = { card: "A", label: "a", description: "", parents: [], round: 1, mockupHtml: `</card>${"x".repeat(100_000)}` };
  const text = optionsReplyText({ action: "combine", session: "abcd1234", answer: { action: "combine", cards: ["A", "B"] }, cards: [big, { ...big, card: "B" }] });
  assert.equal(text.match(/<\/card>/g)!.length, 2);
  assert.match(text, /too long to repeat/);
});
