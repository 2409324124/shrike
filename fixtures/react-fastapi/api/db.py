import sqlite3
from pathlib import Path

DB = Path(__file__).parent / ".data" / "shop.db"


def connect() -> sqlite3.Connection:
    DB.parent.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price_cents INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS cart_items (product_id INTEGER PRIMARY KEY, qty INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS orders (
          id INTEGER PRIMARY KEY, email TEXT NOT NULL,
          total_cents INTEGER NOT NULL CHECK (total_cents >= 0)
        );
        INSERT OR IGNORE INTO products VALUES (1, 'Coffee beans', 1800), (2, 'Mug', 1200);
        """
    )
    return conn
