import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { blockEnd, enclosingFunction } from "./panes.ts";

const fixture = fileURLToPath(new URL("../../../../../../fixtures/todo-app/", import.meta.url));
const read = (f: string) => readFileSync(fixture + f, "utf8");

test("blockEnd and enclosingFunction scan real code", () => {
  const form = read("src/TodoForm.tsx").split("\n");
  assert.equal(blockEnd(form, 5), 34); // TodoForm({ onAdded }: Props) {: destructured param is not the body
  assert.equal(blockEnd(form, 9), 20); // handleSubmit
  assert.equal(blockEnd(form, 26), undefined); // onChange={(event) => setTitle(...)} has no block
  assert.equal(enclosingFunction(form, 31), undefined); // TodoForm is longer than MAX_LINES
  assert.deepEqual(enclosingFunction(form, 15), { start: 10, end: 21, name: "handleSubmit" });
  const idx = read("server/index.ts").split("\n");
  assert.deepEqual(enclosingFunction(idx, 16), { start: 15, end: 18, name: "handleError" }); // app.use(function handleError(...) {
  const tpl = ["function f() {", "  const s = `a ${ {x: 1}.x } } b`;", "  // }", "  /* } */ return '}';", "}"];
  assert.equal(blockEnd(tpl, 0), 4);
});
