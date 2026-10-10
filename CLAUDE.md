# Shrike: working rules for coding agents

Shrike is an Agentic Debugging Environment: an Electron app that runs a user's web app, records what it does end to end, and lets the user's own coding agent debug it through MCP tools. Read `MASTER_PROMPT.md` first, then the docs it lists.

## Where things are

- Product, architecture, data model, agent, design, security, roadmap, testing, GTM: `docs/01` to `docs/10`
- Runtime agent prompts: `prompts/agent/`. Build prompts per phase: `prompts/build/phases.md`
- Each app and package README says what it owns, its planned `src/` layout, and its "done when" check
- Fixtures the product is tested against: `fixtures/`

## How to build

- Work one roadmap phase at a time (`docs/08-roadmap.md`). A phase is done when its "done when" check passes against the fixtures, and you've shown it running.
- The killer demo in `MASTER_PROMPT.md` is the spec. If a choice doesn't serve it, defer it.
- Decisions in `docs/02` and `docs/03` are made. If you think one is wrong, say why and stop; don't silently swap it.
- Keep `docs/` true. If the implementation diverges from a doc, update the doc in the same change.

## Code rules

- TypeScript `strict`. zod-validate every payload that crosses a process boundary; types come from `@shrike/schema`.
- `packages/node-agent` and `packages/browser-agent` run inside users' apps: minimal dependencies, every hook wrapped, never crash or slow the host app.
- Redaction (`@shrike/redact`) runs before anything is stored, shown, sent to an agent or exported. Never add a path around it.
- Agents change code only through `propose_patch` and the user's click. Never add a tool that applies code, runs shell commands, or reaches non-project origins.
- `correlator`, `redact`, `scanner` and heuristics stay free of Electron imports so they're testable with `node:test`.
- One runnable `node:test` check per non-trivial module (list in `docs/09-testing.md`). Playwright `_electron` for e2e.
- Changing a file in `prompts/agent/` means re-running the agent eval and recording the result.
- All visual work follows `design-system/` (tokens in `design-system/tokens.ts`, catalogue with component IDs in `design-system/README.md`). No hard-coded colours; new visual elements get an ID there first.
- User-facing copy follows `docs/06-design.md` (copy rules) and the glossary in `docs/01-product.md`. No em dashes in UI copy or docs.
- Minimal, surgical diffs. No abstractions, dependencies or files nobody asked for.
