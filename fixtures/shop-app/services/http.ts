import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

export function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) text += chunk;
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

export function bearer(req: IncomingMessage): string {
  return /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
}

// routes: { "GET /api/orders": handler }
export function serve(name: string, port: number, routes: Record<string, Handler>): void {
  routes["GET /health"] ??= (_req, res) => send(res, 200, { ok: true });
  createServer(async function route(req, res) {
    const handler = routes[`${req.method} ${(req.url ?? "/").split("?")[0]}`];
    try {
      if (handler) await handler(req, res);
      else send(res, 404, { error: "Not found" });
    } catch (err) {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: (err as Error).message });
    }
  }).listen(port, function onListen() {
    console.log(`${name} ready on http://localhost:${port}`);
  });
}
