import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson, send } from "../../../shared/http.ts";
import { onOrderPlaced } from "../handlers/orderPlaced.ts";

export async function orderPlacedRoute(req: IncomingMessage, res: ServerResponse) {
  const event = await readJson(req);
  send(res, 200, await onOrderPlaced(event as { orderId: number; email: string; totalCents: number; items: number }));
}
