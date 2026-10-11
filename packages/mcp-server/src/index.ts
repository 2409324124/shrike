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

export interface McpServerOptions {
  skillsDir?: string;
  skills?: SkillHost;
  start?: StartHost;
  port?: number; // tried first; taken, a random one
  token?: string;
  onClient?(name: string): void; // an outside client connected or made a call
}

export interface RunningMcpServer {
  url: string;
  readonly token: string; // what outside clients use
  readonly internalToken: string; // Shrike's own brains: never rotated, so a token reset doesn't cut off a live run
  movedFrom?: number; // the asked-for port was taken
  rotateToken(): Promise<string>; // a fresh token; every session an outside client opened is closed
  close(): Promise<void>;
}

export const newToken = (): string => randomBytes(32).toString("hex");

export async function startMcpServer(host: ShrikeHost, opts: McpServerOptions = {}): Promise<RunningMcpServer> {
  let token = opts.token ?? newToken();
  let expected = Buffer.from(`Bearer ${token}`);
  const internalToken = newToken();
  const internalExpected = Buffer.from(`Bearer ${internalToken}`);
  const outside = new Set<string>(); // session ids opened with the outside token
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const clientOf = new Map<string, string>(); // session id -> outside client name

  const matches = (got: Buffer, want: Buffer) => got.length === want.length && timingSafeEqual(got, want);
  const authorized = (req: http.IncomingMessage): "outside" | "internal" | undefined => {
    const got = Buffer.from(req.headers.authorization ?? "");
    return matches(got, internalExpected) ? "internal" : matches(got, expected) ? "outside" : undefined;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const auth = authorized(req);
      if (!auth) return send(res, 401, "Unauthorized");
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
        const name = clientOf.get(sid);
        if (name) opts.onClient?.(name);
        return await transport.handleRequest(req, res, body);
      }
      if (req.method !== "POST" || !isInitializeRequest(body)) {
        return rpcError(res, 400, -32000, "Bad Request: no valid session id");
      }

      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
          if (auth === "outside") outside.add(id);
          if (client) clientOf.set(id, client);
        },
      });
      transport.onclose = () => {
        if (!transport.sessionId) return;
        sessions.delete(transport.sessionId);
        clientOf.delete(transport.sessionId);
        outside.delete(transport.sessionId);
      };
      const mcp = new McpServer({ name: "shrike", version: "0.1.0" });
      const internal = req.headers[INTERNAL_HEADER] === "1";
      const info = (body as { params?: { clientInfo?: { name?: unknown } } }).params?.clientInfo;
      const client = internal ? undefined : String(info?.name || "An MCP client").replace(/[^\w .@-]/g, "").slice(0, 40) || "An MCP client";
      if (client) opts.onClient?.(client);
      registerTools(mcp, host, { client, skillsDir: opts.skillsDir, skills: opts.skills });
      if (opts.start && internal) registerStartTools(mcp, opts.start); // only Shrike's own start agent
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) rpcError(res, 500, -32603, err instanceof Error ? err.message : "Internal error");
      else res.end();
    }
  });

  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => (server.off("error", reject), resolve()));
    });
  await (opts.port ? listen(opts.port).catch(() => listen(0)) : listen(0));
  const { port } = server.address() as AddressInfo;
  const closeSessions = async (only?: Set<string>) => {
    const ids = [...(only ?? sessions.keys())];
    await Promise.allSettled(ids.map((id) => sessions.get(id)?.close()));
    for (const id of ids) (sessions.delete(id), clientOf.delete(id), outside.delete(id));
  };

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    get token() {
      return token;
    },
    internalToken,
    ...(opts.port && opts.port !== port ? { movedFrom: opts.port } : {}),
    async rotateToken() {
      token = newToken();
      expected = Buffer.from(`Bearer ${token}`);
      await closeSessions(new Set(outside));
      return token;
    },
    async close() {
      await closeSessions();
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
