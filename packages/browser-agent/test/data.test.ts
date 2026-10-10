import assert from "node:assert/strict";
import { test } from "node:test";
import type { DebugEvent } from "@shrike/schema";
import { redactEvent } from "../../redact/src/index.ts";
import { dataKind, toData } from "../src/data.ts";

const req = (method: string, url: string, http: Partial<NonNullable<DebugEvent["http"]>> = {}): DebugEvent => ({
  id: "a".repeat(16), traceId: "1".repeat(32), parentId: "b".repeat(16), origin: "browser", kind: "http_request", name: `${method} ${url}`, startMs: 1, durationMs: 5, status: "ok", stack: "Error\n at x",
  http: { method, url, status: 200, ...http },
});
let n = 0;
const id = () => String(++n).padStart(16, "0");
const one = (method: string, url: string, http?: Partial<NonNullable<DebugEvent["http"]>>, headers: Record<string, string> = {}) => {
  const u = new URL(url);
  const kind = dataKind(u, method, headers);
  return { kind, events: kind ? toData(req(method, url, http), u, kind, id) : [] };
};
const sb = { apikey: "sb_publishable_x", "x-client-info": "supabase-js-web/2.117.0" };

test("supabase-js from the page: PostgREST and auth land on the Supabase lane, writes say what changed", () => {
  const sel = one("GET", "http://127.0.0.1:15421/rest/v1/notes?select=*&id=eq.3", { resBody: '[{"id":3,"title":"x"}]' }, sb);
  assert.equal(sel.kind, "supabase");
  const [s] = sel.events;
  assert.equal(s!.kind, "db_query");
  assert.deepEqual(s!.place, { kind: "data", id: "data:supabase:localhost:15421", name: "SUPABASE · localhost:15421", detail: "localhost:15421" });
  assert.equal(s!.db?.statement, "SELECT * FROM notes WHERE id = $1");
  assert.equal(s!.db?.params, '["3"]');
  assert.equal(s!.returned, "1 row");
  assert.equal(s!.stack, "Error\n at x", "keeps the stack so main finds the calling line");

  const [ins] = one("POST", "https://abcdefghijklmnopqrst.supabase.co/rest/v1/notes", { status: 201, reqBody: '{"title":"new"}', resBody: "" }, sb).events;
  assert.equal(ins!.place?.name, "SUPABASE · abcdefghijklmnopqrst");
  assert.deepEqual(ins!.change, { table: "notes", op: "insert", count: 1, rows: [{ after: { title: "new" } }] });

  const [login] = one("POST", "http://127.0.0.1:15421/auth/v1/token?grant_type=password", { status: 400, resBody: '{"code":400,"error_code":"invalid_credentials","msg":"Invalid login credentials"}' }, sb).events;
  assert.equal(login!.db?.statement, "sign in with password (auth)");
  assert.equal(redactEvent(login!).db?.statement, login!.db?.statement, "main's secret masking leaves the words alone");
  assert.equal(login!.status, "error");
  assert.equal(login!.error?.message, "400 Invalid login credentials");

  const [signup] = one("POST", "http://127.0.0.1:15421/auth/v1/signup", { resBody: '{"id":"u1","email":"a@b.c","created_at":"t","access_token":"secret"}' }, sb).events;
  assert.deepEqual(signup!.change, { table: "auth.users", op: "insert", count: 1, rows: [{ pk: "u1", after: { id: "u1", email: "a@b.c", created_at: "t" } }] });

  assert.equal(one("GET", "http://localhost:3000/rest/v1/notes").kind, undefined, "an app's own /rest/v1 without Supabase headers stays a request");
});

const FS = "http://127.0.0.1:18080/google.firestore.v1.Firestore";
const db = "database=projects%2Fdemo-shrike%2Fdatabases%2F(default)";
const channelBody = (...msgs: unknown[]) => `count=${msgs.length}&ofs=0&` + msgs.map((m, i) => `req${i}___data__=${encodeURIComponent(JSON.stringify(m))}`).join("&");

test("Firestore WebChannel: writes and listens become queries on the Firestore lane; the back channel is left out", () => {
  assert.equal(dataKind(new URL(`${FS}/Write/channel?${db}&RID=rpc&SID=x&TYPE=xmlhttp`), "GET", {}), "skip");
  assert.equal(dataKind(new URL("http://localhost:13001/__nextjs_original-stack-frames"), "POST", {}), "skip", "the Next dev overlay's own call");
  const name = "projects/demo-shrike/databases/(default)/documents";
  const write = one("POST", `${FS}/Write/channel?${db}&VER=8&RID=123`, {
    reqBody: channelBody({ streamToken: "t", writes: [
      { update: { name: `${name}/count/counter`, fields: {} }, updateMask: { fieldPaths: [] }, updateTransforms: [{ fieldPath: "count", increment: { integerValue: "1" } }] },
      { update: { name: `${name}/animals/a1`, fields: { name: { stringValue: "Dog" }, age: { integerValue: "3" } } }, currentDocument: { exists: false } },
    ] }),
  });
  assert.equal(write.kind, "firestore");
  const [inc, add] = write.events;
  assert.equal(inc!.id, "a".repeat(16));
  assert.notEqual(add!.id, inc!.id);
  assert.equal(add!.parentId, inc!.parentId);
  assert.deepEqual(inc!.place, { kind: "data", id: "data:firestore:localhost:18080/demo-shrike", name: "FIRESTORE · demo-shrike", detail: "localhost:18080" });
  assert.equal(inc!.db?.statement, 'db.count.update("counter", {"count":"increment(1)"})');
  assert.deepEqual(inc!.change, { table: "count", op: "update", count: 1, rows: [{ pk: "counter", after: { id: "counter", count: "increment(1)" } }] });
  assert.deepEqual(add!.change, { table: "animals", op: "insert", count: 1, rows: [{ pk: "a1", after: { id: "a1", name: "Dog", age: 3 } }] });

  assert.deepEqual(one("POST", `${FS}/Write/channel?${db}&VER=8&RID=1`, { reqBody: channelBody({ database: "projects/demo-shrike/databases/(default)" }) }).events, [], "the handshake is plumbing");
  const listen = one("POST", `${FS}/Listen/channel?${db}&VER=8&RID=2`, {
    reqBody: channelBody(
      { database: "x", addTarget: { documents: { documents: [`${name}/count/counter`] }, targetId: 2 } },
      { database: "x", addTarget: { query: { parent: name, structuredQuery: { from: [{ collectionId: "animals" }], orderBy: [{ field: { fieldPath: "name" } }], limit: 10 } }, targetId: 4 } },
    ),
  }).events;
  assert.deepEqual(listen.map((e) => e.db?.statement), ['db.count.get("counter")', "db.animals.query(order by name, limit 10)"]);
});
