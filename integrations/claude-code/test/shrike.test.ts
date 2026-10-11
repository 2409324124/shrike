import { expect, mock, test } from "claude-code/testing";

// Run with `claude plugin test` from integrations/claude-code. Shrike's MCP server is stubbed.
const BAND = {
  plugin: "shrike",
  component: "AbovePrompt",
  requestId: "band",
  viewport: { columns: 120, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const;
const text = (t: string) => ({ value: { content: [{ type: "text", text: t }], isError: false } });
const start = async ($: any, on: any) => {
  on("session.start", () => ({ cwd: "/work" }));
  on("command.register", () => ({ value: undefined }));
  on("ui.render", () => ({ type: "Text", props: {}, children: ["drawn by Claude Code"] }));
};

test("/shrike and the band show the latest trip, and follow a new one", async ($, on) => {
  const clock = mock.clock(on);
  let reply = 'abc  Clicked "Add Todo"  broke  12ms  at server/todos.ts:18';
  on("mcp.call", ($, e) => (e.server === "plugin:shrike:shrike" && e.tool === "list_trips" ? text(reply) : { deny: "unexpected" }));
  await start($, on);
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });

  expect((await $.command.run({ command: "shrike", args: "" })).text).toBe('Latest trip: Clicked "Add Todo" broke at server/todos.ts:18 (12ms).');
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: "broke" })).toBeDefined();
  expect(await ui.find({ type: "Text", text: " at server/todos.ts:18" })).toBeDefined();
  await ui.unmount();

  reply = 'def  Clicked "Add Todo"  worked  9ms';
  await clock.advance(4000);
  const again = await $.ui.mount({ ...BAND, surface: "desktop" });
  expect(await again.find({ type: "Text", text: "worked" })).toBeDefined();
});

test("says how to connect when Shrike isn't running, and draws nothing", async ($, on) => {
  on("mcp.call", () => ({ deny: "MCP server plugin:shrike:shrike is not connected" }));
  await start($, on);
  expect((await $.command.run({ command: "shrike", args: "" })).text).toMatch(/^Shrike isn't connected\. Open Shrike/);
  const ui = await $.ui.mount({ ...BAND, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: "drawn by Claude Code" })).toBeDefined();
});

test("Claude's own edits pass through unless the user opted in", async ($, on) => {
  on("mcp.call", () => text("No trips yet."));
  on("session.root", () => ({ value: "/work" }));
  on("tool.call", () => ({ result: "edited" }));
  await start($, on);
  await $.command.run({ command: "shrike", args: "" });
  expect(await $.tool.call({ tool: "Edit", file_path: "/work/src/a.ts", old_string: "a", new_string: "b" })).toEqual({ result: "edited" });
});
