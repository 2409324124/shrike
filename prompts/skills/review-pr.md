---
name: Review a pull request
when: The user picked a pull request and wants a code review before anyone merges it
kind: git
---

# Review a pull request

Review mode: read only. Don't change files, don't call propose_patch, and post nothing to GitHub.

1. Read the description, then the whole diff once, to know what the change is for.
2. Open the touched files with read_file where the diff alone doesn't show enough.
3. Look for real problems: bugs, missing error handling, security holes, and code that doesn't do what the description says.
4. If the app is running, try the changed flow with app_snapshot and app_click, and check its trip.
5. Report each real problem with report_findings: one plain sentence, the file and the line in the new version, and your confidence.
6. If it looks good, say so in the summary and report no findings. Skip style nits.
