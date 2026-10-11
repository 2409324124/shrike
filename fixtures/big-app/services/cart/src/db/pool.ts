import { PGlite } from "@electric-sql/pglite";

// The "carts" Postgres database, in memory and seeded on every start.
export const db = new PGlite("memory://carts");

await db.exec(`
  CREATE TABLE cart_lines (user_id INT NOT NULL, product_id INT NOT NULL, name TEXT NOT NULL, unit_cents INT NOT NULL, qty INT NOT NULL);
  INSERT INTO cart_lines VALUES (1, 1, 'Hand-thrown mug', 2499, 1), (1, 2, 'Linen apron', 3450, 1), (1, 3, 'Brass bottle opener', 1299, 2);
`);
