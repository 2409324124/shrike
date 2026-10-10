---
name: Write pull request details
when: A branch is ready to become a pull request and needs a title and a description
kind: git
---

# Write pull request details

1. Title: one plain line that says what the change does for the user, 72 characters or fewer.
2. Description, in this order: what broke (or what's new), how to see it, what changed, how it was proved (the re-run trip, the flows that went green), and anything the reviewer should look at first.
3. Link the issue if there is one. Attach the clip if Shrike recorded one.
4. Keep it short. A reviewer should know in ten seconds whether to look closer.
5. Follow the repo's pull request template if it has one (`.github/pull_request_template.md`).
6. Only after the pull request opened and the user kept your words, propose a skill update if you learned how this repo likes its pull requests.
