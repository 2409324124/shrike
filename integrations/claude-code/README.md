# Shrike for Claude Code

A Claude Code plugin that connects the Claude Code in your terminal to the Shrike app on your machine. Claude reads the same recordings Shrike shows you, and still changes code only after you click Apply in Shrike.

## Install

In Claude Code:

```
/plugin marketplace add SumantxD/shrike
/plugin install shrike@shrike
```

Or from your shell: `claude plugin marketplace add SumantxD/shrike`, then `claude plugin install shrike@shrike`. Keep Shrike open while you use it. There is nothing to paste: the plugin finds Shrike by itself.

Needs Node 22.18 or later on your `PATH` for the bridge. The trip line and `/shrike` need Claude Code 2.1.287 or later (mods); Shrike's tools and the skill work on earlier versions.

## What it adds

| Part | What it does |
|---|---|
| Shrike's tools (`plugin:shrike:shrike` in `/mcp`) | The tools from [docs/05-agent.md](../../docs/05-agent.md#outside-shrike-mcp-for-any-agent): recordings, code, API, the app, `propose_patch`, and the tools that drive Shrike (`run_app`, `list_trips`, `focus_trip`, flows) |
| The skill `/shrike:debug` | How to debug with Shrike: reproduce, read the trip, change code only through `propose_patch`, run it again to check. The same text as [prompts/connect/SKILL.md](../../prompts/connect/SKILL.md) |
| The trip line | One line above the prompt with the latest trip: its name, worked or broke, and where it broke (`server/todos.controller.ts:18`). It changes when Shrike records a new trip and shows nothing while Shrike is closed |
| `/shrike` | The same summary as text, for places that don't draw the line (the VS Code chat panel, `claude -p`) |
| Send code changes through Shrike (off by default) | While Shrike is connected, Claude's own Edit and Write on files in your project are turned back with a note to use `propose_patch`. Turn it on with `/plugin configure shrike@shrike` |

## How it connects

Shrike keeps its MCP server's address and token in `mcp.json` in its own app data folder (macOS: `~/Library/Application Support/Shrike/mcp.json`, mode 0600). The plugin's MCP server is a small bridge, [bridge/bridge.mjs](bridge/bridge.mjs) with no dependencies, that Claude Code starts over stdio. On each new session it reads that file and forwards every message to Shrike on `127.0.0.1`. When Shrike restarts or you press **New token**, it reads the file again and carries on. When Shrike isn't open, `/mcp` shows: "Shrike isn't running. Open Shrike, then run /mcp in Claude Code and reconnect plugin:shrike:shrike."

`SHRIKE_MCP_CONFIG=/path/to/mcp.json` points the bridge at another file. Without it, it reads the newest of the packaged app's file and the one from `pnpm dev` (`@shrike/desktop`).

The trip line polls Shrike's `list_trips` through that same connection every 4 seconds and redraws only when the trip changes.

## Trust

- No secrets live in this plugin or the repo. The token stays in Shrike's own file and goes only to `127.0.0.1`; the bridge refuses any other address.
- Claude changes code through `propose_patch`, which waits for your click in Shrike. The plugin adds no tool that writes files or runs commands, and the mod only reads.
- Shrike never writes Claude Code's files (`~/.claude`, `~/.claude.json`, a project's `.claude` or `.mcp.json`). Claude Code installs and configures the plugin itself.
- The opt-in guard is a reminder for Claude, not a lock. To stop Claude Code's own edits and shell for certain, add the deny settings from Shrike's Tools panel (step 3) to your project's `.claude/settings.local.json`.
- A mod runs inside Claude Code with your permissions. `claude plugin validate integrations/claude-code` lists every event it hooks and every call it makes: `$.mcp.call` to Shrike's `list_trips`, a timer, the `/shrike` command, drawing, and reading the session's folder for the guard.

## Develop

```sh
node --test integrations/claude-code/test/*.test.mjs   # bridge, trip parsing, guard, skill copy
cd integrations/claude-code && claude plugin test       # the mod, with Shrike stubbed
claude plugin validate integrations/claude-code
claude --plugin-dir integrations/claude-code            # load it for one session
```

The skill is a copy of `prompts/connect/SKILL.md` with `name: debug` (a skill named `shrike` would take the `/shrike` command). A test fails when the two drift. Tested with Claude Code 2.1.280 (`claude plugin validate`, `claude plugin test` and `claude mcp list` against a real Shrike MCP server). Before 2.1.287, `claude plugin test` needs `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.
