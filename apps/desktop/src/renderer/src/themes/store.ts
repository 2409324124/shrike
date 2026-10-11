import { create } from "zustand";
import { cssVariables, palette, themes, type ThemeId } from "@shrike/design";
import { parsePref, pick, resolve, type ThemePref } from "./logic.ts";

// Z: the active theme. Swapping the token <style> at the root restyles everything (Thread, cards, sheets, code).
const KEY = "shrike.theme";
const STYLE_ID = "shrike-tokens";

const load = (): ThemePref => {
  try {
    return parsePref(localStorage.getItem(KEY));
  } catch {
    return parsePref(null);
  }
};
const systemDark = (): boolean => typeof matchMedia !== "function" || matchMedia("(prefers-color-scheme: dark)").matches;

interface ThemeState {
  pref: ThemePref;
  active: ThemeId;
  open: boolean; // the Appearance dialog
  choose(theme: ThemeId): void;
  setMatchSystem(on: boolean): void;
  setOpen(open: boolean): void;
}

function apply(id: ThemeId, matchSystem: boolean): void {
  if (typeof document === "undefined") return;
  // The window follows too: macOS draws the traffic lights (and their inactive grey) for this appearance.
  void window.shrike?.setWindowChrome?.({ appearance: matchSystem ? "system" : themes[id].scheme, background: palette(id).color.void, ink: palette(id).color.ink }).catch(() => {});
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.prepend(el);
  }
  el.textContent = cssVariables(id); // --c-*, --code-*, --g-*, --f-*, --r-*, --s-*
  document.documentElement.dataset.theme = id;
  document.documentElement.dataset.glow = themes[id].glow ? "on" : "off";
}

function save(pref: ThemePref): ThemeId {
  try {
    localStorage.setItem(KEY, JSON.stringify(pref));
  } catch {} // private storage: the choice lasts this session
  const id = resolve(pref, systemDark());
  apply(id, pref.matchSystem);
  return id;
}

export const useTheme = create<ThemeState>((set, get) => ({
  pref: load(),
  active: resolve(load(), systemDark()),
  open: false,
  choose: (theme) => {
    const pref = pick({ ...get().pref, matchSystem: false }, theme); // a hand pick wins over the system
    set({ pref, active: save(pref) });
  },
  setMatchSystem: (matchSystem) => {
    const pref = { ...get().pref, matchSystem };
    set({ pref, active: save(pref) });
  },
  setOpen: (open) => set({ open }),
}));

/** Once at boot, before the first render: tokens for the saved theme, then follow the system when asked. */
export function installTheme(): void {
  apply(useTheme.getState().active, useTheme.getState().pref.matchSystem);
  if (typeof matchMedia !== "function") return;
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const { pref } = useTheme.getState();
    if (pref.matchSystem) useTheme.setState({ active: save(pref) });
  });
}
