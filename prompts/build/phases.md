# Build prompts, one per phase

Paste one at a time into your coding agent (Claude Code, Cursor, Codex) from the repo root. Each assumes the agent has read `CLAUDE.md` and `MASTER_PROMPT.md`. Don't start the next phase until the "done when" check passes; ask the agent to show you the check running.

---

## Phase 0 · Instrumentation spike

```
Read docs/02-architecture.md (Instrumentation strategy) and docs/03-tech-stack.md.
This is a throwaway spike in spikes/ (not packages/). Prove or disprove:
1. Express + tsx: NODE_OPTIONS=--import a register script that starts the OTel Node SDK
   and registers a module loader that uses @swc/core to wrap every function in user files
   (not node_modules) with enter/exit hooks carrying file:line. Print a nested tree for one request.
2. Next.js app router (webpack dev, then Turbopack): get the same function-level tree without
   editing next.config.* (preload a require hook on Next's config loading). If impossible,
   document the smallest config wrap that works.
3. A browser fetch with a W3C traceparent header joins the server trace.
4. Clicked DOM element → React component → file:line on React 18 (_debugSource) and React 19 (_debugStack + source maps).
Write findings to docs/spikes/0-instrumentation.md: what works, what doesn't, versions tested, chosen approach.
Done when: that note exists and each of the four has a runnable script or a clear "blocked because".
```

## Phase 1 · Shell

```
Read docs/02-architecture.md, docs/03-tech-stack.md, docs/06-design.md, apps/desktop/README.md.
Scaffold the pnpm + Turborepo workspace and apps/desktop with electron-vite, React 19, Tailwind v4
with the tokens from docs/06-design.md, Monaco, react-resizable-panels, xterm.js + node-pty.
Build: Welcome screen, open folder, project setup screen (detected dev command + URL, editable),
Run/Stop that spawns the dev command, URL detection from stdout, app pane (WebContentsView,
own session partition, sandboxed), file tree, Monaco editor with save, terminal tab.
Typed IPC through a preload with zod validation in main (channels in docs/02-architecture.md).
Build fixtures/todo-app per its README.
Done when: open fixtures/todo-app, press Run, the app is usable inside Shrike, editing a file hot-reloads.
```

## Phase 2 · Scanner and API explorer

```
Read packages/scanner/README.md and the API explorer parts of docs/06-design.md.
Implement @shrike/scanner: framework detection from package.json and file layout; route discovery
with ts-morph for Express (app/router .get/.post/...) and Next.js (app/**/route.ts exports,
pages/api/**). Implement the API explorer panel: fuzzy search over method + path + handler,
method filter, request editor (params, headers, JSON body in Monaco, {{vars}} from an environment),
Send (from main, not the renderer), response view with status words and timing, Copy as cURL /
fetch / axios via httpsnippet, Import cURL, save to .shrike/collections/*.json, Jump to handler.
Add a node:test check for the scanner against both fixtures.
Done when: all fixture routes listed with zero config, search filters, sending shows response and timing.
```

## Phase 3 · Browser capture

```
Read packages/browser-agent/README.md, packages/schema/README.md, packages/store/README.md, docs/04-data-model.md.
Implement @shrike/schema (zod types from docs/04-data-model.md), @shrike/store (SQLite DDL + NDJSON blobs),
the ingest server in main (127.0.0.1, random port, token), the CDP collectors on the app pane
(Network, Runtime console/exceptions), and @shrike/browser-agent injected with
Page.addScriptToEvaluateOnNewDocument: rrweb record with maskAllInputs, action windows for clicks /
submits / navigation, patched fetch/XHR that inherit the actionId and add traceparent for allowed
origins, fiber → file:line via bippy. Redact on ingest with @shrike/redact (see docs/07-security-privacy.md).
Show a raw list of Actions and their events in a temporary panel.
Done when: clicking Add Todo creates one Action with the click at TodoForm.tsx:31 and the POST nested under it.
```

