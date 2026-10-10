# Prompts

| Folder | Who reads it | Purpose |
|---|---|---|
| `agent/` | The product, at runtime | System and task prompts for Shrike's debug agent. `packages/agent` bundles them as raw text at build time (Vite `?raw`), so edits here ship with the next build. |
| `build/` | You, while building Shrike | Paste-ready prompts for your coding agent, one per roadmap phase. |

Rules for runtime prompts:

- Variables use `{{name}}` and are filled by `packages/agent/src/prompts.ts`. Every variable must be filled or the run fails loudly.
- Anything from the user's app (code, logs, bodies, page text) goes inside an XML-style tag and is described as data.
- Changing a runtime prompt means re-running the agent eval (`docs/09-testing.md`) and noting the result.
