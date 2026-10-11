# The shop's SQLite data, shared by flask_app.py and django_app.py (main.py keeps its own copy).
import os
import sqlite3

DB = os.path.join(os.path.dirname(__file__), ".data", "shop.db")


def query(sql, args=()):
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    conn = sqlite3.connect(DB)
    try:
        rows = conn.execute(sql, args).fetchall()
        conn.commit()
        return rows
    finally:
        conn.close()


query("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT, price_cents INTEGER, pack_size INTEGER)")
if not query("SELECT COUNT(*) FROM items")[0][0]:
    for item in [(1, "Coffee beans", 1800, 2), (2, "Paper filters", 600, 100), (3, "Gift card", 2500, 0)]:
        query("INSERT OR IGNORE INTO items VALUES (?, ?, ?, ?)", item)


def unit_cents(price_cents, pack_size):
    # The planted bug: a gift card has pack_size 0.
    return price_cents / pack_size
