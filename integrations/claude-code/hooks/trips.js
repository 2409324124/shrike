// The mod's pure parts: no mods API, so node:test checks them without Claude Code.

export const SERVER = "plugin:shrike:shrike";
export const RECONNECT = "Open Shrike, then run /mcp and reconnect plugin:shrike:shrike.";

/** The newest trip in list_trips' text (`id  label  broke  12ms  at file:line`), or null when there is none. */
export function parseTrip(text) {
  const m = /^(\S+) {2}(.+?) {2}(worked|broke|slow) {2}(\d+)ms(?: {2}at (\S+:\d+))?$/.exec(String(text ?? "").split("\n")[0]);
  return m ? { id: m[1], label: m[2], verdict: m[3], ms: Number(m[4]), ...(m[5] ? { at: m[5] } : {}) } : null;
}

/** list_trips' result as Claude Code's $.mcp.call returns it. */
export const resultText = (r) => (r?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("\n");

export const sameView = (a, b) => a.up === b.up && a.trip?.id === b.trip?.id && a.trip?.verdict === b.trip?.verdict && a.trip?.at === b.trip?.at;

/** The band's one line as styled parts, or null to draw nothing. Colours are Claude Code theme keys. */
export function bandParts(view) {
  if (!view.up || !view.trip) return null;
  const { label, verdict, at } = view.trip;
  return [
    { text: "Shrike", dimColor: true },
    { text: `  ${label}  ` },
    { text: verdict, color: verdict === "broke" ? "error" : verdict === "slow" ? "warning" : "success" },
    ...(at ? [{ text: ` at ${at}`, dimColor: true }] : []),
  ];
}

/** What /shrike prints. */
export function summaryText(view) {
  if (!view.up) return `Shrike isn't connected. ${RECONNECT}`;
  if (!view.trip) return "Shrike is connected. No trips yet: click something in your app.";
  const { label, verdict, at, ms } = view.trip;
  return `Latest trip: ${label} ${verdict}${at ? ` at ${at}` : ""} (${ms}ms).`;
}

const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Why the opt-in guard refuses Claude's own edit to a project file while Shrike is connected, or undefined to let it run. */
export function guardReason({ enabled, up, tool, path, root }) {
  if (!enabled || !up || !EDITS.has(tool) || typeof path !== "string" || !root) return undefined;
  const inside = path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
  return inside ? "Shrike is connected and the user asked for code changes to go through it. Propose this change with the shrike propose_patch tool instead; the user applies it in Shrike with one click." : undefined;
}
