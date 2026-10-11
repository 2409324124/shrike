import json

from django.http import JsonResponse
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST

from . import services
from .models import Account


@require_GET
def health(request):
    return JsonResponse({"ok": True})


@require_GET
@ensure_csrf_cookie
def csrf(request):
    return JsonResponse({"ok": True})


@require_GET
def username_available(request):
    name = request.GET.get("u", "").strip()
    return JsonResponse({"available": bool(name) and not Account.objects.filter(username=name).exists()})


@require_POST
def signup(request):
    body = json.loads(request.body)
    account = services.create_account(body["username"], body["email"], body["plan"])
    return JsonResponse({"id": account.id, "credits": account.credits}, status=201)
