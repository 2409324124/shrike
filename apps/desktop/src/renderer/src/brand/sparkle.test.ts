import assert from "node:assert/strict";
import { test } from "node:test";
import portrait from "@shrike/design/brand/portrait.json" with { type: "json" };
import emblem from "@shrike/design/brand/emblem.json" with { type: "json" };
import { DRAW_IN_MS, emblemDots, frameAt, LOOP_MS, portraitDots, type EmblemGrid, type PortraitData } from "./sparkle.ts";

test("brand dot data loads with the approved counts and an eye inside the grid", () => {
  const p = portrait as PortraitData;
  const { bird, field } = portraitDots(p);
  assert.equal(p.w, 128);
  assert.equal(p.h, 128);
  assert.equal(bird.length, 4554);
  assert.equal(field.length, 2170);
  assert.match(bird[0]![2], /^#[0-9a-f]{6}$/);
  const e = emblem as Record<"40" | "28", EmblemGrid>;
  assert.equal(emblemDots(e["40"]).length, 3116);
  assert.equal(emblemDots(e["28"]).length, 1469);
  assert.equal(e["28"].braille.length, e["28"].h / 4);
  for (const g of [p, e["40"], e["28"]]) assert.ok(g.eye[0] > 0 && g.eye[0] < g.w && g.eye[1] > 0 && g.eye[1] < g.h);
  assert.throws(() => portraitDots({ ...p, colors: p.colors.slice(6) }));
});

test("calm is a still image with a steady eye; otherwise draw in, then sparkle on the loop", () => {
  assert.deepEqual(frameAt(0, true, true), { rows: 1, eye: "steady" });
  assert.deepEqual(frameAt(5000, true, false), { rows: 1, eye: "steady" });
  assert.deepEqual(frameAt(DRAW_IN_MS / 2, false, true), { rows: 0.5, eye: "hidden" });
  assert.equal(frameAt(DRAW_IN_MS, false, true).eye, 0);
  assert.equal(frameAt(0, false, false).eye, 0);
  assert.ok(Math.abs((frameAt(LOOP_MS / 4, false, false).eye as number) - Math.PI / 2) < 1e-9);
  assert.equal(frameAt(LOOP_MS, false, false).eye, 0);
});
