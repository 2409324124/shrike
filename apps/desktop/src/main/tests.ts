import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// L4 Prove: run the project's own unit tests and say what happened in plain words.

const NPM_PLACEHOLDER = /no test specified/;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** "pnpm test" when package.json has a real test script, else null. */
export function testCommand(root: string): string | null {
  let script: unknown;
  try {
    script = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }).scripts?.test;
  } catch {
    return null;
  }
  if (typeof script !== "string" || !script.trim() || NPM_PLACEHOLDER.test(script)) return null;
  const pm = existsSync(join(root, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(root, "yarn.lock")) ? "yarn" : existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock")) ? "bun" : "npm";
  return `${pm} test`;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Counts and the first failing test name from node --test, vitest, jest or mocha output. */
export function summarizeTests(output: string, exitCode: number | null, timedOut = false): { ok: boolean; summary: string } {
  const out = output.replace(ANSI, "");
  const num = (re: RegExp) => {
    const m = re.exec(out);
    return m ? Number(m[1]) : undefined;
  };
  // node --test (TAP or spec reporter), then jest ("Tests: 1 failed, 3 passed"), vitest ("Tests  3 passed | 1 failed"), mocha ("3 passing").
  const pass = num(/^# pass (\d+)/m) ?? num(/^ℹ pass (\d+)/m) ?? num(/Tests:.*?(\d+) passed/) ?? num(/Tests\s+.*?(\d+) passed/) ?? num(/(\d+) passing/);
  const fail = num(/^# fail (\d+)/m) ?? num(/^ℹ fail (\d+)/m) ?? num(/Tests:.*?(\d+) failed/) ?? num(/Tests\s+.*?(\d+) failed/) ?? num(/(\d+) failing/);
  const first = (/^not ok \d+ - (.+)$/m.exec(out) ?? /^\s*● (.+?)\s*$/m.exec(out) ?? /^\s*[×✗✖] (.+?)(?:\s+\d+m?s)?\s*$/m.exec(out) ?? /^\s+1\) (.+)$/m.exec(out))?.[1]?.trim();
  if (timedOut) return { ok: false, summary: `The tests didn't finish in time, so Shrike stopped them${pass ? ` after ${plural(pass, "test")} passed` : ""}.` };
  const ok = exitCode === 0 && !fail;
  if (ok) return { ok, summary: pass ? `All ${plural(pass, "test")} passed.` : "The tests passed." };
  if (fail) return { ok, summary: `${plural(fail, "test")} failed${pass ? `, ${pass} passed` : ""}.${first ? ` First one: ${first}.` : ""}` };
  const tail = out.trim().split("\n").filter((l) => l.trim()).at(-1)?.trim();
  return { ok, summary: `The tests failed (exit code ${exitCode ?? "unknown"}).${tail ? ` Last line: ${tail.slice(0, 160)}` : ""}` };
}

/** Runs the test script in a login shell (the user's PATH), killed after `timeoutMs`. Null when there's no test script. */
export function runTests(root: string, timeoutMs = 180_000): Promise<{ ok: boolean; summary: string; output: string } | null> {
  const cmd = testCommand(root);
  if (!cmd) return Promise.resolve(null);
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/zsh";
    const child = spawn(shell, ["-lc", cmd], { cwd: root, env: { ...process.env, CI: "1", FORCE_COLOR: "0" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const add = (c: Buffer) => {
      output += c.toString("utf8");
      if (output.length > 400_000) output = output.slice(-200_000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    let timedOut = false;
    const kill = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, summary: `Couldn't run ${cmd}: ${err.message}`, output });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      kill(); // watchers a test script left behind
      resolve({ ...summarizeTests(output, code, timedOut), output: output.slice(-20_000) });
    });
  });
}
