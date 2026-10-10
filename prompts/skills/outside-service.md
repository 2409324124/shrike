---
name: Outside service
when: A call to another service (payments, email, an external API) fails, refuses, or is slow
---

# Outside service

The app asked another service for something and didn't get what it expected.

1. With `get_action`, find the call that left your app (the OUTSIDE lane). Note its status and time.
2. Open it with `get_event`. Read what was sent and what came back. The service's own error message usually says exactly what is wrong ("amount must be at least 50 cents").
3. Find the code that builds the request (file:line from the recording) and check the values against what the service asked for.
4. If the service was slow or down, say so plainly and check whether the app handles that (a timeout, a retry, a clear message to the user).
5. Don't send extra requests to the outside service yourself. Fix the values the app sends, then re-run the user's steps.
