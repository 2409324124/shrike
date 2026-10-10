# Master prompt: Shrike, the Agentic Debugging Environment

> Paste this into your coding agent as the project brief, from the repo root. It's the "why" and the "what". The "how" lives in `docs/`, and `CLAUDE.md` holds the working rules. Build one phase at a time using `prompts/build/phases.md`.

---

## The product in one sentence

**The user clicks something in their app, and Shrike shows exactly what the app did (in order, as highlighted source code with timings and logs) while the user's own coding agent finds the broken line, explains it in plain English, fixes it after approval, and re-runs the flow to prove it works.**

Category: **ADE, Agentic Debugging Environment.** [Orca](https://github.com/stablyai/orca) is the ADE for building with coding agents; Shrike is the ADE for debugging what they built.

Tagline: **Your app, recorded. Your agent, with eyes.**

## Who it's for

A **vibe coder**: they built a web app with Cursor, Claude Code, Lovable or Bolt and don't read code fluently. When it breaks, they don't know which file to open. Shrike answers that question, and their agent does the rest.

## The killer demo (this is the spec)

A todo app with a planted bug: the backend reads `req.body.user`, the frontend sends `userId`.

1. User opens the project in Shrike and presses **Run**. The app loads in Shrike's embedded browser.
2. User clicks **Add Todo**. Nothing appears.
3. The timeline shows:

```
🖱 CLICK "Add Todo"                          TodoForm.tsx:31
→  POST /api/todos                 500  48ms  api.ts:12
   ├ createTodo()                        3ms  todos.controller.ts:14
   │  📝 "creating todo" {title}               todos.controller.ts:16
   └ Database insert   ✕ userId=undefined 31ms todos.controller.ts:18
      NOT NULL constraint failed: todos.user_id
⚛  TodoList re-rendered (no change)            TodoList.tsx:9
```

4. The code that ran floats as panes in 3D space, joined in order. A comet flies the path; line 18 glows red with `userId: undefined` beside it. Arrow keys step; O pulls back to the god's-eye overview; REC exports a vertical clip.
5. The user types "When I click Add Todo nothing shows up" into the agent panel. Their Claude Code (or Codex, OpenCode, or the built-in agent) reproduces the click, reads the recording, deep-captures `createTodo()`, and reports:

> **Found it (Observed).** Your form sends the user ID as `userId`, but the server reads `user`. The database won't save a todo without a user, so it errors. → `todos.controller.ts:18`

6. **Show fix** → one-line diff → **Apply** → the agent re-runs "Add a todo" → `201`, the todo appears → **Fixed and verified.**

If a decision doesn't make this demo better, faster or more reliable, defer it.

## Philosophy

1. **Bring your own agent.** Shrike is the environment, not the model. It runs the coding agent the user already pays for, with Shrike's tools over MCP. A built-in agent using the user's own API key is the fallback.
2. **Open source core (MIT), optional paid cloud.** Nobody lets a closed tool watch their app's traffic.
3. **Local-first.** Code, recordings and secrets stay on the machine.
4. **Agents are watched, not trusted.** Every step visible and linked to evidence; code changes only as approved diffs; every fix verified by a re-run.
5. **The code is the world.** Panes of real source float in 3D and light up line by line as the flight passes. One thing glows at a time (ADHD-first).
6. **Show what actually happened, then explain it.** Observed facts first, AI interpretation second, always labelled.

## Non-goals

- Dependency graphs or architecture maps. The 3D view shows the real code that ran, in order (docs/06-design.md)
- Production monitoring
- Agents writing code without a visible diff and a click
- Languages beyond JS/TS in v1 (design the seam, ship Node/TS only)
- Dumping the terminal into a log panel: every log is attached to the request and line that wrote it

## Read next, in this order

| Doc | What's in it |
|---|---|
| [docs/01-product.md](docs/01-product.md) | Positioning, philosophy, users, features by priority, metrics, glossary |
| [docs/02-architecture.md](docs/02-architecture.md) | Processes, the lifecycle of one click, instrumentation per framework, IPC, failure modes |
| [docs/03-tech-stack.md](docs/03-tech-stack.md) | Every technology choice and why, plus verified reference repos |
| [docs/04-data-model.md](docs/04-data-model.md) | Event schema, SQLite DDL, `.shrike/` folder, trace file format |
| [docs/05-agent.md](docs/05-agent.md) | Agent brains, the loop, tools, autonomy, guardrails, heuristics, MCP |
| [docs/06-design.md](docs/06-design.md) | Screens, layout, components, states, tokens, accessibility, shortcuts, copy |
| [docs/07-security-privacy.md](docs/07-security-privacy.md) | Threat model, redaction, what leaves the machine |
| [docs/08-roadmap.md](docs/08-roadmap.md) | Phases with "done when" checks, milestones, risks |
| [docs/09-testing.md](docs/09-testing.md) | Unit checks, fixtures, the agent eval corpus, perf budgets |
| [docs/10-go-to-market.md](docs/10-go-to-market.md) | Message, competitors, pricing, channels, launch checklist |

## Product principles (tie-breakers)

1. The user should never have to ask **"which file do I open?"**
2. The user should never correlate browser, network, server logs and database by hand.
3. The agent never claims something the recording doesn't show, and never claims a fix works without a passing re-run.
