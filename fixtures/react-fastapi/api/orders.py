from db import connect

PROMOS = {"SAVE10": 10, "HALF": 50}


def cart_lines(conn):
    return conn.execute(
        "SELECT p.id, p.name, c.qty, p.price_cents FROM cart_items c JOIN products p ON p.id = c.product_id ORDER BY p.id"
    ).fetchall()


def cart_view(conn):
    items = [{"product_id": i, "name": n, "qty": q, "price_cents": c} for i, n, q, c in cart_lines(conn)]
    return {"items": items, "subtotal_cents": sum(i["qty"] * i["price_cents"] for i in items)}


def add_item(product_id: int, qty: int):
    with connect() as conn:
        conn.execute(
            "INSERT INTO cart_items (product_id, qty) VALUES (?, ?) ON CONFLICT(product_id) DO UPDATE SET qty = qty + excluded.qty",
            (product_id, qty),
        )
        return cart_view(conn)


def discount_cents(subtotal_cents: int, promo: str) -> int:
    percent = PROMOS.get(promo.strip().upper(), 0)
    return subtotal_cents * percent


def place_order(email: str, promo: str):
    with connect() as conn:
        subtotal = cart_view(conn)["subtotal_cents"]
        total = subtotal - discount_cents(subtotal, promo)
        cur = conn.execute("INSERT INTO orders (email, total_cents) VALUES (?, ?)", (email, total))
        conn.execute("DELETE FROM cart_items")
        return {"id": cur.lastrowid, "total_cents": total}
