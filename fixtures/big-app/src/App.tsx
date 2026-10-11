import { useEffect, useState } from "react";
import { dollars, getCart, listProducts, placeOrder, type Cart, type Confirmation, type Product } from "./api.ts";

export function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<Cart | null>(null);
  const [done, setDone] = useState<Confirmation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listProducts().then(setProducts, () => setProducts([]));
    getCart().then(setCart, () => setCart(null));
  }, []);

  async function onPlaceOrder() {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setDone(await placeOrder());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header>
        <h1>Bazaar</h1>
        <span>Handmade goods from independent makers</span>
      </header>
      <main>
        <section aria-label="Featured" className="grid">
          {products.map((p) => (
            <article key={p.id}>
              <div className={`swatch ${p.category}`} aria-hidden />
              <b>{p.name}</b>
              <small>{p.maker}</small>
              <span>{dollars(p.priceCents)}</span>
            </article>
          ))}
        </section>
        <aside aria-label="Your cart">
          <h2>Your cart</h2>
          {cart ? (
            <ul>
              {cart.lines.map((l) => (
                <li key={l.productId}>
                  <span>
                    {l.name} {l.qty > 1 && <small>×{l.qty}</small>}
                  </span>
                  <span>{dollars(l.totalCents)}</span>
                </li>
              ))}
              <li className="sub"><span>Subtotal</span><span>{dollars(cart.subtotalCents)}</span></li>
              <li className="sub"><span>Tax</span><span>{dollars(cart.taxCents)}</span></li>
              <li className="sub"><span>Shipping</span><span>{dollars(cart.shippingCents)}</span></li>
              <li className="total"><span>Total</span><span>{dollars(cart.totalCents)}</span></li>
            </ul>
          ) : (
            <p>Loading your cart...</p>
          )}
          <button onClick={onPlaceOrder} disabled={!cart || busy}>
            {busy ? "Placing order..." : "Place order"}
          </button>
          {error && <p className="bad" role="status">{error}</p>}
          {done && (
            <div role="status" className="ok">
              <p>Order #{done.orderId} placed. A confirmation email is on its way.</p>
              {done.recommended.length > 0 && <p><small>You might also like: {done.recommended.map((p) => p.name).join(", ")}</small></p>}
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}
