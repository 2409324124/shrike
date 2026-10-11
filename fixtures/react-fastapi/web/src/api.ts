// Empty in dev: Vite proxies /api to FastAPI. Set VITE_API_URL to call the API directly (CORS).
const BASE = import.meta.env.VITE_API_URL ?? "";

export interface Product { id: number; name: string; price_cents: number }
export interface Cart { items: { product_id: number; name: string; qty: number; price_cents: number }[]; subtotal_cents: number }
export interface Order { id: number; total_cents: number }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail ?? `HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const listProducts = () => call<Product[]>("/api/products");
export const getCart = () => call<Cart>("/api/cart");
export const addToCart = (productId: number) => call<Cart>("/api/cart", { method: "POST", body: JSON.stringify({ product_id: productId, qty: 1 }) });
export const checkout = (email: string, promo: string) => call<Order>("/api/checkout", { method: "POST", body: JSON.stringify({ email, promo }) });
