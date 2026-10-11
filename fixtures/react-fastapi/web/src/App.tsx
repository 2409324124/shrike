import { useEffect, useState, type FormEvent } from "react";
import { addToCart, checkout, getCart, listProducts, type Cart, type Product } from "./api";

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<Cart>({ items: [], subtotal_cents: 0 });
  const [email, setEmail] = useState("");
  const [promo, setPromo] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    listProducts().then(setProducts).catch(() => setMessage("Couldn't load the shop"));
    getCart().then(setCart).catch(() => {});
  }, []);

  async function onAdd(id: number) {
    try {
      setCart(await addToCart(id));
    } catch {
      setMessage("Couldn't add that");
    }
  }

  async function onCheckout(e: FormEvent) {
    e.preventDefault();
    try {
      const order = await checkout(email, promo);
      setMessage(`Order ${order.id} placed: ${money(order.total_cents)}`);
    } catch (err) {
      setMessage(`Checkout failed: ${(err as Error).message}`);
    }
  }

  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 480, margin: "2rem auto" }}>
      <h1>Corner Shop</h1>
      <ul>
        {products.map((p) => (
          <li key={p.id}>
            {p.name} {money(p.price_cents)}{" "}
            <button type="button" onClick={() => onAdd(p.id)}>
              Add {p.name}
            </button>
          </li>
        ))}
      </ul>
      <h2>Cart</h2>
      <p>
        {cart.items.length} items, {money(cart.subtotal_cents)}
      </p>
      <form onSubmit={onCheckout}>
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input placeholder="Promo code" value={promo} onChange={(e) => setPromo(e.target.value)} />
        <button type="submit">Place order</button>
      </form>
      {message && <p role="status">{message}</p>}
    </main>
  );
}
