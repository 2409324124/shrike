# 08 · Roadmap

Every phase has a "done when" check run against the fixtures. Don't start a phase until the previous one passes. Sizes are relative (S ≈ days, M ≈ 1–2 weeks, L ≈ 3+ weeks for one engineer with an AI agent).

## Milestones

| Milestone | Phases | What you can show |
|---|---|---|
| **M0 Spike** | 0 | Proof the risky instrumentation works on Express and Next.js |
| **M1 Demo** | 1–5 | The killer demo end to end, manually: click, timeline, highlighted line |
| **M2 Private beta** | 6–8 | Agent finds and fixes the planted bugs; 20 beta users |
| **M3 Public launch** | 9–11 | Open source repo, signed builds, website, optional cloud |

## Phases

| # | Phase | Size | Build | Done when |
|---|---|---|---|---|
| 0 | **Instrumentation spike** | M | Throwaway scripts: OTel + SWC loader on the Express fixture; config-wrap injection on the Next.js fixture (webpack and Turbopack); `traceparent` from a browser fetch joining the server trace; React 18 and 19 element → file:line | A written note in `docs/spikes/` with what works, what doesn't, and the chosen approach per framework |
| 1 | **Shell** | M | Electron app, project open, Monaco + file tree, Run spawns dev command, URL detection, app pane, terminal tab | Open `fixtures/todo-app`, press Run, use the app inside Shrike, edit a file |
| 2 | **Scanner + API explorer** | M | Framework detection, route discovery, searchable list, request editor, send, cURL copy/import, collections in `.shrike/` (now the Bruno-style API client, docs/13 AP) | All fixture routes listed with zero config; search filters; sent request shows response and timing |
| 3 | **Browser capture** | M | CDP collectors, browser-agent with rrweb, action windows, fetch patch, fiber → file:line, ingest WS, schema + store | Clicking Add Todo creates an Action with the click (`TodoForm.tsx:31`) and the POST nested under it |
| 4 | **Server capture** | L | node-agent: OTel, SWC function hooks, AsyncLocalStorage, console capture, OTLP ingest, clock alignment, correlator tree, redaction on ingest | Same click shows `createTodo()` → DB insert → error under the POST, with durations, on both Express and Next fixtures |
| 5 | **Timeline + playback** | L | Timeline tree, jump-to-source, inline values and logs, heat gutter, step/play/scrub, rrweb replay sync, git-aware sessions, search | Arrow keys step the demo; highlight lands on `todos.controller.ts:18` with `userId: undefined` inline |
| 6 | **What happened? + heuristics** | M | Deterministic summary card, all heuristics from [05-agent.md](05-agent.md#deterministic-heuristics-run-locally-no-ai) | Slow, N+1 and waterfall fixture endpoints flagged at the right file:line |
| 7 | **MCP server + tools** | L | All tools, autonomy gate, approvals, scenarios, deep capture | An MCP client (Claude Code from a terminal) can reproduce the demo bug and read the failing line using only Shrike tools |
| 8 | **Agent host + brains** | L | Claude Code adapter first, then built-in, Codex, OpenCode; agent panel; Found it card; diff + apply + revert; verify by re-run | Agent eval ([09-testing.md](09-testing.md)) ≥ 80% localisation, ≥ 60% verified fixes on the bug corpus |
| 9 | **Hardening** | M | Perf budget, event caps, crash fallbacks, onboarding, settings, Windows + Linux, signed builds, auto-update | Overhead < 15%; cold start to first Action < 5 min for a new user on all three OSes |
| 10 | **Share + cloud** | M | `.shriketrace` export/import, `apps/cloud` (auth, share links, hosted key, billing), web viewer | A shared link opens a read-only recording in the browser; revoking it works |
| 11 | **Launch** | M | `apps/site`, docs site, demo video, open source repo hygiene (CONTRIBUTING, licence, issue templates) | See [10-go-to-market.md](10-go-to-market.md) launch checklist |

Phase 9, Windows and Linux (2026-10-11): Linux builds (AppImage, `.deb`, x64 and arm64) from `scripts/release/build-linux.sh` and in CI, without voice; not released yet. Windows has its code paths (cmd.exe, taskkill, junctions) and an NSIS target but hasn't been run on Windows. Details and what was checked: [14-compatibility.md](14-compatibility.md#operating-systems).

## After launch (ordered by expected demand)

1. Flow review polish and "make this page faster" agent goal
2. Vite SSR, Remix/React Router, SvelteKit, Nuxt frontends
3. Python backends (`sys.monitoring` on 3.12+): done for FastAPI, Flask and Django with sqlite3 (`packages/python-agent`, docs/14 "Python backends"); next: outgoing calls, logs, more database drivers
4. Mobile companion: get notified when an agent run finishes, approve patches from your phone (Orca has this; same pattern)
5. Team history: shared recordings, comments on timeline rows
6. Parallel hypotheses: run two agent brains on the same bug in separate worktrees and compare (Orca-style fan-out)

## Biggest risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| Next.js / Turbopack instrumentation breaks across versions | Most vibe-coded apps are Next.js | Phase 0 spike; version matrix in CI; OTel-only fallback always works |
| Overhead makes apps feel slow | Users uninstall | Hooks on user files only; size caps; measure in CI |
| Agent CLIs change flags or output formats | Adapters break | Adapter contract tests pinned to CLI versions; built-in brain as a fallback |
| Users won't trust it with their data | Adoption | Open source, local-first, visible redaction, "what was sent" drawer |
| "Just use Cursor + Chrome DevTools MCP" | Competition | Our edge is backend function-level tracing joined to the click, which no browser-only tool sees |
