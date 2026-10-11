// A tiny stdio MCP server for tests (health check, e2e tools hub). Never installs anything.
// ECHO_MCP_HANG=1: never answers (timeout). ECHO_MCP_NOISE=1: prints a banner on stdout and never answers. ECHO_MCP_BAD_TOOLS=1: tools/list returns garbage. ECHO_MCP_CHILD=<file>: starts a grandchild and writes its pid there (no process left behind).
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

if (process.env.ECHO_MCP_CHILD) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(process.env.ECHO_MCP_CHILD, String(child.pid));
}
if (process.env.ECHO_MCP_NOISE) console.log("Starting echo server v1 ...");
if (process.env.ECHO_MCP_HANG || process.env.ECHO_MCP_NOISE) setInterval(() => {}, 1000);
else {
  const server = new Server({ name: "echo", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => (process.env.ECHO_MCP_BAD_TOOLS ? { tools: "nope" } : {
    tools: [
      { name: "echo", description: "Says back what you send", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      { name: "add", description: "Adds two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => ({ content: [{ type: "text", text: JSON.stringify(req.params.arguments ?? {}) }] }));
  await server.connect(new StdioServerTransport());
}
