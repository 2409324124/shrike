import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShrikeHost } from "@shrike/schema";
import { startMcpServer } from "@shrike/mcp-server";
import { addCommand, configCommand, denySettings, readSaved, saveConfig } from "./connect.ts";

const host = {} as ShrikeHost; // nothing connects, so no tool runs

test("connect: the saved port and token come back after a restart; a taken port falls back and the file is rewritten", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "shrike-connect-")), "mcp.json");
  assert.equal(await readSaved(file), undefined);

  const first = await startMcpServer(host);
  await saveConfig(file, first.url, first.token);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  await first.close();

  const saved = await readSaved(file);
  assert.equal(saved?.token, first.token);
  const again = await startMcpServer(host, saved);
  assert.equal(again.url, first.url);

  const other = await startMcpServer(host, await readSaved(file)); // the port is taken by `again`
  assert.notEqual(other.url, again.url);
  chmodSync(file, 0o644);
  await saveConfig(file, other.url, other.token);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal((await readSaved(file))?.port, Number(new URL(other.url).port));
  assert.equal((await readSaved(file))?.token, first.token);
  await other.close();
  await again.close();

  writeFileSync(file, JSON.stringify({ mcpServers: { shrike: { url: "http://evil.example:80/mcp", headers: { Authorization: `Bearer ${"a".repeat(64)}` } } } }));
  assert.equal(await readSaved(file), undefined, "only a 127.0.0.1 address is reused");
  writeFileSync(file, "{ broken");
  assert.equal(await readSaved(file), undefined);
});

test("connect: the copy-paste command, the --mcp-config form and the settings snippet", () => {
  const t = "f".repeat(64);
  assert.equal(addCommand("http://127.0.0.1:4100/mcp", t), `claude mcp add --transport http --scope user shrike http://127.0.0.1:4100/mcp --header "Authorization: Bearer ${t}"`);
  assert.equal(configCommand("/Users/a b/Library/Application Support/Shrike/mcp.json"), "claude --mcp-config '/Users/a b/Library/Application Support/Shrike/mcp.json'");
  assert.equal(configCommand("/x/it's/mcp.json"), `claude --mcp-config '/x/it'\\''s/mcp.json'`);
  assert.deepEqual(JSON.parse(denySettings()), { permissions: { deny: ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"] } });
});
