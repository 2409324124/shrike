# The shop's API on Flask (WSGI), port 8011, with the same planted bug as main.py (in shop.py).
import os

from flask import Flask, jsonify

import shop

app = Flask(__name__)


@app.after_request
def cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    return resp


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/api/items")
def items():
    return jsonify([{"id": i, "name": n, "price_cents": p} for i, n, p in shop.query("SELECT id, name, price_cents FROM items")])


@app.get("/api/items/<int:item_id>/unit-price")
def unit_price(item_id):
    name, price_cents, pack_size = shop.query("SELECT name, price_cents, pack_size FROM items WHERE id = ?", (item_id,))[0]
    return {"name": name, "unit_cents": shop.unit_cents(price_cents, pack_size)}


if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", "8011")))
