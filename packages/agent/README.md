# @shrike/agent

Hosts the debug agent. Shrike doesn't own the brain; it runs the user's own.

## Owns

- Brain detection and auth state: Claude Code and built-in (Codex CLI and OpenCode are planned)
- Adapters that spawn the CLI headless with the Shrike MCP server, their own edit/shell tools disabled, and normalise their JSON streams into `AgentStep`s
- Built-in brain: `@anthropic-ai/sdk` tool-use loop (`claude-sonnet-5`), prompt caching, a 30-step cap
- Prompt loading and variable filling from `prompts/agent/*.md`
- Run lifecycle: start, stream, approvals (delegated to mcp-server), stop, conversation branches

Spec: [docs/05-agent.md](../../docs/05-agent.md). Study [stablyai/orca](https://github.com/stablyai/orca) for CLI spawning and streaming.

```
src/
├── index.ts           # run lifecycle, brain detection
├── prompt.ts          # load + fill {{vars}}
├── claude-code.ts     # spawn Claude Code headless, parse its stream-json
├── builtin.ts         # @anthropic-ai/sdk tool-use loop
├── steps.ts           # tool calls -> AgentStep
├── branches.ts        # conversation branches (C1 to C7)
└── my-mcp.ts          # the user's own MCP servers, read only
```
