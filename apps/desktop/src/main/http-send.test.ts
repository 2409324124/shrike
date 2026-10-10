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
  await assert.rejects(sendRequest(store, { method: "GET", url: "/" }, base, "agent"), /Couldn't reach/);
});
