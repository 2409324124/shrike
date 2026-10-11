import os
import sqlite3

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

DB = os.path.join(os.path.dirname(__file__), ".data", "orders.db")

app = FastAPI()


def query(sql, args=()):
    conn = sqlite3.connect(DB)
    try:
        rows = conn.execute(sql, args).fetchall()
        conn.commit()
        return rows
    finally:
        conn.close()


def seed():
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    query("DROP TABLE IF EXISTS products")
    query("DROP TABLE IF EXISTS coupons")
    query("DROP TABLE IF EXISTS orders")
    query("CREATE TABLE products (sku TEXT PRIMARY KEY, name TEXT, price_cents INTEGER)")
    query("CREATE TABLE coupons (code TEXT PRIMARY KEY, percent INTEGER)")
    query("CREATE TABLE orders (id INTEGER PRIMARY KEY, customer TEXT, total_cents INTEGER)")
    for p in [("MUG", "Enamel mug", 1200), ("BEANS", "Coffee beans 1kg", 2400), ("FILTERS", "Paper filters", 450)]:
        query("INSERT INTO products VALUES (?, ?, ?)", p)
    query("INSERT INTO coupons VALUES ('WELCOME10', 10)")


seed()


class Line(BaseModel):
    sku: str
    qty: int


class OrderIn(BaseModel):
    customer: str
    lines: list[Line]
    coupon: str | None = None


def price_of(sku):
    rows = query("SELECT price_cents FROM products WHERE sku = ?", (sku,))
    if not rows:
        raise HTTPException(404, f"No product {sku}")
    return rows[0][0]


def coupon_percent(code):
    rows = query("SELECT percent FROM coupons WHERE code = ?", (code,))
    return rows[0][0] if rows else None


def order_total(lines, coupon):
    subtotal = sum(price_of(line.sku) * line.qty for line in lines)
    if not coupon:
        return subtotal
    percent = coupon_percent(coupon)
    return subtotal - subtotal * percent // 100


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/products")
def products():
    return [{"sku": s, "name": n, "price_cents": p} for s, n, p in query("SELECT sku, name, price_cents FROM products")]


@app.post("/orders")
def create_order(order: OrderIn):
    total = order_total(order.lines, order.coupon)
    (order_id,) = query("INSERT INTO orders (customer, total_cents) VALUES (?, ?) RETURNING id", (order.customer, total))[0]
    return {"id": order_id, "customer": order.customer, "total_cents": total}


@app.get("/orders/{order_id}")
def get_order(order_id: int):
    rows = query("SELECT id, customer, total_cents FROM orders WHERE id = ?", (order_id,))
    if not rows:
        raise HTTPException(404, "No such order")
    return dict(zip(("id", "customer", "total_cents"), rows[0]))
