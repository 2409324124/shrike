import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { resolveTarget, sendRequest } from "./http-send.ts";
import { Store } from "./store.ts";

test("resolveTarget only allows local http(s)", () => {
  assert.equal(resolveTarget("/api/todos?x=1", "http://localhost:5173").href, "http://localhost:5173/api/todos?x=1");
  assert.throws(() => resolveTarget("https://example.com/", undefined), /only sends requests to your local app/);
  assert.throws(() => resolveTarget("file:///etc/passwd", undefined), /Only http/);
  assert.throws(() => resolveTarget("/api", undefined), /Run your app first/);
  // #53: a live project's own origins too, and nothing else
  assert.equal(resolveTarget("https://demo.example.com/x", undefined, ["https://demo.example.com"]).host, "demo.example.com");
  assert.throws(() => resolveTarget("https://other.example.com/x", undefined, ["https://demo.example.com"]), /only sends requests to your local app/);
});

test("#53: on a live origin an agent can't change data, and no traceparent is added", async () => {
  let seen: string | undefined;
  const srv = createServer((req, res) => {
    seen = req.headers.traceparent as string | undefined;
    if (req.url === "/out") return void res.writeHead(302, { location: "https://shrike-outside.test/x" }).end();
    res.end("ok");
  }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const store = new Store({ projectRoot: () => "/p", onUpdate: () => {} });
  await assert.rejects(sendRequest(store, { method: "POST", url: "/x", body: "{}" }, base, "agent", [base]), /This is your live site/);
  assert.equal(seen, undefined, "refused before anything is sent");
  assert.equal((await sendRequest(store, { method: "GET", url: "/x" }, base, "agent", [base])).response.body, "ok");
  assert.equal(seen, undefined);
  assert.equal((await sendRequest(store, { method: "GET", url: "/out" }, base, "agent", [base])).response.status, 302, "a redirect off the live origin is never followed");
  srv.close();
});

test("sendRequest records an explorer action with traceparent", async () => {
  let seen: string | undefined;
  const srv = createServer((req, res) => {
    seen = req.headers.traceparent as string;
    res.writeHead(500, { "content-type": "application/json" }).end('{"error":"boom"}');
  }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const store = new Store({ projectRoot: () => "/p", onUpdate: () => {} });

  const { response, actionId } = await sendRequest(store, { method: "post", url: "/api/todos", body: '{"title":"x"}' }, base, "explorer");
  assert.equal(response.status, 500);
  assert.equal(response.body, '{"error":"boom"}');
  const view = await store.waitForAction(actionId, 2000);
  assert.equal(view?.complete, true);
  assert.equal(view?.label, "Sent POST /api/todos");
  assert.equal(view?.trigger, "explorer");
  assert.equal(view?.status, "error");
  const req = view?.tree[0]?.event;
  assert.equal(seen, `00-${view?.traceId}-${req?.id}-01`);
  assert.equal(req?.http?.reqBody, '{"title":"x"}');

  // AP: a named resend carries its name to the caller card and links to the trip it edits; a hidden value isn't sent.
  const named = await sendRequest(store, { method: "POST", url: "/api/todos", body: "{}", name: "Create todo", resendOf: actionId }, base, "explorer");
  const root = (await store.waitForAction(named.actionId, 2000))?.root;
  assert.deepEqual(root?.caller, { kind: "explorer", label: "Create todo" });
  assert.equal(root?.resendOf, actionId);
  await assert.rejects(sendRequest(store, { method: "GET", url: "/", headers: { authorization: "[redacted:authorization]" } }, base, "explorer"), /Type the real value for \[redacted:authorization\]/);

  srv.close();
  srv.closeAllConnections();
  await new Promise((r) => setTimeout(r, 100)); // let the pooled keep-alive socket see its close
  await assert.rejects(sendRequest(store, { method: "GET", url: "/" }, base, "agent"), /Nothing is listening on 127\.0\.0\.1:\d+\. Is your app running\?/);
});

test("sendRequest: redirects stay on localhost, big and binary bodies are capped, TLS says why", async () => {
  const srv = createServer((q, r) => {
    if (q.url === "/out") return void r.writeHead(302, { location: "http://shrike-outside.test/x" }).end();
    if (q.url === "/hop") return void r.writeHead(303, { location: "/done" }).end();
    if (q.url === "/done") return void r.end(`${q.method} done`);
    if (q.url === "/bin") return void r.writeHead(200, { "content-type": "image/png" }).end(Buffer.from([0x89, 0x50, 0, 1, 2, 255]));
    if (q.url === "/huge") {
      r.writeHead(200, { "content-type": "text/plain" });
      const chunk = Buffer.alloc(1 << 20, 97);
      let n = 0;
      const write = () => {
        while (n < 40) if ((n++, !r.write(chunk))) return void r.once("drain", write);
        r.end();
      };
      return write();
    }
    r.end("ok");
  }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const port = (srv.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const store = new Store({ projectRoot: () => "/p", onUpdate: () => {} });

  // Before: fetch followed the 302 off localhost (here it failed on DNS with "Couldn't reach").
  const out = await sendRequest(store, { method: "GET", url: "/out" }, base, "agent");
  assert.equal(out.response.status, 302, "a redirect off localhost comes back, never followed");
  const hop = await sendRequest(store, { method: "POST", url: "/hop", body: "{}" }, base, "agent");
  assert.equal(hop.response.body, "GET done", "a local 303 is followed as a GET");
  assert.equal((await sendRequest(store, { method: "GET", url: "/bin" }, base, "agent")).response.body, "[binary image/png, 6 bytes]");
  const before = process.memoryUsage().rss;
  const huge = await sendRequest(store, { method: "GET", url: "/huge" }, base, "agent");
  assert.ok(huge.response.body.length < 1.1 * 1024 * 1024 && huge.response.body.endsWith("…[truncated]"));
  assert.ok(process.memoryUsage().rss - before < 30 * 1024 * 1024, "the rest of a 40MB body is never read");
  await assert.rejects(sendRequest(store, { method: "GET", url: `https://localhost:${port}/` }, base, "agent"), /didn't answer over https\. Try http:\/\//);
  srv.close();
});
