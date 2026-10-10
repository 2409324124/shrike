---
name: Merge when green
when: The pull request's checks passed and its flows re-ran green, and the user wants it merged
kind: git
---

# Merge when green

Shrike does this with gh, after the user says yes.

1. Every check on the pull request has passed. Pending or failed checks mean wait, or Explain a failing check.
2. The fix's saved flows re-ran green on this branch.
3. Shrike asks the user before merging, in plain words: which pull request, into which branch.
4. Merge with gh. Never force-push and never merge a red pull request.
5. Afterwards, offer Sync with main and Clean up for the fix's worktree.
