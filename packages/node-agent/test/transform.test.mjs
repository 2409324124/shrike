import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { transform } from "../src/babel-plugin.mjs";
import { preview } from "../src/preview.mjs";

const defs = [];
const calls = [];
before(() => {
  globalThis.__shrike = {
    def: (_file, entries) => defs.push(...entries),
    run(id, args, fn) {
      calls.push({ id, args: Array.from(args) });
      return fn();
    },
  };
});
after(() => delete globalThis.__shrike);

let n = 0;
const evaluate = async (code) => (await import(`data:text/javascript,${encodeURIComponent(code)}%0A//${n++}`)).default;

async function compile(code, file = "/proj/case.js") {
  return transform(code, file, file.slice("/proj/".length), n++);
}

const cases = {
  thisAndArguments: `
    function f(a) { return [this?.x, arguments.length, a, [...arguments]]; }
    const o = { x: 1, m() { return [this.x, arguments[0]]; } };
    export default [f.call({ x: 9 }, 1, 2, 3), o.m(5), f.length, f.name, o.m.name];`,
  superAndNewTarget: `
    class A { greet(n) { return "A" + n; } static s() { return "sA"; } get g() { return "getA"; } }
    class B extends A {
      constructor() { super(); this.v = new.target === B; }
      greet(n) { return super.greet(n) + "B"; }
      static s() { return super.s() + "B"; }
      arrow = () => super.greet(0);
      #p(x) { return x * 2; }
      callP(x) { return this.#p(x); }
    }
    const base = { hi() { return "base"; } };
    const obj = { __proto__: base, hi() { return super.hi() + "!"; } };
    const b = new B();
    export default [b.greet(1), B.s(), b.g, b.v, b.arrow(), b.callP(4), obj.hi()];`,
  asyncAwait: `
    const log = [];
    async function wait(v) { await null; return v; }
    async function f(n) {
      if (n === 0) return "zero";
      try { const x = await wait(n); if (x > 5) return "big"; return x * 2; } finally { log.push("fin" + n); }
    }
    async function g() { throw new Error("nope"); }
    export default [await f(0), await f(3), await f(9), await g().catch((e) => e.message), log];`,
  defaults: `
    function f(a, b = a * 2, { c = 3, ...rest } = {}, ...more) { return [a, b, c, rest, more, arguments.length]; }
    const arrow = (x, y = x + 1, [z, , w] = [7, 8, 9]) => [x, y, z, w];
    export default [f(1), f(1, 5, { c: 4, d: 5 }, 6, 7), arrow(1), arrow(1, 2, [3, 4, 5]), f.length, arrow.length];`,
  hoisting: `
    function outer() {
      const r = inner();
      var v = "var";
      return [r, typeof later, hoisted, v];
      function inner() { return typeof v; }
      var hoisted;
      function later() {}
    }
    function shadow(a) { var a; return a; }
    function shadow2(a) { var a = a + 1; return a; }
    export default [outer(), shadow(5), shadow2(5)];`,
  concise: `
    const obj = () => ({ a: 1 });
    const seq = (a, b) => (a, b);
    const nested = (x) => (y) => x + y;
    const asyncArrow = async (x) => x * 3;
    export default [obj(), seq(1, 2), nested(1)(2), await asyncArrow(2)];`,
  skipped: `
    function* gen() { yield 1; yield 2; }
    const o = { get v() { return 4; }, set v(x) { this._v = x; }, *g() { yield 3; } };
    o.v = 5;
    export default [[...gen()], o.v, o._v, [...o.g()]];`,
  misc: `
    function strict() { "use strict"; return this === undefined; }
    function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }
    function labels() {
      let n = 0;
      outer: for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) { if (j === 1) continue outer; if (i === 2) break outer; n++; } }
      return n;
    }
    function counter() { let c = 0; return () => ++c; }
    const inc = counter(); inc(); inc();
    function Ctor(v) { if (!new.target) return "no new"; this.v = v; }
    export default [strict(), fact(5), labels(), inc(), new Ctor(3).v, Ctor(1), typeof (function () { return this; })()];`,
  throws: `
    function t() { throw new TypeError("bad"); }
    let caught;
    try { t(); } catch (e) { caught = [e instanceof TypeError, e.message]; }
    export default caught;`,
};

for (const [name, code] of Object.entries(cases)) {
  test(`transform preserves behaviour: ${name}`, async () => {
    const out = await compile(code);
    assert.match(out, /sourceMappingURL=data:application\/json/);
    assert.deepEqual(await evaluate(out), await evaluate(code));
  });
}

test("wraps the right functions", async () => {
  const has = (code) => compile(code).then((out) => out.includes("__shrike.run("));
  assert.equal(await has(cases.skipped), false, "generators, getters and setters stay untouched");
  assert.equal(await has("class A { constructor() { this.a = 1; } }"), false);
  assert.equal(await has("function f(a) { var a; return a; }"), false);
  assert.equal(await has("const f = () => 1;"), true);
  assert.equal(await has("__export(root_exports, { loader: () => loader, default: () => App });"), false, "a bundle's export getters are not steps");
});

