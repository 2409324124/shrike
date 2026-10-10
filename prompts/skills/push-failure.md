---
name: Fix a failed push
when: git push was refused: the branch is behind, protected, or the login or a hook failed
kind: git
---

# Fix a failed push

1. Read what git said and sort it into one of these: behind the remote, protected branch, no access or not logged in, a pre-push hook, or the network.
2. Behind: hand off to Sync with main, then push again. Never force-push.
3. Protected branch: push to a new branch instead (Name a branch) and open a pull request.
4. No access or not logged in: tell the user the one command to run (`gh auth login`), in plain words.
5. A pre-push hook: treat it like Fix a failed commit.
6. Only after the push went through, propose a skill update with what this repo needed.
