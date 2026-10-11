import os
import sqlite3

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

DB = os.path.join(os.path.dirname(__file__), ".data", "shop.db")

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# Through a cursor: OpenTelemetry's sqlite3 instrumentation traces cursors, not Connection.execute.
def query(sql, args=()):
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    conn = sqlite3.connect(DB)
    try:
        cur = conn.cursor()
        cur.execute(sql, args)
        rows = cur.fetchall()
        conn.commit()
        return rows
    finally:
        conn.close()


query("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT, price_cents INTEGER, pack_size INTEGER)")
if not query("SELECT COUNT(*) FROM items")[0][0]:
    for item in [("Coffee beans", 1800, 2), ("Paper filters", 600, 100), ("Gift card", 2500, 0)]:
        query("INSERT INTO items (name, price_cents, pack_size) VALUES (?, ?, ?)", item)


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/api/items")
def items():
    return [{"id": i, "name": n, "price_cents": p} for i, n, p in query("SELECT id, name, price_cents FROM items")]


@app.get("/api/items/{item_id}/unit-price")
def unit_price(item_id: int):
    name, price_cents, pack_size = query("SELECT name, price_cents, pack_size FROM items WHERE id = ?", (item_id,))[0]
    # The planted bug: a gift card has pack_size 0, so this divides by zero and the API answers 500.
    return {"name": name, "unit_cents": price_cents / pack_size}
