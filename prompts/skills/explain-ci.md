---
name: Explain a failing check
when: A check on the pull request failed and the user wants to know why in plain words
kind: git
---

# Explain a failing check

1. Read the failing lines Shrike pulled out of the check's log.
2. Find the first real error, not the last line that gave up.
3. Open the file and line it points to with read_file, and the test or step that failed.
4. Explain the cause in one or two plain sentences with report_findings, citing the file and line.
5. Only if the fix is clear and small, propose it with propose_patch. The user decides.
6. Say whether it might be flaky (a timeout or a network error) rather than a real bug.
