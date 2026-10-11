// Look inside (docs/13 DB): where the project's databases are, from its own settings files. Values (URLs, keys,
// passwords) stay in these objects and in the read-only connections made with them: never logged, sent to the
// renderer, or shown. `from` (a file name) and the host are what the UI may say.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

export type Engine = "postgres" | "mysql" | "mongodb" | "redis" | "sqlite" | "supabase" | "dynamodb" | "firestore";
export interface Source {
  engine: Engine;
  from: string; // the file it came from, relative to the project
  host?: string;
  port?: number;
  database?: string;
  url?: string; // secret
  key?: string; // secret (Supabase API key)
  file?: string; // SQLite file
  project?: string; // Firestore project id
  region?: string;
  supabase?: boolean; // a Postgres that is a Supabase database (hide its system schemas)
}

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", ".vercel", "coverage", "out", ".venv", "venv", "__pycache__", ".tools", "target", ".cache"]);
const ENV_FILES = [".env", ".env.local", ".env.development", ".env.development.local", ".env.dev"];
const SCHEMES: [RegExp, Engine][] = [
  [/^postgres(ql)?(\+\w+)?:\/\//i, "postgres"],
  [/^(mysql|mariadb)(\+\w+)?:\/\//i, "mysql"],
  [/^mongodb(\+srv)?:\/\//i, "mongodb"],
  [/^rediss?:\/\//i, "redis"],
];
const DEFAULT_PORT: Partial<Record<Engine, number>> = { postgres: 5432, mysql: 3306, mongodb: 27017, redis: 6379 };
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "host.docker.internal"]);

export const isLocal = (host: string | undefined) => !host || LOOPBACK.has(host.toLowerCase()) || host.startsWith("/");
export const normHost = (host: string | undefined) => (isLocal(host) ? "localhost" : host!.toLowerCase());

/** Directories to look in: the root and two levels down, skipping dependencies and build output. */
function dirs(root: string, depth = 2): string[] {
  const out = [root];
  if (depth === 0) return out;
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {}
  for (const e of entries) {
    if (SKIP.has(e) || e.startsWith(".")) continue;
    const p = join(root, e);
    try {
      if (statSync(p).isDirectory()) out.push(...dirs(p, depth - 1));
    } catch {}
  }
  return out;
}

const read = (f: string) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return undefined;
  }
};

