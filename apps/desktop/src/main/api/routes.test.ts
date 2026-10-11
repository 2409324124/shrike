import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Route } from "@shrike/schema";
import { Store } from "../store.ts";
import { createApi } from "./index.ts";
import { fetchSpec, findSpecFiles, guessRequest, mergeRoutes, parseGuesses, routeKey, schemaFromExample, specDocs } from "./routes.ts";

const SPEC = {
  openapi: "3.1.0",
  info: { title: "Orders", version: "1.2.0" },
  servers: [{ url: "http://localhost:4410/v1" }],
  paths: {
    "/orders/{order_id}": {
      parameters: [{ name: "order_id", in: "path", required: true, schema: { type: "integer" } }],
      get: { tags: ["orders"], summary: "One order", parameters: [{ name: "expand", in: "query", schema: { type: "string", enum: ["lines", "customer"] } }], responses: { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } }, "404": { description: "Not found" } } },
    },
    "/orders": {
      post: {
        summary: "Place an order",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/OrderIn" } } } },
        responses: { "201": { description: "Created" }, "422": { $ref: "#/components/responses/Invalid" } },
      },
    },
  },
  components: {
    schemas: {
      Line: { type: "object", required: ["sku", "qty"], properties: { sku: { type: "string" }, qty: { type: "integer" } } },
      OrderIn: { allOf: [{ type: "object", required: ["customer"], properties: { customer: { type: "string", format: "email" } } }, { properties: { lines: { type: "array", items: { $ref: "#/components/schemas/Line" } }, next: { $ref: "#/components/schemas/OrderIn" } } }] },
      Order: { type: "object", properties: { id: { type: "integer" }, total: { type: "integer", example: 6480 } } },
    },
    responses: { Invalid: { description: "Bad body", content: { "application/json": { schema: { type: "object", properties: { detail: { type: "string" } } } } } } },
  },
};