## Phase 4 · Server capture

```
Read packages/node-agent/README.md, packages/correlator/README.md, docs/spikes/0-instrumentation.md.
Implement @shrike/node-agent from the spike's chosen approach: OTel SDK + auto-instrumentations,
SWC function hooks for user files only, AsyncLocalStorage context, console capture attached to the
active span, args/return capture (redacted, 2KB cap), OTLP/JSON export to the ingest with the token,
refuse to run when NODE_ENV=production. ProcessRunner injects it via NODE_OPTIONS (and the Next.js
approach from the spike). Implement @shrike/correlator: adapters to DebugEvent, clock alignment,
tree building, source resolution with source maps and precision tags, framework-frame marking.
Fallback: if node-agent crashes on load, restart once in OTel-only mode and flag "basic" instrumentation.
Add the unit checks listed in docs/09-testing.md for correlator and node-agent.
Done when: the same click shows createTodo() → DB insert → error under the POST, with durations,
on both fixtures.
```

## Phase 5 · Timeline and playback

```
Read docs/06-design.md (Workspace layout, Components, Accessibility, Shortcuts).
Build the timeline (virtualised ARIA tree), file:line chips, duration bars, filters, jump-to-source,
Monaco decorations: highlighted line, inline values and logs, heat gutter. Playback: step/play/scrub
that moves the editor highlight, scrolls logs, and seeks the rrweb Replayer. Network and Logs panels
linked to the tree. Global ⌘K search over events (FTS). Git-aware sessions: store SHA + file hashes,
open recorded snapshots when files changed, show the banner.
Done when: arrow keys step through the demo; the highlight lands on todos.controller.ts:18 with
userId: undefined shown inline; editing that file afterwards shows the "changed since recording" banner.
```

## Phase 6 · What happened? and heuristics

```
Read docs/05-agent.md (Deterministic heuristics) and docs/06-design.md (What happened? card).
Implement every heuristic in the correlator with node:test checks against the fixture endpoints.
Build the deterministic What happened? card (headline, clickable checklist, stats).
Done when: slow, N+1 and waterfall endpoints are flagged at the right file:line, clean flows aren't.
```

## Phase 7 · MCP server and tools

```
Read docs/05-agent.md fully and packages/mcp-server/README.md.
Implement @shrike/mcp-server with @modelcontextprotocol/sdk: every tool in docs/05-agent.md with zod
schemas, compact outputs, redaction on every output, the autonomy gate and approval flow (approvals
surface in the Shrike UI and block the tool call until answered), network scope from .shrike/config.json,
scenarios (save/run with expect), deep_capture, propose_patch/revert_patch with path restrictions.
Serve over stdio for agent CLIs and optional 127.0.0.1 HTTP for external clients.
Done when: from a terminal, Claude Code with only the Shrike MCP server enabled reproduces the demo
bug and names todos.controller.ts:18 using only Shrike tools.
```

## Phase 8 · Agent host and brains

```
Read docs/05-agent.md (Agent brains) and packages/agent/README.md. Study how stablyai/orca spawns
and streams agent CLIs before writing adapters.
Implement @shrike/agent: brain detection and auth state; the Claude Code adapter (headless, Shrike
MCP config, allowed tools limited to mcp__shrike__*, stream-json → AgentStep); the built-in brain
(@anthropic-ai/sdk tool-use loop, prompt caching, budgets); then Codex and OpenCode adapters.
Load prompts from prompts/agent/*.md. Build the agent panel (goal input, brain picker, autonomy
toggle, streaming steps linked to timeline rows, inline approvals, Found it card, diff view with
Apply/Reject, verify result, Undo). Build scripts/eval to run fixtures/bugs per brain.
Done when: eval shows ≥ 80% localisation and ≥ 60% verified fixes for Claude Code and built-in.
```

## Phase 9 onwards

Use the tables in `docs/08-roadmap.md` as the prompt: paste the phase row plus the docs it references.
