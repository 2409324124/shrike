import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ActionView, Flow, ProjectInfo, ShrikeDriver, ShrikeHost } from "@shrike/schema";
import { INTERNAL_HEADER, startMcpServer } from "../src/index.ts";

const DRIVE = ["open_project", "run_app", "stop_app", "list_trips", "focus_trip", "list_flows", "record_flow", "run_flow", "open_file", "ask_agent"];

test("B5: outside clients can drive Shrike; Shrike's own brain never sees these tools", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shrike-drive-"));
  await fs.writeFile(path.join(root, "app.ts"), "x");
  const did: string[] = [];
  const flows: Flow[] = [{ id: "add-a-todo", name: "Add a todo", steps: [{ type: "click", name: "Add Todo" }], lastRun: { at: 1, ok: false, actionIds: ["t1"] } }];
  const trip = { id: "t1", label: 'Clicked "Add Todo"', status: "error", durationMs: 12, startMs: 5, summary: { steps: [{ ok: true, text: "POST /api/todos", eventId: "e1" }, { ok: false, text: "createTodo threw", eventId: "e2", source: { file: "server/todos.controller.ts", line: 18, precision: "exact" } }] } } as unknown as ActionView;
  const drive: ShrikeDriver = {
    openProject: async (r) => (did.push(`open ${r}`), { root: r, name: "todo-app", frontend: "vite-react", backend: "express", routes: [{ method: "GET", path: "/" }] } as ProjectInfo),
    run: async () => (did.push("run"), { state: "running", url: "http://localhost:5173" }),
    stop: async () => (did.push("stop"), { state: "stopped" }),
    focusTrip: (id) => void did.push(`focus ${id}`),
    openFile: (p, line) => void did.push(`file ${p}:${line}`),
    listFlows: async () => flows,
    startFlowRecording: async () => void did.push("record"),
    stopFlowRecording: async (name) => (did.push(`save ${name}`), { id: "checkout", name, steps: [{ type: "click", name: "Pay" }] }),
    runFlow: async (id) => (did.push(`replay ${id}`), { ok: true, actionIds: ["t2", "t3"] }),
    askAgent: async (goal) => (did.push(`ask ${goal}`), { runId: "r1", status: "done", summary: "userId was undefined." }),
  };
  const host = { projectRoot: () => root, listActions: () => [trip], getAction: (id: string) => (id === "t1" ? trip : undefined), drive } as unknown as ShrikeHost;
  const server = await startMcpServer(host);
  const connect = async (internal: boolean) => {
    const c = new Client({ name: internal ? "shrike" : "Claude Code", version: "0" });
    const headers: Record<string, string> = { Authorization: `Bearer ${server.token}`, ...(internal ? { [INTERNAL_HEADER]: "1" } : {}) };
    await c.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }));
    return c;
  };
  const inside = await connect(true);
  const outside = await connect(false);
  try {
    const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);
    assert.deepEqual((await names(inside)).filter((n) => DRIVE.includes(n)), [], "never offered to the in-app brain");
    assert.deepEqual((await names(outside)).filter((n) => DRIVE.includes(n)).sort(), [...DRIVE].sort());

    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await outside.callTool({ name, arguments: args });
      return { text: (r.content as { text: string }[]).map((c) => c.text).join("\n"), isError: r.isError === true };
    };
    assert.match((await call("open_project", { path: root })).text, /Opened todo-app .*vite-react.*1 routes/);
    assert.equal((await call("open_project", { path: "relative/dir" })).isError, true);
    assert.match((await call("run_app")).text, /running at http:\/\/localhost:5173/);
    assert.match((await call("list_trips")).text, /^t1 {2}Clicked "Add Todo" {2}broke {2}12ms {2}at server\/todos\.controller\.ts:18$/);
    assert.match((await call("focus_trip", { tripId: "t1" })).text, /Showing/);
    assert.equal((await call("focus_trip", { tripId: "nope" })).isError, true);
    assert.match((await call("list_flows")).text, /add-a-todo {2}"Add a todo" {2}1 steps {2}last run failed/);
    assert.match((await call("record_flow", { action: "start" })).text, /Recording/);
    assert.match((await call("record_flow", { action: "stop", name: "Checkout" })).text, /Saved checkout/);
    assert.match((await call("run_flow", { flow: "add a todo" })).text, /^Flow "Add a todo" passed\. Trips: t2, t3$/);
    assert.match((await call("run_flow", { flow: "missing" })).text, /Saved flows: add-a-todo/);
    assert.match((await call("open_file", { path: "app.ts", line: 3 })).text, /app\.ts:3/);
    assert.equal((await call("open_file", { path: "../../etc/passwd" })).isError, true);
    assert.match((await call("ask_agent", { goal: "why did it break?" })).text, /r1 done\.\nuserId was undefined/);
    assert.match((await call("stop_app")).text, /stopped/);
    assert.deepEqual(did, [`open ${root}`, "run", "focus t1", "record", "save Checkout", "replay add-a-todo", "file app.ts:3", "ask why did it break?", "stop"]);
  } finally {
    await inside.close();
    await outside.close();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
