import { PGlite } from "@electric-sql/pglite";

// The "catalog" Postgres database, in memory and seeded on every start.
export const db = new PGlite("memory://catalog");

await db.exec(`
  CREATE TABLE products (id SERIAL PRIMARY KEY, name TEXT NOT NULL, maker TEXT NOT NULL, category TEXT NOT NULL, price_cents INT NOT NULL, featured BOOLEAN NOT NULL DEFAULT false);
  CREATE TABLE promotions (id SERIAL PRIMARY KEY, category TEXT NOT NULL, percent_off INT NOT NULL, ends_at TIMESTAMPTZ NOT NULL);
  INSERT INTO products (name, maker, category, price_cents, featured) VALUES
    ('Hand-thrown mug', 'Kiln & Co', 'kitchen', 2499, true),
    ('Linen apron', 'Field Linen', 'kitchen', 3450, true),
    ('Brass bottle opener', 'Ostrander Metal', 'bar', 1299, true),
    ('Walnut serving board', 'Northwood', 'kitchen', 5800, true),
    ('Beeswax candles, pair', 'Hive Works', 'home', 1850, true),
    ('Wool throw', 'Highland Mill', 'home', 12900, true),
    ('Stoneware bowl set', 'Kiln & Co', 'kitchen', 6400, true),
    ('Copper jigger', 'Ostrander Metal', 'bar', 2200, true),
    ('Indigo napkins, set of 4', 'Field Linen', 'kitchen', 2800, false),
    ('Ceramic planter', 'Terra Studio', 'garden', 3900, false),
    ('Hand-bound notebook', 'Paper Hollow', 'stationery', 1600, false),
    ('Cast iron skillet', 'Forge Ten', 'kitchen', 7400, false),
    ('Rattan tray', 'Weavers Row', 'home', 4200, false),
    ('Olive wood spoons', 'Northwood', 'kitchen', 1900, false),
    ('Glass carafe', 'Clearwater', 'bar', 3100, false),
    ('Leather key ring', 'Saddle Lane', 'accessories', 1400, false),
    ('Pressed flower print', 'Paper Hollow', 'home', 2600, false),
    ('Herb scissors', 'Forge Ten', 'garden', 2100, false),
    ('Tea towel, striped', 'Field Linen', 'kitchen', 1500, false),
    ('Soy candle, cedar', 'Hive Works', 'home', 2400, false),
    ('Enamel pitcher', 'Clearwater', 'kitchen', 3600, false),
    ('Brass candle snuffer', 'Ostrander Metal', 'home', 1700, false),
    ('Terracotta herb pots, 3', 'Terra Studio', 'garden', 2900, false),
    ('Merino socks', 'Highland Mill', 'accessories', 2200, false);
  INSERT INTO promotions (category, percent_off, ends_at) VALUES ('garden', 10, now() + interval '7 days');
`);
