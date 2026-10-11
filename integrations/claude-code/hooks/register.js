// Shrike's mod: the latest trip in a line above the prompt, /shrike for the same in text, and an opt-in nudge
// toward propose_patch. Read-only: it only calls list_trips, through the plugin's own Shrike connection.
import { SERVER, bandParts, guardReason, parseTrip, resultText, sameView, summaryText } from "./trips.js";

const POLL_MS = 4000;
let view = { up: false, trip: null };

async function poll($) {
  let next;
  try {
    const r = await $.mcp.call(SERVER, "list_trips", { limit: 1 });
    next = r.isError ? { up: false, trip: view.trip } : { up: true, trip: parseTrip(resultText(r)) };
  } catch {
    next = { up: false, trip: view.trip };
  }
  // Redraw only when something the band shows changed, so it never flickers.
  if (!sameView(view, next)) {
    view = next;
    $.ui.invalidate("ui.render");
  }
}

export function register(on, options) {
  on("session.start", async ($, e, next) => {
    $.clock.every(POLL_MS, () => poll($));
    await $.command.register({ name: "shrike", description: "Show the latest Shrike trip", immediate: true });
    return next(e);
  });

  on("command.run", { command: "shrike" }, async ($) => {
    await poll($);
    return { text: summaryText(view) };
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const parts = bandParts(view);
    if (!parts) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const theirs = await next(e);
    const line = Text({ wrap: "truncate-end", children: parts.map(({ text, ...style }) => Text({ ...style, children: [text] })) });
    return Box({ flexDirection: "column", children: theirs ? [line, theirs] : [line] });
  });

  on("tool.call", { tool: ["Edit", "Write", "MultiEdit", "NotebookEdit"] }, async ($, e, next) => {
    if (!options?.edits_through_shrike) return next(e);
    const deny = guardReason({ enabled: true, up: view.up, tool: e.tool, path: e.file_path ?? e.notebook_path, root: await $.session.root() });
    return deny ? { deny } : next(e);
  });
}
