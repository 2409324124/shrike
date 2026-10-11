// Look inside (docs/13 DB): settings discovery, lane matching, and each engine's read-only reader. The real-database
// cases run against packages/node-agent/test/drivers/containers.sh (non-standard ports) and skip when it isn't up.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import type { InspectRequest, InspectResult } from "@shrike/schema";
import { InspectHub } from "../inspector.ts";
import { discover, parseEnv, type Source } from "./discover.ts";
import { directInspect, pick, plainError } from "./index.ts";

const PW = "shrike-secret-pw";
const up = (port: number) => new Promise<boolean>((r) => net.connect(port, "127.0.0.1").on("connect", function (this: net.Socket) { this.destroy(); r(true); }).on("error", () => r(false)));
const avail = { pg: await up(25432), mysql: await up(23306), redis: await up(26379), mongo: await up(27117) };
const PG: Source = { engine: "postgres", from: ".env", host: "127.0.0.1", port: 25432, database: "shrike", url: `postgresql://postgres:${PW}@127.0.0.1:25432/shrike` };
const MY: Source = { engine: "mysql", from: ".env", host: "127.0.0.1", port: 23306, database: "shrike", url: `mysql://root:${PW}@127.0.0.1:23306/shrike` };
const RD: Source = { engine: "redis", from: ".env", host: "127.0.0.1", port: 26379, url: `redis://:${PW}@127.0.0.1:26379/0` };
const MG: Source = { engine: "mongodb", from: ".env", host: "127.0.0.1", port: 27117, database: "shrike_inspect", url: "mongodb://127.0.0.1:27117/shrike_inspect" };
const read = (s: Source, req: InspectRequest) => directInspect("/nowhere", req, [s])!;

test("parseEnv: quotes, export, comments", () => {
  assert.deepEqual(parseEnv(`export A="x # y"\nB=plain # note\nC='q'\n# D=no\nE=`), { A: "x # y", B: "plain", C: "q", E: "" });
});

