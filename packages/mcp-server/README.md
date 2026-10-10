# @shrike/mcp-server

The single tool surface for every agent: in-app brains over stdio, external clients (Cursor, Claude Code in a terminal) over stdio or 127.0.0.1 HTTP while Shrike is open.

## Owns

- Every tool in [docs/05-agent.md](../../docs/05-agent.md#tools), zod schemas → JSON Schema
- Autonomy gate and approvals (block the call until the user answers in the Shrike UI)
- Network scope from `.shrike/config.json`; path restrictions for patches
- Redaction of every tool output via `@shrike/redact`
- Compact output formats (timeline-like trees, not raw JSON dumps)
- `ask_options` (docs/13 M1): option cards with plain-HTML mockups; blocks like an approval, loops on each answer, times out after 9 minutes with `action: "waiting"` (`src/options.ts` writes what goes back to the agent)
- `self_review` (docs/13 RL5): the repo's review lessons for the likely reviewers and the changed files; called with results it records them on the self-check card (only when the host sets `selfReview`)

External clients get Recordings, Code, API and App tools. Fix tools are in-app only.

```
src/
├── server.ts          # MCP server, transports
├── gate.ts            # autonomy + approvals
├── scope.ts           # origins, paths
├── format.ts          # compact tree rendering for model context
└── tools/
    ├── recordings.ts  app.ts  api.ts  code.ts  probe.ts  fix.ts  report.ts
```

User setup for external clients (docs site): one command that prints the MCP config snippet for Cursor / Claude Code.

## Connecting an outside client (current build)

While Shrike is open, the MCP server's address and token are in `<Shrike user data>/mcp.json` (macOS: `~/Library/Application Support/<app name>/mcp.json`, mode 0600), in the standard `mcpServers` shape. Point Cursor or a terminal Claude Code at it. Reads of trips by an outside client show a "watched by" eye with the client's name on those trips (A11). Shrike's own runs send `x-shrike-internal: 1` and don't count.
