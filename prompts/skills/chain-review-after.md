---
name: "After it finishes, review the diff"
when: "You want the next step to run only when this one worked"
kind: chain
version: 1
---

# After it finishes, review the diff

1. Take the run going now (or the last one).
2. Check the run worked.
3. It worked: Review the diff you just made as a careful reviewer would: bugs, missed cases, security. Fix only real problems and say what you changed.

```json
{
  "prompt": "",
  "check": "succeeded",
  "rubric": "It does what was asked, works, and reads cleanly.",
  "threshold": 8,
  "loop": false,
  "maxRounds": 1,
  "budget": {
    "tokens": 300000,
    "minutes": 20
  },
  "pass": "Review the diff you just made as a careful reviewer would: bugs, missed cases, security. Fix only real problems and say what you changed."
}
```
