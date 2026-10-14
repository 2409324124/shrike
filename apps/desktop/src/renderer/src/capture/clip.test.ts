import { test } from "node:test";
import assert from "node:assert/strict";
import type { ActionView, DebugEvent } from "@shrike/schema";
import type { Trip } from "../lib/thread-layout.ts";
import { buildTrip, FALLBACK, knownPlaces, LANE_X, layoutTrip } from "../lib/thread-layout.ts";
import { curlSignup, payNow } from "../thread/fixtures.ts";
import { cropAround, diveTarget, fitValue, frameCount, frameFor, lengthOf, outPoints, partial, phaseAt, retPoints, rng, snippetRange, timeline, toCanvas, totalOf } from "./paint.ts";

const PL = [FALLBACK.screen, FALLBACK.page, FALLBACK.server, FALLBACK.database];
const st = (lane: 0 | 1 | 2 | 3, p: Partial<Trip["stations"][number]> = {}): Trip["stations"][number] => ({
  id: String(Math.random()), stepIndex: 0, lane: PL[lane]!.id, place: PL[lane]!, sub: 0, kind: "function", label: "f()", status: "ok", ms: 1, caption: "ran", eventIds: [], ...p,
});
const trip: Trip = {
  actionId: "a1", title: 'Clicked "Add Todo"', status: "error", ms: 15, shape: "db_refused", verdict: "The database refused.", returned: "Server error (500)",
  caller: { place: FALLBACK.screen, browser: true, text: "" }, places: PL.map((place) => ({ place, hop: 0 })), forks: [],
  stations: [st(1), st(1, { sub: 1 }), st(2), st(2, { sub: 1, chip: "{ userId: undefined }", chipError: true, status: "error" }), st(3, { snap: true, status: "error", kind: "db_query" }), st(2)],
};

test("timeline: about 8s with every phase, shorter without snap/dive; frames are exact", () => {
  const full = timeline({ snap: true, dive: true });
  assert.deepEqual(full.map((p) => p.name), ["intro", "drop", "snap", "return", "dive", "verdict", "outro"]);
  assert.equal(totalOf(full), 8);
  assert.equal(frameCount(full, 30), 240);
  assert.equal(frameCount(full, 60), 480);
  const ok = timeline({ snap: false, dive: false });
  assert.deepEqual(ok.map((p) => p.name), ["intro", "drop", "return", "verdict", "outro"]);
  assert.equal(totalOf(ok), 5);
  assert.equal(phaseAt(full, 0).phase.name, "intro");
  assert.equal(phaseAt(full, 2.4).phase.name, "snap");
  assert.equal(phaseAt(full, 2.39).phase.name, "drop");
  assert.equal(phaseAt(full, 4).phase.name, "dive");
  assert.equal(phaseAt(full, 99).phase.name, "outro");
  assert.ok(Math.abs(phaseAt(full, 99).k - 1) < 1e-9);
  for (let n = 0; n < 240; n++) assert.equal(JSON.stringify(phaseAt(full, n / 30)), JSON.stringify(phaseAt(full, n / 30)));
});

test("layout geometry scales into both canvases at the lane fractions", () => {
  for (const a of ["9:16", "16:9"] as const) {
    const f = frameFor(a);
    assert.equal(f.LW * f.k, f.W);
    const g = layoutTrip(trip, f.LW);
    g.lanes.cols.forEach((c, i) => assert.ok(Math.abs(toCanvas(f, 0, c.x, 0).x - LANE_X[i]! * f.W) <= f.k));
    assert.equal(toCanvas(f, g.shotY, 0, g.shotY).y, f.feedTop);
    assert.ok(g.stations.every((s) => toCanvas(f, 0, s.x, 0).x < f.W), "nothing past the right edge");
  }
});

test("thread polylines stop at the snap; partial path tip walks the arc", () => {
  const g = layoutTrip(trip, 540);
  const { pts, at } = outPoints(g);
  assert.equal(at.length, 6);
  assert.equal(at[5], Infinity, "station after the snap is never reached");
  assert.equal(at[4], lengthOf(pts));
  assert.deepEqual(pts[pts.length - 1], [g.stations[4]!.x, g.stations[4]!.y]);
  assert.deepEqual(partial(pts, 0).tip, pts[0]);
  assert.deepEqual(partial(pts, 1e9).tip, pts[pts.length - 1]);
  assert.deepEqual(partial(pts, 10).tip, [pts[0]![0], pts[0]![1] + 10]);
  const r = retPoints(g);
  assert.deepEqual(r[0], [g.stations[4]!.x, g.stations[4]!.y]);
  assert.deepEqual(r[2], [g.callerX, g.endY]);
});

