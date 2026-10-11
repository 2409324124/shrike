import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import orders
from db import connect

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("CORS_ORIGINS", "http://localhost:4510").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


class AddItem(BaseModel):
    product_id: int
    qty: int = 1


class Checkout(BaseModel):
    email: str
    promo: str = ""


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/products")
def products():
    with connect() as conn:
        rows = conn.execute("SELECT id, name, price_cents FROM products ORDER BY id").fetchall()
    return [{"id": i, "name": n, "price_cents": c} for i, n, c in rows]


@app.get("/api/cart")
def cart():
    with connect() as conn:
        return orders.cart_view(conn)


@app.post("/api/cart")
def add(body: AddItem):
    return orders.add_item(body.product_id, body.qty)


@app.post("/api/checkout")
def checkout(body: Checkout):
    return orders.place_order(body.email, body.promo)
