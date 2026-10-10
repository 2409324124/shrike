# @shrike/schema

Single source of truth for every type that crosses a process boundary: `DebugEvent`, `Action`, `Session`, `Scenario`, `Route`, `AgentRun`, `AgentStep`, `Finding`, `Patch`, IPC channel payloads, ingest wire formats.

- zod schemas; TS types via `z.infer`
- No runtime dependencies besides zod
- Spec: [docs/04-data-model.md](../../docs/04-data-model.md)

```
src/
├── events.ts      # DebugEvent, SourceLocation, Action, WhatHappened
├── session.ts     # Session, git info
├── scenario.ts    # Scenario, Locator, SavedRequest, Route
├── agent.ts       # AgentRun, AgentStep, Finding, Patch
├── ipc.ts         # channel name → request/response schemas
└── ingest.ts      # wire formats from node-agent and browser-agent
```
