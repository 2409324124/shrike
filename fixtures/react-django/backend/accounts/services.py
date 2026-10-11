from .models import Account

PLAN_CREDITS = {"free": 100, "pro": 1000}


def starting_credits(plan: str):
    return PLAN_CREDITS.get(plan.strip())


def create_account(username: str, email: str, plan: str) -> Account:
    credits = starting_credits(plan)
    return Account.objects.create(username=username, email=email, plan=plan, credits=credits)
