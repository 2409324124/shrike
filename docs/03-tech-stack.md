# 03 · Tech stack

Use the latest stable version of everything at the time each package is created, and pin exact versions in the lockfile.

## Choices

### Workspace and language

| Area | Choice | Why | Rejected |
|---|---|---|---|
| Language | TypeScript, `strict` | One language across desktop, agents, cloud | |
| Runtime | Node 22.18+ for Shrike itself (user apps: Node 18.19+, database hooks 22.15+, see [14-compatibility.md](14-compatibility.md)) | `module.register`, stable `--import`, `AsyncLocalStorage` | |
| Package manager | pnpm workspaces | Fast, strict, good monorepo support | npm, yarn |
| Task runner | Turborepo | Cached builds across packages | Nx (heavier) |
| Validation | zod | Runtime-checked contracts at every process boundary | io-ts |
| Lint/format | Biome | One fast tool | ESLint + Prettier |

### Desktop app (`apps/desktop`)

| Area | Choice | Why | Rejected |
|---|---|---|---|
| Shell | Electron | Embedded browser + CDP access (`webContents.debugger`) + Node to spawn processes | Tauri (system webview, no CDP on macOS/WebKit), web app + proxy (no CDP, iframe limits) |
| Build | electron-vite | Vite for main, preload and renderer | |
| UI | React 19 | Ecosystem; Monaco and rrweb bindings | |
| Styling | Tailwind CSS v4 + CSS variables for tokens | Fast iteration, theming via tokens ([06-design.md](06-design.md)) | |
| Components | Radix UI primitives (via shadcn/ui source copies) | Accessible menus, dialogs, tabs | MUI (heavy, opinionated look) |
| State | Zustand | Small, no boilerplate | Redux |
| Long lists | TanStack Virtual | Timeline and logs can hold 50k rows | |
| Panels | react-resizable-panels | Resizable, collapsible, persisted layout | |
| Editor | monaco-editor via `@monaco-editor/react` | Decorations, diff editor, TS worker | CodeMirror 6 (lighter, but no built-in TS language service) |
| Terminal | xterm.js + node-pty | Raw dev-server output tab | |
| Replay | rrweb `Replayer` | Seek DOM replay in sync with timeline | |
| Packaging | electron-builder, notarised macOS, auto-update | | |

### Instrumentation

| Area | Choice | Why |
|---|---|---|
| Server tracing | `@opentelemetry/sdk-node` + `@opentelemetry/auto-instrumentations-node` | HTTP, Express, Next, pg, mysql2, Prisma, Mongo, fetch for free |
| Function hooks | `@swc/core` transform (Babel fallback for exotic syntax) | Fast enough to run on every file load |
| Async context | `AsyncLocalStorage` bound to OTel context | Keeps function events under the right request |
| Browser recording | rrweb (`record`, `addCustomEvent`, console plugin) | Proven DOM record/replay |
| React introspection | bippy | Safe access to fibers via the DevTools hook |
| Browser protocol | CDP through Electron's debugger API | No user-code changes |
| Source maps | `source-map` (Mozilla) | `SourceMapConsumer` for Vite, Next, tsc output |
| Route discovery | ts-morph | AST queries for Express and Next route definitions |
| cURL/snippets | httpsnippet | cURL, fetch, axios output |

### Storage

| Area | Choice | Why |
|---|---|---|
| Local DB | SQLite via better-sqlite3 | Synchronous, fast, single file per user |
| Raw events | NDJSON files, gzip on session close | Cheap append, easy export |
| Project config | `.shrike/` folder in the user's repo (git-friendly) | Collections, scenarios, settings travel with the repo |
| Sessions | App data dir, not the repo | Recordings can hold sensitive data |

### AI (bring your own agent)

