# Python's harder shapes, one request each, through the stand-in Starlette. test_semantics.py reads what was recorded.
import asyncio
import concurrent.futures
import functools

from starlette.applications import Starlette


class Cart:
    def __init__(self, items):
        self.items = items

    def total(self):
        return sum(self.items) + Cart.tax(sum(self.items))

    @staticmethod
    def tax(amount):
        return amount // 10

    @classmethod
    def empty(cls):
        return cls([])

    @property
    def count(self):
        return len(self.items)


def logged(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        return fn(*args, **kwargs)

    return wrapper


@logged
def discounted(price, pct):
    return price - price * pct // 100


def dive(n):
    return n if n == 0 else dive(n - 1)


def tiny(i):
    return i + 1


def risky():
    raise ValueError("bad input")


def safe():
    try:
        risky()
    except ValueError:
        return "handled"


def rethrow():
    try:
        risky()
    except ValueError:
        raise


def note(x):
    return x


def numbers(n):
    for i in range(n):
        yield i


def total_of(n):
    total = 0
    for x in numbers(n):
        total += note(x)
    return total


def first_of(n):
    gen = numbers(n)
    first = next(gen)
    gen.close()
    return first


async def ticks(n):
    for i in range(n):
        await asyncio.sleep(0)
        yield i


def work(n):
    return n * 10


class Loud:
    def __repr__(self):
        raise RuntimeError("no repr for you")


class Chatty:
    def __repr__(self):
        return f"Chatty({note(1)})"


def big(numbers, blob, cyclic, loud, chatty, text):
    return len(numbers)


def login(username, password, api_key=None, headers=None, token=None):
    return {"user": username, "session": "s3cr3t"}


async def handler(scope):
    which = scope["path"].strip("/")
    if which == "classes":
        cart = Cart([100, 200])
        return [cart.total(), cart.count, Cart.empty().count, discounted(200, 10)]
    if which == "recursion":
        return dive(100)
    if which == "hot":
        return sum(tiny(i) for i in range(3000))
    if which == "errors":
        safe()
        rethrow()
    if which == "generators":
        out = [total_of(3), first_of(5)]
        async for t in ticks(2):
            out.append(note(t))
        return out
    if which == "threads":
        a = await asyncio.to_thread(work, 2)
        with concurrent.futures.ThreadPoolExecutor() as pool:
            b = pool.submit(work, 3).result()
        return [a, b]
    if which == "values":
        cyclic = [1]
        cyclic.append(cyclic)
        return big(list(range(100_000)), b"x" * 1_000_000, cyclic, Loud(), Chatty(), "y" * 50_000)
    if which == "secrets":
        return login("ada", "hunter2", api_key="sk-1", headers={"Authorization": "Bearer abc", "accept": "*/*"}, token="t0k")
    if which == "orm":
        from django import orm

        return orm.query(orm.get_new_connection(":memory:"), "SELECT %s", ("ada",))
    if which.startswith("concurrent"):
        await asyncio.sleep(0)
        return work(int(which[-1]))


app = Starlette(handler)


async def call(path):
    async def receive():
        return {"type": "http.request", "body": b""}

    async def send(msg):
        pass

    scope = {"type": "http", "method": "GET", "path": path, "headers": [(b"host", b"localhost:8010")], "server": ("127.0.0.1", 8010)}
    try:
        await app(scope, receive, send)
    except Exception:
        pass


async def main():
    for path in ["/classes", "/recursion", "/hot", "/errors", "/generators", "/threads", "/values", "/secrets", "/orm"]:
        await call(path)
    await asyncio.gather(call("/concurrent1"), call("/concurrent2"))


asyncio.run(main())
