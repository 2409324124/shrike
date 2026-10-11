# A request that writes through psycopg (test/libs' stand-in): the import hook patches it as it loads.
import asyncio

import psycopg
from starlette.applications import Starlette

DB = psycopg.connect(host="127.0.0.1", port=5432, dbname="shop")
DB.execute("INSERT INTO users (name, password) VALUES (%s, %s)", ("boot", "x"))  # outside a request: not recorded


def add_user(name):
    row = DB.execute("INSERT INTO users (name, password) VALUES (%s, %s) RETURNING id, name", (name, "hunter2")).fetchone()
    return row


async def handler(scope):
    return repr(add_user("ada")).encode()


async def main():
    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(msg):
        if msg["type"] == "http.response.body":
            print(msg["body"].decode())

    scope = {"type": "http", "method": "POST", "path": "/users", "raw_path": b"/users", "query_string": b"", "headers": [(b"host", b"localhost:8010")], "server": ("127.0.0.1", 8010)}
    await Starlette(handler)(scope, receive, send)


asyncio.run(main())