test("discover: URLs, split DB_* vars, Prisma sqlite, compose, supabase and firebase configs, sqlite files", () => {
  const root = mkdtempSync(join(tmpdir(), "shrike-ds-"));
  try {
    mkdirSync(join(root, "backend"));
    mkdirSync(join(root, "prisma"));
    mkdirSync(join(root, "supabase"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { mysql2: "*" } }));
    writeFileSync(join(root, ".env"), `DATABASE_URL="postgresql+psycopg://app:pw1@localhost:15434/app"\nREDIS_URL=redis://localhost:16379\nNEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:15421\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=pk-1\nLITE_URL=file:./dev.db\n`);
    writeFileSync(join(root, "backend", ".env"), "DB_HOST=127.0.0.1\nDB_PORT=13307\nDB_USER=root\nDB_PASSWORD=root\nDB_NAME=test\nMONGODB_URL=mongodb://127.0.0.1:17017/node-boilerplate\n");
    writeFileSync(join(root, "prisma", "schema.prisma"), `datasource db {\n  provider = "sqlite"\n  url      = env("LITE_URL")\n}\n`);
    writeFileSync(join(root, "docker-compose.yml"), `services:\n  db:\n    image: postgres:16\n    ports:\n      - "15999:5432"\n    environment:\n      POSTGRES_USER: shopper\n      POSTGRES_PASSWORD: pw2\n      POSTGRES_DB: shop\n`);
    writeFileSync(join(root, "supabase", "config.toml"), `[api]\nport = 15421\n\n[db]\nport = 15422\n`);
    writeFileSync(join(root, "firebase.json"), JSON.stringify({ emulators: { firestore: { port: 18080 } } }));
    writeFileSync(join(root, ".firebaserc"), JSON.stringify({ projects: { default: "demo-shrike" } }));
    writeFileSync(join(root, "data.sqlite"), "");
    assert.equal(discover(root).find((s) => s.from === "docker-compose.yml")?.url, "postgresql://shopper:pw2@127.0.0.1:15999/shop", "the first key under environment: counts");
    const found = discover(root).map(({ url, key, ...s }) => ({ ...s, secret: !!(url || key) }));
    const by = (e: string) => found.filter((s) => s.engine === e).map((s) => `${s.host ?? s.file}:${s.port ?? ""}/${s.database ?? ""} ${s.from}`);
    assert.deepEqual(by("postgres"), ["localhost:15434/app .env", "localhost:15422/postgres supabase/config.toml", "localhost:15999/shop docker-compose.yml"]);
    assert.deepEqual(by("mysql"), ["127.0.0.1:13307/test backend/.env"]);
    assert.deepEqual(by("mongodb"), ["127.0.0.1:17017/node-boilerplate backend/.env"]);
    assert.deepEqual(by("redis"), ["localhost:16379/ .env"]);
    assert.deepEqual(by("supabase"), ["127.0.0.1:15421/ .env"]);
    assert.deepEqual(by("firestore"), ["localhost:18080/ firebase.json"]);
    assert.deepEqual(by("sqlite"), [`${join(root, "prisma", "dev.db")}:/ prisma/schema.prisma`, `${join(root, "data.sqlite")}:/ data.sqlite`]);
    assert.ok(found.every((s) => !JSON.stringify(s).includes("pw1") && !JSON.stringify(s).includes("pw2")), "the listing itself carries no passwords");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pick: a lane's host, port and database choose the source; an expected lane takes the first of its engine", () => {
  const a: Source = { engine: "postgres", from: "a/.env", host: "localhost", port: 5432, database: "app" };
  const b: Source = { engine: "postgres", from: "b/.env", host: "127.0.0.1", port: 15433, database: "postgres" };
  const sb: Source = { engine: "postgres", from: "supabase/config.toml", host: "localhost", port: 15422, database: "postgres", supabase: true };
  const api: Source = { engine: "supabase", from: ".env.local", host: "127.0.0.1", port: 15421 };
  const lite: Source = { engine: "sqlite", from: "prisma/schema.prisma", file: "/p/prisma/data.db" };
  const all = [a, b, sb, api, lite];
  assert.equal(pick("data:postgres:localhost:15433/postgres", all)?.source, b);
  assert.equal(pick("data:postgres", all)?.source, a);
  assert.equal(pick("data:postgres:db.example.com:5432/x", all), undefined);
  assert.equal(pick("data:supabase:localhost:15421", all)?.source, sb, "its own database beats the API");
  assert.equal(pick("data:supabase:localhost:15421", [a, api])?.source, api);
  assert.equal(pick("data:sqlite:data.db", all)?.source, lite);
  assert.equal(pick("data:sqlite:other.db", all), undefined);
  assert.equal(pick("data:mysql", all), undefined);
  assert.equal(pick("data:localhost:15433", all)?.source, b, "a place declared by host and port in .shrike/config.json");
  assert.equal(pick("data:localhost:5432/app", all)?.source, a);
  assert.equal(pick("data:localhost:9999", all), undefined);
});

test("errors in plain words, never the connection string", () => {
  const s: Source = { ...PG, url: "postgresql://u:topsecret@db.internal:5432/x", host: "db.internal", port: 5432 };
  assert.equal(plainError(Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" }), s).message, "Shrike couldn't reach the database at db.internal:5432. Is it running?");
  assert.match(plainError(new Error('password authentication failed for user "u"'), s).message, /turned down the login from \.env/);
  assert.doesNotMatch(plainError(new Error("bad thing at postgresql://u:topsecret@db.internal:5432/x"), s).message, /topsecret/);
});

describe("sqlite", () => {
  let dir: string;
  let s: Source;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "shrike-ds-lite-"));
    const db = new DatabaseSync(join(dir, "app.db"));
    db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, password TEXT); INSERT INTO users (email, password) VALUES ('ada@x.io', 'hunter2'), ('bob@x.io', 'pw')");
    db.close();
    s = { engine: "sqlite", from: "app.db", file: join(dir, "app.db") };
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("tables, rows, search, and a write is refused", async () => {
    const t = await read(s, { op: "tables", placeId: "data:sqlite:app.db" });
    assert.ok(t.op === "tables" && t.system === "sqlite");
    assert.deepEqual(t.tables, [{ name: "users", rows: 2, columns: [{ name: "id", pk: true }, { name: "email", pk: false }, { name: "password", pk: false }] }]);
    const r = await read(s, { op: "rows", placeId: "data:sqlite:app.db", table: "users", search: "bob" });
    assert.ok(r.op === "rows");
    assert.deepEqual(r.rows, [[2, "bob@x.io", "pw"]]);
    const { readOnly } = await import("./sqlite.ts");
    await assert.rejects(readOnly(s, (db) => db.exec("INSERT INTO users (email) VALUES ('evil')")), /readonly/i);
  });

  test("through the hub: no process holds it, main reads it directly and redacts", async () => {
    const hub = new InspectHub({ direct: (req) => directInspect("/nowhere", req, [s]) });
    const r = await hub.request({ op: "rows", placeId: "data:sqlite:app.db", table: "users" });
    assert.ok(r.op === "rows");
    assert.deepEqual(r.rows[0], [1, "ada@x.io", "[redacted:password]"]);
  });

  test("a file found through prisma/schema.prisma is named by its own path", async () => {
    const t = await directInspect(dir, { op: "tables", placeId: "data:sqlite:app.db" }, [{ ...s, from: "prisma/schema.prisma" }])!;
    assert.ok(t.op === "tables");
    assert.equal(t.how, "the file app.db, from prisma/schema.prisma.");
  });
});

