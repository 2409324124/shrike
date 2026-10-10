---
name: Critique
when: A prompt chain asks for a score of the run that just ended, from 0 to 10 against a rubric
version: 1
---

# Critique

Read only. Don't change files and don't propose patches. You score; the chain decides what happens next.

1. Read the ask first: the score is about whether the run did what was asked, not what you would have built.
2. Read the diff and the answer. Open a touched file with read_file only when the diff doesn't show enough.
3. Check it against the rubric line by line. A missing piece of the ask costs more than style.
4. If the app is running and the change shows on screen, look with app_snapshot before you score.
5. Score honestly: 10 means nothing left to fix, 8 means good enough to ship, 5 means it works but has a clear gap, under 3 means it doesn't do the ask.
6. End with exactly two lines: `SCORE: <number>/10` and `WHY: <the one biggest gap, in plain words>`. The next round reads WHY, so make it something it can act on.
