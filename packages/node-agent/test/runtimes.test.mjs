// Real runtimes (docs/13 real projects): CommonJS apps, nest-style `node dist/main` with source maps,
// servers started by a framework CLI in node_modules, and build helpers that must stay inert.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const register = pathToFileURL(path.join(here, "..", "src", "register.mjs")).href;
const babel = createRequire(import.meta.url)("@babel/core");
const ts = createRequire(import.meta.url)("@babel/plugin-transform-typescript").default;

let root;
let ingest;
const write = (rel, text) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};

before(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "shrike-rt-")));
  write("package.json", JSON.stringify({ name: "rt-app" }));
  write(
    "src/user.service.js",
    `function createUser(name) {
  return { name };
}
const handle = wrap(async (url) => createUser(url));
function wrap(fn) {
  return fn;
}
module.exports = { handle };
`,
  );
  write(
    "src/main.js",
    `const http = require("node:http");
const svc = require(process.env.SVC);
const server = http.createServer(async (req, res) => res.end(JSON.stringify(await svc.handle(req.url))));
server.listen(0, () => console.log("listening " + server.address().port));
`,
  );
  // nest-cli style: dist/*.js compiled from src/*.ts with a .js.map next to it, started as `node dist/main`.
  const src = `interface Dto {
  name: string;
}

export class UsersService {
  create(dto: Dto): Dto {
    return { name: dto.name };
  }
}
exports.handle = async (url: string) => new UsersService().create({ name: url });
`;
  write("src/users.service.ts", src);
  const out = babel.transformSync(src, {
    filename: path.join(root, "src/users.service.ts"),
    sourceFileName: "../src/users.service.ts",
    sourceMaps: true,
    babelrc: false,
    configFile: false,
    plugins: [ts],
  });
  write("dist/users.service.js", out.code.replace("export class", "class") + "\n//# sourceMappingURL=users.service.js.map\n");
  write("dist/users.service.js.map", JSON.stringify(out.map));
  write("dist/main.js", `process.env.SVC ??= require.resolve("./users.service.js");\nrequire("../src/main.js");\n`);
  for (const bin of ["node_modules/next/dist/bin/next", "node_modules/vite/bin/vite.js", ".next/postcss.js"]) {
    write(bin, `require(${JSON.stringify(path.join(root, "src/main.js"))});\n`);
  }
  // npm/remix dev style: a tool runs a script that sets its own NODE_OPTIONS.
  write(
    "node_modules/runner/cli.js",
    `const c = require("node:child_process").spawn("sh", ["-c", "NODE_OPTIONS='--no-deprecation' exec node src/main.js"], { stdio: "inherit" });
process.on("SIGTERM", () => (c.kill(), process.exit()));
`,
  );
  write("node_modules/next/package.json", JSON.stringify({ name: "next" }));
  write("node_modules/vite/package.json", JSON.stringify({ name: "vite" }));

  const messages = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      messages.push(JSON.parse(body));
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  ingest = { server, messages, url: `http://127.0.0.1:${server.address().port}` };
});

after(() => {
  ingest?.server.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

// Runs `node <entry>`, makes one request, returns what it told the ingest.
async function run(entry, svc) {
  ingest.messages.length = 0;
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      NODE_OPTIONS: `--import=${register} --enable-source-maps`,
      SHRIKE_INGEST_URL: ingest.url,
      SHRIKE_PROJECT_ROOT: root,
      SHRIKE_SERVICE: "",
      SVC: svc ?? path.join(root, "src/user.service.js"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  try {
    const port = await new Promise((resolve, reject) => {
      let out = "";
      child.stdout.on("data", (c) => {
        out += c;
        const m = /listening (\d+)/.exec(out);
        if (m) resolve(m[1]);
      });
      child.on("exit", (code) => reject(new Error(`exited ${code}: ${stderr}`)));
    });
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/ann`)).text(), JSON.stringify({ name: "/ann" }));
    await new Promise((r) => setTimeout(r, 400));
  } finally {
    child.kill();
  }
  const events = ingest.messages.flatMap((m) => (m.type === "events" ? m.events : []));
  return { hello: ingest.messages.find((m) => m.type === "hello"), fns: events.filter((e) => e.kind === "function") };
}

const steps = (fns) => fns.map((e) => `${e.name} ${e.source.file}:${e.source.line}`).sort();

test("CommonJS app: function steps from require()d files", async () => {
  const { hello, fns } = await run("src/main.js");
  assert.equal(hello?.place.id, "service:rt-app");
  assert.deepEqual(steps(fns), ["createUser() src/user.service.js:1", "handle() src/user.service.js:4", "server (createServer)() src/main.js:3"]);
});

test("nest-cli style `node dist/main`: argv without extension, steps point at src/*.ts", async () => {
  const { hello, fns } = await run("dist/main", path.join(root, "dist/users.service.js"));
  assert.ok(hello, "agent active");
  assert.deepEqual(steps(fns), ["UsersService.create() src/users.service.ts:6", "handle() src/users.service.ts:10", "server (createServer)() src/main.js:3"]);
});

test("framework CLI in node_modules (next) runs the app: active, named after the project", async () => {
  const { hello, fns } = await run("node_modules/next/dist/bin/next");
  assert.equal(hello?.place.id, "service:rt-app");
  assert.equal(fns.length, 3);
});

test("a script that sets its own NODE_OPTIONS still runs the agent", async () => {
  const { hello, fns } = await run("node_modules/runner/cli.js");
  assert.equal(hello?.place.id, "service:rt-app");
  assert.equal(fns.length, 3);
});

test("withAgent keeps our flag in NODE_OPTIONS assignments", async () => {
  const { withAgent } = await import(register);
  const f = "--import=file:///a/register.mjs";
  assert.equal(withAgent(`NODE_OPTIONS="--import ./mocks/index.js" remix-serve x`, f), `NODE_OPTIONS="--import ./mocks/index.js ${f}" remix-serve x`);
  assert.equal(withAgent(`NODE_OPTIONS='--inspect' next dev`, f), `NODE_OPTIONS='--inspect ${f}' next dev`);
  assert.equal(withAgent(`cross-env NODE_OPTIONS=--max-old-space-size=4096 next build`, f), `cross-env NODE_OPTIONS="--max-old-space-size=4096 ${f}" next build`);
  for (const same of [`NODE_OPTIONS="$NODE_OPTIONS --inspect" next`, `NODE_OPTIONS="${f}" x`, "next dev"]) assert.equal(withAgent(same, f), same);
});

test("other node_modules tools and build helpers stay inert", async () => {
  for (const entry of ["node_modules/vite/bin/vite.js", ".next/postcss.js"]) {
    const { hello } = await run(entry);
    assert.equal(hello, undefined, entry);
  }
});
