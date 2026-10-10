# 05 · The debug agent

The agent is the product's headline. Shrike doesn't own the brain: it runs **the user's own coding agent** and gives it tools that act on the running app and read Shrike's recordings. All tools are served by `@shrike/mcp-server`, which also enforces autonomy levels and approvals, so the rules are the same whichever brain is driving.

## Agent brains

| Brain | How Shrike runs it | Notes |
|---|---|---|
| **Claude Code** | Child process, headless (`claude -p`), `--mcp-config` pointing at Shrike, `--allowedTools` limited to `mcp__shrike__*`, `--output-format stream-json` | Default when installed. Uses the user's Claude subscription. |
| **Codex CLI** | `codex exec` with Shrike in its MCP config, read-only sandbox, JSON event output | Uses the user's ChatGPT/OpenAI plan. |
| **OpenCode** | Headless run with Shrike as an MCP server, its edit/bash tools disabled | Any model OpenCode supports. |
| **Built-in** | `@anthropic-ai/sdk` tool-use loop in the main process, user's API key (or hosted key on a paid plan) | Fallback when no CLI is installed. Same tools, called in-process. |

Rules for every brain:

- **Disable the brain's own file-edit and shell tools.** Code changes must go through `propose_patch` so the user sees a diff. If a CLI can't disable them, run it in a read-only sandbox or a throwaway git worktree and turn any changes it makes into a proposed patch.
- **Same system prompt** ([prompts/agent/system.md](../prompts/agent/system.md)), passed through each CLI's system-prompt option or prepended to the task.
- **Normalise the stream.** `packages/agent/src/brains/<name>.ts` turns each CLI's JSON events into `AgentStep`s for the agent panel. Detect the CLI and its auth state at startup; show "Sign in to Claude Code" rather than failing.
- Before writing an adapter, read how [stablyai/orca](https://github.com/stablyai/orca) spawns and streams these CLIs.

## The loop

```
         ┌────────────────────────────────────────────────────────────┐
 goal ──▶│ 1 Understand   restate the bug, pick or build a scenario   │
         │ 2 Reproduce    drive the app / send the request            │
         │ 3 Observe      read the Action tree, logs, errors, code    │
         │ 4 Hypothesise  name the suspected line and why             │
         │ 5 Probe        deep-capture a function, vary input, re-run │──┐
         │ 6 Explain      plain-English findings with file:line       │  │ until confident
         │ 7 Fix          propose a patch (needs approval)            │  │ or budget spent
         │ 8 Verify       re-run scenario, compare before/after       │◀─┘
         └────────────────────────────────────────────────────────────┘
```

The user watches each step stream into the agent panel. Every step that refers to a timeline row links to it, so clicking a step moves the editor highlight.

### Example run (the killer demo)

```
You: When I click Add Todo nothing shows up

Agent
 ● Reproducing: typing "buy milk" and clicking Add Todo           [action A7]
 ● The click worked. It sent POST /api/todos and got a server error (500).
 ● Reading what the server did...
 ● createTodo() at todos.controller.ts:14 ran. The database insert at line 18
   failed: "NOT NULL constraint failed: todos.user_id".
 ● Turning on detailed capture for createTodo() and trying again   [action A8]
 ● req.body = { title: "buy milk", userId: 1 }. Line 18 reads req.body.user,
   which is undefined.

 Found it  (Observed)
 Your form sends the user ID as `userId`, but the server reads `user`.
 The database won't save a todo without a user, so it errors.
 → todos.controller.ts:18

 [Show fix]  [Explain more]

You: Show fix

 ● Proposed change to todos.controller.ts (1 line)    [diff view]
 [Apply]  [Reject]

You: Apply

 ● Applied. Re-running "Add a todo"...                             [action A9]
 ● POST /api/todos returned 201 and the todo appears in the list.
 ✓ Fixed and verified. [Undo change]
```

## Autonomy levels

Set per run, default from settings. The level caps which tools the agent can call.

| Level | Can do | Needs approval for |
|---|---|---|
| **Explain** | Read recordings and code | (nothing else allowed) |
| **Investigate** (default) | + drive the app, send requests, deep-capture, re-run scenarios | Requests that change data and weren't part of the user's own reproduction; anything outside allowed origins |
| **Fix** | + propose patches | Every patch apply. Always. |

There is no level that applies code without a click.

## Tools

Defined in `packages/mcp-server/src/tools/`, one file per group, each with a zod input schema converted to JSON Schema. Agent CLIs reach them over MCP; the built-in agent calls the same functions in-process.

### Recordings

| Tool | Input | Returns |
|---|---|---|
| `list_actions` | `{ limit?, status? }` | recent Actions: id, label, status, duration, stats |
| `get_action` | `{ actionId, includeFramework? }` | the event tree, compact (names, timings, status, file:line), no payloads |
| `get_event` | `{ eventId }` | one event with redacted payloads (args, bodies, query, error) |
| `search_events` | `{ query, kind?, status? }` | matching events across the session |
| `get_logs` | `{ actionId?, level? }` | logs with source locations |
| `compare_actions` | `{ beforeId, afterId }` | structured diff: new/missing steps, status and timing changes, errors gone/added |

### App (drives the app pane through CDP)

| Tool | Input | Returns |
|---|---|---|
| `app_snapshot` | `{}` | accessibility tree of the current page with stable element refs, URL, title |
| `app_screenshot` | `{}` | PNG of the app pane |
| `app_click` | `{ ref }` or `{ locator }` | the resulting actionId |
| `app_type` | `{ ref, text, submit? }` | the resulting actionId |
| `app_navigate` | `{ url }` (same origin only) | the resulting actionId |
| `run_scenario` | `{ scenarioId }` or `{ steps }` | actionIds, plus pass/fail against the scenario's `expect` |
| `save_scenario` | `{ name, steps, expect }` | scenarioId (written to `.shrike/scenarios/`) |

### API

| Tool | Input | Returns |
|---|---|---|
| `list_routes` | `{ query? }` | discovered routes with handler file:line |
| `send_request` | `{ method, url, headers?, body? }` | response + actionId of the traced server work |

### Code

| Tool | Input | Returns |
|---|---|---|
| `read_file` | `{ path, startLine?, endLine? }` | contents (recorded snapshot if the trace is older than the file) |
| `search_code` | `{ query, glob? }` | matches with file:line (ripgrep) |
| `list_files` | `{ glob? }` | repo-relative paths, respecting `.gitignore` |

### Probe

| Tool | Input | Returns |
|---|---|---|
| `deep_capture` | `{ file, functionName }` or `{ file, line }` | ok; the next run captures full args, locals at return, and the return value for that function |

Implementation: v1 raises the capture cap for that function id in node-agent. v1.x sets a CDP logpoint (no pause) through `node --inspect` to read locals at a line.

### Fix

| Tool | Input | Returns |
|---|---|---|
| `propose_patch` | `{ files: [{ path, edits: [{ oldText, newText }] }], rationale }` | patchId; UI shows Monaco diff with Apply / Reject |
| `revert_patch` | `{ patchId }` | ok |

`apply` is not a tool. Only the user's click applies a patch. The dev server's hot reload picks it up; the agent then calls `run_scenario` to verify.

### Reporting

| Tool | Input | Returns |
|---|---|---|
| `report_findings` | `{ findings: Finding[], summary }` | renders the Found it card; ends the investigate phase |
| `ask_user` | `{ question, options? }` | the user's answer (for ambiguous goals, logins, test data) |
| `ask_options` | `{ thread?, question, header?, options: [{ id?, label, description, mockupHtml?, preview? }] (2 to 4), multi? }` | Shows the options as cards (docs/13 M) and waits. Returns one JSON line `{ action: vary \| tweak \| combine \| approve \| other \| waiting, thread, option(s)?, count?, text? }`, the mockups it points at, and what to do next. The agent calls it again with the same `thread` and the new cards until `approve`, then builds the approved mockup with `propose_patch`. After 9 minutes (under Claude Code's 10-minute MCP timeout) it returns `waiting` and the cards stay up; calling again with only `thread` keeps waiting. Mockup HTML is redacted on the way in and only ever drawn in a sandboxed iframe |
| `self_review` | `{ results?: [{ lesson, found, fixed?, where? }] }` | Review lessons before a pull request (docs/13 RL5). No results: the lessons the likely reviewers (CODEOWNERS, then recent ones) keep flagging, their conventions and the changed files. With results: recorded on Ship's self-check card ("Checked 6 repeat issues for @ana: 1 found (loading state), fixed"). Reads only; `where` is redacted |
| `preflight` | `{}` | CI lessons pre-flight (docs/13 CI3): runs the CI jobs the current change touches on this computer, the way CI runs them, and returns each job's result, the first failing line and its usual fix. It takes no command: the legs come from the project's CI config or its CI lessons skill, every command goes through the guarded shell (R6), and one CI's config doesn't have asks the user first |

## Context management

- **Start of run (all brains):** system prompt ([prompts/agent/system.md](../prompts/agent/system.md)), project facts (framework, routes count, dev URL), the last 5 Actions as one-line summaries, the user's goal. System prompt and tool definitions are prompt-cached.
- **Tool results are compact by default.** `get_action` returns a tree like the timeline, no bodies. The agent asks for payloads with `get_event` only where needed.
- **Code is pulled, not pushed.** The agent reads files it chooses. We never paste the whole repo.
- **Long runs:** after 20 steps, older tool results are replaced with one-line summaries.

## Budgets and stopping

| Limit | Default |
|---|---|
| Steps per run | 30 |
| App interactions per run | 15 |
| Wall time | 5 minutes |
| Cost (built-in brain only) | shown live; soft cap $0.50 per run, configurable. CLI brains bill to the user's own subscription. |

On hitting a limit, the agent must call `report_findings` with what it has, labelled honestly, and suggest what to try next.

## Guardrails

- **Tool results are data, not instructions.** Page text, logs, response bodies and code comments can contain prompt-injection text. The system prompt says so, and tool outputs are wrapped in clearly delimited blocks.
- **Network scope:** `app_navigate` and `send_request` only reach the project's own origins from `config.json`. No arbitrary internet.
- **No shell tool in v1.** The agent can't run commands. It can suggest one for the user to run.
- **Data-changing requests:** `POST/PUT/PATCH/DELETE` outside a recorded user scenario need an approval click in Investigate mode.
- **Secrets:** login forms. The agent asks the user to log in in the app pane, or uses a scenario step marked `secret` whose value never enters model context.
- **Redaction** runs on every tool output before it reaches the model ([07-security-privacy.md](07-security-privacy.md)).
- **Patches touch user files only** inside the project root, never `node_modules`, `.env*`, lockfiles or `.git`.
- **Undo:** every applied patch keeps the previous contents; one click reverts.

## Honesty rules

Every finding carries a confidence label:

- **Observed:** read directly from the recording ("the server returned 500").
- **Likely:** inferred from observed facts with one step of reasoning.
- **Possible:** a plausible explanation the recording doesn't confirm.

Every claim about code cites `file:line`. If the recording can't answer the question, the agent says what to record next instead of guessing.

## Other AI features (single-shot, not the loop)

| Feature | Trigger | Prompt |
|---|---|---|
| What happened? paragraph | after each Action (debounced, opt-in) | [prompts/agent/what-happened.md](../prompts/agent/what-happened.md) |
| Explain this | button on any row, chip, error, request, code selection | [prompts/agent/explain.md](../prompts/agent/explain.md) |
| Flow review | button on any successful Action; also suggested when heuristics fire | [prompts/agent/flow-review.md](../prompts/agent/flow-review.md) |
| Fix | "Show fix" on a finding (enters the loop at step 7) | [prompts/agent/fix.md](../prompts/agent/fix.md) |
| Critique (prompt chains, docs/13 P3) | a chain step's run ends and the chain decides by score | The [critique skill](../prompts/skills/critique.md) plus the rubric, the run's ask, steps, answer and diff (`critiqueAsk` in `apps/desktop/src/main/chains.ts`). A separate read-only brain call, kept off the agent panel; it ends with `SCORE: n/10` and `WHY:` |

## Deterministic heuristics (run locally, no AI)

These feed the What happened? card and flow review. The AI explains them; it doesn't invent them.

| Heuristic | Rule |
|---|---|
| Slow step | > 100ms and > 30% of its parent |
| N+1 | same normalised query shape ≥ 5× under one request |
| Sequential independent awaits | sibling async calls where the second's args don't use the first's result (from captured args), total > 200ms |
| External dominates | external_call > 50% of request time |
| Browser waterfall | fetch B starts within 20ms of fetch A ending, B's URL/body doesn't contain values from A's response |
| Duplicate requests | identical method + URL + body twice in one Action |
| Swallowed error | server error event, but HTTP status 200 |
| Silent frontend failure | response ≥ 400 and no render or visible text change afterwards |

## Outside Shrike: MCP for any agent

The same MCP server can be added to Cursor, Claude Code or any MCP client running *outside* Shrike, while the Shrike app is open. A user in Cursor can ask "what happened when I clicked Add Todo?" and get the real trace. External clients get Recordings, Code, API and App tools; Fix tools stay inside Shrike where the diff UI lives. Marketing line: *give your coding agent eyes*. See [packages/mcp-server/README.md](../packages/mcp-server/README.md).
