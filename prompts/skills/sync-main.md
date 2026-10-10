---
name: Sync with main
when: The branch is behind main and the user wants the newest changes before going on
kind: git
---

# Sync with main

1. Fetch main and show what's incoming first: the commits and the files they change.
2. A branch that's only on this machine is rebased on main. One already on GitHub is merged instead, so it never needs a force-push.
3. Uncommitted work is set aside first and put back afterwards.
4. If files conflict, hand off to Fix merge conflicts.
5. When it's done, re-run the saved flows so the user sees nothing broke.
