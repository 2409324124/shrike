import type { AgentRunInfo, McpCatalogEntry, McpHubState, McpServerView, ShrikeApi } from "@shrike/schema";
import catalog from "../../../main/mcp-catalog.json";

// MCP in the dev mock (renderer only): one of Claude Code's servers working, one of Shrike's needing a token, one from the repo to trust.

const now = Date.now();
let servers: McpServerView[] = [
  { name: "chrome-devtools", source: "claude-user", transport: "stdio", command: "npx -y chrome-devtools-mcp@latest", envNames: [], headerNames: [], purpose: (catalog as McpCatalogEntry[])[0]!.purpose, glyph: "browser", catalogId: "chrome-devtools", enabled: true, trusted: true, missing: [], health: { state: "ok", at: now, ms: 1840, tools: [{ name: "take_snapshot", description: "Take a text snapshot of the page" }, { name: "click", description: "Clicks on the provided element" }, { name: "list_console_messages", description: "List all console messages" }] } },
  { name: "github", source: "shrike-personal", transport: "http", url: "https://api.githubcopilot.com/mcp/", envNames: [], headerNames: ["Authorization"], purpose: "Reads and writes issues, pull requests, code and checks on GitHub.", glyph: "git", catalogId: "github", enabled: true, trusted: true, missing: [], health: { state: "failed", at: now, ms: 420, error: "It needs you to sign in or a valid token. For servers that sign in, run claude in a terminal, type /mcp and sign in there." } },
  { name: "pencil", source: "claude-project", transport: "stdio", command: "pencil mcp", envNames: ["PENCIL_TOKEN"], headerNames: [], purpose: "Your own tool server.", glyph: "plug", enabled: true, trusted: false, missing: [] },
];
let dismissed: string[] = [];
let listener: (s: McpHubState) => void = () => {};
export const onMockMcp = (fn: (s: McpHubState) => void): void => void (listener = fn);
const state = (): McpHubState => ({ servers, catalog: catalog as McpCatalogEntry[], recommended: [{ id: "stripe", why: "Your app uses Stripe." }, { id: "sqlite", why: "Your app uses a SQLite database." }].filter((r) => !dismissed.includes(r.id) && !servers.some((s) => s.name === r.id)), project: "/mock/todo-app" });
const put = (fn: (s: McpServerView[]) => McpServerView[]) => ((servers = fn(servers)), listener(state()), state());

export const mcpMock: Pick<ShrikeApi, "mcpState" | "mcpCheck" | "mcpSetEnabled" | "mcpTrust" | "mcpAdd" | "mcpRemove" | "mcpFix" | "mcpDismiss"> = {
  async mcpState() {
    return state();
  },
  async mcpCheck() {
    return state();
  },
  async mcpSetEnabled(name, on) {
    return put((l) => l.map((s) => (s.name === name ? { ...s, enabled: on } : s)));
  },
  async mcpTrust(name) {
    return put((l) => l.map((s) => (s.name === name ? { ...s, trusted: true, health: { state: "ok", at: Date.now(), ms: 300, tools: [{ name: "open_document" }] } } : s)));
  },
  async mcpAdd(req) {
    const e = (catalog as McpCatalogEntry[]).find((c) => req.kind === "catalog" && c.id === req.id);
    const name = e?.id ?? (req.kind === "paste" ? (req.name ?? "my-tool") : "my-tool");
    return put((l) => [...l.filter((s) => s.name !== name), { name, source: req.scope === "project" ? "shrike-project" : "shrike-personal", transport: e?.transport ?? "stdio", command: e?.command ? [e.command, ...(e.args ?? [])].join(" ") : undefined, envNames: Object.keys(e?.env ?? {}), headerNames: [], purpose: e?.purpose ?? "Your own tool server.", glyph: e?.glyph ?? "plug", catalogId: e?.id, enabled: true, trusted: true, missing: [], health: { state: "checking", at: Date.now() } }]);
  },
  async mcpRemove(name) {
    return put((l) => l.filter((s) => s.name !== name));
  },
  async mcpFix(name) {
    return { id: "mock-fix", goal: `Fix ${name}`, brain: "claude-code", status: "running" } as AgentRunInfo;
  },
  async mcpDismiss(id) {
    dismissed = [...dismissed, id];
    return state();
  },
};
