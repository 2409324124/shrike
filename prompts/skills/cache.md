---
name: Cache
when: Data looks stale, a change doesn't show up, or the cache never seems to help
---

# Cache

Check what the cache was asked, what it answered, and when it was filled or cleared.

1. With `get_action`, find the cache steps (the CACHE lane): a quick bounce back is a hit, a pass-through to the database is a miss.
2. Stale data: find the write that changed the data and check whether it also clears or updates the cache key. Compare the key used to read with the key used to clear (`get_event` on both).
3. Never hits: compare the keys between two trips. A key that includes a timestamp, a random id, or the whole request usually never repeats.
4. Propose the smallest change: clear the right key after the write, or build the key from the fields that matter.
5. Re-run twice and check that the second run hits the cache, or that the change now shows up.
