// Runs the Python suite (test_*.py) once per Python 3.12+ on this machine; skips when there is none.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const dir = import.meta.dirname;
const seen = new Map(); // version -> interpreter
for (const exe of ["python3", "python3.12", "python3.13", "python3.14", "python3.15"]) {
  const r = spawnSync(exe, ["-c", "import sys; print('%d.%d' % sys.version_info[:2], sys.version_info >= (3, 12))"], { encoding: "utf8" });
  const [version, ok] = (r.stdout ?? "").trim().split(" ");
  if (r.status === 0 && ok === "True" && !seen.has(version)) seen.set(version, exe);
}

if (!seen.size) test("python-agent suite", { skip: "no Python 3.12+ on this machine" }, () => {});
for (const [version, exe] of seen) {
  test(`python-agent suite on Python ${version}`, () => {
    const r = spawnSync(exe, ["-m", "unittest", "discover", "-s", dir], { encoding: "utf8", timeout: 180_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /\nOK/);
  });
}
