import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson, send } from "../../../shared/http.ts";
import { placeOrder } from "../handlers/placeOrder.ts";

export async function createOrderRoute(req: IncomingMessage, res: ServerResponse) {
  const input = await readJson(req);
  send(res, 201, await placeOrder(input));
}
