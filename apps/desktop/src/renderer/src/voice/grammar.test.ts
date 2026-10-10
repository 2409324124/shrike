import { test } from "node:test";
import assert from "node:assert/strict";
import { contextWords, matchFile } from "./grammar.ts";

const FILES = ["server/todos.controller.ts", "server/todos.service.ts", "server/index.ts", "web/src/App.tsx", "web/src/components/TodoList.tsx", "web/src/api.ts", "package.json", "README.md"];

test("open <file> is fuzzy over the project's files", () => {
  assert.equal(matchFile("controller", FILES), "server/todos.controller.ts");
  assert.equal(matchFile("todos controller", FILES), "server/todos.controller.ts");
  assert.equal(matchFile("todo controler", FILES), "server/todos.controller.ts", "a misheard letter");
  assert.equal(matchFile("the todos service file", FILES), "server/todos.service.ts");
  assert.equal(matchFile("to do list", FILES), "web/src/components/TodoList.tsx", "glued words");
  assert.equal(matchFile("app", FILES), "web/src/App.tsx");
  assert.equal(matchFile("readme", FILES), "README.md");
  assert.equal(matchFile("package json", FILES), "package.json");
  assert.equal(matchFile("banana", FILES), null);
  assert.equal(matchFile("file", FILES), null);
});

test("the recognizer's hints: live names and file names in words", () => {
  const w = contextWords(FILES, ["admin", "PR 42"]);
  assert.ok(w.includes("todos controller") && w.includes("todo list") && w.includes("admin") && w.includes("PR 42"));
  assert.ok(w.length <= 300);
});
