import type { IncomingMessage, ServerResponse } from "node:http";
import { send } from "../../../shared/http.ts";
import { fetchCart } from "../clients/cart.ts";
import { quoteItems } from "../clients/catalog.ts";
import { submitOrder } from "../clients/orders.ts";
import { recommendFor } from "../clients/recommendations.ts";
import { relatedSearches } from "../clients/search.ts";
import { buildCheckout } from "../domain/checkout.ts";
import { confirmationView } from "../domain/confirmation.ts";
import { requireSession } from "../middleware/session.ts";

export async function placeOrderRoute(req: IncomingMessage, res: ServerResponse) {
  const session = await requireSession(req, res);
  if (!session) return;
  const cart = await fetchCart(session.userId);
  if (!cart) return send(res, 409, { error: "Your cart is empty." });

  const ids: number[] = [];
  const names: string[] = [];
  for (const l of cart.lines) ids.push(l.productId), names.push(l.name);
  const [quote, related, recommended] = await Promise.all([quoteItems(ids), relatedSearches(names), recommendFor(session.userId)]);

  const checkout = buildCheckout(session, cart, quote);
  const placed = await submitOrder(checkout);
  if (!placed.ok) return send(res, 502, { error: "We couldn't place your order.", reason: placed.error });
  send(res, 201, confirmationView(placed.order, recommended, related));
}
