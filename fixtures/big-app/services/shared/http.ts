import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void> | void;

const port = (name: string, fallback: number) => Number(process.env[`${name}_PORT`] ?? fallback);
// Every service's address. Shrike sets <NAME>_PORT per worktree (W2), so two copies run side by side.
export const PORTS = {
  gateway: port("GATEWAY", 4400),
  auth: port("AUTH", 4401),
  catalog: port("CATALOG", 4402),
  search: port("SEARCH", 4403),
  cart: port("CART", 4404),
  orders: port("ORDERS", 4405),
  recommendations: port("RECOMMENDATIONS", 4406),
  notifications: port("NOTIFICATIONS", 4407),
  queue: port("QUEUE", 4408),
  stripe: port("STRIPE", 4498),
  email: port("EMAIL", 4499),
};
export const urlOf = Object.fromEntries(Object.entries(PORTS).map(([k, v]) => [k, `http://localhost:${v}`])) as Record<keyof typeof PORTS, string>;

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

// routes: { "GET /products/:id": handler }
export function serve(name: keyof typeof PORTS, routes: Record<string, Handler>): void {
  routes["GET /health"] ??= (_req, res) => send(res, 200, { ok: true });
  const table = Object.entries(routes).map(([key, handler]) => {
    const [method, path] = key.split(" ");
    return { method, re: new RegExp(`^${path!.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`), handler };
  });
  createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    try {
      for (const r of table) {
        const m = r.method === req.method ? r.re.exec(path) : null;
        if (m) return await r.handler(req, res, { ...m.groups });
      }
      send(res, 404, { error: "Not found" });
    } catch (err) {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: (err as Error).message });
    }
  }).listen(PORTS[name], () => console.log(`${name} ready on http://localhost:${PORTS[name]}`));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
