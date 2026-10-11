# 02 · Architecture

## System overview

```
┌──────────────────────────── Shrike desktop (Electron) ─────────────────────────────┐
│ Renderer (React)                                                                  │
│  Explorer · Monaco · App pane (WebContentsView) · Timeline · Panels · Agent       │
│        ▲ typed IPC (contextBridge, zod-validated)                                 │
├────────┼──────────────────────────────────────────────────────────────────────────┤
│ Main process                                                                      │
│  ProjectService     open folder, detect framework, read .shrike/config.json        │
│  Scanner            routes, entry points, package info         (@shrike/scanner)   │
│  ProcessRunner      spawn dev command with node-agent, detect URL, pty terminal   │
│  BrowserCollector   CDP on app pane + injects browser-agent                       │
│  Ingest             127.0.0.1 HTTP (/ingest, OTLP /v1/traces), per-session token  │
│  Correlator         adapters → DebugEvent, clock alignment, tree   (@shrike/correlator)│
│  Store              in memory + NDJSON per project  (SQLite planned, @shrike/store)│
│  Redactor           runs on ingest, before store                   (@shrike/redact)│
│  AgentHost          runs Claude Code / Codex / OpenCode / built-in (@shrike/agent) │
│  McpServer          Shrike tools + approval gate, for every agent  (@shrike/mcp-server)│
└───────────────────────────────────────────────────────────────────────────────────┘
          ▲ OTLP + WS (localhost)                     ▲ CDP + injected script
┌─────────┴───────────────┐   HTTP + traceparent   ┌──┴────────────────────────┐
│ User's dev server       │◀───────────────────────│ User's frontend           │
│ + @shrike/node-agent     │                        │ + @shrike/browser-agent    │
└─────────────────────────┘                        └───────────────────────────┘

Agent CLIs run as child processes on the user's subscription, connected to McpServer.
Optional cloud (apps/cloud): auth, billing, hosted AI key, share links.
No source code or raw recordings go to the cloud unless the user shares.
```

## Processes and trust

| Process | Runs | Trust |
|---|---|---|
| Electron main | Our code, full Node access | Trusted |
| Renderer | Our UI, no Node, `contextIsolation: true`, `sandbox: true` | Trusted UI, untrusted data |
| App pane | User's frontend, separate session partition | Untrusted |
| User's dev server | User's code + our node-agent | Same trust as running `npm run dev` yourself |
| Agent (CLI or built-in) | User's agent CLI as a child process, its own file/shell tools disabled; acts only through Shrike's MCP tools | Untrusted output; every side effect goes through a Shrike tool with guards |

## Lifecycle of one Action (the core sequence)

```
User clicks "Add Todo" in app pane
 1 browser-agent: click listener opens action window, actionId=A1, traceId=T1
   - resolves clicked element → React fiber → TodoForm.tsx:31
   - emits user_action event over WS
 2 onClick runs → fetch("/api/todos")
   - patched fetch: inherits A1, adds traceparent: 00-T1-<span>-01
   - captures stack → api.ts:12 (resolved later)
 3 CDP Network.requestWillBeSent / responseReceived → timing, headers, bodies
 4 Node: OTel http server span joins T1 via traceparent
 5 node-agent function hooks: createTodo() enter/exit with args, timing, file:line
 6 console.log inside createTodo → log event attached to active span
 7 OTel db span: INSERT fails → error event
 8 Response 500 → CDP + fetch patch close the request
 9 React commit observed via fiber hook → render event (TodoList)
10 Action window closes after network idle 500ms and no pending renders
11 Correlator builds tree, Redactor already ran on ingest, Store persists
12 Renderer receives action:completed → Timeline + What happened? card
```

## Instrumentation strategy by framework

This is the riskiest engineering area. Spike it in week one (see [08-roadmap.md](08-roadmap.md), Phase 0).

### Server side