| Area | Choice | Why |
|---|---|---|
| Agent brains | Claude Code, Codex CLI, OpenCode as child processes, on the user's own subscription | No second AI bill; users already trust these agents |
| Agent wiring | Each CLI gets Shrike's MCP server in its config; its built-in edit and shell tools are disabled | One tool surface, one approval gate, whatever the brain |
| Streaming | Each CLI's JSON stream mode (e.g. Claude Code `--output-format stream-json`), normalised into `AgentStep`s | Live agent panel for every brain |
| Built-in agent | `@anthropic-ai/sdk` tool-use loop, user's API key | For people with no agent CLI installed |
| Built-in models | `claude-sonnet-5` default, `claude-opus-5-5` for "investigate deeper" | Speed vs depth |
| Pattern | Streaming, prompt caching on system prompt + tool definitions | Low latency, low cost per step |
| MCP | `@modelcontextprotocol/sdk` | The single tool surface for in-app and external agents |

### Voice (on this Mac; [16-voice.md](16-voice.md))

| Area | Choice | Why | Rejected |
|---|---|---|---|
| Speech to text | NVIDIA Nemotron 3.5 ASR Streaming 0.6B (OpenMDW-1.1), MLX INT5 (539 MB), 320 ms chunks, language hint, in the `ShrikeVoice.app` helper | The only open model that truly streams and is good at Hindi; final about 105 ms after release, 690 MB resident | whisper turbo (about 900 ms), Qwen3-ASR (can't force the language), Apple (no on-device Hindi; kept only as the English fallback while the model downloads) |
| ASR runtime | speech-swift (Apache-2.0, soniqo) on mlx-swift 0.31.6 (MIT), the four targets voice needs vendored in `native/voice/vendor/` | Won the bake-off: under the 1 GB memory gate with the best English and Hinglish; no Python, no server, same process as the mic | sherpa-onnx C API (2.0 GB resident), speech-swift Core ML INT8 (1.24 GB RSS, 17 s first load), FluidAudio (Hindi only at 560 ms chunks) |
| Voice activity, end of turn | Silero VAD v6.2 (MIT) and Smart Turn v3.2 (BSD-2), Core ML, through the same speech-swift targets | Open, small (0.6 MB and 17 MB), Smart Turn kept every mid-sentence pause in the fixtures as one turn | TEN VAD and the LiveKit turn model (restrictive licences), Kyutai semantic VAD (English and French only) |
| Understanding | Tier 0 and 1 grammar in TypeScript over the action registry; then a bundled planner | The grammar settles most commands in 0.1 ms with no model | An embedding tier (added nothing over going to the planner) |
| Planner model | Qwen3 1.7B Q4_K_M GGUF (Apache-2.0, 1.1 GB), downloaded on first use with a sha256 check | Smallest model and quantisation that meets the gates (held-out 97%, p95 under 0.6 s) | Jev (no arguments or plans), sub-1B and Q4 Gemma 3 (collapse on tool calls) |
| Planner runtime | node-llama-cpp (MIT, prebuilt Metal binaries) in an Electron `utilityProcess` | No native build, a crash can't take Shrike down, schema-forced JSON through its grammar | Ollama (users won't have it), a llama.cpp server binary |

### Cloud (`apps/cloud`) and site (`apps/site`)

| Area | Choice | Why |
|---|---|---|
| API | Hono on Node | Small, fast, typed |
| DB | Postgres (Neon) + Drizzle | Accounts, plans, usage, share metadata |
| Auth | Better Auth (GitHub + Google + email link) | Self-hosted, no per-user fee |
| Billing | Stripe subscriptions | |
| Blob storage | Cloudflare R2 | Shared recordings, expiring links |
| Hosted key (optional) | Hono route forwarding to Anthropic with per-user metering | Built-in agent for users with no subscription or key |
| Marketing site | Astro | Static, fast, good SEO |
| Product analytics | PostHog, opt-in only | |
| Crash reports | Sentry for our own app, opt-in only | |

### Testing

| Level | Tool |
|---|---|
| Unit | `node:test` (built in) |
| Desktop e2e | Playwright `_electron` |
| Agent evals | Our own runner over `fixtures/bugs` ([09-testing.md](09-testing.md)) |

## Reference codebases

Verified on GitHub on 7 Oct 2026. **Check the licence before copying any code.** AGPL and custom-licensed repos are for reading only.

