import type { IncomingMessage, ServerResponse } from "node:http";
import { send } from "../../../shared/http.ts";
import { getCart } from "../handlers/getCart.ts";

export async function getCartRoute(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>) {
  const cart = await getCart(Number(params.userId));
  send(res, cart.lines.length ? 200 : 404, cart.lines.length ? cart : { error: "Your cart is empty." });
}
