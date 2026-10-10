---
name: Name a branch
when: A fix or a feature needs its own branch before anything is committed
kind: git
---

# Name a branch

1. Use the repo's own pattern if its branches show one (`fix/`, `feat/`, a ticket id first). Look at the recent branch names.
2. Else `fix/<what-broke>` for a fix and `feat/<what-it-adds>` for anything new: lowercase, words joined with `-`, 40 characters or fewer.
3. Never the base branch, and never a name that already exists.
4. Answer with the name only.
5. Only after the branch was made and kept, propose a skill update if you learned this repo's naming rule.