test("dive picks the call carrying the bad value; sparks are reproducible", () => {
  assert.equal(diveTarget(trip), 3);
  assert.equal(diveTarget({ ...trip, status: "ok" }), -1);
  const a = rng(42);
  const b = rng(42);
  for (let i = 0; i < 22; i++) assert.equal(a(), b());
});

test("snippet: whole function when it fits, else a window around the live line", () => {
  const src = ["// x", "export function f(a) {", "  const b = a;", "  return g(b);", "}", "", "x", "y"];
  assert.deepEqual(snippetRange(src, 4, 14), [2, 5]);
  const long = ["function big() {", ...Array.from({ length: 40 }, (_, i) => `  s${i}();`), "}"];
  const [s, e] = snippetRange(long, 30, 9);
  assert.ok(s <= 30 && e >= 30 && e - s + 1 <= 9);
  assert.deepEqual(snippetRange(["a", "b", "c"], 2, 14), [1, 3]);
});

test("crop centres on the click and keeps the card aspect inside the image", () => {
  const r = cropAround(880, 1280, 1.72, { x: 318, y: 82, width: 90, height: 36, viewportWidth: 440, viewportHeight: 640 });
  assert.ok(Math.abs(r.sw / r.sh - 1.72) < 1e-9);
  assert.ok(r.sx >= 0 && r.sy >= 0 && r.sx + r.sw <= 880 + 1e-9 && r.sy + r.sh <= 1280);
  const cx = (318 + 45) * 2;
  assert.ok(r.sx <= cx && cx <= r.sx + r.sw, "click inside the crop");
  assert.deepEqual(cropAround(1000, 500, 2), { sx: 0, sy: 0, sw: 1000, sh: 500 });
});

test("a long value keeps its bad part when it has to be cut", () => {
  const m = { measureText: (t: string) => ({ width: t.length * 10 }) };
  const chip = "insertTodo({ title: 'buy milk', userId: undefined })";
  assert.equal(fitValue(m, chip, 1000), chip);
  const cut = fitValue(m, chip, 250);
  assert.ok(cut.startsWith("…") && cut.includes("userId: undefined") && cut.length * 10 <= 250, cut);
  assert.match(fitValue(m, "a plain long value with nothing wrong in it", 100), /…$/);
});

test("many lanes in a portrait clip: every lane on canvas, short names, forks and terminal cards", () => {
  const f = frameFor("9:16");
  const pay = layoutTrip(buildTrip(payNow(0)), f.LW);
  assert.equal(pay.lanes.cols.length, 9);
  assert.ok(pay.lanes.cols.every((c) => c.x > 0 && c.x < f.LW));
  assert.ok(pay.stations.every((s) => s.x > 0 && s.x < f.LW), "nothing past the edges");
  assert.deepEqual(pay.lanes.cols.map((c) => c.head).slice(-4), ["LRU", "POSTGRES", "SQLITE", "STRIPE"]);
  const { at } = outPoints(pay);
  const side = pay.stations.findIndex((s) => s.fork && !s.fork.main);
  assert.ok(isFinite(at[side]!) && at[side]! > pay.forks[0]!.start, "the side branch is reached after it leaves the thread");
  const curl = buildTrip(curlSignup(0));
  assert.equal(curl.caller.browser, false);
  assert.ok(retPoints(layoutTrip(curl, f.LW))[2]![0] === layoutTrip(curl, f.LW).callerX);
});

test("a live trip's grey server station is on the clip's thread (T22)", () => {
  const f = frameFor("9:16");
  const root = { id: "r", traceId: "t", origin: "browser", kind: "user_action", name: 'Clicked "Save"', trigger: "click", startMs: 0, status: "ok", source: { file: "app/page.tsx", line: 3, precision: "exact" } } satisfies DebugEvent;
  const req = { id: "q", traceId: "t", origin: "browser", kind: "http_request", name: "POST", startMs: 5, durationMs: 120, status: "ok", http: { method: "POST", url: "/api/save", status: 200 } } satisfies DebugEvent;
  const view = { id: "r", traceId: "t", trigger: "click", label: root.name, startMs: 0, durationMs: 130, status: "ok", complete: true, tree: [{ event: req, children: [] }], root, summary: { headline: "", steps: [], stats: { files: 0, functions: 0, requests: 1, queries: 0, logs: 0, errors: 0, totalMs: 130 } }, flags: [] } satisfies ActionView;
  const g = layoutTrip(buildTrip(view, new Set(), knownPlaces([], [], { liveUrl: "https://shop.example.com" })), f.LW);
  const i = g.stations.findIndex((s) => s.live);
  assert.ok(i > 0 && g.stations[i]!.x > 0 && g.stations[i]!.x < f.LW);
  assert.ok(isFinite(outPoints(g).at[i]!), "the tip reaches it, so the painter draws it");
});
