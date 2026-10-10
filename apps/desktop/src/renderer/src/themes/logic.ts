import { THEME_IDS, themes, type ThemeId } from "@shrike/design";

// Z: theme choice. Pure so themes.test.ts can check it and every theme's contrast.

export interface ThemePref {
  theme: ThemeId; // the picked theme
  matchSystem: boolean; // follow macOS: `dark` when the system is dark, Daylight when it is light
  dark: ThemeId; // the dark half of the system pair: the last dark theme picked
}

export const DEFAULT_PREF: ThemePref = { theme: "abyss", matchSystem: false, dark: "abyss" };

const isId = (v: unknown): v is ThemeId => typeof v === "string" && (THEME_IDS as string[]).includes(v);

/** Stored JSON back to a pref; anything unknown falls back to Abyss. */
export function parsePref(raw: string | null | undefined): ThemePref {
  try {
    const v = JSON.parse(raw ?? "null") as Partial<ThemePref> | null;
    if (!v || typeof v !== "object") return DEFAULT_PREF;
    const theme = isId(v.theme) ? v.theme : DEFAULT_PREF.theme;
    const dark = isId(v.dark) && themes[v.dark].scheme === "dark" ? v.dark : themes[theme].scheme === "dark" ? theme : DEFAULT_PREF.dark;
    return { theme, matchSystem: v.matchSystem === true, dark };
  } catch {
    return DEFAULT_PREF;
  }
}

/** Picking a theme by hand: a dark one also becomes the dark half of the system pair. */
export const pick = (p: ThemePref, theme: ThemeId): ThemePref => ({ ...p, theme, dark: themes[theme].scheme === "dark" ? theme : p.dark });

export const resolve = (p: ThemePref, systemDark: boolean): ThemeId => (p.matchSystem ? (systemDark ? p.dark : "daylight") : p.theme);

/** WCAG 2 contrast ratio. `fg` may be rgba(); it is blended over `bg` (a hex). */
export function contrast(fg: string, bg: string): number {
  const b = rgb(bg);
  const f = rgb(fg, b);
  const [l1, l2] = [lum(f), lum(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

function rgb(c: string, under: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(c);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)) as [number, number, number];
  const m = /^rgba?\(([^)]+)\)$/.exec(c);
  if (!m) throw new Error(`not a colour: ${c}`);
  const [r, g, bl, a = 1] = m[1]!.split(",").map(Number) as [number, number, number, number?];
  return [r, g, bl].map((x, i) => x * a + under[i]! * (1 - a)) as [number, number, number];
}

function lum([r, g, b]: [number, number, number]): number {
  const ch = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
