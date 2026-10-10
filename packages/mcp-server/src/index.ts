import http from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { ShrikeHost } from "@shrike/schema";
import { registerTools } from "./tools.ts";
import { registerStartTools, type StartHost } from "./start.ts";

export { registerStartTools, type StartHost, type PlanArgs } from "./start.ts"; // R: start agent

export { optionsReplyText } from "./options.ts"; // M1
export { frontMatter, listSkills, OUTCOME, outcomeOf, readSkills, parseSkill, skillSteps, whenOf, type SkillDoc, type SkillHost } from "./skills.ts";
import type { SkillHost } from "./skills.ts";

// Shrike's own brains send this header so their reads don't show as "watched by" (A11).
export const INTERNAL_HEADER = "x-shrike-internal";

const MAX_BODY = 4 * 1024 * 1024;

export async function startMcpServer(host: ShrikeHost, opts: { skillsDir?: string; skills?: SkillHost; start?: StartHost } = {}): Promise<{ url: string; token: string; close(): Promise<void> }> {
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const authorized = (req: http.IncomingMessage) => {
    const got = Buffer.from(req.headers.authorization ?? "");
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (!authorized(req)) return send(res, 401, "Unauthorized");
      if (new URL(req.url ?? "/", "http://x").pathname !== "/mcp") return send(res, 404, "Not found");

      let body: unknown;
      if (req.method === "POST") {
        const raw = await readBody(req);
        if (raw === null) return send(res, 413, "Request too large");
        try {
          body = JSON.parse(raw);
        } catch {
          return rpcError(res, 400, -32700, "Parse error");
        }
      }

      const sid = req.headers["mcp-session-id"];
      if (typeof sid === "string") {
        const transport = sessions.get(sid);
        // 404 tells the client to start a new session (reconnect after a restart).
        if (!transport) return rpcError(res, 404, -32001, "Session not found");
        return await transport.handleRequest(req, res, body);
      }
      if (req.method !== "POST" || !isInitializeRequest(body)) {
        return rpcError(res, 400, -32000, "Bad Request: no valid session id");
      }

      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => void sessions.set(id, transport),
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      const mcp = new McpServer({ name: "shrike", version: "0.1.0" });
      const internal = req.headers[INTERNAL_HEADER] === "1";
      const info = (body as { params?: { clientInfo?: { name?: unknown } } }).params?.clientInfo;
      const client = internal ? undefined : String(info?.name || "An MCP client").replace(/[^\w .@-]/g, "").slice(0, 40) || "An MCP client";
      registerTools(mcp, host, { client, skillsDir: opts.skillsDir, skills: opts.skills });
      if (opts.start && internal) registerStartTools(mcp, opts.start); // only Shrike's own start agent
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) rpcError(res, 500, -32603, err instanceof Error ? err.message : "Internal error");
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    async close() {
      await Promise.allSettled([...sessions.values()].map((t) => t.close()));
      sessions.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function send(res: http.ServerResponse, status: number, text: string) {
  res.writeHead(status, { "content-type": "text/plain" }).end(text);
}

function rpcError(res: http.ServerResponse, status: number, code: number, message: string) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

async function readBody(req: http.IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
