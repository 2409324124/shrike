import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// test-only: esbuild comes from browser-agent's devDependencies
import { transformSync } from "../../browser-agent/node_modules/esbuild/lib/main.js";
import { resolveBrowserStack } from "../src/index.ts";
import { parseStack } from "../src/source.ts";

const ROOT = "/Users/me/proj";
const TS = [
  "type Todo = { title: string };",
  "",
  "interface Opts {",
  "  a: number;",
  "  b: string;",
  "}",
  "",
  "const base: string = '/api';",
  "",
  "export async function createTodo(todo: Todo): Promise<Todo> {",
  "  const body: string = JSON.stringify(todo);",
  "  const res = await fetch(`${base}/todos`, { method: 'POST', body });",
  "  return res.json();",
  "}",
].join("\n");

function compile(sourcefile: string, sourcemap: "inline" | "external") {
  const r = transformSync(TS, { loader: "ts", sourcemap, sourcefile, format: "esm" }) as { code: string; map: string };
  const lines = r.code.split("\n");
  const i = lines.findIndex((l) => l.includes("fetch("));
  return { ...r, line: i + 1, column: lines[i]!.indexOf("fetch(") + 1 };
}

const stackAt = (url: string, line: number, column: number) =>
  [
    "Error",
    "    at window.fetch (<anonymous>:1:2045)",
    "    at patched (http://localhost:5173/__shrike/browser-agent.js:1:99)",
    `    at async createTodo (${url}:${line}:${column})`,
    "    at onSubmit (http://localhost:5173/src/TodoForm.tsx:20:5)",
  ].join("\n");

test("parseStack handles named, anonymous, async and [as] frames", () => {
  const f = parseStack("Error\n    at async Foo.bar [as baz] (http://h/a.js:1:2)\n    at http://h/b.js?x=1:3:4\n    at new Thing (file:///c.js:5:6)\n    at eval (eval at <anonymous> (http://h/a.js:1:1), <anonymous>:1:1)\n    at <anonymous>");
  assert.deepEqual(f, [
    { fn: "Foo.bar", url: "http://h/a.js", line: 1, column: 2 },
    { url: "http://h/b.js?x=1", line: 3, column: 4 },
    { fn: "Thing", url: "file:///c.js", line: 5, column: 6 },
  ]);
});

test("inline base64 map with absolute source and query in URL", async () => {
  const c = compile(`${ROOT}/src/api.ts`, "inline");
  const url = "http://localhost:5173/src/api.ts?t=1001";
  const loaded: string[] = [];
  const loc = await resolveBrowserStack(stackAt(url, c.line, c.column), ROOT, async (u) => {
    loaded.push(u);
    if (u !== url) throw new Error("unexpected " + u);
    return c.code;
  });
  assert.deepEqual(loc && { file: loc.file, line: loc.line, fn: loc.functionName, p: loc.precision }, { file: "src/api.ts", line: 12, fn: "createTodo", p: "exact" });
  assert.equal(loc!.column, 21);
  // cached: second call does not reload
  await resolveBrowserStack(stackAt(url, c.line, c.column), ROOT, async () => {
    throw new Error("should be cached");
  });
  assert.deepEqual(loaded, [url]);
});

test("inline map with charset and Vite-style /src source", async () => {
  const c = compile("/src/api.ts", "inline");
  const code = c.code.replace("data:application/json;base64,", "data:application/json;charset=utf-8;base64,");
  assert.ok(code.includes("charset=utf-8;base64,"));
  const url = "http://localhost:5173/src/api2.ts";
  const loc = await resolveBrowserStack(stackAt(url, c.line, c.column), ROOT, async () => code);
  assert.equal(loc?.file, "src/api.ts");
  assert.equal(loc?.line, 12);
  assert.equal(loc?.precision, "exact");
});

