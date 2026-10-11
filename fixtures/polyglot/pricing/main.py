import os
import sqlite3

from fastapi import FastAPI, HTTPException

DB = os.path.join(os.path.dirname(__file__), ".data", "pricing.db")
TAX_RATES = {"standard": 0.2, "zero": 0.0}

app = FastAPI()


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


query("CREATE TABLE IF NOT EXISTS items (sku TEXT PRIMARY KEY, cents INTEGER, tax_class TEXT)")
if not query("SELECT COUNT(*) FROM items")[0][0]:
    # The planted bug: books moved to a "reduced" tax class that TAX_RATES never got.
    for item in [("tea", 450, "standard"), ("book", 1200, "reduced")]:
        query("INSERT INTO items (sku, cents, tax_class) VALUES (?, ?, ?)", item)


def with_tax(cents, tax_class):
    return round(cents * (1 + TAX_RATES[tax_class]))


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/price/{sku}")
def price(sku: str, qty: int = 1):
    rows = query("SELECT cents, tax_class FROM items WHERE sku = ?", (sku,))
    if not rows:
        raise HTTPException(404, f"No item {sku}")
    cents, tax_class = rows[0]
    return {"sku": sku, "qty": qty, "cents": with_tax(cents * qty, tax_class)}
