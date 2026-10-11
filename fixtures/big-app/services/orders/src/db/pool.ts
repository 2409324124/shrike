import { PGlite } from "@electric-sql/pglite";

// The "orders" Postgres database, in memory and seeded on every start.
export const db = new PGlite("memory://orders");

await db.exec(`
  CREATE TABLE orders (id SERIAL PRIMARY KEY, user_id INT NOT NULL, total_cents INT NOT NULL, payment_id TEXT NOT NULL, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE order_lines (order_id INT NOT NULL REFERENCES orders(id), product_id INT NOT NULL, name TEXT NOT NULL, unit_cents INT NOT NULL, qty INT NOT NULL);
  ALTER SEQUENCE orders_id_seq RESTART WITH 1041;
`);
