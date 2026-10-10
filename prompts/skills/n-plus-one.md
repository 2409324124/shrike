---
name: N+1 hunter
when: A page or request is slow and the trip shows the same database query or request repeated many times
---

# N+1 hunter

One request turned into many identical queries or calls, usually one per item in a list.

1. With `get_action`, find the repeated step (the trip draws it as a coil with ×N). Note the count and the total time it took.
2. Open one of the repeats with `get_event` to see the query and its parameters. Find the loop that issues it: the function and file:line that called it.
3. Confirm the count matches the number of items on the page (`app_snapshot` or the response body).
4. Propose the smallest change that fetches everything in one go: a single query with `IN (...)` or a join, or one batched request. Keep the result shape the same so nothing else changes.
5. Re-run with `run_scenario` and compare with `compare_actions`. Say how many queries and how many milliseconds it took before and after.