describe("postgres", { skip: !avail.pg && "postgres container not up (packages/node-agent/test/drivers/containers.sh)" }, () => {
  before(async () => {
    const pg = (await import("pg")).default;
    const c = new pg.Client({ connectionString: PG.url });
    await c.connect();
    await c.query("DROP TABLE IF EXISTS inspect_items; CREATE TABLE inspect_items (id serial PRIMARY KEY, name text, api_key text, made timestamp DEFAULT '2026-01-02 03:04:05'); INSERT INTO inspect_items (name, api_key) VALUES ('pen', 'k1'), ('ink', 'k2')");
    await c.end();
  });

  test("tables, rows, order, and writes fail inside the read-only transaction", async () => {
    const t = await read(PG, { op: "tables", placeId: "data:postgres:localhost:25432/shrike" });
    assert.ok(t.op === "tables" && t.system === "postgres");
    assert.match(t.how, /^a read-only transaction on localhost:25432, from \.env\.$/);
    assert.equal(t.tables.find((x) => x.name === "inspect_items")?.rows, 2);
    const r = await read(PG, { op: "rows", placeId: "data:postgres", table: "inspect_items", orderBy: "name", desc: true });
    assert.ok(r.op === "rows");
    assert.deepEqual(r.rows, [[1, "pen", "k1", "2026-01-02 03:04:05"], [2, "ink", "k2", "2026-01-02 03:04:05"]], "a timestamp shows as stored, not shifted to Shrike's time zone");
    const { readOnly } = await import("./postgres.ts");
    await assert.rejects(readOnly(PG, (q) => q("INSERT INTO inspect_items (name) VALUES ('evil')")), /read-only transaction/);
    await assert.rejects(readOnly(PG, (q) => q("COMMIT; INSERT INTO inspect_items (name) VALUES ('evil')")), /read-only transaction/);
    const again = await read(PG, { op: "tables", placeId: "data:postgres" });
    assert.equal(again.op === "tables" && again.tables.find((x) => x.name === "inspect_items")?.rows, 2, "nothing was written");
  });

  test("a wrong password comes back in plain words without the password", async () => {
    const bad = { ...PG, url: PG.url!.replace(PW, "wrong-pw-xyz") };
    await assert.rejects(read(bad, { op: "tables", placeId: "data:postgres" }), (e: Error) => /turned down the login/.test(e.message) && !e.message.includes("wrong-pw-xyz"));
  });
});

describe("mysql", { skip: !avail.mysql && "mysql container not up" }, () => {
  before(async () => {
    const mysql = await import("mysql2/promise");
    const c = await mysql.createConnection({ uri: MY.url, multipleStatements: true });
    await c.query("DROP TABLE IF EXISTS inspect_users; CREATE TABLE inspect_users (id int AUTO_INCREMENT PRIMARY KEY, firstName varchar(50)); INSERT INTO inspect_users (firstName) VALUES ('Ada'), ('Grace')");
    await c.end();
  });

  test("tables, rows, search, and writes fail in the read-only transaction", async () => {
    const t = await read(MY, { op: "tables", placeId: "data:mysql:localhost:23306/shrike" });
    assert.ok(t.op === "tables" && t.system === "mysql");
    assert.deepEqual(t.tables.find((x) => x.name === "inspect_users"), { name: "inspect_users", rows: 2, columns: [{ name: "id", pk: true }, { name: "firstName", pk: false }] });
    const r = await read(MY, { op: "rows", placeId: "data:mysql", table: "inspect_users", search: "gra" });
    assert.ok(r.op === "rows");
    assert.deepEqual(r.rows, [[2, "Grace"]]);
    const { readOnly } = await import("./mysql.ts");
    await assert.rejects(readOnly(MY, undefined, (q) => q("INSERT INTO inspect_users (firstName) VALUES ('evil')")), /READ ONLY/i);
  });
});

