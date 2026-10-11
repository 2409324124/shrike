import assert from "node:assert/strict";
import { test } from "node:test";
import type { RouteDoc } from "@shrike/schema";
import { checkBody, docFor, groupRoutes, reqFromDoc, schemaRows, seenIn, testFromDoc } from "./routes.ts";

const ORDER_IN = {
  type: "object",
  required: ["customer", "lines"],
  properties: {
    customer: { type: "string", description: "Their email" },
    coupon: { type: ["string", "null"] },
    lines: { type: "array", items: { type: "object", required: ["sku", "qty"], properties: { sku: { type: "string", enum: ["BEANS", "MILK"] }, qty: { type: "integer" } } } },
  },
};
const POST: RouteDoc = { method: "POST", path: "/orders", tag: "orders", sources: ["spec"], summary: "Create Order", params: [], body: { contentType: "application/json", required: true, schema: ORDER_IN, example: '{"customer":"a@b.c","lines":[{"sku":"BEANS","qty":1}]}' }, responses: [{ status: "201" }, { status: "422" }] };
const GET: RouteDoc = { method: "GET", path: "/orders/:order_id", tag: "orders", sources: ["code"], params: [{ name: "order_id", in: "path", required: true, example: "5" }, { name: "expand", in: "query", required: true, example: "lines" }, { name: "x-team", in: "header", required: false }], responses: [] };

test("body check: plain words for missing, wrong type, wrong value and unknown fields; a good body has none", () => {
  assert.deepEqual(checkBody(ORDER_IN, { customer: "a@b.c", coupon: null, lines: [{ sku: "BEANS", qty: 3 }] }), []);
  assert.deepEqual(checkBody(ORDER_IN, { Customer: "a@b.c", lines: [{ sku: "beans", qty: "3" }, { sku: "MILK", qty: 1.5 }] }), [
    "customer is missing. The API needs it.",
    "Customer isn't a field the API knows. Did you mean customer?",
    "lines[0].sku should be one of BEANS, MILK.",
    "lines[0].qty should be a whole number, not text.",
    "lines[1].qty should be a whole number, not a number.",
  ]);
  assert.deepEqual(checkBody(ORDER_IN, { customer: "a", lines: [], coupn: "X" }), ["coupn isn't a field the API knows. Did you mean coupon?"], "a typo suggests the near name");
  assert.deepEqual(checkBody(ORDER_IN, []),["The body should be an object, not a list."]);
  assert.deepEqual(checkBody({ type: "object", properties: { a: { type: "number" } } }, { a: 2 }), [], "a whole number is a number");
  assert.deepEqual(checkBody({ type: "object", properties: { a: {} }, additionalProperties: true }, { b: 1 }), [], "extra fields allowed when the schema says so");
  assert.deepEqual(checkBody(undefined, { x: 1 }), []);
});

test("schema rows: nested fields indented, required marked, list items shown as their fields", () => {
  assert.deepEqual(schemaRows(ORDER_IN), [
    { name: "customer", depth: 0, type: "string", required: true, description: "Their email" },
    { name: "coupon", depth: 0, type: "string", required: false },
    { name: "lines", depth: 0, type: "object[]", required: true },
    { name: "sku", depth: 1, type: "string", required: true, enum: ["BEANS", "MILK"] },
    { name: "qty", depth: 1, type: "integer", required: true },
  ]);
});

test("routes: found by a concrete URL, grouped and searched, marked when a call was seen", () => {
  assert.equal(docFor([POST, GET], "get", "http://localhost:4410/orders/5?expand=lines"), GET);
  assert.equal(docFor([POST, GET], "POST", "{{baseUrl}}/orders"), POST);
  assert.equal(docFor([POST, GET], "DELETE", "/orders/5"), undefined);
  assert.deepEqual(groupRoutes([POST, GET], "create").map((g) => [g.tag, g.routes.length]), [["orders", 1]]);
  assert.equal(seenIn(GET, [{ method: "GET", url: "http://localhost:4410/orders/9" }]), true);
  assert.equal(seenIn(POST, [{ method: "GET", url: "/orders" }]), false);
});

test("Try it: examples from the doc, required query params on; Save as test adds the first 2xx", () => {
  const g = reqFromDoc(GET);
  assert.equal(g.url, "/orders/:order_id?expand=lines");
  assert.deepEqual(g.pathVals, { order_id: "5" });
  assert.deepEqual(g.headers.map((h) => [h.name, h.on]), [["x-team", false]]);
  const p = reqFromDoc(POST);
  assert.equal(p.body.mode, "json");
  assert.equal(JSON.parse(p.body.text).lines[0].sku, "BEANS");
  assert.equal(p.docs, "Create Order");
  const seen = reqFromDoc({ ...GET, params: [] }, [{ method: "GET", url: "/orders/42" }]);
  assert.equal(seen.pathVals.order_id, "42", "the last real call fills what the doc doesn't");
  assert.deepEqual(testFromDoc(POST).asserts.map((a) => [a.expr, a.op, a.value]), [["res.status", "eq", "201"]]);
});
