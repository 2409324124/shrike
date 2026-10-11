# apps/desktop

The Shrike Electron app: main process services and the React renderer.

## Owns

- Window, menus, settings
- Main-process services: project, process runner, app view, ingest, store, wiring to correlator/agent/mcp-server ([docs/02-architecture.md](../../docs/02-architecture.md))
- Renderer: every screen and component in [docs/06-design.md](../../docs/06-design.md)
- Typed preload bridge (IPC channels from `@shrike/schema`)

## Layout

```
src/
├── main/
│   ├── index.ts                # app lifecycle, windows
│   ├── ipc.ts                  # every IPC method, zod-validated
│   ├── project.ts              # open folder, .shrike/config.json
│   ├── runner.ts               # spawn dev commands with node-agent and python-agent, URL detection
│   ├── app-view.ts             # the app pane's <webview>: CDP, browser-agent injection
│   ├── ingest.ts               # 127.0.0.1 HTTP: /ingest (agents' JSON), /v1/traces (OTLP), token
│   ├── otlp.ts                 # OTLP traces (protobuf or JSON) to DebugEvents: basic tracing for any backend
│   ├── store.ts, sessions.ts   # trips in memory, newest trips per project on disk (NDJSON)
│   ├── agent.ts, mcp.ts        # agent runs, the MCP server and the user's own MCP servers
│   ├── platform.ts             # shells, process trees, folder links on macOS, Linux and Windows
│   ├── api/                    # API client: Bruno collections, environments, send, codegen
│   ├── datasources/            # read-only looks inside the app's databases
│   ├── start/                  # the start agent: recipes, guarded shell (R6), services
│   └── ...                     # git, scm, worktrees, flows, skills, voice, lessons, quests
├── preload/
│   └── index.ts                # contextBridge, typed API
└── renderer/src/
    ├── app.tsx, main.tsx
    ├── theme.css               # tokens from design-system/tokens.ts
    ├── stores/                 # zustand stores
    ├── hud/, thread/           # the shell around the Thread, and the Thread itself
    ├── components/             # shared panels and ui/
    └── ...                     # one folder per feature: api, scm, pr, voice, quests, workspaces, chains, inspector, start, ...
```

## Platforms

macOS (Apple Silicon) is the released build. Linux (AppImage, .deb) and Windows (NSIS) build from `electron-builder.yml`; see [docs/RELEASING.md](../../docs/RELEASING.md) and the OS table in [docs/14-compatibility.md](../../docs/14-compatibility.md). Everything that differs by OS goes through `src/main/platform.ts` (main) and `src/renderer/src/lib/platform.ts` (the renderer, from preload's `platform`): the shell, killing a process tree, linking `node_modules`, the title bar, shortcut labels and voice, which is macOS only.

## Depends on

`@shrike/schema`, `redact`, `correlator`, `scanner`, `agent`, `mcp-server`, `@shrike/design`. Bundles `node-agent`, `python-agent` and `browser-agent` as resources.

## Done when

Phases 1, 5 and 8 of [docs/08-roadmap.md](../../docs/08-roadmap.md) pass.