/** KEY=value lines (dotenv style): quotes, `export`, and # comments outside quotes. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    const q = /^(["'`])([\s\S]*)\1$/.exec(v);
    v = q ? q[2]! : v.replace(/\s+#.*$/, "");
    out[m[1]!] = v;
  }
  return out;
}

function fromUrl(url: string, from: string): Source | undefined {
  const engine = SCHEMES.find(([re]) => re.test(url))?.[1];
  if (!engine) return undefined;
  try {
    const u = new URL(url.replace(/^(\w+)\+\w+:/, "$1:")); // postgresql+psycopg:// (SQLAlchemy) -> postgresql://
    const database = decodeURIComponent(u.pathname.replace(/^\/+/, "").split("/")[0] ?? "") || undefined;
    return { engine, from, host: decodeURIComponent(u.hostname.replace(/^\[|\]$/g, "")) || "localhost", port: Number(u.port) || DEFAULT_PORT[engine], database, url: u.href };
  } catch {
    return undefined;
  }
}

// DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME and the PG*, POSTGRES_*, MYSQL_*, MONGO_*, REDIS_* families.
const PREFIXES: [string, Engine | undefined][] = [["DB_", undefined], ["DATABASE_", undefined], ["PG", "postgres"], ["POSTGRES_", "postgres"], ["MYSQL_", "mysql"], ["MONGO_", "mongodb"], ["MONGODB_", "mongodb"], ["REDIS_", "redis"]];

function fromParts(env: Record<string, string>, from: string, deps: Set<string>): Source[] {
  const out: Source[] = [];
  for (const [p, fixed] of PREFIXES) {
    const host = env[`${p}HOST`] ?? env[`${p}SERVER`];
    const port = env[`${p}PORT`];
    if (!host && !port) continue;
    const kind = (env[`${p}DIALECT`] ?? env[`${p}TYPE`] ?? env[`${p}CLIENT`] ?? env[`${p}ENGINE`] ?? env[`${p}CONNECTION`] ?? "").toLowerCase();
    const n = Number(port);
    const engine: Engine | undefined =
      fixed ??
      (/postgres|pg/.test(kind) ? "postgres" : /mysql|maria/.test(kind) ? "mysql" : /mongo/.test(kind) ? "mongodb" : undefined) ??
      (n === 5432 ? "postgres" : n === 3306 ? "mysql" : n === 27017 ? "mongodb" : undefined) ??
      (deps.has("mysql2") || deps.has("mysql") ? "mysql" : deps.has("pg") || deps.has("postgres") ? "postgres" : deps.has("mongodb") || deps.has("mongoose") ? "mongodb" : undefined);
    if (!engine) continue;
    const user = env[`${p}USER`] ?? env[`${p}USERNAME`] ?? env[`${p}ROOT_USER`] ?? (engine === "mysql" && env[`${p}ROOT_PASSWORD`] ? "root" : undefined);
    const pass = env[`${p}PASSWORD`] ?? env[`${p}PASS`] ?? env[`${p}ROOT_PASSWORD`];
    const database = env[`${p}NAME`] ?? env[`${p}DATABASE`] ?? env[`${p}DB`];
    const scheme = engine === "mongodb" ? "mongodb" : engine === "redis" ? "redis" : engine;
    const auth = user || pass ? `${encodeURIComponent(user ?? "")}${pass ? `:${encodeURIComponent(pass)}` : ""}@` : "";
    const h = host || "localhost";
    const url = `${scheme}://${auth}${h.includes(":") ? `[${h}]` : h}:${n || DEFAULT_PORT[engine]}/${database ? encodeURIComponent(database) : ""}`;
    out.push({ engine, from, host: h, port: n || DEFAULT_PORT[engine], database, url });
  }
  return out;
}

function supabaseFrom(env: Record<string, string>, from: string): Source | undefined {
  const urlKey = Object.keys(env).find((k) => /(^|_)SUPABASE_URL$/.test(k));
  const url = urlKey && env[urlKey];
  if (!url) return undefined;
  const pick = (re: RegExp) => Object.keys(env).find((k) => re.test(k) && env[k]);
  const keyName = pick(/SUPABASE_SERVICE_ROLE_KEY$/) ?? pick(/SUPABASE_(ANON|PUBLISHABLE)(_OR_ANON)?_KEY$/) ?? pick(/SUPABASE_(SECRET_)?KEY$/);
  try {
    const u = new URL(url);
    return { engine: "supabase", from, host: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80), url: u.origin, key: keyName ? env[keyName] : undefined };
  } catch {
    return undefined;
  }
}

function dynamoFrom(env: Record<string, string>, from: string, deps: Set<string>): Source | undefined {
  const endpoint = env.DYNAMODB_ENDPOINT ?? env.AWS_ENDPOINT_URL_DYNAMODB ?? env.DYNAMO_ENDPOINT ?? env.DYNAMODB_URL;
  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  if (!endpoint && !(region && (deps.has("@aws-sdk/client-dynamodb") || deps.has("@aws-sdk/lib-dynamodb") || deps.has("dynamoose")))) return undefined;
  try {
    const u = endpoint ? new URL(endpoint) : undefined;
    return { engine: "dynamodb", from, host: u?.hostname ?? `dynamodb.${region}.amazonaws.com`, port: u ? Number(u.port) || 80 : 443, url: u?.href, region: region ?? "us-east-1" };
  } catch {
    return undefined;
  }
}

function prismaFrom(file: string, root: string, env: Record<string, string>): Source | undefined {
  const text = read(file);
  const ds = text && /datasource\s+\w+\s*\{([^}]*)\}/.exec(text)?.[1];
  if (!ds) return undefined;
  const provider = /provider\s*=\s*"(\w+)"/.exec(ds)?.[1];
  const envName = /url\s*=\s*env\(\s*"([^"]+)"\s*\)/.exec(ds)?.[1];
  const url = envName ? (env[envName] ?? process.env[envName]) : /url\s*=\s*"([^"]+)"/.exec(ds)?.[1];
  if (!url) return undefined;
  const from = relative(root, file);
  if (provider === "sqlite" || url.startsWith("file:")) {
    const p = url.replace(/^file:/, "").split("?")[0]!;
    return { engine: "sqlite", from, file: resolve(dirname(file), p) };
  }
  return fromUrl(url, from);
}

// supabase/config.toml: the local stack's database (postgres:postgres) and API ports.
function supabaseLocal(dir: string, root: string): Source[] {
  const text = read(join(dir, "supabase", "config.toml"));
  if (!text) return [];
  const section = (name: string) => new RegExp(String.raw`^\[${name}\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))`, "m").exec(text)?.[1] ?? "";
  const port = Number(/^\s*port\s*=\s*(\d+)/m.exec(section("db"))?.[1]) || 54322;
  const from = relative(root, join(dir, "supabase", "config.toml"));
  return [{ engine: "postgres", from, host: "localhost", port, database: "postgres", url: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`, supabase: true }];
}

function firebaseLocal(dir: string, root: string, env: Record<string, string>): Source | undefined {
  const cfg = read(join(dir, "firebase.json"));
  let port: number | undefined;
  let host = "localhost";
  try {
    const fs = JSON.parse(cfg ?? "{}")?.emulators?.firestore;
    port = Number(fs?.port) || undefined;
    if (fs?.host) host = String(fs.host);
  } catch {}
  const hostEnv = env.FIRESTORE_EMULATOR_HOST;
  if (hostEnv) [host, port] = [hostEnv.split(":")[0]!, Number(hostEnv.split(":")[1]) || 8080];
  if (!port) return undefined;
  let project = env.GCLOUD_PROJECT ?? env.FIREBASE_PROJECT_ID ?? env.VITE_FIREBASE_PROJECT_ID ?? env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  try {
    project ??= JSON.parse(read(join(dir, ".firebaserc")) ?? "{}")?.projects?.default;
  } catch {}
  return { engine: "firestore", from: relative(root, join(dir, "firebase.json")) || "firebase.json", host, port, project: project ?? "demo-project" };
}

// docker-compose: services whose image is a database, their published port and the env that sets credentials.
function composeFrom(file: string, root: string): Source[] {
  const text = read(file);
  if (!text) return [];
  const out: Source[] = [];
  const blocks = text.split(/\n(?=\s{2}[\w.-]+:\s*\n)/);
  for (const b of blocks) {
    const image = /image:\s*["']?([\w./-]+)/.exec(b)?.[1] ?? "";
    const engine: Engine | undefined = /postgres|postgis|timescale/.test(image) ? "postgres" : /mysql|mariadb/.test(image) ? "mysql" : /mongo/.test(image) ? "mongodb" : /redis|valkey/.test(image) ? "redis" : undefined;
    if (!engine) continue;
    const inner = DEFAULT_PORT[engine]!;
    const port = Number(new RegExp(String.raw`["']?(?:[\d.]+:)?(\d+):${inner}["']?`).exec(b)?.[1]) || inner;
    const env: Record<string, string> = {};
    for (const m of b.matchAll(/^[ \t]*-?[ \t]*["']?(\w+)["']?[ \t]*[:=][ \t]*["']?([^"'\n]*)["']?[ \t]*$/gm)) env[m[1]!] = m[2]!; // one line each: `environment:` must not swallow its first key
    const from = relative(root, file);
    if (engine === "postgres") {
      const user = env.POSTGRES_USER ?? "postgres";
      out.push({ engine, from, host: "localhost", port, database: env.POSTGRES_DB ?? user, url: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(env.POSTGRES_PASSWORD ?? "")}@127.0.0.1:${port}/${encodeURIComponent(env.POSTGRES_DB ?? user)}` });
    } else if (engine === "mysql") {
      const user = env.MYSQL_USER ?? "root";
      const pass = env.MYSQL_USER ? env.MYSQL_PASSWORD : (env.MYSQL_ROOT_PASSWORD ?? env.MARIADB_ROOT_PASSWORD);
      out.push({ engine, from, host: "localhost", port, database: env.MYSQL_DATABASE ?? env.MARIADB_DATABASE, url: `mysql://${encodeURIComponent(user)}:${encodeURIComponent(pass ?? "")}@127.0.0.1:${port}/${encodeURIComponent(env.MYSQL_DATABASE ?? env.MARIADB_DATABASE ?? "")}` });
    } else out.push({ engine, from, host: "localhost", port, url: `${engine === "redis" ? "redis" : "mongodb"}://127.0.0.1:${port}/` });
  }
  return out;
}

function sqliteFiles(root: string): Source[] {
  const out: Source[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {}
    for (const e of entries) {
      if (SKIP.has(e)) continue;
      const p = join(dir, e);
      if (/\.(db|sqlite3?|db3)$/i.test(e)) {
        try {
          if (statSync(p).isFile()) out.push({ engine: "sqlite", from: relative(root, p), file: p });
        } catch {}
      } else if (depth > 0 && !e.startsWith(".")) {
        try {
          if (statSync(p).isDirectory()) walk(p, depth - 1);
        } catch {}
      }
    }
  };
  walk(root, 3);
  return out;
}

function depsOf(dir: string, into: Set<string>): void {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    for (const k of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) into.add(k);
  } catch {}
}

/** Every database Shrike can find settings for in this project, most specific first. */
export function discover(root: string): Source[] {
  if (!root || !existsSync(root)) return [];
  const out: Source[] = [];
  const all = dirs(root);
  const deps = new Set<string>();
  for (const d of all) depsOf(d, deps);
  const merged: Record<string, string> = {};
  for (const d of all) {
    for (const f of ENV_FILES) {
      const text = read(join(d, f));
      if (text === undefined) continue;
      const env = parseEnv(text);
      Object.assign(merged, env);
      const from = relative(root, join(d, f));
      for (const v of Object.values(env)) {
        const s = fromUrl(v, from);
        if (s) out.push(s);
      }
      out.push(...fromParts(env, from, deps));
      const sb = supabaseFrom(env, from);
      if (sb) out.push(sb);
      const dy = dynamoFrom(env, from, deps);
      if (dy) out.push(dy);
    }
  }
  for (const d of all) {
    for (const f of ["schema.prisma", join("prisma", "schema.prisma")]) {
      const s = existsSync(join(d, f)) ? prismaFrom(join(d, f), root, merged) : undefined;
      if (s) out.push(s);
    }
    out.push(...supabaseLocal(d, root));
    const fb = firebaseLocal(d, root, merged);
    if (fb) out.push(fb);
    for (const f of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) if (existsSync(join(d, f))) out.push(...composeFrom(join(d, f), root));
  }
  out.push(...sqliteFiles(root));
  // Same database found twice (a URL in .env and the compose file): keep the first, it carries the app's own credentials.
  const seen = new Set<string>();
  return out.filter((s) => {
    const k = `${s.engine}|${s.file ?? `${normHost(s.host)}:${s.port}/${s.database ?? ""}`}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export const where = (s: Source) => (s.file ? basename(s.file) : `${normHost(s.host)}${s.port ? `:${s.port}` : ""}${s.database ? `/${s.database}` : ""}`);
