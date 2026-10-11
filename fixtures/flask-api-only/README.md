# fixtures/flask-api-only

A Python backend with no web page: a small Flask room-bookings API on SQLite (`.data/bookings.db`, reseeded on every start: Oak is confirmed on 2026-10-20 and held for a guest on 2026-10-21). Shrike shows no page for it; send requests from the API explorer or curl. `fixtures/py-api-only` is the same idea on FastAPI.

| Route | What it does |
|---|---|
| `POST /api/bookings` `{ room, night, guest }` | Books a room for a night. A taken night answers 409 with a plain message. |
| `GET /api/rooms/<room>/free?night=` | Is the room free that night? |
| `GET /api/bookings` | All bookings. |
| `GET /health` | Readiness check. |

`channel_sync.py` is a cron-style job: every `SYNC_EVERY` seconds (default 60) it copies bookings made on a travel site into the API. Under Shrike, add it in Setup as a second process, `SHRIKE_CALLER=cron .venv/bin/python channel_sync.py`, so its trips start in a CRON lane.

## Install

Python 3.12 or newer:

```sh
cd fixtures/flask-api-only
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Then open `fixtures/flask-api-only` in Shrike and press Run. It runs `.venv/bin/python app.py` on port 4411 (the port follows `PORT`).

## Planted bug

`is_free()` only counts confirmed bookings (`app.py:33`, `status = 'confirmed'`), but the table's unique index covers held ones too. So for Oak on 2026-10-21 the check says free, the insert (`app.py:38`) hits `UNIQUE constraint failed: bookings.room, bookings.night`, `book()` swallows it and returns `None`, and the API answers 500 "Couldn't save the booking." instead of the promised 409.

```
curl -X POST localhost:4411/api/bookings -H 'content-type: application/json' \
  -d '{"room":"Oak","night":"2026-10-21","guest":"kai@example.com"}'   # 500, should be 409
```

The trip shows `is_free(room='Oak', night='2026-10-21')` returning `True`, then `book()` returning `None` with the refused `INSERT` in the SQLITE lane. Fix: count every booking in `is_free()` (drop the status filter), or answer 409 when the insert is refused.

## Automated checks

When `.venv` exists: `apps/desktop/e2e/py-api-only.test.ts` and `packages/scanner/test/scanner.test.ts`. The e2e skips otherwise.
