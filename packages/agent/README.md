# @shrike/agent

Hosts the debug agent. Shrike doesn't own the brain; it runs the user's own.

## Owns

- Brain detection and auth state: Claude Code, Codex CLI, OpenCode, built-in
- Adapters that spawn each CLI headless with the Shrike MCP server, their own edit/shell tools disabled, and normalise their JSON streams into `AgentStep`s
- Built-in brain: `@anthropic-ai/sdk` tool-use loop (`claude-sonnet-5` default, `claude-opus-5-5` deep), prompt caching, budgets
- Prompt loading and variable filling from `prompts/agent/*.md`
- Run lifecycle: start, stream, approvals (delegated to mcp-server), stop, budgets, persistence

Spec: [docs/05-agent.md](../../docs/05-agent.md). Study [stablyai/orca](https://github.com/stablyai/orca) for CLI spawning and streaming.

```
src/
├── host.ts            # run lifecycle
├── prompts.ts         # load + fill {{vars}}
├── brains/
│   ├── detect.ts
│   ├── claude-code.ts
│   ├── codex.ts
│   ├── opencode.ts
│   └── builtin.ts
└── budget.ts
```
