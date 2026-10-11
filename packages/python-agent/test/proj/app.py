# The "user's app" test_agent.py runs: one ASGI request that works, one that divides by zero, one WSGI request.
import asyncio
import io
import json
import os
import sqlite3
import sys
import time

from flask.app import Flask
from starlette.applications import Starlette

import vendored  # lives in .venv/lib/site-packages: never recorded

DB = sqlite3.connect(os.path.join(os.path.dirname(__file__), "shop.db"))
DB.execute("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT, price INTEGER, qty INTEGER)")
DB.execute("DELETE FROM items")
DB.executemany("INSERT INTO items VALUES (?, ?, ?, ?)", [(1, "Coffee", 1800, 2), (3, "Gift card", 2500, 0)])


def load(item_id, opts):
    cur = DB.cursor()
    cur.execute("SELECT name, price, qty FROM items WHERE id = ?", (item_id,))
    name, price, qty = cur.fetchone()
    return {"name": name, "price": price, "qty": qty, "api_key": "sk-live-123"}


def unit_price(item, password):
    return vendored.half(item["price"] * 2) / item["qty"]


async def rate(n):
    await asyncio.sleep(0)
    return n * 2


def plain(fn):
    return fn


@plain
async def handler(scope):
    item_id = int(scope["path"].split("/")[3])
    item = load(item_id, {"token": "abc", "full": True})
    a, b = await asyncio.gather(rate(1), rate(2))
    return json.dumps({"unit": unit_price(item, "hunter2"), "rates": [a, b]}).encode()


def echo(body):
    return body.upper()


async def call(app, path, headers=()):
    sent = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(msg):
        sent.append(msg)

    scope = {"type": "http", "method": "GET", "path": path, "raw_path": path.encode(), "query_string": b"full=1", "headers": [(b"host", b"localhost:8010"), *headers], "server": ("127.0.0.1", 8010)}
    try:
        await app(scope, receive, send)
    except ZeroDivisionError:
        pass
    return sent


t0 = time.perf_counter()
load(1, {})  # outside a request: not recorded
asgi = Starlette(handler)
asyncio.run(call(asgi, "/api/items/1/unit-price", [(b"user-agent", b"curl/8.4.0")]))
asyncio.run(call(asgi, "/api/items/3/unit-price", [(b"traceparent", b"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")]))

wsgi = Flask(echo)
environ = {"REQUEST_METHOD": "POST", "PATH_INFO": "/echo", "QUERY_STRING": "", "SERVER_PORT": "8010", "HTTP_HOST": "localhost:8010", "CONTENT_TYPE": "text/plain", "wsgi.input": io.BytesIO(b"hi there")}
result = wsgi.wsgi_app(environ, lambda status, headers: None)
print(b"".join(result).decode(), file=sys.stderr)
getattr(result, "close", lambda: None)()
getattr(wsgi.wsgi_app({**environ, "PATH_INFO": "/echo-into", "wsgi.input": io.BytesIO(b"hi there")}, lambda status, headers: None), "close", lambda: None)()
print(f"requests_ms={(time.perf_counter() - t0) * 1000:.0f}")
