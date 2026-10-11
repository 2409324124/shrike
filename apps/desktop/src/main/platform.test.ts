import assert from "node:assert/strict";
import { spawn, type execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultShell, isWin, killTree, linkDir, loginPathNeeded, mergePath, shellArgs, userPath } from "./platform.ts";

test("shell: $SHELL or /bin/sh on macOS and Linux, cmd.exe on Windows", () => {
  assert.deepEqual(shellArgs("npm run dev", "linux", {}), ["/bin/sh", ["-lc", "npm run dev"]]);
  assert.deepEqual(shellArgs("npm run dev", "darwin", { SHELL: "/bin/zsh" }), ["/bin/zsh", ["-lc", "npm run dev"]]);
  assert.deepEqual(shellArgs('npm run "dev"', "win32", { ComSpec: "C:\\Windows\\system32\\cmd.exe" }), ["C:\\Windows\\system32\\cmd.exe", ["/d", "/s", "/c", '"npm run "dev""']]);
  assert.equal(defaultShell("win32", {}), "cmd.exe");
  assert.equal(loginPathNeeded("win32"), false);
  assert.equal(loginPathNeeded("linux"), true);
});

test("killTree: taskkill /T on Windows, the whole process group elsewhere", { skip: isWin }, async () => {
  const calls: unknown[][] = [];
  killTree(1234, "SIGKILL", "win32", ((...a: unknown[]) => calls.push(a.slice(0, 2))) as unknown as typeof execFile);
  assert.deepEqual(calls, [["taskkill", ["/pid", "1234", "/T", "/F"]]]);

  const child = spawn("/bin/sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 100));
  const closed = new Promise((r) => child.once("close", r));
  killTree(child.pid, "SIGKILL", "linux");
  await closed;
  killTree(child.pid, "SIGKILL", "linux"); // already gone: no throw
  killTree(undefined);
});

test("linkDir: links a folder, copies when linking fails", () => {
  const tmp = mkdtempSync(join(tmpdir(), "shrike-platform-"));
  mkdirSync(join(tmp, "a"));
  writeFileSync(join(tmp, "a", "x.txt"), "x");
  linkDir(join(tmp, "a"), join(tmp, "b"));
  assert.ok(lstatSync(join(tmp, "b")).isSymbolicLink());
  mkdirSync(join(tmp, "c"));
  writeFileSync(join(tmp, "c", "taken"), ""); // a non-empty folder at `to` stops the link, not the copy
  linkDir(join(tmp, "a"), join(tmp, "c"));
  assert.ok(existsSync(join(tmp, "c", "x.txt")));
});

test("user PATH: what ~/.zshrc adds (nvm, fnm, asdf) counts, as when Shrike is opened from Finder", { skip: !existsSync("/bin/zsh") && "needs zsh" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "shrike-home-"));
  writeFileSync(join(home, ".zshrc"), 'echo "welcome"\nexport PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"\n');
  const env = { HOME: home, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" };
  const p = await userPath("darwin", env);
  assert.ok(p?.split(":").includes(join(home, ".nvm/versions/node/v22.12.0/bin")), p);
  assert.equal(await userPath("win32", env), undefined);
  assert.equal(mergePath("/a:/b", "/b:/c", ":"), "/a:/b:/c");
});
