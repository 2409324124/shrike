import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMcpServer } from "@shrike/agent";
import { parseSkill } from "@shrike/mcp-server";
import { detectProject } from "@shrike/scanner";
import { CATALOG, catalogEntry, configFile, createMcpHub, mcpServerOfStep, parsePaste, recommend, type Keychain } from "./mcp.ts";

// A fake keychain: reversible, and never the plain value on disk.
const keychain: Keychain = { encrypt: (s) => `enc:${Buffer.from(s).toString("base64")}`, decrypt: (s) => Buffer.from(s.replace(/^enc:/, ""), "base64").toString() };
const repo = join(import.meta.dirname, "../../../..");
const echo = join(repo, "packages/agent/test/fixtures/echo-mcp.mjs");

function world() {
  const home = mkdtempSync(join(tmpdir(), "shrike-mcp-home-"));
  const root = mkdtempSync(join(tmpdir(), "shrike-mcp-proj-"));
  const state = mkdtempSync(join(tmpdir(), "shrike-mcp-state-"));
  const claude = JSON.stringify({
    mcpServers: { "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] }, pencil: { command: "pencil", env: { PENCIL_TOKEN: "pencil-secret-123" } } },
    projects: { [root]: { mcpServers: { local: { command: "local-one" } } } },
  });
  writeFileSync(join(home, ".claude.json"), claude);
  const mcpJson = JSON.stringify({ mcpServers: { repo: { command: "node", args: ["repo.js"] }, pencil: { command: "pencil-from-repo" } } });
  writeFileSync(join(root, ".mcp.json"), mcpJson);
  const checks: string[] = [];
  const hub = createMcpHub({ home, stateDir: state, keychain, check: async (c) => (checks.push(String(c.command ?? c.url)), { ok: true, tools: [{ name: "t" }], ms: 5 }) });
  return { home, root, state, hub, checks, claude, mcpJson };
}

test("MCP zod: configs, the add request and every catalog entry", () => {
  assert.ok(configFile.safeParse({ mcpServers: { a: { command: "npx", args: ["x"] }, b: { type: "http", url: "https://x.dev/mcp" } } }).success);
  assert.ok(!configFile.safeParse({ mcpServers: { shrike: { command: "x" } } }).success, "shrike is Shrike's own");
  assert.ok(!configFile.safeParse({ mcpServers: { "bad name": { command: "x" } } }).success);
  assert.ok(!configFile.safeParse({ mcpServers: { a: { url: "file:///etc/passwd" } } }).success, "web addresses only");
  assert.ok(!configFile.safeParse({ mcpServers: { a: { env: { A: "1" } } } }).success, "a command or a url");
  // Catalog: valid, unique, at least the popular ones, each ${NAME} it uses asked for by a field (or the project folder).
  assert.ok(CATALOG.length >= 14);
  assert.equal(new Set(CATALOG.map((e) => e.id)).size, CATALOG.length);
  for (const id of ["chrome-devtools", "playwright", "github", "postgres", "supabase", "sqlite", "filesystem", "fetch", "sentry", "linear", "figma", "stripe", "context7", "memory"]) assert.ok(CATALOG.some((e) => e.id === id), id);
  for (const e of CATALOG) {
    assert.ok(catalogEntry.safeParse(e).success, e.id);
    const holes = [...JSON.stringify([e.args, e.env, e.headers, e.url]).matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]!).filter((k) => k !== "PROJECT_ROOT");
    assert.deepEqual([...new Set(holes)].sort(), e.fields.map((f) => f.name).sort(), `${e.id} fields match its placeholders`);
    assert.ok(!/—/.test(JSON.stringify(e)), `${e.id}: no em dashes`);
  }
});

test("MCP merge: Shrike's own beat Claude Code's, narrower scope wins, off and untrusted servers stay out of a run", async () => {
  const { hub, root, home } = world();
  mkdirSync(join(home, ".shrike"));
  writeFileSync(join(home, ".shrike", "mcp.json"), JSON.stringify({ mcpServers: { "chrome-devtools": { command: "my-chrome" } } }));
  const st = await hub.state(root);
  const by = Object.fromEntries(st.servers.map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(by).sort(), ["chrome-devtools", "local", "pencil", "repo"]);
  assert.equal(by["chrome-devtools"]!.source, "shrike-personal");
  assert.deepEqual(by["chrome-devtools"]!.shadows, ["claude-user"]);
  assert.equal(by.pencil!.source, "claude-project", ".mcp.json beats ~/.claude.json, like Claude Code");
  assert.equal(by.local!.source, "claude-local");
  assert.equal(by.repo!.trusted, false, "a project file needs a trust click");
  assert.deepEqual(by.pencil!.envNames, [], "the repo's pencil has no env");
  assert.ok(!JSON.stringify(st).includes("pencil-secret-123"), "env values never reach the renderer");

  let run = await hub.servers(root);
  assert.deepEqual(Object.keys(run).sort(), ["chrome-devtools", "local"], "untrusted project servers aren't passed");
  await hub.trust(root, "repo");
  await hub.trust(root, "pencil");
  await hub.setEnabled(root, "local", false);
  run = await hub.servers(root);
  assert.deepEqual(Object.keys(run).sort(), ["chrome-devtools", "pencil", "repo"]);
  assert.equal(run["chrome-devtools"]!.command, "my-chrome");
  // Trust is for that exact config: a changed file asks again.
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { repo: { command: "node", args: ["evil.js"] } } }));
  assert.ok(!Object.keys(await hub.servers(root)).includes("repo"));
  // The per-project switch is per project.
  const other = mkdtempSync(join(tmpdir(), "shrike-mcp-other-"));
  assert.ok(Object.keys(await hub.servers(other)).includes("chrome-devtools"));
});

