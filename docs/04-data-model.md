# 04 · Data model

All types live in `@shrike/schema` as zod schemas, with TS types derived via `z.infer`. Every collector emits `DebugEvent`; the UI and the agent read nothing else.

## Core types

```ts
type Precision = "exact" | "approximate" | "unavailable";

type SourceLocation = {
  file: string;            // repo-relative, forward slashes
  line: number;            // 1-based
  column?: number;
  functionName?: string;
  precision: Precision;
  fileHash?: string;       // sha1 of file contents at record time
};

type DebugEvent = {
  id: string;              // ulid
  sessionId: string;
  traceId: string;
  parentId?: string;
  actionId?: string;
  origin: "browser" | "server" | "db" | "external" | "explorer" | "agent";
  kind:
    | "user_action" | "navigation" | "render"
    | "http_request" | "function" | "db_query" | "external_call"
    | "log" | "error";
  name: string;            // "CLICK 'Add Todo'", "POST /api/todos", "createTodo()"
  startMs: number;         // session-relative, clock-aligned
  durationMs?: number;
  status: "ok" | "slow" | "error";
  source?: SourceLocation;
  framework?: boolean;     // inside node_modules / framework internals
  http?: {
    method: string; url: string; status?: number;
    reqHeaders?: Record<string, string>; resHeaders?: Record<string, string>;
    reqBody?: unknown; resBody?: unknown; sizeBytes?: number;
  };
  db?: { system: string; statement: string; params?: unknown[]; rows?: number };
  log?: { level: "debug" | "info" | "warn" | "error"; message: string; data?: unknown };
  error?: { message: string; type?: string; stack?: string; source?: SourceLocation };
  args?: unknown;          // redacted, ≤ 2KB serialised
  returned?: unknown;      // redacted, ≤ 2KB serialised
  truncated?: boolean;
};

type Action = {
  id: string;
  sessionId: string;
  traceId: string;
  trigger: "click" | "submit" | "input" | "navigation" | "explorer" | "agent" | "server";
  label: string;           // "Clicked 'Add Todo'"
  startMs: number;
  durationMs: number;
  status: "ok" | "slow" | "error";
  stats: { files: number; functions: number; requests: number; queries: number; logs: number; errors: number };
  summary?: WhatHappened;
};

type WhatHappened = {
  headline: string;        // "You clicked Add Todo. The server returned an error."
  steps: { ok: boolean; text: string; eventId: string; source?: SourceLocation }[];
  aiParagraph?: string;
};

type Session = {
  id: string;
  projectId: string;
  startedAt: string;       // ISO
  endedAt?: string;
  git: { repo?: string; branch?: string; sha?: string; dirty: boolean };
  fileSnapshots: Record<string, string>;  // repo path → fileHash, for touched files
  framework: { frontend?: string; backend?: string; versions: Record<string, string> };
  instrumentation: "full" | "basic";       // basic = OTel-only
};

type Scenario = {           // a replayable list of user steps; stored in .shrike/scenarios
  id: string;
  name: string;            // "Add a todo"
  startUrl: string;
  steps: (
    | { type: "click"; target: Locator }
    | { type: "type"; target: Locator; text: string; secret?: boolean }
    | { type: "navigate"; url: string }
    | { type: "request"; request: SavedRequest }
    | { type: "wait"; for: "network-idle" | "ms"; ms?: number }
  )[];
  expect?: { noErrors?: boolean; status?: Record<string, number>; textVisible?: string[] };
};

type Locator = { role?: string; name?: string; text?: string; testId?: string; css?: string };

type SavedRequest = {
  id: string; name: string; method: string; url: string;   // url may contain {{vars}}
  headers?: Record<string, string>; query?: Record<string, string>; body?: string;
};

type Route = {
  method: string; path: string;            // "/api/todos/:id"
  handler?: SourceLocation;
  discoveredBy: "static" | "runtime" | "openapi";
  lastExample?: SavedRequest;
};
```

## Agent types

