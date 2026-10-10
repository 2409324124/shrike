---
name: Ship this fix
when: A fix is verified and the user wants it on GitHub as a pull request
kind: git
---

# Ship this fix

Shrike runs the git and gh steps itself, on the user's machine. Your part is the words.

1. Make sure the fix was verified: the re-run trip came back clean. If not, say so and stop.
2. Shrike makes a branch for the fix (never the user's main branch) and commits only the files the fix changed.
3. The commit message is the trip's verdict in one plain line ("Fix: Add Todo saves userId as a number"), then the issue card as the body.
4. Pushing and opening the pull request ask the user first, in plain words. Never force-push.
5. The pull request description is the issue card: what broke, the steps, the failing line, the fix and the clip.
6. After it opens, watch the checks (Explain a failing check) and offer Merge when green.
7. End with a skill: if shipping taught you something about this repo (a branch rule, a check that always needs a rerun, a reviewer's habit), call `propose_skill_update` on this playbook once with a one-line reason.
