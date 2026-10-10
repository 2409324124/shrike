import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addMemory, formatMemory, loadMemory, memoryPath, parseMemory, removeMemory } from "./memory.ts";

test("memory.md round trip: format, parse back, hand-written lines too", async () => {
  const root = mkdtempSync(join(tmpdir(), "shrike-mem-"));
  assert.deepEqual(await loadMemory(root), []);

  const a = await addMemory(root, { text: "  userId must be a   number ", file: "server/todos.controller.ts", line: 18, by: "agent" });
  const b = await addMemory(root, { text: "The API runs on port 3001", by: "user" });
  assert.equal(a.note.text, "userId must be a number");
  assert.deepEqual((await addMemory(root, { text: "userId must be a number", file: "server/todos.controller.ts", line: 18, by: "agent" })).note, a.note); // no duplicates

  const md = readFileSync(memoryPath(root), "utf8");
  assert.match(md, /^# Shrike memory\n/);
  assert.match(md, new RegExp(`^- userId must be a number \\(server/todos\\.controller\\.ts:18\\) <!-- id:${a.note.id} by:agent at:\\d+ -->$`, "m"));
  assert.deepEqual(await loadMemory(root), [a.note, b.note]);
  assert.deepEqual(parseMemory(formatMemory([a.note, b.note])), [a.note, b.note]);

  // A person adds lines by hand: plain bullets load, with a stable id.
  writeFileSync(memoryPath(root), `${md}- Todos need a title (src/TodoForm.tsx:31)\n* Prices are in cents (server/pay.ts)\nnot a note\n-   \n`);
  const all = await loadMemory(root);
  assert.equal(all.length, 4);
  assert.deepEqual({ ...all[2], id: "" }, { id: "", text: "Todos need a title", file: "src/TodoForm.tsx", line: 31, createdAt: 0, by: "user" });
  assert.deepEqual({ ...all[3], id: "" }, { id: "", text: "Prices are in cents", file: "server/pay.ts", createdAt: 0, by: "user" });
  assert.equal((await loadMemory(root))[2]!.id, all[2]!.id);

  // Removing a hand-written note keeps the rest, and the file stays readable.
  const left = await removeMemory(root, all[2]!.id);
  assert.deepEqual(left.map((n) => n.text), ["userId must be a number", "The API runs on port 3001", "Prices are in cents"]);
  assert.deepEqual(await loadMemory(root), left);

  // Concurrent adds don't lose each other.
  await Promise.all(["one", "two", "three"].map((text) => addMemory(root, { text, by: "agent" })));
  assert.equal((await loadMemory(root)).length, 6);
  await assert.rejects(addMemory(root, { text: "   ", by: "user" }), /empty/);
});

test("adding and removing notes keeps a person's headings, prose and own bullets", async () => {
  const root = mkdtempSync(join(tmpdir(), "shrike-mem-"));
  const mine = "# Team notes\n\nWritten by the team, read by the agent.\n\n## Server\n\n* Prices are in cents\n- The API runs on 3001\n\nAsk before deleting anything below.\n";
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(root, ".shrike"));
  writeFileSync(memoryPath(root), mine);
  const added = await addMemory(root, { text: "insertTodo needs a userId", file: "server/db.ts", line: 33, by: "agent" });
  const md = readFileSync(memoryPath(root), "utf8");
  assert.ok(md.startsWith(mine), md);
  assert.match(md, /\n- insertTodo needs a userId \(server\/db\.ts:33\) <!-- id:\w+ by:agent at:\d+ -->\n$/);
  await removeMemory(root, added.note.id);
  assert.equal(readFileSync(memoryPath(root), "utf8"), mine);
});

test("comment markers in a note can't break the line format", () => {
  const n = { id: "x1", text: "a <!-- id:evil by:agent at:1 --> b", createdAt: 5, by: "user" as const };
  assert.deepEqual(parseMemory(formatMemory([n])), [{ ...n, text: "a  id:evil by:agent at:1  b" }]);
});
