# apps/desktop

The Shrike Electron app: main process services and the React renderer.

## Owns

- Window, menus, auto-update, settings
- Main-process services: ProjectService, ProcessRunner, BrowserCollector, Ingest, wiring to correlator/store/agent/mcp-server ([docs/02-architecture.md](../../docs/02-architecture.md))
- Renderer: every screen and component in [docs/06-design.md](../../docs/06-design.md)
- Typed preload bridge (IPC channels from `@shrike/schema`)

## Planned layout

```
src/
├── main/
│   ├── index.ts                # app lifecycle, windows
│   ├── ipc.ts                  # channel registry, zod validation
│   ├── project.ts              # open folder, .shrike/config.json
│   ├── runner.ts               # spawn dev command, inject node-agent, URL detection, pty
│   ├── browser-collector.ts    # CDP on the app pane, inject browser-agent
│   ├── ingest.ts               # 127.0.0.1 OTLP/JSON + WS, token
│   └── git.ts                  # SHA, dirty state, snapshots
├── preload/
│   └── index.ts                # contextBridge, typed API
└── renderer/
    ├── app.tsx
    ├── theme.css               # tokens from docs/06-design.md
    ├── stores/                 # zustand: project, run, timeline, agent, api
    ├── screens/                # welcome, project-setup, workspace, settings
    └── components/
        ├── explorer/  editor/  app-pane/  timeline/  playback/
        ├── what-happened/  network/  logs/  api-explorer/  terminal/
        └── agent/              # panel, steps, approvals, found-it, diff
```

## Depends on

`@shrike/schema`, `store`, `redact`, `correlator`, `scanner`, `agent`, `mcp-server`. Bundles `node-agent` and `browser-agent` as resources.

## Done when

Phases 1, 5 and 8 of [docs/08-roadmap.md](../../docs/08-roadmap.md) pass.
