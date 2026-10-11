import os
import sqlite3

from flask import Flask, jsonify, request

DB = os.path.join(os.path.dirname(__file__), ".data", "bookings.db")

app = Flask(__name__)


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
    query("DROP TABLE IF EXISTS bookings")
    query("CREATE TABLE bookings (id INTEGER PRIMARY KEY, room TEXT, night TEXT, guest TEXT, status TEXT DEFAULT 'held', UNIQUE (room, night))")
    query("INSERT INTO bookings (room, night, guest, status) VALUES ('Oak', '2026-10-20', 'mia@example.com', 'confirmed')")
    query("INSERT INTO bookings (room, night, guest) VALUES ('Oak', '2026-10-21', 'leo@example.com')")


seed()


def is_free(room, night):
    return not query("SELECT 1 FROM bookings WHERE room = ? AND night = ? AND status = 'confirmed'", (room, night))


def book(room, night, guest):
    try:
        (booking_id,) = query("INSERT INTO bookings (room, night, guest) VALUES (?, ?, ?) RETURNING id", (room, night, guest))[0]
    except sqlite3.IntegrityError:
        return None
    return booking_id


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/api/rooms/<room>/free")
def room_free(room):
    return {"room": room, "night": request.args.get("night"), "free": is_free(room, request.args.get("night"))}


@app.post("/api/bookings")
def create_booking():
    body = request.get_json()
    room, night, guest = body["room"], body["night"], body["guest"]
    if not is_free(room, night):
        return jsonify(error=f"{room} is taken on {night}. Try another night."), 409
    booking_id = book(room, night, guest)
    if booking_id is None:
        return jsonify(error="Couldn't save the booking."), 500
    return jsonify(id=booking_id, room=room, night=night, guest=guest), 201


@app.get("/api/bookings")
def bookings():
    return jsonify([dict(zip(("id", "room", "night", "guest", "status"), r)) for r in query("SELECT id, room, night, guest, status FROM bookings")])


if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", 4411)))
