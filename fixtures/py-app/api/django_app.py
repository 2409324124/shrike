# The shop's API on Django in one file, port 8012, with the same planted bug as main.py (in shop.py).
import os
import sys

from django.conf import settings

settings.configure(DEBUG=False, SECRET_KEY="fixture-only", ROOT_URLCONF=__name__, ALLOWED_HOSTS=["*"], MIDDLEWARE=[f"{__name__}.cors"])

from django.http import JsonResponse  # noqa: E402
from django.urls import path  # noqa: E402

import shop  # noqa: E402


def cors(get_response):
    def middleware(request):
        response = get_response(request)
        response["Access-Control-Allow-Origin"] = "*"
        return response

    return middleware


def health(request):
    return JsonResponse({"ok": True})


def items(request):
    return JsonResponse([{"id": i, "name": n, "price_cents": p} for i, n, p in shop.query("SELECT id, name, price_cents FROM items")], safe=False)


def unit_price(request, item_id):
    name, price_cents, pack_size = shop.query("SELECT name, price_cents, pack_size FROM items WHERE id = ?", (item_id,))[0]
    return JsonResponse({"name": name, "unit_cents": shop.unit_cents(price_cents, pack_size)})


urlpatterns = [path("health", health), path("api/items", items), path("api/items/<int:item_id>/unit-price", unit_price)]

if __name__ == "__main__":
    from django.core.management import execute_from_command_line

    execute_from_command_line([sys.argv[0], "runserver", f"127.0.0.1:{os.environ.get('PORT', '8012')}", "--noreload"])
