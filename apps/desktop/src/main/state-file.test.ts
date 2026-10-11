import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listDrafts, noteUse } from "./skills.ts";
import { readJson, readJsonSync, writeAtomic, writeAtomicSync } from "./state-file.ts";
import { createWorkspaces } from "./workspaces.ts";

const broken = (dir: string, name: string) => readdirSync(dir).filter((f) => f.startsWith(`${name}.broken-`));

test("a damaged state file is kept aside once per damage, never overwritten; missing and empty files read as undefined", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "shrike-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.mock.method(console, "warn", () => {});
  const f = join(dir, "s.json");
  assert.equal(readJsonSync(f), undefined);
  writeFileSync(f, "");
  assert.equal(await readJson(f), undefined);
  assert.deepEqual(broken(dir, "s.json"), []);

  writeFileSync(f, '{"projects":["/a"');
  assert.equal(readJsonSync(f), undefined);
  assert.equal(await readJson(f), undefined); // the same damage again: still one copy
  assert.equal(broken(dir, "s.json").length, 1);
  assert.equal(readFileSync(join(dir, broken(dir, "s.json")[0]!), "utf8"), '{"projects":["/a"');
  writeFileSync(f, "{nope");
  readJsonSync(f);
  assert.equal(broken(dir, "s.json").length, 2); // new damage, new copy, the old one kept

  writeAtomicSync(f, '{"ok":1}');
  assert.deepEqual(await readJson(f), { ok: 1 });
  await writeAtomic(join(dir, "deep", "x.json"), "[]");
  assert.deepEqual(readJsonSync(join(dir, "deep", "x.json")), []);
});

test("a save into a read-only folder fails in plain words and leaves no temp file", { skip: process.getuid?.() === 0 || process.platform === "win32" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "shrike-state-"));
  const ro = join(dir, "ro");
  mkdirSync(ro);
  writeFileSync(join(ro, "config.json"), "{}");
  chmodSync(ro, 0o500);
  t.after(() => (chmodSync(ro, 0o700), rmSync(dir, { recursive: true, force: true })));
  await assert.rejects(writeAtomic(join(ro, "config.json"), "{}"), { message: "Shrike couldn't save config.json: Shrike isn't allowed to write to that folder." });
  assert.throws(() => writeAtomicSync(join(ro, "config.json"), "{}"), /^Error: Shrike couldn't save config\.json: /);
  assert.deepEqual(readdirSync(ro), ["config.json"]);
});

test("workspaces and skills keep a damaged file's data before saving over it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "shrike-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.mock.method(console, "warn", () => {});
  const proj = join(dir, "p");
  mkdirSync(proj);
  const file = join(dir, "workspaces.json");
  const damaged = '{"projects":["/a","/b","/c"],"labels":{"x":"y"}';
  writeFileSync(file, damaged);
  const ws = createWorkspaces({ file, current: () => null, status: () => undefined, portsOf: async () => [], requestApproval: async () => false, stopBackground: async () => {}, emit: () => {}, gh: async () => ({ code: 1, stdout: "", stderr: "" }) });
  await ws.remember(proj);
  assert.equal(readFileSync(join(dir, broken(dir, "workspaces.json")[0]!), "utf8"), damaged);
  assert.equal((JSON.parse(readFileSync(file, "utf8")) as { projects: string[] }).projects.length, 1);

  const state = join(dir, "state");
  mkdirSync(state);
  const d = { builtin: dir, personal: dir, claude: dir, state };
  writeFileSync(join(state, "skills.json"), '{"uses":{"a":40}');
  writeFileSync(join(state, "skill-drafts.json"), '[{"id":"x"');
  await noteUse(d, "b");
  assert.deepEqual(await listDrafts(d), []);
  assert.equal(broken(state, "skills.json").length, 1);
  assert.equal(broken(state, "skill-drafts.json").length, 1);
});
