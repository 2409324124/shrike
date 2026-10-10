import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Patch } from "@shrike/schema";
import { fileTree, resolveInside } from "./files.ts";
import { applyEdits, checkPatchPath, proposePatch, revertPatch, type PatchDeps } from "./patches.ts";

function project() {
  const root = mkdtempSync(join(tmpdir(), "shrike-patch-"));
  mkdirSync(join(root, "server"));
  mkdirSync(join(root, "node_modules/x"), { recursive: true });
  writeFileSync(join(root, "server/a.ts"), "const a = req.body.user;\nconst b = 1;\n");
  writeFileSync(join(root, "node_modules/x/i.js"), "");
  writeFileSync(join(root, ".env"), "SECRET=1");
  return root;
}

test("applyEdits requires exactly one match", () => {
  assert.equal(applyEdits("f", "a b c", [{ oldText: "b", newText: "B" }]), "a B c");
  assert.throws(() => applyEdits("f", "a b b", [{ oldText: "b", newText: "B" }]), /more than once/);
  assert.throws(() => applyEdits("f", "a", [{ oldText: "z", newText: "B" }]), /not found/);
  assert.throws(() => applyEdits("f", "a", [{ oldText: "", newText: "B" }]), /empty/);
});

test("checkPatchPath blocks secrets, deps and lockfiles", () => {
  for (const p of [".env", "server/.env.local", "node_modules/x/i.js", ".git/config", "pnpm-lock.yaml", "../x.ts"]) assert.throws(() => checkPatchPath(p), p);
  checkPatchPath("server/a.ts");
});

test("resolveInside rejects traversal, absolute paths and symlink escapes", () => {
  const root = project();
  symlinkSync(tmpdir(), join(root, "escape"));
  assert.throws(() => resolveInside(root, "../etc/passwd"), /outside/);
  assert.throws(() => resolveInside(root, "/etc/passwd"), /Not a project path/);
  assert.throws(() => resolveInside(root, "escape/x"), /outside/);
  assert.ok(resolveInside(root, "server/a.ts").endsWith("server/a.ts"));
  assert.ok(resolveInside(root, "server/new.ts").endsWith("server/new.ts"));
});

test("fileTree skips node_modules and dotfiles", async () => {
  const names = (await fileTree(project())).map((n) => n.name);
  assert.deepEqual(names, ["server"]);
});

test("proposePatch: approve writes, revert restores, reject leaves file alone", async () => {
  const root = project();
  const file = join(root, "server/a.ts");
  const original = readFileSync(file, "utf8");
  const updates: Patch["status"][] = [];
  let answer = true;
  let hellos = 0;
  const deps: PatchDeps = {
    root,
    requestApproval: async (req) => {
      assert.equal(req.kind, "patch");
      assert.equal(req.patch?.files[0]?.after.includes("userId"), true);
      return answer;
    },
    waitForServerHello: async () => (hellos++, true),
    onUpdate: (p) => updates.push(p.status),
  };
  const edits = [{ path: "server/a.ts", edits: [{ oldText: "req.body.user", newText: "req.body.userId" }] }];

  const r = await proposePatch(deps, edits, "use userId");
  assert.equal(r.status, "applied");
  assert.equal(hellos, 1);
  assert.match(readFileSync(file, "utf8"), /req\.body\.userId/);
  await revertPatch(deps, r.patchId);
  assert.equal(readFileSync(file, "utf8"), original);
  assert.deepEqual(updates, ["proposed", "applied", "reverted"]);
  await assert.rejects(revertPatch(deps, r.patchId), /reverted/);

  answer = false;
  assert.equal((await proposePatch(deps, edits, "x")).status, "rejected");
  assert.equal(readFileSync(file, "utf8"), original);

  await assert.rejects(proposePatch(deps, [{ path: ".env", edits: [{ oldText: "1", newText: "2" }] }], "x"), /doesn't change/);
});

test("proposePatch refuses when the file changed while waiting", async () => {
  const root = project();
  const deps: PatchDeps = {
    root,
    requestApproval: async () => (writeFileSync(join(root, "server/a.ts"), "edited by user"), true),
    waitForServerHello: async () => true,
    onUpdate: () => {},
  };
  await assert.rejects(proposePatch(deps, [{ path: "server/a.ts", edits: [{ oldText: "b = 1", newText: "b = 2" }] }], "x"), /changed while waiting/);
  assert.equal(readFileSync(join(root, "server/a.ts"), "utf8"), "edited by user");
});