test("MCP merge: Claude Code's own approval of .mcp.json servers counts as trust", async () => {
  const { hub, root, home } = world();
  const c = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  c.projects[root].enabledMcpjsonServers = ["repo"];
  writeFileSync(join(home, ".claude.json"), JSON.stringify(c));
  assert.ok(Object.keys(await hub.servers(root)).includes("repo"));
});

test("MCP add: catalog and paste write only Shrike's files; secrets go to the keychain, never plain; Claude Code's files untouched", async () => {
  const { hub, root, home, state, claude, mcpJson } = world();
  const plans = await hub.plan(root, { kind: "catalog", id: "github", scope: "personal", values: { GITHUB_TOKEN: "ghp_supersecret123456" } });
  assert.equal(plans[0]!.file, join(home, ".shrike", "mcp.json"));
  assert.ok(!existsSync(plans[0]!.file), "planning writes nothing");
  await hub.commit(root, plans);
  const file = readFileSync(join(home, ".shrike", "mcp.json"), "utf8");
  assert.ok(!file.includes("ghp_supersecret"), "the file has the placeholder only");
  assert.match(file, /Bearer \$\{GITHUB_TOKEN\}/);
  const secrets = readFileSync(join(state, "mcp-secrets.json"), "utf8");
  assert.ok(!secrets.includes("ghp_supersecret") && secrets.includes("enc:"), "the keychain holds it");
  const run = await hub.servers(root);
  assert.equal((run.github!.headers as Record<string, string>).Authorization, "Bearer ghp_supersecret123456", "filled only for the run");
  const view = (await hub.state(root)).servers.find((s) => s.name === "github")!;
  assert.deepEqual([view.source, view.catalogId, view.glyph, view.headerNames], ["shrike-personal", "github", "git", ["Authorization"]]);
  assert.ok(!JSON.stringify(view).includes("ghp_"));

  // A field that isn't a secret (a project ref) goes in as text; one that's missing refuses.
  await assert.rejects(hub.plan(root, { kind: "catalog", id: "supabase", scope: "project", values: { SUPABASE_PROJECT_REF: "abc" } }), /needs Access token/);
  const sb = await hub.plan(root, { kind: "catalog", id: "supabase", scope: "project", values: { SUPABASE_PROJECT_REF: "abcdef", SUPABASE_ACCESS_TOKEN: "sbp_token_value_1" } });
  assert.deepEqual(sb[0]!.config.args, ["-y", "@supabase/mcp-server-supabase@latest", "--read-only", "--project-ref=abcdef"]);
  assert.deepEqual(sb[0]!.values, { SUPABASE_ACCESS_TOKEN: "sbp_token_value_1" });
  await hub.commit(root, sb);
  assert.ok(existsSync(join(root, ".shrike", "mcp.json")));
  assert.equal((await hub.state(root)).servers.find((s) => s.name === "supabase")!.trusted, true, "you added it, so it's trusted");
  await assert.rejects(hub.plan(root, { kind: "catalog", id: "filesystem", scope: "personal", values: {} }), /only works per project/);
  const fs = await hub.plan(root, { kind: "catalog", id: "filesystem", scope: "project", values: {} });
  await hub.commit(root, fs);
  assert.deepEqual((await hub.servers(root)).filesystem!.args, ["-y", "@modelcontextprotocol/server-filesystem", root], "scoped to this project's folder");

  // Paste: a README's claude mcp add line with an inline token.
  const pasted = await hub.plan(root, { kind: "paste", text: 'claude mcp add --transport http sentry https://mcp.sentry.dev/mcp --header "Authorization: Bearer sntrys_abcdef123"', scope: "personal", values: {} });
  assert.equal(pasted[0]!.name, "sentry");
  assert.deepEqual(pasted[0]!.config, { type: "http", url: "https://mcp.sentry.dev/mcp", headers: { Authorization: "${SENTRY_AUTHORIZATION}" } });
  await hub.commit(root, pasted);
  assert.ok(!readFileSync(join(home, ".shrike", "mcp.json"), "utf8").includes("sntrys_"));

  // Remove: Shrike's own only.
  await assert.rejects(hub.remove(root, "chrome-devtools"), /never edits those/);
  await hub.remove(root, "github");
  assert.ok(!(await hub.state(root)).servers.some((s) => s.name === "github"));
  assert.ok(!readFileSync(join(state, "mcp-secrets.json"), "utf8").includes("personal:github"));

  assert.equal(readFileSync(join(home, ".claude.json"), "utf8"), claude, "~/.claude.json never written");
  assert.equal(readFileSync(join(root, ".mcp.json"), "utf8"), mcpJson, ".mcp.json never written");
  assert.ok(!existsSync(join(home, ".claude")) && !existsSync(join(root, ".claude")));
});

