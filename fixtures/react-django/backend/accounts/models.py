from django.db import models


class Account(models.Model):
    username = models.CharField(max_length=40, unique=True)
    email = models.EmailField()
    plan = models.CharField(max_length=20)
    credits = models.IntegerField()