test("records original locations and names", async () => {
  defs.length = 0;
  const code = ["", "function a() {}", "  const b = () => 1;", "class C { m() {} }", "export default { a, b, c: new C(), d: [1].map((x) => x) };"].join("\n");
  await evaluate(await compile(code, "/proj/src/loc.js"));
  assert.deepEqual(
    defs.map(({ file, line, column, name }) => ({ file, line, column, name })),
    [
      { file: "src/loc.js", line: 2, column: 1, name: "a" },
      { file: "src/loc.js", line: 3, column: 13, name: "b" },
      { file: "src/loc.js", line: 4, column: 11, name: "C.m" },
      { file: "src/loc.js", line: 5, column: 47, name: "d (map)" },
    ],
  );
});

test("secret arguments are marked by parameter name or a password function's name", async () => {
  defs.length = 0;
  const code = "function login(email, password) {}\nconst password = (value, helpers) => value;\nfunction save(user, apiKey, ...rest) {}\nexport default [login, password, save];";
  await evaluate(await compile(code, "/proj/src/s.js"));
  assert.deepEqual(defs.map(({ name, secret }) => [name, secret]), [["login", [1]], ["password", [0, 1]], ["save", [1]]]);
});

test("destructured arrow args are rebuilt for previews", async () => {
  calls.length = 0;
  await evaluate(await compile("const insertTodo = ({ title, userId }, ...rest) => title; export default insertTodo({ title: 'buy milk' }, 1);"));
  assert.equal(calls.length, 1);
  assert.equal(preview(calls[0].args[0]), "{ title: 'buy milk', userId: undefined }");
  assert.deepEqual(calls[0].args.slice(1), [1]);
});

test("strips TypeScript and keeps original lines", async () => {
  defs.length = 0;
  const code = [
    "import type { Foo } from './nowhere.ts';",
    "interface Todo { title: string; userId?: number }",
    "class Box<T> { declare tag: string; value!: T; constructor(v: T) { this.value = v; } get(): T { return this.value; } }",
    "export function describe(t: Todo, extra?: string): string {",
    "  const u = (t.userId as number | undefined) ?? -1;",
    "  return `${t.title}:${u}:${extra ?? ''}:${new Box<number>(2).get()!}`;",
    "}",
    "export default describe({ title: 'x' } satisfies Todo);",
  ].join("\n");
  assert.equal(await evaluate(await compile(code, "/proj/server/t.ts")), "x:-1::2");
  assert.deepEqual(
    defs.map((d) => [d.name, d.line]),
    [
      ["Box.get", 3],
      ["describe", 4],
    ],
  );
});

test("bundles: a sectioned source map (Turbopack) picks the user's functions and their original lines", async () => {
  const { transformSync } = await import("../src/babel-plugin.mjs");
  const babel = (await import("@babel/core")).default;
  const piece = (code, source) => babel.transformSync(code, { sourceFileName: source, sourceMaps: true, babelrc: false, configFile: false });
  const vendor = piece("function vendorThing() {\n  return 1;\n}", "turbopack:///[project]/node_modules/x/index.js");
  const user = piece("\n\nconst postRouter = { create: procedure.mutation(async ({ input }) => input) };", "turbopack:///[project]/src/server/post.ts");
  const map = { version: 3, sections: [{ offset: { line: 0, column: 0 }, map: vendor.map }, { offset: { line: 3, column: 0 }, map: user.map }] };
  const chunk = `${vendor.code}\n${user.code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`;
  defs.length = 0;
  const out = transformSync(chunk, "/proj/.next/server/chunks/c.js", ".next/server/chunks/c.js", 7, "/proj");
  globalThis.procedure = { mutation: (fn) => fn };
  new Function(out)();
  delete globalThis.procedure;
  assert.deepEqual(
    defs.map(({ file, line, name }) => ({ file, line, name })),
    [{ file: "src/server/post.ts", line: 3, name: "create (mutation)" }],
  );
  const vendorOnly = `${vendor.code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(vendor.map)).toString("base64")}`;
  assert.equal(transformSync(vendorOnly, "/proj/.next/server/chunks/v.js", ".next/server/chunks/v.js", 8, "/proj"), vendorOnly);
});

test("bundles: an identifier the bundler renamed (esbuild's action5) takes its original name", async () => {
  const { transformSync } = await import("../src/babel-plugin.mjs");
  const babel = (await import("@babel/core")).default;
  const rename = () => ({ visitor: { Program: (p) => p.scope.rename("action", "action5") } });
  const src = "async function action() {\n  return 1;\n}\nconst loader = action;";
  const out = babel.transformSync(src, { sourceFileName: "../app/routes/join.tsx", sourceMaps: true, babelrc: false, configFile: false, plugins: [rename] });
  assert.match(out.code, /action5/);
  const bundle = `${out.code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(out.map)).toString("base64")}`;
  defs.length = 0;
  new Function(transformSync(bundle, "/proj/build/index.js", "build/index.js", 9, "/proj"))();
  assert.deepEqual(defs.map(({ file, line, name }) => ({ file, line, name })), [{ file: "app/routes/join.tsx", line: 1, name: "action" }]);
});

test("names: wrapper calls and builder chains take the name they are given", async () => {
  defs.length = 0;
  await evaluate(await compile("const wrap = (f) => f; const register = wrap(async (req) => 1); export default register;"));
  assert.deepEqual(defs.map((d) => d.name), ["wrap", "register"]);
});
