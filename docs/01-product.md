# 01 · Product

Working name: **Shrike**. Check trademarks and domains before anything public. Rename in one pass: `@shrike/*` package scope, `.shrike/` project folder, `.shriketrace` files, this doc set.

**Why Shrike:** the shrike is a small songbird that hunts insects and pins them to thorns. It finds the bug and pins it to the exact line. Short, an animal, a hunter, the same family of name as Orca.

## Positioning

**Shrike is the ADE for debugging: an Agentic Debugging Environment.**

Orca ([stablyai/orca](https://github.com/stablyai/orca)) is an ADE for *building* with a fleet of coding agents. Shrike is the ADE for *debugging* what they built. One-liner: **"Your app, recorded. Your agent, with eyes."**

You describe the problem in plain words ("when I click Add Todo, nothing happens"). Your agent, running inside Shrike, opens your app, reproduces the problem, watches what your frontend, server and database actually did, finds the line that caused it, explains it in plain English, proposes a fix, and re-runs the scenario to prove the fix works.

Everything the agent sees, you can see too: a timeline of every step, with the source line highlighted and timings attached. The agent's conclusions are grounded in a real recording of your app, not a guess from reading code.

### Why "agentic" is true here, not a label

Most "AI debugging" today means pasting an error into a chat. The model reads code and guesses. Shrike's agent has **runtime eyes and hands**:

| Hands (it can act) | Eyes (it can observe) |
|---|---|
| Click, type and navigate in your running app | Every user action, request, function call, query, log and error, in order |
| Send API requests | Which line of which file produced each one |
| Turn on deeper capture for one function and re-run | Arguments, return values and timings |
| Propose a patch, apply it after you approve, re-run the scenario | Before/after recordings to compare |

That loop (reproduce, observe, hypothesise, probe, fix, verify) is what makes it an agent. See [05-agent.md](05-agent.md).

## Philosophy (borrowed from Orca, applied to debugging)

1. **Bring your own agent.** Shrike is the environment, not the model. It runs the agent you already pay for (Claude Code today; Codex and OpenCode are planned) on your own subscription and hands it Shrike's tools over MCP. No second AI bill. A built-in agent using your own API key exists for people with no agent installed.
2. **Open source core, MIT.** The desktop app, instrumentation and MCP server are open. People will only let a tool watch their app's traffic if they can read its code. The paid layer is optional cloud (sharing, team history, hosted keys).
3. **Local-first.** Your code, recordings and secrets stay on your machine. Nothing is uploaded unless you share it.
4. **Desktop, real Chromium.** Electron with an embedded browser, like Orca's design mode, because debugging needs a real browser and real dev tools access.
5. **Agents are watched, not trusted.** Every agent step is visible and linked to evidence. Agents can't edit files directly; changes arrive as a diff you approve.
6. **Works with what you already use.** Your own editor stays your editor. Cursor and Claude Code sessions outside Shrike can still query its recordings through MCP.

## Who it's for

**Primary: the vibe coder.** Built a working app with Cursor, Claude Code, Lovable, Bolt, v0 or Replit. Can run `npm run dev`. Can't read a stack trace with confidence. When something breaks they paste errors into a chat and hope. They lose hours to bugs a senior engineer would find in five minutes.

**Secondary: the junior or full-stack developer** who can debug but hates stitching together DevTools, server logs, Postman and the editor. They want the correlated timeline and will use the manual tools more than the agent.

**Not for (v1):** production incident response, large microservice estates, mobile apps, non-JS backends.

## Jobs to be done

1. "Something's broken. Tell me where and why, in words I understand."
2. "Fix it, but show me what you changed and prove it works."
3. "Show me what happens when I click this button." (learning their own AI-written code)
4. "Why is this page slow?"
5. "Let me poke at my APIs without learning Postman."

## Core experiences, in priority order

| # | Experience | Phase |
|---|---|---|
| 1 | **Run your app inside Shrike.** Open folder, press Run, app appears in the embedded browser. | MVP |
| 2 | **Timeline of what happened.** Every click becomes an Action: requests, backend functions, queries, logs, errors, nested and timed, each linked to `file:line`. | MVP |
| 3 | **Code panes in space.** The code that ran floats in 3D, connected in order; the live line glows with its values; the camera flies the flight like God's Eye View. | MVP |
| 4 | **What happened? card.** Plain-English checklist after every Action. | MVP |
| 5 | **Debug agent, your choice of brain.** Describe the bug; Claude Code or the built-in agent (Codex and OpenCode planned) reproduces, investigates, explains, proposes a fix and verifies it. | MVP |
| 6 | **API explorer.** Auto-discovered routes, search, send, cURL copy/import. Requests sent here are traced like clicks. Grown into a Bruno-style API client: collections, tabs, environments, assertions, edit and resend (docs/13 AP). | MVP |
| 7 | **Inline logs.** Logs appear next to the line that wrote them, and in a filterable panel linked to their request. | MVP |
| 8 | **Flow review.** On working flows, the agent flags slow steps, N+1 queries, sequential awaits and request waterfalls. | v1 |
| 9 | **MCP server.** The same tools the in-app agent uses, available to Cursor or Claude Code sessions outside Shrike. (The server itself ships in MVP because the in-app agents use it.) | MVP |
| 10 | **Share a recording.** Redacted `.shriketrace` file or a private link for a friend or mentor. | v1 |
| 11 | **Python backends.** FastAPI, Flask and Django on Python 3.12+ get the same function steps as Node, through python-agent (`packages/python-agent`). | v2, shipped early |

## Non-goals

- **Architecture diagrams.** No dependency graphs or boxes-and-arrows maps. The 3D view shows the real code that ran, in the order it ran ([06-design.md](06-design.md)).
- **Production monitoring.** Local dev only.
- **Silent code changes.** The agent never writes code without showing a diff and getting a click.
- **Teaching debugging.** We show what happened. We don't lecture.
- **A code editor.** Users keep their own editor; Shrike opens files there at the right line.

## Success metrics

| Metric | Target at beta |
|---|---|
| Time from install to first recorded Action | < 5 minutes |
| Agent finds the right file:line on the bug corpus ([09-testing.md](09-testing.md)) | ≥ 80% |
| Agent's proposed fix verified by re-run | ≥ 60% |
| Instrumentation overhead per request | < 15% |
| Week-4 retention of activated users | ≥ 30% |
| Users who say the explanation was understandable (in-app thumbs) | ≥ 85% |

## Glossary (internal term → what the user sees)

We never show the left column in UI copy unless the user expands technical details.

| Internal | User-facing |
|---|---|
| Action / trace | Recording, "what happened when you clicked X" |
| Span, event | Step |
| HTTP request | Call to the server, shown with method and path |
| 4xx / 5xx | "The server said no (401)", "Server error (500)" |
| Stack trace | "Where it broke" + file:line |
| Call stack (Files view) | The CALL STACK row: how the step got there, frames that returned struck through |
| Project map, file tree slice | Files view: the trip through your folders and files (THREAD \| FILES, key V) |
| Middleware | Code that runs before your route |
| N+1 query | "The same database question asked 47 times" |
| Source map | (never shown) |
| Precision: approximate | "Roughly here" |
