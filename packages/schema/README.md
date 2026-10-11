# @shrike/schema

Single source of truth for every type that crosses a process boundary: `DebugEvent`, `ActionView`, `IngestMessage`, `Finding`, `Patch`, `ShrikeHost` (the IPC and MCP host surface), ingest wire formats.

- Plain TypeScript types, no runtime code and no dependencies. The zod schemas that validate payloads live where the payload arrives (`apps/desktop/src/main/ipc.ts`, `ingest.ts`, `otlp.ts`)
- Spec: [docs/04-data-model.md](../../docs/04-data-model.md)

```
src/
└── index.ts       # every shared type
```
