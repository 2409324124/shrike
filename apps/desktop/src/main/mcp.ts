import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { McpAddRequest, McpCatalogEntry, McpHealth, McpHubState, McpRecommendation, McpServerView, McpSource, Place } from "@shrike/schema";
import { checkMcpServer, mcpServersOf, readClaudeMcp, type McpCheck, type McpServerConfig } from "@shrike/agent";
import { redactText } from "@shrike/redact";
import catalogJson from "./mcp-catalog.json" with { type: "json" };

// MCP: the tools hub (docs/13 MCP). Electron-free so it tests with node:test; ipc.ts brings the keychain, approvals and the shell.
// Shrike only ever writes its own config (~/.shrike/mcp.json, <project>/.shrike/mcp.json), never ~/.claude.json, .mcp.json or .claude/.

type Server = McpServerConfig;
export interface Keychain {
  encrypt(s: string): string; // Electron safeStorage in the app, a fake in tests
  decrypt(s: string): string;
}

// ---- zod: every config Shrike reads from disk or the renderer pastes ----

export const serverName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "use letters, digits, dash or underscore").refine((n) => n !== "shrike", "shrike is Shrike's own server");
const envKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
const headerKey = z.string().regex(/^[A-Za-z0-9-]{1,128}$/);
const webUrl = z.string().max(2048).url().refine((u) => /^https?:\/\//i.test(u), "use an http or https address");
export const stdioServer = z.object({ type: z.literal("stdio").optional(), command: z.string().trim().min(1).max(1024), args: z.array(z.string().max(4096)).max(64).optional(), env: z.record(envKey, z.string().max(8192)).optional(), cwd: z.string().max(4096).optional() });
export const httpServer = z.object({ type: z.enum(["http", "sse"]).optional(), url: webUrl, headers: z.record(headerKey, z.string().max(8192)).optional() });
export const serverConfig = z.union([stdioServer, httpServer]);
export const configFile = z.object({ mcpServers: z.record(serverName, serverConfig) });
const field = z.object({ name: envKey, label: z.string().min(1).max(60), secret: z.boolean(), hint: z.string().max(200).optional() });
export const catalogEntry = z.object({
  id: serverName,
  name: z.string().min(1).max(40),
  purpose: z.string().min(1).max(200),
  why: z.string().min(1).max(160),
  glyph: z.enum(["browser", "git", "data", "files", "fetch", "issue", "design", "pay", "docs", "memory", "plug"]),
  transport: z.enum(["stdio", "http"]),
  command: z.string().min(1).max(200).optional(),
  args: z.array(z.string().max(400)).max(20).optional(),
  url: webUrl.optional(),
  headers: z.record(headerKey, z.string().max(400)).optional(),
  env: z.record(envKey, z.string().max(400)).optional(),
  fields: z.array(field).max(6),
  install: z.string().min(1).max(300).optional(),
  scope: z.literal("project").optional(),
  signals: z.array(z.string().min(1).max(80)).max(6).optional(),
  match: z.array(z.string().min(2).max(80)).max(6).optional(),
}).refine((e) => (e.transport === "stdio" ? !!e.command && !e.url : !!e.url && !e.command), "stdio needs a command, http a url");
export const addRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("catalog"), id: serverName, scope: z.enum(["personal", "project"]), values: z.record(envKey, z.string().max(8192)) }),
  z.object({ kind: z.literal("paste"), text: z.string().trim().min(1).max(20_000), scope: z.enum(["personal", "project"]), name: serverName.optional(), values: z.record(envKey, z.string().max(8192)) }),
]);

export const CATALOG: McpCatalogEntry[] = z.array(catalogEntry).parse(catalogJson) as McpCatalogEntry[];
export const PLUG = "plug";

