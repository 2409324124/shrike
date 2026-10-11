import type { IncomingMessage, ServerResponse } from "node:http";
import { send } from "../../../shared/http.ts";
import { fetchCart } from "../clients/cart.ts";
import { listCatalog } from "../clients/catalog.ts";
import { requireSession } from "../middleware/session.ts";

export async function listProductsRoute(_req: IncomingMessage, res: ServerResponse) {
  send(res, 200, await listCatalog());
}

export async function getCartRoute(req: IncomingMessage, res: ServerResponse) {
  const session = await requireSession(req, res);
  if (!session) return;
  const cart = await fetchCart(session.userId);
  send(res, cart ? 200 : 404, cart ?? { error: "Your cart is empty." });
}
