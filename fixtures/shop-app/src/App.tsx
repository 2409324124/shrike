import { useEffect, useState } from "react";
import { getCart, listOrders, payNow, type Cart, type Order } from "./api.ts";

export function App() {
  const [cart, setCart] = useState<Cart | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  function refreshOrders() {
    listOrders().then(setOrders, () => setOrders([]));
  }

  useEffect(() => {
    getCart().then(setCart, () => setCart(null));
    refreshOrders();
  }, []);

  async function onPay() {
    if (!cart) return;
    setBusy(true);
    setMessage(null);
    try {
      const order = await payNow(cart.id);
      setMessage({ ok: true, text: `Paid. Order #${order.id} is on its way.` });
      refreshOrders();
    } catch {
      setMessage({ ok: false, text: "Payment failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Trailhead Shop</h1>
      <section aria-label="Your cart">
        <h2>Your cart</h2>
        {cart ? (
          <ul>
            {cart.items.map((item) => (
              <li key={item.name}>
                <span>{item.name}</span>
                <span>${item.price.toFixed(2)}</span>
              </li>
            ))}
            <li className="total">
              <span>Total</span>
              <span>${cart.total.toFixed(2)}</span>
            </li>
          </ul>
        ) : (
          <p>Loading your cart...</p>
        )}
        <button onClick={onPay} disabled={!cart || busy}>
          Pay now
        </button>
        {message && <p className={message.ok ? "ok" : "bad"} role="status">{message.text}</p>}
      </section>
      <section aria-label="Past orders">
        <h2>
          Past orders <button onClick={refreshOrders}>Refresh orders</button>
        </h2>
        <ul>
          {orders.map((o) => (
            <li key={o.id}>
              <span>
                #{o.id} · {o.status}
              </span>
              <span>${o.total.toFixed(2)}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
