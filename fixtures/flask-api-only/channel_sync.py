# Channel sync: every SYNC_EVERY seconds, copies bookings made on a travel site into the API. Like cron, with no web page.
# Under Shrike, run it with SHRIKE_CALLER=cron so its trips start in a CRON lane.
import json
import os
import time
import urllib.error
import urllib.request

API = os.environ.get("API_URL") or f"http://localhost:{os.environ.get('API_PORT', '4411')}"
EVERY = float(os.environ.get("SYNC_EVERY", "60"))
FEED = [{"room": "Oak", "night": "2026-10-21", "guest": "kai@example.com"}]


def push(booking):
    req = urllib.request.Request(f"{API}/api/bookings", json.dumps(booking).encode(), {"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req) as res:
            print(booking["guest"], res.status, json.load(res))
            return True
    except urllib.error.HTTPError as e:
        print(booking["guest"], e.code, e.read().decode())
        return e.code == 409  # taken is fine: the travel site gets told


while True:
    failed = sum(not push(b) for b in FEED)
    print(f"channel sync: {failed} of {len(FEED)} failed" if failed else "channel sync: all good", flush=True)
    time.sleep(EVERY)
