---
name: CI lessons (recipe)
purpose: How Claude writes and rewrites a project's .shrike/skills/ci-lessons.md. Not on the skill shelf itself (no "when"); the project's own file is the skill that evolves.
---

# Writing a project's CI lessons

Shrike read the project's CI config and its recent runs and gives you a draft built from them (the pipeline map), the project's run skill if it has one, the current lessons file if there is one, and, sometimes, one new lesson: a failing CI log, or a difference between what pre-flight saw here and what CI then reported. Return the whole new file body. Plain words, no em dashes.

The rule the owner lives by: green here means green in CI. Run only the jobs the change touches.

1. Keep the draft's sections in order: `## Run each job like CI`, `## When CI fails`, `## Watch out`, `## Lessons`, `## Legs`. One `###` per job under the first, named as CI names it.
2. For each job, say when it runs (which folders), the Node version and env CI uses, the services it needs, then the exact commands in order. Use the commands CI runs; change one only when this computer needs it (the run skill says so, for example `nix develop -c` or a heap size), and say why in one line.
3. A command that changes git, downloads a tool, or needs a secret stays out of the legs. Say what it would have checked instead.
4. Under `## When CI fails`, one line per kind of failure this project has had (format, lint, types, tests, build, install, out of memory, missing env, schema, secrets, network): what it looks like in the log and the fix.
5. Under `## Watch out`, name the flaky jobs (failed then passed on the same commit), the slow ones, and the jobs that don't run on pull requests.
6. A new lesson goes under `## Lessons` as one line: what CI saw, why pre-flight missed it (Node version, an env var, a skipped step, a service), and what pre-flight now does about it. If the lesson changes how a job must run here, change that job's legs too. Keep earlier lessons unless the config made them untrue.
7. `## Legs` ends the file: one fenced json block, `{"legs":[{"job":"<CI job name>","run":["<command>", ...],"env":{"NAME":"value"},"cwd":"<folder>"}]}`. Shrike runs exactly these, in order, through its guarded shell. A command CI doesn't run, or an env value the CI config doesn't set, asks the user first, so add one only when it's needed. `cwd` stays inside the project. Never put a secret value in env.
8. Don't invent jobs, commands or history. If the map doesn't say, leave it out.
