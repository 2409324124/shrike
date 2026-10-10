import assert from "node:assert/strict";
import { test } from "node:test";
import { cssVariables, palette, THEME_IDS, themes } from "@shrike/design";
import { contrast, DEFAULT_PREF, parsePref, pick, resolve } from "./logic.ts";

test("every theme's text passes WCAG AA on its grounds; high contrast passes AAA", () => {
  for (const id of THEME_IDS) {
    const { color: c, code: k } = palette(id);
    const min = id === "contrast" ? 7 : 4.5;
    for (const bg of ["void", "abyss"] as const) // navy is only the glow tint at the stage centre
      for (const fg of ["ink", "inkDim", "cyan", "violet", "ok", "slow", "fail"] as const) {
        const r = contrast(c[fg], c[bg]);
        assert.ok(r >= min, `${id}: ${fg} on ${bg} is ${r.toFixed(2)}, needs ${min}`);
      }
    for (const tk of Object.keys(k).filter((n) => n !== "bg" && (n !== "comment" || id === "daylight" || id === "contrast")) as (keyof typeof k)[]) {
      const r = contrast(k[tk], k.bg);
      assert.ok(r >= min, `${id}: code ${tk} is ${r.toFixed(2)}, needs ${min}`);
    }
    if (id === "contrast") assert.ok(contrast(c.inkFaint, c.void) >= 7, "high contrast: even faint text is AAA");
    assert.match(cssVariables(id), new RegExp(`--c-void: ${c.void};.*--code-keyword: ${k.keyword.replace(/[()]/g, "\\$&")};.*color-scheme: ${themes[id].scheme}`));
  }
});

test("theme prefs: parse, pick and the system pair", () => {
  assert.deepEqual(parsePref(null), DEFAULT_PREF);
  assert.deepEqual(parsePref("{bad"), DEFAULT_PREF);
  assert.deepEqual(parsePref(JSON.stringify({ theme: "neon", matchSystem: "yes" })), DEFAULT_PREF);
  assert.deepEqual(parsePref(JSON.stringify({ theme: "daylight", matchSystem: true, dark: "daylight" })), { theme: "daylight", matchSystem: true, dark: "abyss" });
  const p = pick(pick(DEFAULT_PREF, "tokyo"), "daylight");
  assert.deepEqual(p, { theme: "daylight", matchSystem: false, dark: "tokyo" });
  assert.equal(resolve(p, true), "daylight");
  assert.equal(resolve({ ...p, matchSystem: true }, true), "tokyo");
  assert.equal(resolve({ ...p, matchSystem: true }, false), "daylight");
});
