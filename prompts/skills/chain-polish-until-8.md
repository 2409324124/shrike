---
name: "Build, critique, polish until 8/10"
when: "You want it scored and improved until it reaches 8/10"
kind: chain
version: 1
---

# Build, critique, polish until 8/10

1. Take the run going now (or the last one).
2. A critique scores it from 0 to 10 against: It does everything the ask says, works when you try it, handles empty and error states, and the code reads cleanly.
3. Under 8: Improve it using the critique below. Fix the biggest gap first and keep what already works. Then score again (up to 3 rounds).
4. Then stop.

```json
{
  "prompt": "",
  "check": "critique",
  "rubric": "It does everything the ask says, works when you try it, handles empty and error states, and the code reads cleanly.",
  "threshold": 8,
  "below": "Improve it using the critique below. Fix the biggest gap first and keep what already works.",
  "loop": true,
  "maxRounds": 3,
  "budget": {
    "tokens": 400000,
    "minutes": 30
  }
}
```