describe("redis", { skip: !avail.redis && "redis container not up" }, () => {
  before(async () => {
    const { createClient } = await import("redis");
    const c = await createClient({ url: RD.url }).connect();
    await c.set("inspect:str", "hello");
    await c.hSet("inspect:hash", { a: "1" });
    await c.del("inspect:list");
    await c.rPush("inspect:list", ["x", "y"]);
    await c.quit();
  });

  test("keys with types and values; write commands are refused", async () => {
    const k = await read(RD, { op: "cacheKeys", placeId: "cache:redis:localhost:26379/0", match: "inspect:" });
    assert.ok(k.op === "cacheKeys");
    const by = Object.fromEntries(k.entries.map((e) => [e.key, `${e.type} ${e.preview}`]));
    assert.deepEqual(by, { "inspect:str": "string hello", "inspect:hash": 'hash {"a":"1"}', "inspect:list": 'list ["x","y"]' });
    const g = await read(RD, { op: "cacheGet", placeId: "cache:redis", key: "inspect:hash" });
    assert.ok(g.op === "cacheGet" && g.value === '{"a":"1"}');
    const { readOnly } = await import("./redis.ts");
    await assert.rejects(readOnly(RD, (send) => send("SET", "inspect:str", "evil")), /not a read command/);
    await assert.rejects(readOnly(RD, (send) => send("FLUSHALL")), /not a read command/);
  });
});

describe("mongodb", { skip: !avail.mongo && "mongo container not up" }, () => {
  before(async () => {
    const { MongoClient } = await import("mongodb");
    const c = await new MongoClient(MG.url!).connect();
    const users = c.db("shrike_inspect").collection("users");
    await users.deleteMany({});
    await users.insertMany([{ email: "ada@x.io", role: "admin" }, { email: "bob@x.io", tags: ["a"] }]);
    await c.close();
  });

  test("collections, documents, search; the facade can't write", async () => {
    const t = await read(MG, { op: "tables", placeId: "data:mongodb:localhost:27117/shrike_inspect" });
    assert.ok(t.op === "tables" && t.system === "mongodb");
    assert.deepEqual(t.tables, [{ name: "users", rows: 2, columns: [{ name: "_id", pk: true }, { name: "email", pk: false }, { name: "role", pk: false }, { name: "tags", pk: false }] }]);
    const r = await read(MG, { op: "rows", placeId: "data:mongodb", table: "users", search: "BOB" });
    assert.ok(r.op === "rows");
    assert.deepEqual(r.columns, ["_id", "email", "role", "tags"]);
    assert.deepEqual(r.rows[0]!.slice(1), ["bob@x.io", null, '["a"]']);
    assert.match(String(r.rows[0]![0]), /^[0-9a-f]{24}$/);
    const { readOnly } = await import("./mongodb.ts");
    await readOnly(MG, undefined, async (db) => {
      assert.deepEqual(Object.keys(db).sort(), ["aggregate", "collections", "count", "estimate", "find"]);
      await assert.rejects(db.aggregate("users", [{ $match: {} }, { $out: "stolen" }]), /only reads/);
      await assert.rejects(db.aggregate("users", [{ $merge: { into: "x" } }]), /only reads/);
    });
  });
});

