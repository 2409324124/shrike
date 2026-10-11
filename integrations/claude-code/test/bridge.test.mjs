import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { DOWN, configPaths, readShrike, startBridge } from "../bridge/bridge.mjs";
import { startMcpServer } from "../../../packages/mcp-server/src/index.ts";

const BRIDGE = fileURLToPath(new URL("../bridge/bridge.mjs", import.meta.url));
const save = (file, url, token) => fs.writeFile(file, JSON.stringify({ mcpServers: { shrike: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } }), { mode: 0o600 });

test("finds Shrike's mcp.json: the override, the packaged and source userData folders, newest valid one wins", async () => {
  assert.deepEqual(configPaths({ SHRIKE_MCP_CONFIG: "/x/mcp.json" }), ["/x/mcp.json"]);
  assert.deepEqual(configPaths({}, "darwin", "/h"), ["/h/Library/Application Support/Shrike/mcp.json", "/h/Library/Application Support/@shrike/desktop/mcp.json"]);
  assert.deepEqual(configPaths({}, "linux", "/h"), ["/h/.config/Shrike/mcp.json", "/h/.config/@shrike/desktop/mcp.json"]);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shrike-bridge-"));
  const [a, b, bad, far] = ["a.json", "b.json", "bad.json", "far.json"].map((f) => path.join(dir, f));
  await save(a, "http://127.0.0.1:4100/mcp", "a".repeat(64));
  await save(b, "http://127.0.0.1:4200/mcp", "b".repeat(64));
  await fs.utimes(a, new Date(1000), new Date(1000));
  await fs.writeFile(bad, "{nope");
  await save(far, "http://10.0.0.5:4300/mcp", "c".repeat(64));
  assert.equal((await readShrike([a, b, bad, far, path.join(dir, "missing.json")]))?.url, "http://127.0.0.1:4200/mcp");
  assert.equal(await readShrike([bad, far]), undefined, "a broken file or a non-127.0.0.1 address is ignored");
  await fs.rm(dir, { recursive: true, force: true });
});

test("errors in plain words when Shrike isn't running", async () => {
  const out = await new Promise((resolve) => {
    const child = execFile(process.execPath, [BRIDGE], { env: { ...process.env, SHRIKE_MCP_CONFIG: path.join(os.tmpdir(), "no-shrike-here.json") } }, (_e, stdout) => resolve(stdout));
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "0" } } })}\n`);
  });
  assert.deepEqual(JSON.parse(out), { jsonrpc: "2.0", id: 1, error: { code: -32000, message: DOWN } });
});

test("bridges stdio to Shrike's server and picks up a new token, then says when Shrike is gone", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shrike-bridge-"));
  const file = path.join(dir, "mcp.json");
  const trip = { id: "t1", label: 'Clicked "Add Todo"', status: "error", durationMs: 12, startMs: 5, summary: { steps: [{ ok: false, text: "threw", eventId: "e", source: { file: "server/todos.ts", line: 18, precision: "exact" } }] } };
  const drive = { focusTrip() {}, listFlows: async () => [] };
  const server = await startMcpServer({ projectRoot: () => dir, listActions: () => [trip], getAction: () => trip, drive });
  await save(file, server.url, server.token);

  const input = new PassThrough();
  const waiting = new Map();
  const bridge = startBridge({ paths: [file], input, write: (m) => waiting.get(m.id)?.(m), log: () => {} });
  let id = 0;
  const ask = (method, params = {}) =>
    new Promise((resolve) => {
      waiting.set(++id, resolve);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const trips = async () => {
    const r = await ask("tools/call", { name: "list_trips", arguments: { limit: 1 } });
    return r.error?.message ?? r.result.content[0].text;
  };
  try {
    const init = await ask("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "0" } });
    assert.equal(init.result.serverInfo.name, "shrike");
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    assert.ok((await ask("tools/list")).result.tools.some((t) => t.name === "propose_patch"));
    assert.equal(await trips(), 't1  Clicked "Add Todo"  broke  12ms  at server/todos.ts:18');

    await save(file, server.url, await server.rotateToken()); // New token: the old session is closed
    assert.match(await trips(), /^t1 .* at server\/todos\.ts:18$/, "reopens with the token Shrike saved");

    await server.close();
    assert.equal(await trips(), DOWN);
  } finally {
    bridge.close();
    await server.close().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  }
});
