---
name: Auth
when: The app says not allowed, logs you out, or a request comes back 401 or 403
---

# Auth

Find out who the server thought you were, and why it said no.

1. With `get_action`, find the request that came back "not logged in (401)" or "not allowed (403)".
2. Open it with `get_event`. Check whether a session cookie or an authorization header was sent at all. Never copy or print the token itself.
3. If nothing was sent: look at how the page makes the request (`credentials`, the header it sets, the cookie path or domain).
4. If it was sent: read the server's check (`search_code` for the middleware or the function that returns 401/403) and see which condition failed.
5. Never type passwords or ask for them. If the user needs to log in, ask them to log in in the app pane, then re-run.
6. Propose the smallest change. Don't loosen a permission check unless the user clearly expects it to allow this.
