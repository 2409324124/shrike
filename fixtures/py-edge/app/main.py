import asyncio
import os
import time

import httpx
from fastapi import BackgroundTasks, FastAPI
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from sqlalchemy import String, create_engine, func, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql+psycopg://edge:edge@localhost:4622/edge")
RATES_URL = os.environ.get("RATES_URL", "http://localhost:4621")
PAGE = os.path.join(os.path.dirname(__file__), "index.html")


class Base(DeclarativeBase):
    pass


class Order(Base):
    __tablename__ = "orders"
    id: Mapped[int] = mapped_column(primary_key=True)
    item: Mapped[str] = mapped_column(String(50))
    cents: Mapped[int]
    currency: Mapped[str] = mapped_column(String(3))
    receipt_sent: Mapped[bool] = mapped_column(default=False)


if DATABASE_URL.startswith("sqlite:///"):
    os.makedirs(os.path.dirname(DATABASE_URL[len("sqlite:///"):]) or ".", exist_ok=True)
engine = create_engine(DATABASE_URL)
for attempt in range(30):  # Postgres in Docker may still be starting
    try:
        Base.metadata.create_all(engine)
        break
    except Exception:
        if attempt == 29:
            raise
        time.sleep(1)

app = FastAPI()


class NewOrder(BaseModel):
    item: str
    cents: int
    currency: str = "USD"


def usd_rate(currency):
    if currency == "USD":
        return 1
    res = httpx.get(f"{RATES_URL}/rates", params={"base": "USD"}, timeout=5)
    res.raise_for_status()
    return res.json()[currency]


def convert(cents, rate):
    return round(cents * rate)


def send_receipt(order_id):
    httpx.post(f"{RATES_URL}/receipts", json={"order": order_id}, timeout=5)
    with Session(engine) as s:
        s.get(Order, order_id).receipt_sent = True
        s.commit()


@app.get("/", response_class=HTMLResponse)
def page():
    with open(PAGE) as f:
        return f.read()


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/api/orders")
def create_order(body: NewOrder, background_tasks: BackgroundTasks):
    cents = convert(body.cents, usd_rate(body.currency))
    with Session(engine) as s:
        order = Order(item=body.item, cents=cents, currency=body.currency)
        s.add(order)
        s.commit()
        order_id = order.id
    background_tasks.add_task(send_receipt, order_id)
    return {"id": order_id, "cents": cents, "currency": body.currency}


async def fetch_rates(client, base):
    res = await client.get(f"{RATES_URL}/rates", params={"base": base})
    return res.json()


def count_orders():
    with Session(engine) as s:
        return s.scalar(select(func.count()).select_from(Order))


@app.get("/api/dashboard")
async def dashboard():
    async with httpx.AsyncClient(timeout=5) as client:
        usd, gbp, orders = await asyncio.gather(fetch_rates(client, "USD"), fetch_rates(client, "GBP"), asyncio.to_thread(count_orders))
    return {"orders": orders, "usd": usd, "gbp": gbp}