test("spec files: shallow first, build and dependency folders skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "shrike-spec-"));
  try {
    for (const f of ["openapi.yaml", "docs/api/orders.openapi.json", "node_modules/x/swagger.json", ".venv/openapi.json", "a/b/c/d/openapi.json", "readme.json"]) {
      mkdirSync(join(root, f, ".."), { recursive: true });
      writeFileSync(join(root, f), "{}");
    }
    assert.deepEqual(findSpecFiles(root), ["openapi.yaml", "docs/api/orders.openapi.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("spec URLs: only the app's own loopback origin, well-known paths in order, first spec wins", async () => {
  const asked: string[] = [];
  const fake = (async (url: string) => {
    asked.push(url);
    if (url.endsWith("/api-json")) return new Response(JSON.stringify({ openapi: "3.0.0", paths: {} }));
    if (url.endsWith("/openapi.json")) return new Response("<html>not json</html>");
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const hit = await fetchSpec("http://localhost:4410/health", fake);
  assert.equal(hit?.from, "http://localhost:4410/api-json");
  assert.deepEqual(asked, ["http://localhost:4410/openapi.json", "http://localhost:4410/api-json"]);
  asked.length = 0;
  assert.equal(await fetchSpec("https://api.example.com", fake), undefined);
  assert.equal(await fetchSpec(undefined, fake), undefined);
  assert.deepEqual(asked, [], "never asks another host");
  const slow = ((_u: string, init: RequestInit) => new Promise((_r, fail) => init.signal!.addEventListener("abort", () => fail(new Error("aborted"))))) as typeof fetch;
  const t = Date.now();
  assert.equal(await fetchSpec("http://127.0.0.1:1", slow, 30), undefined);
  assert.ok(Date.now() - t < 2000, "a silent server times out quickly");
});

test("OpenAPI 3 to route docs: refs, allOf, params, body example, responses, server prefix", () => {
  const { routes, title, version } = specDocs(SPEC);
  assert.equal(title, "Orders");
  assert.equal(version, "1.2.0");
  const one = routes.find((r) => r.method === "GET")!;
  assert.equal(one.path, "/v1/orders/:order_id");
  assert.equal(one.tag, "orders");
  assert.deepEqual(one.params, [
    { name: "order_id", in: "path", required: true, type: "integer" },
    { name: "expand", in: "query", required: false, type: "string", enum: ["lines", "customer"] },
  ]);
  assert.equal(one.responses[0]!.status, "200");
  assert.equal(JSON.parse(one.responses[0]!.example!).total, 6480);
  const place = routes.find((r) => r.method === "POST")!;
  assert.equal(place.tag, "orders", "no tag: the first path segment, past the version");
  assert.deepEqual(place.body!.schema!.required, ["customer"]);
  const props = place.body!.schema!.properties as Record<string, Record<string, unknown>>;
  assert.equal((props.lines!.items as Record<string, unknown>).title, "Line");
  assert.deepEqual(props.next, { type: "object", title: "OrderIn" }, "a cycle stops at its name");
  assert.deepEqual(JSON.parse(place.body!.example!), { customer: "user@example.com", lines: [{ sku: "string", qty: 0 }], next: {} });
  assert.equal(place.responses.find((r) => r.status === "422")!.description, "Bad body");
  assert.throws(() => specDocs({ swagger: "2.0", paths: {} }), /Swagger 2/);
});

test("merge: spec and scan meet on method and path params; guesses fill only what the spec doesn't cover", () => {
  const scanned: Route[] = [
    { method: "GET", path: "/v1/orders/<int:id>", handler: { file: "main.py", line: 86, precision: "exact" } },
    { method: "DELETE", path: "/v1/orders/[id]" },
  ];
  const spec = specDocs(SPEC).routes;
  const guess = { method: "POST", path: "/v1/orders", params: [], responses: [{ status: "200" }], summary: "x" };
  const del = { method: "DELETE", path: "/v1/orders/:id", params: [{ name: "id", in: "path" as const, required: true, example: "7" }], responses: [{ status: "204", description: "Gone" }] };
  const routes = mergeRoutes(spec, scanned, [guess, del]);
  const get = routes.find((r) => r.method === "GET")!;
  assert.deepEqual(get.sources, ["spec", "code"]);
  assert.equal(get.handler?.line, 86);
  assert.equal(routes.find((r) => r.method === "POST")!.summary, "Place an order", "a guess never overrides the spec");
  const d = routes.find((r) => r.method === "DELETE")!;
  assert.deepEqual(d.sources, ["code", "guess"]);
  assert.equal(d.params[0]!.example, "7");
  assert.equal(d.responses[0]!.status, "204");
  assert.equal(routeKey("get", "/a/{x}/"), routeKey("GET", "/a/:y"));
});

test("agent guesses: the last JSON block, zod-checked, cut to the routes asked about, redacted", () => {
  const asked = [{ method: "POST", path: "/v1/users" }];
  const reply = [
    "I read src/server.ts. Here is a draft:",
    "```json\n{\"routes\":[]}\n```",
    "Final:",
    "```json",
    JSON.stringify({
      routes: [
        { method: "post", path: "/v1/users", summary: "Creates a user", params: [{ name: "x-trace", in: "header", example: 3 }], body: { example: { email: "sam@example.com", name: "Sam", token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB" }, required: ["email", "name", "nope"] }, responses: [{ status: 201, description: "Created", example: { id: 1 } }, { status: "409" }] },
        { method: "DELETE", path: "/v1/everything", params: [], responses: [] },
      ],
    }),
    "```",
  ].join("\n");
  const [g, ...rest] = parseGuesses(reply, asked);
  assert.equal(rest.length, 0, "a route nobody asked about is dropped");
  assert.equal(g!.method, "POST");
  assert.deepEqual(g!.params, [{ name: "x-trace", in: "header", required: false, example: "3" }]);
  assert.deepEqual(g!.body!.schema, { type: "object", properties: { email: { type: "string" }, name: { type: "string" }, token: { type: "string" } }, required: ["email", "name"] });
  assert.match(g!.body!.example, /\[redacted/);
  assert.doesNotMatch(g!.body!.example, /ghp_/);
  assert.deepEqual(g!.responses.map((r) => r.status), ["201", "409"]);
  assert.throws(() => parseGuesses("no json here", asked), /no examples/);
  assert.throws(() => parseGuesses('```json\n{"routes":[{"method":"POST","path":"no-slash"}]}\n```', asked), /shape/);
  assert.deepEqual(schemaFromExample([{ n: 1.5, ok: true }]), { type: "array", items: { type: "object", properties: { n: { type: "number" }, ok: { type: "boolean" } } } });
  const req = guessRequest(g!);
  assert.equal(req.url, "/v1/users");
  assert.equal(req.body.type, "json");
  assert.match(req.docs!, /^Guessed from code/);
});

test("routes view: a spec file in the repo, merged with scanned routes; an accepted guess is saved and lands in the collection", async () => {
  const root = mkdtempSync(join(tmpdir(), "shrike-routes-"));
  const state = mkdtempSync(join(tmpdir(), "shrike-routes-state-"));
  try {
    writeFileSync(join(root, "openapi.json"), JSON.stringify(SPEC));
    const scanned: Route[] = [{ method: "DELETE", path: "/v1/orders/:id", handler: { file: "main.py", line: 90, precision: "exact" } }];
    const api = createApi({ stateDir: () => state, projectRoot: () => root, keychain: { encrypt: (s) => s, decrypt: (s) => s }, store: new Store({ projectRoot: () => root, onUpdate: () => {} }), baseUrl: () => undefined, routes: () => scanned, getAction: () => undefined, ask: async () => '```json\n{"routes":[{"method":"DELETE","path":"/v1/orders/:id","params":[{"name":"id","in":"path","example":"7"}],"responses":[{"status":"204"}]}]}\n```' });
    const v = await api.routes();
    assert.equal(v.spec?.from, "openapi.json");
    assert.deepEqual(v.routes.map((r) => `${r.method} ${r.path} ${r.sources.join("+")}`), ["POST /v1/orders spec", "DELETE /v1/orders/:id code", "GET /v1/orders/:order_id spec"]);
    const [g] = await api.guessRoutes([{ method: "DELETE", path: "/v1/orders/:id" }]);
    const after = await api.saveGuess(g!);
    assert.deepEqual(after.routes.find((r) => r.method === "DELETE")!.sources, ["code", "guess"]);
    await api.saveGuess(g!); // again: replaced, not duplicated
    assert.equal(JSON.parse(readFileSync(join(root, ".shrike/api/guessed-routes.json"), "utf8")).length, 1);
    const [col] = await api.collections();
    const reqs = JSON.stringify(col!.tree);
    assert.equal(reqs.match(/DELETE \/v1\/orders\/:id/g)?.length, 1);
    const folder = col!.tree.find((n) => n.type === "folder" && n.name === "orders");
    assert.ok(folder?.type === "folder", "saved under the route's group");
    const saved = await api.readRequest(col!.id, folder.children[0]!.path);
    assert.equal(saved.pathParams[0]?.value, "7");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});
