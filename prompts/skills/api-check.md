---
name: API check
when: A bug shows up in a request to the app's own backend (a wrong status, a wrong body, a 500), or a fix needs proof that an API call works now
---

# API check

Reproduce the bug with one request, make the request as small as it can be, then prove the fix with an assertion that stays in the project.

1. Find the request that went wrong. With `get_action` on the broken trip, note the method, the path and the status. Open the request with `get_event` to read the exact body and headers the app sent.
2. Reproduce it with `send_request`, copying that method, path, headers and body. A value shown as `[redacted:...]` was hidden by Shrike: leave that header out, or use the project's `{{variable}}` for it. Never guess a secret. Confirm you get the same status and the same error in the trip.
3. Make the request smaller. Remove one body field or header at a time and send again. Keep only what is needed to trigger the bug. Say which field matters, for example "the server reads `user`, the page sends `userId`".
4. Say what the server expects. Point at the handler's file:line that reads the request (the trip shows where), and state the cause in one sentence.
5. Fix it with `propose_patch`, the smallest change. After the user applies it, send the same request again with `assertions` that describe the right answer, for example `res.status eq 201` and `res.body.title eq "buy milk"`. Then send the original failing request once more to show it works now.
6. Keep the proof. When the assertions pass, call `save_request` with the reproducing request, its assertions and a short name ("Create todo with title"), so the project's collection gains a check that runs again with its flows. Save one request per bug, not every try.

Done when: the reproducing request answers the right status with its assertions passing, and it is saved in the project's collection.
