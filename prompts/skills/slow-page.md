---
name: Slow page
when: A click or page load works but takes too long
---

# Slow page

Find where the time went before changing anything.

1. With `get_action`, read the timings. Find the single step that took most of the total.
2. Check the usual causes in this order:
   - the same query or request repeated (switch to the N+1 hunter playbook with `load_skill`),
   - requests that wait for each other but don't need to (they could run at the same time),
   - one slow query (open it with `get_event`; look for a missing filter or a scan of a big table),
   - a slow outside service,
   - a deliberate delay or timer left in the code (`search_code` for `setTimeout`, `sleep`, `delay`).
3. Report the step and its share of the time in plain words ("the server spent 820ms of the 900ms waiting for the database").
4. Propose the smallest fix for that one step only. Re-run and compare the timing.