// Supabase's PostgREST and the Firestore emulator speak HTTP; small stand-ins check what is (and isn't) sent.
describe("http databases", () => {
  let server: http.Server;
  let port = 0;
  const seen: string[] = [];
  const dynamo: string[] = [];
  before(async () => {
    server = http.createServer((req, res) => {
      const json = (v: unknown, h: Record<string, string> = {}) => res.writeHead(200, { "content-type": "application/json", ...h }).end(JSON.stringify(v));
      const target = String(req.headers["x-amz-target"] ?? "");
      if (target) {
        dynamo.push(target.split(".")[1]!);
        if (target.endsWith("ListTables")) return json({ TableNames: ["orders"] });
        if (target.endsWith("DescribeTable")) return json({ Table: { TableName: "orders", ItemCount: 2, KeySchema: [{ AttributeName: "id", KeyType: "HASH" }], AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }] } });
        if (target.endsWith("Scan")) return json({ Items: [{ id: { S: "o1" }, total: { N: "42" } }, { id: { S: "o2" }, paid: { BOOL: true } }], Count: 2 });
        return json({});
      }
      seen.push(`${req.method} ${req.url} ${req.headers.apikey ?? ""}`);
      if (req.url === "/rest/v1/") return json({ definitions: { notes: { properties: { id: { description: "Note:\nThis is a Primary Key.<pk/>", type: "integer" }, title: { type: "string" } } } }, paths: { "/notes": { get: {} } } });
      if (req.url?.startsWith("/rest/v1/notes")) return json([{ id: 1, title: "seeded" }], { "content-range": "0-0/3" });
      if (req.url?.endsWith(":listCollectionIds")) return json({ collectionIds: ["animals"] });
      if (req.url?.includes("/documents/animals")) return json({ documents: [{ name: "projects/demo/databases/(default)/documents/animals/a1", fields: { name: { stringValue: "cat" }, legs: { integerValue: "4" } } }] });
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as net.AddressInfo).port;
  });
  after(() => server.close());

  test("supabase: tables and rows through PostgREST with the key; nothing but GET leaves", async () => {
    const s: Source = { engine: "supabase", from: ".env.local", host: "127.0.0.1", port, url: `http://127.0.0.1:${port}`, key: "anon-1" };
    const t = await read(s, { op: "tables", placeId: `data:supabase:localhost:${port}` });
    assert.ok(t.op === "tables" && t.system === "supabase");
    assert.match(t.how, /row level security applies/);
    assert.deepEqual(t.tables, [{ name: "notes", rows: 3, columns: [{ name: "id", pk: true }, { name: "title", pk: false }] }]);
    const r = await read(s, { op: "rows", placeId: `data:supabase:localhost:${port}`, table: "notes" });
    assert.ok(r.op === "rows" && r.total === 3);
    assert.ok(seen.every((x) => x.startsWith("GET ") && x.endsWith(" anon-1")), seen.join("\n"));
    const { get } = await import("./supabase.ts");
    await assert.rejects(get(s, "/rest/v1/notes", {}, "POST"), /only reads/);
  });

  test("dynamodb: ListTables, DescribeTable, Scan; a PutItem is never sent", async () => {
    const s: Source = { engine: "dynamodb", from: ".env", host: "127.0.0.1", port, url: `http://127.0.0.1:${port}`, region: "local" };
    const t = await read(s, { op: "tables", placeId: `data:dynamodb:localhost:${port}` });
    assert.ok(t.op === "tables" && t.system === "dynamodb");
    assert.deepEqual(t.tables, [{ name: "orders", rows: 2, columns: [{ name: "id", pk: true }] }]);
    const r = await read(s, { op: "rows", placeId: "data:dynamodb", table: "orders" });
    assert.ok(r.op === "rows");
    assert.deepEqual(r.columns, ["id", "total", "paid"]);
    assert.deepEqual(r.rows, [["o1", 42, null], ["o2", null, true]]);
    const { readOnly } = await import("./dynamodb.ts");
    const { PutItemCommand } = await import("@aws-sdk/client-dynamodb");
    await assert.rejects(readOnly(s, (send) => send(new PutItemCommand({ TableName: "orders", Item: { id: { S: "x" } } }) as never)), /only reads/);
    assert.ok(!dynamo.includes("PutItem"), dynamo.join(","));
  });

  test("firestore emulator: collections and documents", async () => {
    const s: Source = { engine: "firestore", from: "firebase.json", host: "127.0.0.1", port, project: "demo" };
    const t = await read(s, { op: "tables", placeId: "data:firestore" });
    assert.ok(t.op === "tables");
    assert.deepEqual(t.tables, [{ name: "animals", rows: 1, columns: [{ name: "id", pk: true }, { name: "name", pk: false }, { name: "legs", pk: false }] }]);
    const r = (await read(s, { op: "rows", placeId: "data:firestore", table: "animals" })) as Extract<InspectResult, { op: "rows" }>;
    assert.deepEqual(r.rows, [["a1", "cat", 4]]);
    const lane = `data:firestore:localhost:${port}/demo-shrike`;
    const t2 = await read(s, { op: "tables", placeId: lane });
    assert.ok(t2.op === "tables" && /project demo-shrike/.test(t2.how ?? ""), "the page's project from the lane beats the settings' guess");
    await read(s, { op: "rows", placeId: lane, table: "animals" });
    assert.ok(seen.some((x) => x.includes("/projects/demo-shrike/") && x.includes("/documents/animals")), seen.join("\n"));
  });
});
