# Standing orders: every REORDER_EVERY seconds, re-places each cafe's usual order. Like cron, with no web page.
# Under Shrike, run it with SHRIKE_CALLER=cron so its trips start in a CRON lane.
import json
import os
import time
import urllib.error
import urllib.request

API = os.environ.get("API_URL") or f"http://localhost:{os.environ.get('API_PORT', '4410')}"
EVERY = float(os.environ.get("REORDER_EVERY", "60"))
STANDING = [
    {"customer": "ana@corner.cafe", "lines": [{"sku": "BEANS", "qty": 3}], "coupon": "welcome10"},  # typed lowercase on the signup form
    {"customer": "raj@quay.cafe", "lines": [{"sku": "FILTERS", "qty": 4}]},
]


def place(order):
    req = urllib.request.Request(f"{API}/orders", json.dumps(order).encode(), {"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req) as res:
            print(order["customer"], res.status, json.load(res))
            return True
    except urllib.error.HTTPError as e:
        print(order["customer"], e.code, e.read().decode())
        return False


while True:
    failed = sum(not place(o) for o in STANDING)
    print(f"reorder: {failed} of {len(STANDING)} failed" if failed else "reorder: all placed", flush=True)
    time.sleep(EVERY)
