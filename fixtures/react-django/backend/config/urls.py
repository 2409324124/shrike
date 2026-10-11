from django.urls import path

from accounts import views

urlpatterns = [
    path("api/health", views.health),
    path("api/csrf", views.csrf),
    path("api/username", views.username_available),
    path("api/signup", views.signup),
]
