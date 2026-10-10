---
name: Review lessons
when: Before you change code or open a pull request in this repo: what reviewers keep flagging in your pull requests, and how to fix it before they do
version: 1
scope: project
---

# Review lessons

This repo has no lessons yet. Shrike learns them from your pull requests' review threads (the Lessons tab in the right dock). Once it has, this project's own `review-lessons` skill replaces this one, with a section per repeat issue and per reviewer.

1. Before you write code, read every lesson: how to spot it and how to fix it. Write the code so none of them come up.
2. Before a pull request opens, call `self_review`. It gives you the lessons the likely reviewers care about and the files this branch changes.
3. Check the diff against each lesson. Fix what you find with `propose_patch`, smallest change first.
4. Call `self_review` again with one result per lesson: found or not, fixed or not, and where.
5. Follow each reviewer's conventions too (how they want names, tests, comments and PR descriptions).

## How Shrike clusters

Shrike's read-only brain call reads this section. You place review comments into lessons; Shrike counts everything else.

- A lesson is a kind of issue reviewers flag again and again, not one comment. Group comments that would be fixed by the same habit ("Missing loading state", "Raw SQL in a migration without a reason", "Unbounded query with no limit").
- Keep the ids of existing lessons and add new comments to them by id. Make a new lesson only for two or more alike comments, or for a comment marked LEARN (it always gets a lesson, alone if need be).
- Title: 3 to 7 plain words naming the issue. Spot it: one sentence on how to see it in a diff. Fix it: 1 to 5 short steps someone who doesn't read code fluently can follow; when a comment says which commit fixed it, take the steps from that patch.
- A lesson marked NOT WORKING YET was flagged again after its fix was written: rewrite its fix steps so they would have caught the new comment.
- Leave out comments that don't fit any lesson. Skip praise, questions that were only answered and bot noise (deploy previews, coverage numbers).
- For each reviewer listed, 1 to 3 conventions they enforce, in plain words ("Numbers each finding W01 or N01 with a severity dot; W blocks, N doesn't", "Asks why for every migration"), and one line on how they review.
- Answer with one JSON block and nothing after it:

```json
{"lessons":[{"id":"missing-loading-state","title":"Missing loading state","spot":"A fetch without a pending state","fix":["Show a spinner while it loads"],"comments":["c1","c4"]}],"reviewers":[{"login":"ana","style":["Asks for a test with every fix"],"habit":"Blocks on correctness, nits on naming"}]}
```
