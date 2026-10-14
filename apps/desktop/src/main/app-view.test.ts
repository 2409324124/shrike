import assert from "node:assert/strict";
import { test } from "node:test";
import type { IngestMessage } from "@shrike/schema";
import { AppView, placeAppWindow, popupPolicy, withConfig } from "./app-view.ts";

test("sign-in popups open as sandboxed child windows; other schemes are refused", () => {
  const p = popupPolicy("https://accounts.google.com/o/oauth2/auth?x=1");
  assert.equal(p.action, "allow");
  assert.equal(p.action === "allow" && p.overrideBrowserWindowOptions.webPreferences?.nodeIntegration, false);
  assert.equal(popupPolicy("http://127.0.0.1:19099/emulator/auth/handler").action, "allow");
  for (const u of ["file:///etc/passwd", "javascript:alert(1)", "shrike://x"]) assert.equal(popupPolicy(u).action, "deny", u);
});

test("the app window reopens where it was, or centred on the primary display when that display is gone", () => {
  const primary = { x: 0, y: 25, width: 1440, height: 875 };
  const external = { id: 7, workArea: { x: 1440, y: 0, width: 2560, height: 1440 } };
  const displays = [{ id: 1, workArea: primary }, external];
  const saved = { displayId: 7, bounds: { x: 1600, y: 100, width: 1800, height: 1000 }, fullScreen: true };
  assert.deepEqual(placeAppWindow(saved, displays, primary), { bounds: saved.bounds, fullScreen: true });
  // the external monitor is unplugged: centre on the primary, sized to fit, not full screen
  assert.deepEqual(placeAppWindow(saved, [displays[0]!], primary), { bounds: { x: 0, y: 25, width: 1440, height: 875 }, fullScreen: false });
  // the display shrank: the window stays inside it
  const small = [{ id: 7, workArea: { x: 1440, y: 0, width: 1920, height: 1080 } }];
  assert.deepEqual(placeAppWindow({ ...saved, bounds: { x: 3000, y: 900, width: 1000, height: 600 } }, small, primary).bounds, { x: 2360, y: 480, width: 1000, height: 600 });
  // nothing saved, or junk: the default size centred on the primary
  for (const junk of [undefined, null, "x", { displayId: 1, bounds: { x: 0 } }]) assert.deepEqual(placeAppWindow(junk, displays, primary), { bounds: { x: 80, y: 33, width: 1280, height: 860 }, fullScreen: false });
});

test("#54 a page can't answer a point mode Shrike didn't start; main marks live events, the page can't", () => {
  const got: IngestMessage[] = [];
  const picks: unknown[] = [];
  let live = false;
  const v = new AppView({ bundlePath: "/none", appUrl: () => undefined, live: () => live, onMessage: (m) => void got.push(m), onWarning: () => {} });
  v.onPoint = (p) => void picks.push(p);
  const rect = { x: 0, y: 0, width: 1, height: 1, viewportWidth: 9, viewportHeight: 9 };
  v["onBinding"](JSON.stringify({ type: "point", pick: { selector: "#pay", text: "Pay", role: "button", rect } }));
  assert.deepEqual(picks, []);
  const ev = { id: "a".repeat(16), traceId: "b".repeat(32), origin: "server", kind: "log", name: "x", startMs: 1, status: "ok", live: true };
  v["onBinding"](JSON.stringify({ type: "events", events: [ev] }));
  live = true;
  v["onBinding"](JSON.stringify({ type: "events", events: [{ ...ev, live: false }] }));
  const [local, remote] = got.map((m) => (m.type === "events" ? m.events[0] : undefined));
  assert.deepEqual([local?.origin, local?.live, remote?.origin, remote?.live], ["browser", undefined, "browser", true]);
  assert.equal(withConfig("/*bundle*/", { traceparent: false }), '(() => {\nconst __shrikeConfig = {"traceparent":false};\n/*bundle*/\n})();');
});