// ---- paste: a JSON snippet, a URL, a command, or a README's `claude mcp add …` line ----

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const isPlaceholder = (v: string) => /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(v);
const secretArg = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s]+@/i; // a connection string with a password
const secretFlag = /^--?[\w-]*(key|token|secret|password|pat)$/i; // `--api-key VALUE`: the next word is the secret
const secretQuery = /([?&]([^=&#]*(?:key|token|secret|auth|password)[^=&#]*)=)([^&#]+)/gi;

/** An arg as the renderer may see it: a password in a connection string, `--api-key VALUE` or `--token=VALUE` hidden. */
const maskArg = (a: string, i: number, all: string[]) =>
  secretArg.test(a) || (i > 0 && secretFlag.test(all[i - 1]!) && !a.startsWith("-")) ? "[redacted]" : a.replace(/^(--?[\w-]*(?:key|token|secret|password|pat)=).+$/i, "$1[redacted]");

/** Words of a shell line, quotes removed. */
function words(s: string): string[] {
  return [...s.matchAll(/"((?:\\.|[^"])*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
}

const nameFrom = (s: string) => {
  const pkg = s.replace(/@[\w.-]+$/, "").split("/").pop() ?? s;
  return pkg.replace(/^(mcp-server-|server-)|(-mcp-server|-mcp)$/g, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "my-tool";
};

/**
 * Turns pasted text into servers. Values typed inline (env, headers, a connection string) move out of the config:
 * the config gets ${NAME} and the value goes to `values`, which the caller stores in the keychain.
 */
export function parsePaste(text: string, name?: string): { servers: Record<string, Server>; values: Record<string, string> } {
  const t = text.trim();
  let raw: Record<string, unknown>;
  if (/^[{[]/.test(t)) {
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      throw new Error("That looks like JSON but it doesn't parse. Check the brackets and quotes.");
    }
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const map = (o.mcpServers ?? o.servers ?? o) as Record<string, unknown>;
    if (typeof o.command === "string" || typeof o.url === "string") raw = { [name ?? nameFrom(String(o.url ? new URL(String(o.url)).hostname.split(".").at(-2) : (o.args as string[] | undefined)?.find((a) => !a.startsWith("-")) ?? o.command))]: o };
    else raw = map;
  } else if (/^https?:\/\//i.test(t) && !/\s/.test(t)) {
    raw = { [name ?? nameFrom(new URL(t).hostname.replace(/^(mcp|api)\./, "").split(".")[0]!)]: { type: "http", url: t } };
  } else {
    let w = words(t);
    let n = name;
    const env: Record<string, string> = {};
    const headers: Record<string, string> = {};
    let transport: string | undefined;
    if (w[0] === "claude" && w[1] === "mcp" && w[2] === "add") {
      const rest = w.slice(3);
      const dash = rest.indexOf("--");
      const head = dash >= 0 ? rest.slice(0, dash) : rest;
      const pos: string[] = [];
      for (let i = 0; i < head.length; i++) {
        const a = head[i]!;
        const val = () => head[++i] ?? "";
        if (a === "--transport" || a === "-t") transport = val();
        else if (a === "--scope" || a === "-s") val();
        else if (a === "--env" || a === "-e") {
          const [k, ...v] = val().split("=");
          if (k) env[k] = v.join("=");
        } else if (a === "--header" || a === "-H") {
          const [k, ...v] = val().split(":");
          if (k) headers[k.trim()] = v.join(":").trim();
        } else if (/^--(transport|scope|env|header)=/.test(a)) {
          const [k, ...v] = a.slice(2).split("=");
          if (k === "transport") transport = v.join("=");
        } else pos.push(a);
      }
      n ??= pos[0];
      w = dash >= 0 ? rest.slice(dash + 1) : pos.slice(1);
    }
    if (!w.length) throw new Error("Paste a JSON snippet, an address (https://…) or the command that starts the server.");
    if (/^https?:\/\//i.test(w[0]!)) raw = { [n ?? nameFrom(new URL(w[0]!).hostname.split(".")[0]!)]: { type: transport === "sse" ? "sse" : "http", url: w[0], ...(Object.keys(headers).length ? { headers } : {}) } };
    else {
      while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) {
        const [k, ...v] = w.shift()!.split("=");
        env[k!] = v.join("=");
      }
      const [command, ...args] = w;
      raw = { [n ?? nameFrom(args.find((a) => !a.startsWith("-")) ?? command!)]: { command, ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}) } };
    }
  }
  const values: Record<string, string> = {};
  const servers: Record<string, Server> = {};
  for (const [key, cfg] of Object.entries(raw)) {
    const n = serverName.safeParse(key);
    if (!n.success) throw new Error(`"${key}" can't be a server name: ${n.error.issues[0]?.message}.`);
    const c = serverConfig.safeParse(cfg);
    if (!c.success) throw new Error(`${key}: ${c.error.issues[0]?.path.join(".") || "config"} ${c.error.issues[0]?.message ?? "isn't right"}.`);
    const s: Record<string, any> = structuredClone(c.data);
    const keep = (k: string, v: string) => {
      const id = k.toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/^(?=\d)/, "_");
      values[id] = v;
      return `\${${id}}`;
    };
    for (const [k, v] of Object.entries((s.env ?? {}) as Record<string, string>)) if (!isPlaceholder(v)) s.env[k] = keep(k, v);
    for (const [k, v] of Object.entries((s.headers ?? {}) as Record<string, string>)) if (!/\$\{[A-Za-z_]\w*\}/.test(v)) s.headers[k] = keep(`${key}_${k}`, v);
    if (Array.isArray(s.args)) s.args = s.args.map((a: string, i: number, all: string[]) => (secretArg.test(a) || redactText(a) !== a || (i > 0 && secretFlag.test(all[i - 1]!) && !a.startsWith("-")) ? keep(`${key}_ARG${i}`, a) : a));
    if (typeof s.url === "string") s.url = s.url.replace(secretQuery, (_m: string, pre: string, k: string, v: string) => (isPlaceholder(v) ? `${pre}${v}` : `${pre}${keep(`${key}_${k}`, v)}`));
    servers[n.data] = s;
  }
  if (!Object.keys(servers).length) throw new Error("There's no server in that snippet.");
  return { servers, values };
}

// ---- reading every source, in precedence order ----

export interface Entry {
  name: string;
  source: McpSource;
  config: Server;
  file: string;
}

// Shrike's own beat Claude Code's (Shrike can't change those, so its own copy is how you change one); within each, the narrower scope wins.
export const PRECEDENCE: McpSource[] = ["shrike-project", "shrike-personal", "claude-local", "claude-project", "claude-user"];
export const shrikeFile = (scope: "personal" | "project", home: string, root: string) => (scope === "personal" ? join(home, ".shrike", "mcp.json") : join(root, ".shrike", "mcp.json"));

async function readShrike(file: string): Promise<Record<string, Server>> {
  try {
    const v = configFile.safeParse(JSON.parse(await readFile(file, "utf8")));
    return v.success ? mcpServersOf(v.data.mcpServers) : {};
  } catch {
    return {};
  }
}

export async function readSources(root: string, home: string): Promise<{ entries: Entry[]; approved: { all: boolean; names: string[]; denied: string[] } }> {
  const claude = await readClaudeMcp(root, home);
  const files: Record<McpSource, [Record<string, Server>, string]> = {
    "shrike-project": [await readShrike(shrikeFile("project", home, root)), shrikeFile("project", home, root)],
    "shrike-personal": [await readShrike(shrikeFile("personal", home, root)), shrikeFile("personal", home, root)],
    "claude-local": [claude.local, join(home, ".claude.json")],
    "claude-project": [claude.project, join(root, ".mcp.json")],
    "claude-user": [claude.user, join(home, ".claude.json")],
  };
  const entries = PRECEDENCE.flatMap((source) => Object.entries(files[source][0]).map(([name, config]) => ({ name, source, config, file: files[source][1] })));
  return { entries, approved: claude.approved };
}

/** The winner per name (highest precedence first), with the lower sources it hides. */
export function merge(entries: Entry[]): (Entry & { shadows: McpSource[] })[] {
  const out = new Map<string, Entry & { shadows: McpSource[] }>();
  for (const e of entries) {
    const had = out.get(e.name);
    if (had) had.shadows.push(e.source);
    else out.set(e.name, { ...e, shadows: [] });
  }
  return [...out.values()];
}

// ---- Shrike's own per-project switches (userData mcp-state.json) and secrets (mcp-secrets.json, keychain-encrypted) ----

interface ProjectState {
  off: string[];
  trusted: Record<string, string>; // name -> fingerprint of the config that was trusted
  dismissed: string[];
}
interface HubFile {
  projects: Record<string, ProjectState>;
}
const projectState = z.object({ off: z.array(z.string()).default([]), trusted: z.record(z.string()).default({}), dismissed: z.array(z.string()).default([]) });
const hubFile = z.object({ projects: z.record(projectState).default({}) });
const secretsFile = z.record(z.record(z.string()));

export const fingerprint = (c: Server) => createHash("sha1").update(JSON.stringify(c)).digest("hex").slice(0, 16);
const needsTrust = (s: McpSource) => s === "claude-project" || s === "shrike-project";

async function readJson<T>(file: string, schema: z.ZodType<T>, empty: T): Promise<T> {
  try {
    const v = schema.safeParse(JSON.parse(await readFile(file, "utf8")));
    return v.success ? v.data : empty;
  } catch {
    return empty;
  }
}
/** For read-modify-write: a missing file is empty, a damaged one stops the write instead of being replaced. */
async function readStrict<T>(file: string, schema: z.ZodType<T>, empty: T): Promise<T> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw e;
  }
  let v: z.SafeParseReturnType<unknown, T>;
  try {
    v = schema.safeParse(JSON.parse(text));
  } catch {
    v = { success: false } as z.SafeParseReturnType<unknown, T>;
  }
  if (!v.success) throw new Error(`Shrike can't read ${file}, so it left it alone. Fix or delete that file, then try again.`);
  return v.data;
}
/** A project's .shrike folder that is really a link somewhere else (a cloned repo's trick) is refused. */
async function ownDir(file: string, project: boolean): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  if (project && basename(await realpath(dirname(file))) !== ".shrike") throw new Error(`${dirname(file)} points somewhere else, so Shrike won't write there.`);
  if (await lstat(file).then((s) => s.isSymbolicLink(), () => false)) throw new Error(`${file} points somewhere else, so Shrike won't write there.`); // a linked mcp.json would copy its target into the project
}
async function writeJson(file: string, v: unknown): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(v, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

/** Puts values into ${NAME}s: Shrike's secrets for its own servers, the project folder for ${PROJECT_ROOT}. Names it couldn't fill come back as missing. */
export function fill(c: Server, values: Record<string, string>, root: string): { config: Server; missing: string[] } {
  const missing = new Set<string>();
  const sub = (s: string) => s.replace(PLACEHOLDER, (m, k: string) => (k === "PROJECT_ROOT" ? root : k in values ? values[k]! : (missing.add(k), m)));
  const out: Record<string, unknown> = { ...c };
  if (Array.isArray(c.args)) out.args = c.args.map((a) => sub(String(a)));
  if (typeof c.url === "string") out.url = sub(c.url);
  for (const k of ["env", "headers"] as const) if (c[k] && typeof c[k] === "object") out[k] = Object.fromEntries(Object.entries(c[k] as Record<string, string>).map(([n, v]) => [n, sub(String(v))]));
  return { config: out, missing: [...missing] };
}

const placeholders = (c: Server) => [...new Set([...JSON.stringify(c).matchAll(PLACEHOLDER)].map((m) => m[1]!).filter((k) => k !== "PROJECT_ROOT"))];

/** The catalog entry a configured server is, by name or by a word in its command or address. */
export function catalogOf(name: string, c: Server): McpCatalogEntry | undefined {
  const hay = [c.command, ...(Array.isArray(c.args) ? c.args : []), c.url].filter((x) => typeof x === "string").join(" ").toLowerCase();
  return CATALOG.find((e) => e.id === name) ?? CATALOG.find((e) => e.match?.some((m) => hay.includes(m.toLowerCase())));
}

// ---- MCP3: recommendations from what the scanner and the start plan found ----

const PLACE_WORDS: Record<string, string> = { "data:postgres": "Postgres", "data:supabase": "Supabase", "data:sqlite": "a SQLite database", "outside:api.stripe.com": "Stripe" };
export function recommend(o: { places: Pick<Place, "id">[]; deps: string[]; github: boolean; have: string[]; dismissed: string[] }, max = 3): McpRecommendation[] {
  const out: McpRecommendation[] = [];
  for (const e of CATALOG) {
    if (out.length >= max) break;
    if (o.have.includes(e.id) || o.dismissed.includes(e.id)) continue;
    const hit = e.signals?.find((s) =>
      s === "github" ? o.github : s === "client" ? o.places.some((p) => p.id.startsWith("client:")) : s.startsWith("dep:") ? o.deps.some((d) => d.startsWith(s.slice(4))) : o.places.some((p) => p.id === s || p.id.startsWith(`${s}:`)),
    );
    if (!hit) continue;
    const why = hit === "github" ? "This project's code is on GitHub." : hit === "client" ? "Your app has a web page." : hit.startsWith("dep:") ? `Your app uses ${hit.slice(4).replace(/\/$/, "")}.` : `Your app uses ${PLACE_WORDS[hit] ?? hit.split(":").pop()}.`;
    out.push({ id: e.id, why });
  }
  return out;
}

// ---- the hub ----

export interface HubDeps {
  home: string;
  stateDir: string; // userData
  keychain: Keychain;
  check?(c: Server, o: { cwd: string }): Promise<McpCheck>; // tests: a fake or the real one against a fixture
  redact?(s: string): string;
}

export interface AddPlan {
  name: string;
  scope: "personal" | "project";
  file: string;
  config: Server;
  values: Record<string, string>; // to the keychain, never the file
  install?: string;
  replaces?: McpSource; // a server of that name already exists there or below
  catalog?: McpCatalogEntry;
}

export function createMcpHub(d: HubDeps) {
  const stateFile = join(d.stateDir, "mcp-state.json");
  const secretFile = join(d.stateDir, "mcp-secrets.json");
  const health = new Map<string, McpHealth>(); // root\0name\0fingerprint
  const hkey = (root: string, name: string, c: Server) => `${root}\0${name}\0${fingerprint(c)}`;
  const check = d.check ?? ((c: Server, o: { cwd: string }) => checkMcpServer(c, o));
  const clean = (s: string) => (d.redact ?? redactText)(s);
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  const readState = () => readJson<HubFile>(stateFile, hubFile as z.ZodType<HubFile>, { projects: {} });
  const proj = (h: HubFile, root: string): ProjectState => (h.projects[root] ??= { off: [], trusted: {}, dismissed: [] });
  const update = (root: string, fn: (p: ProjectState) => void) =>
    serial(async () => {
      const h = await readStrict<HubFile>(stateFile, hubFile as z.ZodType<HubFile>, { projects: {} });
      fn(proj(h, root));
      await writeJson(stateFile, h);
    });
  const secretScope = (e: Pick<Entry, "source">, root: string) => (e.source === "shrike-project" ? `project:${root}` : "personal");
  async function secrets(scope: string, server: string): Promise<Record<string, string>> {
    const all = await readJson(secretFile, secretsFile, {});
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(all[`${scope}:${server}`] ?? {})) {
      try {
        out[k] = d.keychain.decrypt(v);
      } catch {} // a key from another machine: it counts as missing
    }
    return out;
  }
  const saveSecrets = (scope: string, server: string, values: Record<string, string>) =>
    serial(async () => {
      const all = await readStrict(secretFile, secretsFile, {});
      const k = `${scope}:${server}`;
      all[k] = { ...all[k], ...Object.fromEntries(Object.entries(values).filter(([, v]) => v !== "").map(([n, v]) => [n, d.keychain.encrypt(v)])) };
      await writeJson(secretFile, all);
    });

  /** Every winning server with what Shrike knows about it, and its config with secrets filled (never sent to the renderer). */
  async function resolved(root: string) {
    const [{ entries, approved }, st] = await Promise.all([readSources(root, d.home), readState()]);
    const p = st.projects[root] ?? { off: [], trusted: {}, dismissed: [] };
    return Promise.all(
      merge(entries).map(async (e) => {
        const shrike = e.source.startsWith("shrike");
        const { config, missing } = shrike ? fill(e.config, await secrets(secretScope(e, root), e.name), root) : { config: e.config, missing: [] as string[] };
        const trusted = !needsTrust(e.source) || p.trusted[e.name] === fingerprint(e.config) || (e.source === "claude-project" && !approved.denied.includes(e.name) && (approved.all || approved.names.includes(e.name)));
        return { ...e, filled: config, missing, trusted, enabled: !p.off.includes(e.name) };
      }),
    );
  }

  const view = (root: string, e: Awaited<ReturnType<typeof resolved>>[number]): McpServerView => {
    const cat = catalogOf(e.name, e.config);
    const c = e.config;
    const line = typeof c.command === "string" ? clean([c.command, ...(Array.isArray(c.args) ? c.args.map(String).map(maskArg) : [])].join(" ")) : undefined;
    return {
      name: e.name,
      source: e.source,
      transport: typeof c.url === "string" ? (c.type === "sse" ? "sse" : "http") : "stdio",
      ...(line ? { command: line } : {}),
      ...(typeof c.url === "string" ? { url: clean(c.url.replace(/([?&][^=&#]*(?:key|token|secret|auth)[^=&#]*=)[^&#]*/gi, "$1[redacted]")) } : {}),
      envNames: Object.keys((c.env as object | undefined) ?? {}),
      headerNames: Object.keys((c.headers as object | undefined) ?? {}),
      purpose: cat?.purpose ?? "Your own tool server.",
      glyph: cat?.glyph ?? PLUG,
      ...(cat ? { catalogId: cat.id } : {}),
      enabled: e.enabled,
      trusted: e.trusted,
      missing: e.missing,
      ...(e.shadows.length ? { shadows: e.shadows } : {}),
      ...((h) => (h ? { health: h } : {}))(health.get(hkey(root, e.name, e.config))),
    };
  };

  async function state(root: string, project?: { places: Pick<Place, "id">[]; deps: string[]; github: boolean }): Promise<McpHubState> {
    const [list, st] = await Promise.all([resolved(root), readState()]);
    const servers = list.map((e) => view(root, e));
    const have = servers.flatMap((s) => (s.catalogId ? [s.catalogId, s.name] : [s.name]));
    return { servers, catalog: CATALOG, recommended: project ? recommend({ ...project, have, dismissed: st.projects[root]?.dismissed ?? [] }) : [], project: root };
  }

  return {
    state,
    /** MCP6: what a run gets: on, trusted and nothing missing, secrets filled. */
    async servers(root: string): Promise<Record<string, Server>> {
      return Object.fromEntries((await resolved(root)).filter((e) => e.enabled && e.trusted && !e.missing.length).map((e) => [e.name, e.filled]));
    },
    /** MCP1: health check one server or every one that's on and trusted. onChange fires as each starts and ends. */
    async check(root: string, name: string | undefined, onChange: () => void): Promise<void> {
      const list = (await resolved(root)).filter((e) => (name ? e.name === name : e.enabled) && e.trusted && !e.missing.length);
      const one = async (e: (typeof list)[number]) => {
        const k = hkey(root, e.name, e.config);
        health.set(k, { ...health.get(k), state: "checking", at: Date.now() });
        onChange();
        const r = await check(e.filled, { cwd: root }).catch((err: unknown) => ({ ok: false, tools: [], error: String(err), ms: 0 }) as McpCheck);
        const secretsOf = Object.values(await secrets(secretScope(e, root), e.name)).filter((v) => v.length >= 6);
        const scrub = (s: string) => clean(secretsOf.reduce((t, v) => t.split(v).join("[redacted]"), s));
        health.set(k, { state: r.ok ? "ok" : "failed", ...(r.ok ? { tools: r.tools } : { error: scrub(r.error ?? "It failed to start.") }), at: Date.now(), ms: r.ms });
        onChange();
      };
      for (let i = 0; i < list.length; i += 3) await Promise.all(list.slice(i, i + 3).map(one)); // three at a time
    },
    setEnabled: (root: string, name: string, on: boolean) => update(root, (p) => void (p.off = on ? p.off.filter((n) => n !== name) : [...new Set([...p.off, name])])),
    async trust(root: string, name: string): Promise<void> {
      const e = (await resolved(root)).find((x) => x.name === name);
      if (!e) throw new Error(`There's no tool server called ${name}.`);
      await update(root, (p) => void (p.trusted[name] = fingerprint(e.config)));
    },
    dismiss: (root: string, id: string) => update(root, (p) => void (p.dismissed = [...new Set([...p.dismissed, id])])),
    /** MCP2: what adding would do, before the approval card. Nothing is written. */
    async plan(root: string, req: McpAddRequest): Promise<AddPlan[]> {
      const r = addRequest.parse(req) as McpAddRequest;
      const existing = merge((await readSources(root, d.home)).entries);
      const scope = r.scope;
      const out: AddPlan[] = [];
      if (r.kind === "catalog") {
        const e = CATALOG.find((x) => x.id === r.id);
        if (!e) throw new Error("That tool isn't in Shrike's list.");
        if (e.scope === "project" && scope !== "project") throw new Error(`${e.name} only works per project.`);
        const config: Server = e.transport === "http" ? { type: "http", url: e.url!, ...(e.headers ? { headers: e.headers } : {}) } : { command: e.command!, ...(e.args ? { args: e.args } : {}), ...(e.env ? { env: e.env } : {}) };
        const values: Record<string, string> = {};
        for (const f of e.fields) {
          const v = r.values[f.name]?.trim() ?? "";
          if (!v) throw new Error(`${e.name} needs ${f.label}.`);
          if (f.secret) values[f.name] = v;
          else if (/[\0\n]/.test(v) || v.length > 1024) throw new Error(`${f.label} doesn't look right.`);
        }
        // Plain fields (a project ref, a file path) go in as text; secrets stay ${NAME} for the keychain.
        const plainFields = Object.fromEntries(e.fields.filter((f) => !f.secret).map((f) => [f.name, r.values[f.name]!.trim()]));
        const config2 = fill(config, plainFields, "${PROJECT_ROOT}").config;
        const had = existing.find((x) => x.name === e.id);
        out.push({ name: e.id, scope, file: shrikeFile(scope, d.home, root), config: config2, values, ...(e.install ? { install: e.install } : {}), ...(had ? { replaces: had.source } : {}), catalog: e });
      } else {
        const p = parsePaste(r.text, r.name);
        for (const [name, config] of Object.entries(p.servers)) {
          const mine = Object.fromEntries(placeholders(config).map((k) => [k, r.values[k] ?? p.values[k] ?? ""]).filter(([, v]) => v));
          const had = existing.find((x) => x.name === name);
          out.push({ name, scope, file: shrikeFile(scope, d.home, root), config, values: mine, ...(had ? { replaces: had.source } : {}) });
        }
      }
      return out;
    },
    /** After the approval: Shrike's own file gets the config, the keychain gets the values; a project add is trusted (you just added it). */
    async commit(root: string, plans: AddPlan[]): Promise<void> {
      for (const p of plans) {
        if (Object.keys(p.values).length) await saveSecrets(p.scope === "project" ? `project:${root}` : "personal", p.name, p.values); // first: no keychain, no config
        await serial(async () => {
          await ownDir(p.file, p.scope === "project");
          const cur = await readStrict(p.file, configFile, { mcpServers: {} });
          cur.mcpServers[p.name] = p.config as z.infer<typeof serverConfig>;
          await writeJson(p.file, cur);
        });
        await update(root, (s) => {
          s.off = s.off.filter((n) => n !== p.name);
          if (p.scope === "project") s.trusted[p.name] = fingerprint(p.config);
        });
      }
    },
    /** Only Shrike's own config: Claude Code's servers are switched off here instead. */
    async remove(root: string, name: string): Promise<void> {
      const e = (await readSources(root, d.home)).entries.find((x) => x.name === name && x.source.startsWith("shrike"));
      if (!e) throw new Error(`${name} comes from Claude Code's settings. Shrike never edits those: switch it off here instead.`);
      await serial(async () => {
        await ownDir(e.file, e.source === "shrike-project");
        const cur = await readStrict(e.file, configFile, { mcpServers: {} });
        delete cur.mcpServers[name];
        await writeJson(e.file, cur);
        const all = await readStrict(secretFile, secretsFile, {});
        delete all[`${secretScope(e, root)}:${name}`];
        await writeJson(secretFile, all);
      });
    },
    /** For "Fix it": the failing server's error in plain words and its redacted shape. */
    async describe(root: string, name: string): Promise<McpServerView | undefined> {
      return (await state(root)).servers.find((s) => s.name === name);
    },
  };
}

/** MCP8: the server behind a tool step that worked (mcp__<server>__<tool>), or undefined. */
export function mcpServerOfStep(s: { kind: string; tool?: string; text: string }): string | undefined {
  if (s.kind !== "tool_result" || s.text.startsWith("Problem:")) return undefined;
  return /^mcp__(.+?)__.+$/.exec(s.tool ?? "")?.[1];
}
