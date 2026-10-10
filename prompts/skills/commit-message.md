---
name: Write a commit message
when: Changes are staged (or about to be) and the user wants a commit message that says what changed and why
kind: git
---

# Write a commit message

You write the words. Shrike runs git itself, and only when the user presses Commit.

1. Read the files and the patch below. Describe only those. When nothing is staged, the list says so and the commit takes every change in it.
2. Subject: one plain line, 72 characters or fewer, in the imperative ("Fix: Add Todo saves userId as a number"). Name the behaviour that changed, not the file.
3. Leave a blank line, then a short body: what was wrong, why this change fixes it, and the trip or issue it came from when you know it.
4. No secrets, tokens or personal data from the patch, ever.
5. Answer with the message only, ready to paste: no lead-in, no code fences.
6. Only after the commit landed and the user kept the message, propose a skill update if you learned a rule of this repo (a prefix, a ticket format, a length limit).