```ts
type AgentRun = {
  id: string; sessionId: string;
  goal: string;                          // user's words
  autonomy: "explain" | "investigate" | "fix";
  model: string;
  status: "running" | "waiting_approval" | "done" | "failed" | "stopped";
  steps: AgentStep[];
  findings?: Finding[];
  patch?: Patch;
  verification?: { scenarioId: string; beforeActionId: string; afterActionId: string; passed: boolean };
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
};

type AgentStep = {
  id: string; index: number;
  kind: "thought" | "tool_call" | "tool_result" | "approval_request" | "message";
  tool?: string; input?: unknown; output?: unknown;   // output redacted
  linkedEventIds?: string[];                          // timeline rows this step refers to
  createdAt: string;
};

type Finding = {
  confidence: "observed" | "likely" | "possible";
  claim: string;                         // plain English
  evidence: { eventId?: string; source?: SourceLocation }[];
};

type Patch = {
  files: { path: string; before: string; after: string }[];
  rationale: string;
  status: "proposed" | "approved" | "applied" | "rejected" | "reverted";
};
```

## SQLite schema (local)

One database per user in the app data dir: `~/Library/Application Support/Shrike/shrike.db` on macOS. Large payloads (bodies, args, rrweb chunks) live in NDJSON blobs; rows hold a `blob_ref`.

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  framework_json TEXT, created_at TEXT NOT NULL, last_opened_at TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL, ended_at TEXT,
  git_json TEXT, snapshots_json TEXT, instrumentation TEXT NOT NULL
);

CREATE TABLE actions (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  trace_id TEXT NOT NULL, trigger TEXT NOT NULL, label TEXT NOT NULL,
  start_ms REAL NOT NULL, duration_ms REAL, status TEXT NOT NULL,
  stats_json TEXT, summary_json TEXT
);
CREATE INDEX actions_session ON actions(session_id, start_ms);

CREATE TABLE events (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  action_id TEXT, trace_id TEXT NOT NULL, parent_id TEXT,
  origin TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
  start_ms REAL NOT NULL, duration_ms REAL, status TEXT NOT NULL,
  file TEXT, line INTEGER, col INTEGER, function_name TEXT, precision TEXT,
  framework INTEGER NOT NULL DEFAULT 0,
  http_method TEXT, http_url TEXT, http_status INTEGER,
  message TEXT,                    -- log message or error message, for search
  blob_ref TEXT                    -- file:offset:length into the session NDJSON
);
CREATE INDEX events_action ON events(action_id, start_ms);
CREATE INDEX events_file ON events(session_id, file, line);
CREATE VIRTUAL TABLE events_fts USING fts5(name, message, http_url, file, content='events', content_rowid='rowid');

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  goal TEXT NOT NULL, autonomy TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
  findings_json TEXT, patch_json TEXT, verification_json TEXT, usage_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE agent_steps (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL, kind TEXT NOT NULL, tool TEXT,
  input_json TEXT, output_ref TEXT, linked_event_ids TEXT, created_at TEXT NOT NULL
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
```

Retention: keep the last 20 sessions per project by default; older ones are deleted with their blobs. Configurable.

## Project folder: `.shrike/` (committed to the user's repo)

```
.shrike/
├── config.json          # dev command, app URL, ports, allowlisted origins, redaction rules
├── collections/         # saved API requests, one JSON file per request (Bruno-style)
│   └── todos/create-todo.json
├── scenarios/           # replayable user flows the agent can re-run
│   └── add-a-todo.json
└── .gitignore           # ignores local-only files
```

`config.json` example:

```json
{
  "devCommand": "npm run dev",
  "appUrl": "http://localhost:5173",
  "serverUrl": "http://localhost:3001",
  "traceOrigins": ["http://localhost:3001"],
  "redact": { "headers": ["x-internal-key"], "bodyFields": ["ssn"] },
  "ignore": ["src/generated/**"]
}
```

## Export format: `.shriketrace`

A zip:

```
manifest.json         # format version, session metadata, git info, app version
events.ndjson         # DebugEvents (already redacted)
actions.json
rrweb/<actionId>.json # DOM recording chunks
sources/<path>        # snapshots of touched files only
agent/<runId>.json    # optional
```

Opening a trace never touches the live repo. Sources come from the snapshot.

## Ingest wire format (agents → main)

- **Node agent:** OTLP/HTTP JSON for spans and logs (`POST /v1/traces`, `/v1/logs`), plus `POST /shrike/v1/events` for function events in batches of up to 500.
- **Browser agent:** WebSocket messages `{ type: "events", events: DebugEvent[] }` and `{ type: "rrweb", actionId, chunk }`.
- Every request carries `x-shrike-token`. Wrong or missing token gets a 401, and the payload is dropped.
- Main validates with zod, redacts, then stores. Invalid payloads are logged and dropped, never crash the ingest.