test("linked map with sourceRoot and /@fs URL", async () => {
  const c = compile("api.ts", "external");
  const map = JSON.parse(c.map);
  map.sourceRoot = "/@fs/Users/me/proj/src/";
  const url = "http://localhost:5173/assets/api3.js";
  const files: Record<string, string> = {
    [url]: c.code + "\n//# sourceMappingURL=maps/api3.js.map\n",
    "http://localhost:5173/assets/maps/api3.js.map": JSON.stringify(map),
  };
  const loc = await resolveBrowserStack(stackAt(url, c.line, c.column), ROOT, async (u) => {
    const t = files[u];
    if (t === undefined) throw new Error("404 " + u);
    return t;
  });
  assert.equal(loc?.file, "src/api.ts");
  assert.equal(loc?.line, 12);
});

test("no map or failing loader -> approximate; no user frame -> undefined", async () => {
  const noMap = await resolveBrowserStack(stackAt("http://localhost:5173/src/plain.js", 7, 3), ROOT, async () => "fetch('/x')");
  assert.deepEqual(noMap, { file: "src/plain.js", line: 7, column: 3, functionName: "createTodo", precision: "approximate" });
  const failing = await resolveBrowserStack(stackAt("http://localhost:5173/src/gone.ts", 2, 1), ROOT, async () => {
    throw new Error("offline");
  });
  assert.equal(failing?.precision, "approximate");
  const only = "Error\n    at x (http://localhost:5173/node_modules/.vite/deps/react.js?v=1:1:1)\n    at y (http://localhost:5173/@vite/client:1:1)\n    at z (http://localhost:5173/assets/chunk-ABC123.js:1:1)";
  assert.equal(await resolveBrowserStack(only, ROOT, async () => ""), undefined);
  assert.equal(await resolveBrowserStack("", ROOT, async () => ""), undefined);
  const broken = await resolveBrowserStack(stackAt("http://localhost:5173/src/bad.ts", 2, 1), ROOT, async () => "x\n//# sourceMappingURL=data:application/json;base64,!!!notjson");
  assert.equal(broken?.precision, "approximate");
});

test("Turbopack dev chunks: index maps are read and library frames inside the chunk are skipped", async () => {
  const section = (line: number, source: string) => ({ offset: { line, column: 0 }, map: { version: 3, sources: [source], names: [], mappings: "AAAA" } });
  const map = JSON.stringify({ version: 3, sections: [section(0, "turbopack:///[project]/node_modules/@supabase/auth-js/dist/main.js"), section(10, "turbopack:///[project]/components/login-form.tsx")] });
  const chunk = "http://localhost:13001/_next/static/chunks/_00u6qmzifpkly._.js";
  const files: Record<string, string> = { [chunk]: "x\n//# sourceMappingURL=_00u6qmzifpkly._.js.map", [`${chunk}.map`]: map };
  const stack = ["Error", `    at _request (${chunk}:1:5)`, `    at handleLogin (${chunk}:11:3)`].join("\n");
  const loc = await resolveBrowserStack(stack, ROOT, async (u) => files[u] ?? Promise.reject(new Error("404")));
  assert.deepEqual(loc, { file: "components/login-form.tsx", line: 1, column: 1, functionName: "handleLogin", precision: "exact" });
});

test("a page served from web/ (Vite root in a top folder) resolves to web/src/...", async () => {
  const root = mkdtempSync(join(tmpdir(), "shrike-src-"));
  mkdirSync(join(root, "web/src"), { recursive: true });
  writeFileSync(join(root, "web/src/api.ts"), TS);
  const c = compile("api.ts", "inline"); // Vite's map names the file relative to its own URL
  const loc = await resolveBrowserStack(stackAt("http://localhost:4510/src/api.ts", c.line, c.column), root, async () => c.code);
  assert.deepEqual(loc && { file: loc.file, line: loc.line }, { file: "web/src/api.ts", line: 12 });
  rmSync(root, { recursive: true, force: true });
});
