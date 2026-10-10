import type { IncomingMessage, ServerResponse } from "node:http";
import { bearer, readJson, send, serve } from "../http.ts";
import { trackEvent } from "./analytics.ts";
import { chargeCard, verifyToken } from "./clients.ts";
import { createOrder, loadCart } from "./db.ts";
import { forgetOrders, listOrders } from "./orders.ts";

async function signedIn(req: IncomingMessage, res: ServerResponse) {
  const user = await verifyToken(bearer(req));
  if (!user) send(res, 401, { error: "Please sign in again." });
  return user;
}

async function getCart(req: IncomingMessage, res: ServerResponse) {
  const user = await signedIn(req, res);
  if (!user) return;
  const cart = await loadCart("cart-1", user.userId);
  send(res, cart ? 200 : 404, cart ?? { error: "Your cart is empty." });
}

async function getOrders(req: IncomingMessage, res: ServerResponse) {
  const user = await signedIn(req, res);
  if (user) send(res, 200, await listOrders(user.userId));
}

async function checkout(req: IncomingMessage, res: ServerResponse) {
  const user = await signedIn(req, res);
  if (!user) return;
  const { cartId } = await readJson(req);
  const cart = await loadCart(String(cartId), user.userId);
  if (!cart) return send(res, 404, { error: "Your cart is empty." });
  const [payment] = await Promise.all([
    chargeCard({ amount: cart.total, currency: "usd", customer: user.userId }),
    trackEvent("checkout_started", { cartId: cart.id, total: cart.total }),
  ]);
  if (!payment.ok) {
    console.warn("payment refused:", payment.error);
    return send(res, 402, { error: "Payment failed", reason: payment.error });
  }
  const order = await createOrder(user.userId, cart.total * 100);
  forgetOrders(user.userId);
  send(res, 201, order);
}

serve("api", Number(process.env.API_PORT ?? 4100), { "GET /api/cart": getCart, "GET /api/orders": getOrders, "POST /api/checkout": checkout });
