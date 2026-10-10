---
name: Fix a failed commit
when: git commit was refused, usually by a pre-commit hook, a linter or a formatter
kind: git
---

# Fix a failed commit

1. Read the hook's output and find the first real error, not the summary line.
2. Say in one plain sentence what refused the commit and why.
3. If a formatter or linter can fix it by itself, say which command (the repo's own script, like `pnpm lint --fix`), and let Shrike ask the user before running it.
4. If code must change, propose the smallest fix with propose_patch. Never skip the hook (`--no-verify`) unless the user asks for that in plain words.
5. Then commit again with the same message.
6. Only after the commit went through, propose a skill update with what this repo's hooks check.
