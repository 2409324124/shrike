// Entry for NODE_OPTIONS=--import. Inert unless this process is the user's own app.
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { isMainThread } from "node:worker_threads";

// Framework CLIs that run the user's server in their own process (or a child that is also theirs).
// Others in node_modules (bundlers, watchers like nodemon or nest start, test runners) only start the app.
const SERVER_CLIS = new Set(["next", "@remix-run/serve", "@react-router/serve", "ts-node", "ts-node-dev"]);

// argv[1] the way Node resolves it: `node dist/main` runs dist/main.js.
function entryFile(argv1) {
  const file = path.resolve(argv1);
  try {
    return realpathSync(file);
  } catch {
    return realpathSync(createRequire(import.meta.url).resolve(file));
  }
}

const inside = (root, file) => {
  const rel = path.relative(root, file);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
};

export function projectRoot(env = process.env, argv1 = process.argv[1], cwd = process.cwd()) {
  const { SHRIKE_INGEST_URL, SHRIKE_PROJECT_ROOT, NODE_ENV } = env;
  if (!SHRIKE_INGEST_URL || !SHRIKE_PROJECT_ROOT || NODE_ENV === "production") return undefined;
  // ponytail: worker threads stay uninstrumented (hooks are not inherited by workers).
  if (!isMainThread || !argv1 || "__shrike" in globalThis) return undefined;
  try {
    const root = realpathSync(SHRIKE_PROJECT_ROOT);
    const file = entryFile(argv1);
    const parts = file.split(path.sep);
    const nm = parts.lastIndexOf("node_modules");
    if (nm >= 0) {
      const pkg = parts[nm + 1]?.startsWith("@") ? parts.slice(nm + 1, nm + 3).join("/") : parts[nm + 1];
      // Next's own jest-worker children (static paths, builds) are helpers, not the server.
      if (!SERVER_CLIS.has(pkg) || /worker/i.test(parts.slice(nm + 2).join("/"))) return undefined;
      return inside(root, realpathSync(cwd)) ? root : undefined;
    }
    const rel = path.relative(root, file);
    // Build output helpers such as Turbopack's .next/postcss.js are not the app.
    if (!rel || !inside(root, file) || rel.split(path.sep)[0].startsWith(".")) return undefined;
    return root;
  } catch {
    return undefined;
  }
}

const FLAG = `--import=${import.meta.url}`;
const NODE_OPTIONS_SET = /\bNODE_OPTIONS=("[^"]*"|'[^']*'|[^\s;&|]*)/g;

// A script that sets its own NODE_OPTIONS (`NODE_OPTIONS='--inspect' next dev`, cross-env) keeps ours too.
export function withAgent(command, flag = FLAG) {
  return command.replace(NODE_OPTIONS_SET, (all, value) => {
    if (value.includes(flag) || value.includes("NODE_OPTIONS")) return all;
    const q = value[0] === "'" || value[0] === '"' ? value[0] : '"';
    const inner = q === value[0] ? value.slice(1, -1) : value;
    return `NODE_OPTIONS=${q}${inner ? inner + " " : ""}${flag}${q}`;
  });
}

// Every spawn (exec, fork, npm's `sh -c <script>`) goes through ChildProcess.prototype.spawn.
export function keepAgentInChildren(ChildProcess, flag = FLAG) {
  const spawn = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function (options) {
    try {
      if (Array.isArray(options?.envPairs))
        options.envPairs = options.envPairs.map((p) => (p.startsWith("NODE_OPTIONS=") && !p.includes(flag) ? `${p} ${flag}` : p));
      const c = options?.args?.indexOf("-c") ?? -1;
      if (c > 0 && typeof options.args[c + 1] === "string") options.args[c + 1] = withAgent(options.args[c + 1], flag);
    } catch {}
    return spawn.call(this, options);
  };
}

if (process.env.SHRIKE_INGEST_URL && isMainThread && process.env.NODE_OPTIONS?.includes(FLAG)) {
  try {
    keepAgentInChildren((await import("node:child_process")).ChildProcess);
  } catch {}
}

const root = projectRoot();
if (root) {
  try {
    const [{ register }, runtime, cjs, stack, exporter, http, outgoing, libs, consolePatch, { servicePlace }, inspect] = await Promise.all([
      import("node:module"),
      import("./runtime.mjs"),
      import("./cjs.mjs"),
      import("./stack.mjs"),
      import("./exporter.mjs"),
      import("./http.mjs"),
      import("./outgoing.mjs"),
      import("./libs.mjs"),
      import("./console.mjs"),
      import("./place.mjs"),
      import("./inspect.mjs"),
    ]);
    // The exporter keeps the unpatched fetch, so the ingest's own calls are never recorded.
    const out = exporter.createExporter(process.env.SHRIKE_INGEST_URL, process.env.SHRIKE_TOKEN);
    const hello = (url) =>
      out.post({ type: "hello", source: "server", pid: process.pid, at: Date.now(), place: { ...servicePlace }, ...(url ? { url } : {}) });
    stack.setRoot(root);
    runtime.setSink(out.push);
    runtime.installRuntime();
    http.patchHttp(hello);
    outgoing.patchOutgoing(process.env.SHRIKE_INGEST_URL);
    consolePatch.patchConsole();
    libs.hookLibraries();
    inspect.configureInspector(process.env.SHRIKE_INGEST_URL, process.env.SHRIKE_TOKEN);
    register(new URL("./loader.mjs", import.meta.url), { data: { root } });
    cjs.hookCommonJs(root);
    hello();
  } catch {}
}