test("MCP paste: JSON, a bare command, an address; inline values move to the keychain; bad input says why", () => {
  const a = parsePaste('{ "mcpServers": { "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] } } }');
  assert.deepEqual(a.servers, { playwright: { command: "npx", args: ["@playwright/mcp@latest"] } });
  const b = parsePaste("GITHUB_TOKEN=ghp_x1234567 npx -y @modelcontextprotocol/server-github");
  assert.deepEqual(b.servers, { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" } } });
  assert.deepEqual(b.values, { GITHUB_TOKEN: "ghp_x1234567" });
  const c = parsePaste("npx -y @modelcontextprotocol/server-postgres postgres://me:hunter2@localhost/app");
  assert.deepEqual(c.servers.postgres!.args, ["-y", "@modelcontextprotocol/server-postgres", "${POSTGRES_ARG2}"]);
  assert.equal(c.values.POSTGRES_ARG2, "postgres://me:hunter2@localhost/app");
  assert.deepEqual(parsePaste("https://mcp.linear.app/mcp").servers, { linear: { type: "http", url: "https://mcp.linear.app/mcp" } });
  assert.deepEqual(Object.keys(parsePaste("claude mcp add chrome-devtools -- npx chrome-devtools-mcp@latest").servers), ["chrome-devtools"]);
  assert.deepEqual(Object.keys(parsePaste('{ "command": "uvx", "args": ["mcp-server-fetch"] }').servers), ["fetch"]);
  const d = parsePaste("npx -y some-mcp --api-key plainvalue42 --token=ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  assert.deepEqual(d.servers.some!.args, ["-y", "some-mcp", "--api-key", "${SOME_ARG3}", "${SOME_ARG4}"]);
  assert.equal(d.values.SOME_ARG3, "plainvalue42");
  const e = parsePaste("https://mcp.ctx.dev/sse?apiKey=sekret99&x=1");
  assert.equal(e.servers.ctx!.url, "https://mcp.ctx.dev/sse?apiKey=${CTX_APIKEY}&x=1");
  assert.equal(e.values.CTX_APIKEY, "sekret99");
  assert.throws(() => parsePaste("{ nope"), /doesn't parse/);
  assert.throws(() => parsePaste('{ "mcpServers": { "shrike": { "command": "x" } } }'), /Shrike's own/);
  assert.throws(() => parsePaste('{ "mcpServers": { "a": { "url": "ftp://x" } } }'), /a:/);
});

test("MCP3: recommendations from the fixtures' project info, at most three, never what you have or dismissed", async () => {
  const todo = await detectProject(join(repo, "fixtures/todo-app"));
  const shop = await detectProject(join(repo, "fixtures/shop-app"));
  const ids = (p: typeof todo, o: { github?: boolean; have?: string[]; dismissed?: string[] } = {}) => recommend({ places: p.expectedPlaces, deps: [], github: !!o.github, have: o.have ?? [], dismissed: o.dismissed ?? [] }).map((r) => r.id);
  assert.deepEqual(ids(todo), ["chrome-devtools", "sqlite"], "a web page and a SQLite file");
  assert.deepEqual(ids(shop).slice(0, 2), ["chrome-devtools", "postgres"], "PGlite counts as Postgres");
  assert.ok(ids(shop).length <= 3);
  assert.deepEqual(ids(todo, { github: true }), ["chrome-devtools", "github", "sqlite"]);
  assert.deepEqual(ids(todo, { github: true, have: ["chrome-devtools"], dismissed: ["github"] }), ["sqlite"]);
  const r = recommend({ places: [{ id: "outside:api.stripe.com" }, { id: "data:supabase" }], deps: ["@sentry/node"], github: false, have: [], dismissed: [] });
  assert.deepEqual(r, [
    { id: "supabase", why: "Your app uses Supabase." },
    { id: "sentry", why: "Your app uses @sentry." },
    { id: "stripe", why: "Your app uses Stripe." },
  ]);
});

test("MCP1: the hub's health check against a tiny local stdio server, with errors redacted", async () => {
  const home = mkdtempSync(join(tmpdir(), "shrike-mcp-home-"));
  const root = mkdtempSync(join(tmpdir(), "shrike-mcp-proj-"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [echo] }, broken: { command: process.execPath, args: ["-e", "console.error('bad key sk_' + 'live_0123456789abcdefghijklmn'); process.exit(1)"] } } }));
  const hub = createMcpHub({ home, stateDir: mkdtempSync(join(tmpdir(), "shrike-mcp-state-")), keychain, check: (c, o) => checkMcpServer(c, { ...o, timeoutMs: 15_000 }) });
  let changes = 0;
  await hub.check(root, undefined, () => changes++);
  const st = await hub.state(root);
  const echoView = st.servers.find((s) => s.name === "echo")!;
  assert.equal(echoView.health?.state, "ok");
  assert.deepEqual(echoView.health?.tools?.map((t) => t.name), ["echo", "add"]);
  const broken = st.servers.find((s) => s.name === "broken")!;
  assert.equal(broken.health?.state, "failed");
  assert.match(broken.health!.error!, /It stopped as soon as it started/);
  assert.ok(!broken.health!.error!.includes("sk_live_0123456789"), `redacted: ${broken.health!.error}`);
  assert.ok(changes >= 4, "each check reports when it starts and ends");
  await hub.setEnabled(root, "echo", false);
  await hub.check(root, undefined, () => {});
  assert.ok(!Object.keys(await hub.servers(root)).includes("echo"));
});

test("MCP7/MCP8: skills declare the servers they use; a tool step that worked names its server", () => {
  const s = parseSkill("drive-it", "---\nname: Drive it\nwhen: Clicking through the app\nuses-mcp: [chrome-devtools, \"github\", bad name]\n---\nGo.");
  assert.deepEqual(s?.usesMcp, ["chrome-devtools", "github"]);
  assert.equal(parseSkill("plain", "---\nname: Plain\nwhen: x\n---\nGo.")?.usesMcp, undefined);
  assert.equal(mcpServerOfStep({ kind: "tool_result", tool: "mcp__chrome-devtools__click", text: "Clicked" }), "chrome-devtools");
  assert.equal(mcpServerOfStep({ kind: "tool_result", tool: "mcp__chrome-devtools__click", text: "Problem: no page" }), undefined);
  assert.equal(mcpServerOfStep({ kind: "tool_call", tool: "mcp__chrome-devtools__click", text: "Using" }), undefined);
  assert.equal(mcpServerOfStep({ kind: "tool_result", tool: "read_file", text: "ok" }), undefined);
});

test("MCP add: a damaged Shrike file is left alone, never replaced; a linked .shrike folder is refused", async () => {
  const { home, root, hub } = world();
  mkdirSync(join(home, ".shrike"));
  writeFileSync(join(home, ".shrike", "mcp.json"), "{ hand edited, broken");
  const plans = await hub.plan(root, { kind: "paste", text: "npx -y @playwright/mcp@latest", scope: "personal", values: {} });
  await assert.rejects(hub.commit(root, plans), /can't read/);
  assert.equal(readFileSync(join(home, ".shrike", "mcp.json"), "utf8"), "{ hand edited, broken");
  const elsewhere = mkdtempSync(join(tmpdir(), "shrike-mcp-elsewhere-"));
  symlinkSync(elsewhere, join(root, ".shrike"));
  await assert.rejects(hub.commit(root, await hub.plan(root, { kind: "paste", text: "npx -y @playwright/mcp@latest", scope: "project", values: {} })), /points somewhere else/);
  assert.equal(existsSync(join(elsewhere, "mcp.json")), false);
});

test("MCP add: a project mcp.json linked to ~/.claude.json is refused; secrets in Claude Code's args never reach the panel", async () => {
  const { home, root, hub, claude } = world();
  mkdirSync(join(root, ".shrike"));
  symlinkSync(join(home, ".claude.json"), join(root, ".shrike", "mcp.json"));
  await assert.rejects(hub.commit(root, await hub.plan(root, { kind: "paste", text: "npx -y @playwright/mcp@latest", scope: "project", values: {} })), /points somewhere else/);
  assert.equal(readFileSync(join(home, ".claude.json"), "utf8"), claude);
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { db: { command: "npx", args: ["pg-mcp", "postgres://me:hunter2pass@db/app", "--api-key", "sk-live-abc123", "--token=tok-xyz789"] } } }));
  const line = (await hub.state(root)).servers.find((s) => s.name === "db")!.command!;
  for (const v of ["hunter2pass", "sk-live-abc123", "tok-xyz789"]) assert.ok(!line.includes(v), line);
});