| What we need | Repo | Licence | Look at |
|---|---|---|---|
| Editor, decorations, diff view | [microsoft/monaco-editor](https://github.com/microsoft/monaco-editor) | MIT | `deltaDecorations`, after-content decorations, diff editor |
| API client UX, file-based collections | [usebruno/bruno](https://github.com/usebruno/bruno) | MIT | request editor, collection format, environments |
| API client UX, cURL import | [hoppscotch/hoppscotch](https://github.com/hoppscotch/hoppscotch) | MIT | search, history, cURL import |
| Snippet generation | [Kong/httpsnippet](https://github.com/Kong/httpsnippet) | Apache-2.0 | use directly |
| DOM record and replay | [rrweb-io/rrweb](https://github.com/rrweb-io/rrweb) | MIT | `record`, `Replayer`, `addCustomEvent`, console plugin |
| Server tracing | [open-telemetry/opentelemetry-js](https://github.com/open-telemetry/opentelemetry-js), [opentelemetry-js-contrib](https://github.com/open-telemetry/opentelemetry-js-contrib) | Apache-2.0 | `--import` registration, instrumentations, context propagation |
| Next.js OTel bootstrap | [vercel/otel](https://github.com/vercel/otel) | check repo | `instrumentation.ts` |
| Closest prior art: local dev trace overlay | [getsentry/spotlight](https://github.com/getsentry/spotlight) | custom | local sidecar, dev-time trace UI |
| Local dev trace dashboard | [encoredev/encore](https://github.com/encoredev/encore) | MPL-2.0 | per-request trace view |
| Logs + traces + replay joined | [hyperdxio/hyperdx](https://github.com/hyperdxio/hyperdx) | MIT | session ↔ trace ↔ log joins |
| Replay + network + console correlation | [highlight/highlight](https://github.com/highlight/highlight) | custom | `traceparent` injection in fetch, frontend ↔ backend linking |
| Replay synced to devtools panels | [openreplay/openreplay](https://github.com/openreplay/openreplay) | custom | network and console panels synced to replay |
| Time-travel debugger UI | [replayio/devtools](https://github.com/replayio/devtools) | custom | scrubber synced to source and console |
| Time-travel trace model | [metacraft-labs/codetracer](https://github.com/metacraft-labs/codetracer) | AGPL-3.0, read only | trace format, step back/forward |
| Per-function hooks with source maps | [istanbuljs/babel-plugin-istanbul](https://github.com/istanbuljs/babel-plugin-istanbul) | BSD-3-Clause | the transform pattern for node-agent |
| Fast transforms | [swc-project/swc](https://github.com/swc-project/swc) | Apache-2.0 | `@swc/core` |
| React fibers | [aidenybai/bippy](https://github.com/aidenybai/bippy) | MIT | render hooks, fiber reads |
| Render detection | [aidenybai/react-scan](https://github.com/aidenybai/react-scan) | MIT | what re-rendered and why |
| Element → source file | [ericclemmons/click-to-component](https://github.com/ericclemmons/click-to-component) | MIT | `_debugSource` → file:line |
| Node debugging, source maps | [microsoft/vscode-js-debug](https://github.com/microsoft/vscode-js-debug) | MIT | source-map resolution, breakpoints for deep capture |
| Source maps | [mozilla/source-map](https://github.com/mozilla/source-map) | BSD-3-Clause | `SourceMapConsumer` |
| CDP | [ChromeDevTools/devtools-protocol](https://github.com/ChromeDevTools/devtools-protocol) | BSD-3-Clause | Network, Runtime, Page domains |
| AST route discovery | [dsherret/ts-morph](https://github.com/dsherret/ts-morph) | MIT | find route definitions |
| Nested span rows | [jaegertracing/jaeger-ui](https://github.com/jaegertracing/jaeger-ui) | Apache-2.0 | row layout with duration bars (borrow the row, not the graph) |
| Desktop shell | [electron/electron](https://github.com/electron/electron) | MIT | `WebContentsView`, `webContents.debugger` |
| ADE shell, agent CLI orchestration (closest product cousin) | [stablyai/orca](https://github.com/stablyai/orca) | MIT | how it spawns and streams Claude Code / Codex, embedded Chromium design mode, worktrees, BYO subscription |
| Browser automation for the agent | [microsoft/playwright](https://github.com/microsoft/playwright) | Apache-2.0 | locator strategies, accessibility snapshots |
