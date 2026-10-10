---
name: Address review comments
when: A pull request has open review conversations and the user wants the agent to fix what they ask for
kind: git
---

# Address review comments

Shrike gives you every open conversation on the pull request: its thread id, the file and line, and what each person said. Bots count too, but weigh them lower.

1. Read each conversation once, then open the file at that line with read_file.
2. Decide per conversation: the comment is right (fix it), it's a question (answer it), or it's wrong or out of scope (say why, kindly).
3. Fix what is right with propose_patch. One patch for several conversations is fine. The user approves it.
4. Never post to GitHub yourself. Shrike posts each reply only after the user says yes.
5. End your last message with one line per conversation, exactly: `REPLY <thread id>: <the reply>`. Keep each reply short and plain: what you changed, or the answer, or why not.
