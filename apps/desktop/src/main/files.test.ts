import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FileNode } from "@shrike/schema";
import { listing, mapTree, sliceTree } from "./files.ts";

const find = (nodes: FileNode[], path: string): FileNode | undefined => {
  for (const n of nodes) {
    if (n.path === path) return n;
    const hit = n.children && find(n.children, path);
    if (hit) return hit;
  }
};

test("mapTree reads git's list: dotfiles in, .gitignore respected, ignored folders one dimmed row, .git never", async () => {
  const root = mkdtempSync(join(tmpdir(), "shrike-map-"));
  for (const d of ["server", "src", "node_modules/x", "dist"]) mkdirSync(join(root, d), { recursive: true });
  for (const [f, t] of Object.entries({ ".gitignore": "node_modules\ndist\n*.log\n", ".env.example": "A=1", "server/db.ts": "", "server/todos.controller.ts": "", "src/api.ts": "", "src/App.tsx": "", "node_modules/x/i.js": "", "dist/a.js": "", "debug.log": "" })) writeFileSync(join(root, f), t);
  execFileSync("git", ["init", "-q"], { cwd: root });
  const { files, ignored } = await listing(root);
  assert.ok(files.includes(".env.example") && files.includes(".gitignore"), "dotfiles are listed");
  assert.ok(!files.includes("debug.log") && !files.some((f) => f.startsWith(".git/")), "ignored files and .git are not");
  assert.deepEqual(ignored.sort(), ["dist", "node_modules"]);
  const t = await mapTree(root, ["server/todos.controller.ts"]);
  assert.equal(find(t.nodes, "node_modules")?.ignored, true);
  assert.equal(find(t.nodes, "node_modules")?.children, undefined, "an ignored folder stays collapsed");
  assert.ok(find(t.nodes, "server")?.children, "the route folder opens");
  assert.equal(find(t.nodes, "src")?.children, undefined, "a sibling folder stays collapsed");
  assert.equal(find(t.nodes, "src")?.count, 2);
});

test("sliceTree: no cap, wide folders fold round each touched file, touched paths always survive, editor sort", () => {
  const big = Array.from({ length: 50_000 }, (_, i) => `pkg/m${i}.ts`);
  const files = [...big, "src/b10.ts", "src/b9.ts", "src/A.ts", "README.md"];
  const t0 = performance.now();
  const t = sliceTree(files, [], ["pkg/m25000.ts", "gone/deleted.ts"]);
  assert.ok(performance.now() - t0 < 1500, "a 50k listing slices fast");
  assert.equal(t.total, files.length);
  const pkg = find(t.nodes, "pkg")!;
  assert.equal(pkg.count, 50_000);
  assert.ok(find(t.nodes, "pkg/m25000.ts"), "the touched file is a row");
  assert.ok(find(t.nodes, "gone/deleted.ts"), "a stop is never hidden, even with no git row");
  const folds = pkg.children!.filter((n) => n.fold);
  assert.equal(folds.length, 2);
  assert.equal(folds.reduce((a, n) => a + n.fold!, 0) + pkg.children!.filter((n) => !n.fold).length, 50_000);
  assert.ok(pkg.children!.length < 12, "only the rows round the touched file are sent");
  assert.deepEqual(t.nodes.map((n) => n.name), ["gone", "pkg", "src", "README.md"], "folders first");
  assert.equal(find(t.nodes, "src")?.children, undefined);
  const s = sliceTree(files, [], ["src/A.ts"]);
  assert.deepEqual(find(s.nodes, "src")!.children!.map((n) => n.name), ["A.ts", "b9.ts", "b10.ts"], "numeric, case-insensitive like the editor");
});
