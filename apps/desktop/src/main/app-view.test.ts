import assert from "node:assert/strict";
import { test } from "node:test";
import { placeAppWindow, popupPolicy } from "./app-view.ts";

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
