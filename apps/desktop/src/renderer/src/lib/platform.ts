// Phase D: the OS, from preload. Shortcut labels, voice and the title bar follow it.
export const platform = (typeof window === "undefined" ? undefined : window.shrike?.platform) ?? "darwin";
export const isMac = platform === "darwin";

/** "⌘⇧G" stays on macOS; elsewhere it reads "Ctrl+Shift+G". Handlers accept ⌘ or Ctrl either way. */
export function keys(s: string, mac = isMac): string {
  if (mac) return s;
  return s
    .replace(/[⌘⌃]\s?/g, "Ctrl+")
    .replace(/⌥\s?/g, "Alt+")
    .replace(/⇧\s?/g, "Shift+")
    .replace(/↵/g, "Enter")
    .replace(/\+(?=$|[\s)])/g, "");
}