| Setup | How we get function-level spans | Notes |
|---|---|---|
| `node`/`tsx`/`ts-node` + Express, Fastify, Hono | `NODE_OPTIONS=--import @shrike/node-agent/register` → OTel SDK + `module.register()` loader that SWC-transforms user files | Loader must chain after `tsx`'s own loader. Skip `node_modules`. |
| Next.js (webpack, dev) | Server code is bundled, so a Node loader never sees route files. Inject a webpack loader. | v1: launcher preloads a require hook on Next's config loader to append our loader without editing `next.config.*`. Fallback: one-click "Enable full tracing" adds `withShrike()` to the config, shown as a diff. |
| Next.js (Turbopack) | Turbopack loader rules (`turbopack.rules`) via the same config wrap | Spike; if blocked, OTel-only with `approximate` locations. |
| Vite SSR | Vite plugin via the same config-wrap approach | v1.x |
| Python 3.12+ (FastAPI, Flask, Django) | The runner puts `packages/python-agent/src` first on `PYTHONPATH`; its `sitecustomize.py` starts `sys.monitoring` callbacks on project code and wraps the framework's ASGI or WSGI entry when it loads | Standard library only, `contextvars` for the trip, sqlite3 queries; other drivers through OpenTelemetry. Inert before 3.12 and under `opentelemetry-instrument`. See [packages/python-agent](../packages/python-agent/README.md). |
| Any OpenTelemetry backend (.NET, Python, Go, Java) | No function hooks. The runner sets `OTEL_EXPORTER_OTLP_ENDPOINT` (the ingest URL), `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, `OTEL_EXPORTER_OTLP_HEADERS=x-shrike-token=…`, `OTEL_SERVICE_NAME` (the process name) and turns metrics and logs off; the app's own SDK or auto-instrumentation sends its traces to `POST /v1/traces` (`apps/desktop/src/main/otlp.ts`) | Basic tracing: requests, queries and outside calls with timing and errors, no per-function values. Exporter settings the user already has win. Protobuf or JSON, no gRPC. |

When function hooks are unavailable, degrade to **OTel-only**: HTTP and DB spans still appear; locations come from stack traces captured at span start, marked `approximate`.

### Browser side

| Need | Mechanism |
|---|---|
| Network, console, exceptions | CDP via `webContents.debugger` on the app pane |
| Clicks, inputs, navigation, DOM replay | `@shrike/browser-agent` injected with `Page.addScriptToEvaluateOnNewDocument`; uses rrweb |
| Element → component → file:line | React DevTools global hook (bippy approach). React ≤18: `_debugSource`. React 19: parse `_debugStack` through source maps. |
| Request ↔ click linking | Patched `fetch`/XHR inherit the open action window; W3C `traceparent` header joins the backend |
| Renders | Fiber commit hook (react-scan approach) |

The `traceparent` header is only added to same-origin requests and origins on an allowlist, so we don't break CORS on third-party APIs.

## Clock alignment

Browser and Node clocks differ. At session start each agent reports `(wallClockMs, monotonicMs)` pairs over WS; the Correlator computes per-source offsets and re-syncs every 30s. Nesting uses parent/child links first and timestamps second, so small skew never reorders a child before its parent.

## IPC contract (renderer ↔ main)

All channels are typed in `@shrike/schema` and validated with zod in main. The renderer never gets raw Node access.

| Channel | Direction | Payload |
|---|---|---|
| `project:open` / `project:info` | R→M / M→R | path / framework, routes, commands |
| `run:start` / `run:stop` / `run:status` | R→M / M→R | command / url, pid, state, error |
| `action:started` / `action:event` / `action:completed` | M→R | Action, DebugEvent (batched every 50ms) |
| `timeline:query` | R→M | filters, search text → events |
| `file:read` / `file:write` / `file:changed` | R↔M | repo-relative path, contents, hash |
| `api:list` / `api:send` | R↔M | routes / request → actionId |
| `agent:start` / `agent:step` / `agent:approve` / `agent:stop` | R↔M | goal, autonomy / step stream / approval id |
| `settings:get` / `settings:set` | R↔M | settings object |

## Local ports

| Port | Owner | Bind |
|---|---|---|
| User's dev server (e.g. 3000, 5173) | User | as configured |
| Ingest (random free port) | Shrike main | 127.0.0.1 only, token in `SHRIKE_INGEST_URL` |
| MCP (Streamable HTTP) | Shrike main | 127.0.0.1 only, Bearer token; the main server keeps its port and token across restarts |

## Failure modes and what the user sees

| Failure | Behaviour |
|---|---|
| Dev command exits | Terminal tab opens with the output; agent offers "Explain this error" |
| URL not detected in 45s | The run stops and says to type the app's address in Setup; a command that printed a different local address than the one set is named with both addresses |
| App port already taken | Refused before starting when anything accepts connections there (TCP, not only HTTP); a command that still dies on it gets "Port N is already in use by another program" under its own error line (Node, Python, Go, Vite wordings) |
| Dev command waits for an answer (`(Y/n)`, `›`) | It gets no stdin, so it exits; the error adds that Shrike can't answer questions and to run it once in a terminal or skip the question |
| Dev command floods its output | Main reads it without falling behind (the 2,000-line tail trims in batches) and sends the window at most 20 messages a second, the newest 64KB each, with "[shrike] Skipped N KB of output to keep up." (`host.ts`) |
| Shrike force-quit or crashed while the app runs | Each process group and its leader's start time are kept in `userData/process-groups.json`; the next launch ends those groups before anything starts, never a group whose leader's start time differs (a reused pid). Quit and window close stop every group as before. Windows: not tracked |
| Second launch on the same data | It quits and focuses the first window (single-instance lock), so two copies never share files or the MCP port |
| Error thrown in main | Logged (redacted) to `userData/logs/main.log`; Shrike keeps running and no error dialog appears |
| Window renderer crashes | The window loads again and re-reads its state from main; three crashes in a minute stop the reloading |
| Damaged state file (`userData` or `.shrike`) | Read as missing, but first copied aside to `<file>.broken-<hash>` so a later save never erases it; saves are temp file + rename; a failed save says why in plain words (read-only folder, no permission, disk full) (`state-file.ts`) |
| node-agent crashes on load | Restart once without function hooks (OTel-only), show "Basic tracing" badge |
| No source maps | Locations marked approximate; banner explains in one line |
| Event flood (a click with 100k steps, a server polling in a loop) | A trip keeps its first 5,000 steps (errors still get in up to 10,000) and one note in the trip says how many more were skipped; the store keeps the newest 500 trips and 100,000 events, dropping the oldest finished trips first and never one an agent waits on; bodies are cut at 64KB with "…[truncated]" (`apps/desktop/src/main/store.ts`) |
| Files changed since recording | Banner; editor opens recorded snapshot, never highlights the live file |
| AI unavailable or no key | All non-AI features work; agent panel shows setup steps |

## Repo layout

See the root [README.md](../README.md#repository-layout). Every app and package has its own README with responsibilities, planned `src/` tree and its "done when" check.
