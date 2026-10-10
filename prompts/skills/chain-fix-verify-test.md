---
name: "Fix, verify, then write tests"
when: "You want the next step to run only when this one worked"
kind: chain
version: 1
---

# Fix, verify, then write tests

1. Take the run going now (or the last one).
2. Check the fix was verified.
3. It worked: The fix is verified. Write tests that would have caught this bug, run them, and keep them only if they pass.
4. If it failed: The fix wasn't verified. Look at the re-run, say plainly what still breaks, and try a different fix.

```json
{
  "prompt": "",
  "check": "verified",
  "rubric": "It does what was asked, works, and reads cleanly.",
  "threshold": 8,
  "loop": false,
  "maxRounds": 1,
  "budget": {
    "tokens": 400000,
    "minutes": 30
  },
  "pass": "The fix is verified. Write tests that would have caught this bug, run them, and keep them only if they pass.",
  "failed": "The fix wasn't verified. Look at the re-run, say plainly what still breaks, and try a different fix."
}
```
