// GitHub runtime failures in the built app (gh installed, GitHub not answering): offline reads as offline, not "sign in",
// and a rate-limited pull request list ends in plain words and Try again, not a loading line that never ends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureCopy, gitIn, key, launch, openFolder, shot, waitFor } from "./helpers.ts";

// Messages are real gh 2.97 output.
const FAKE = `#!/usr/bin/env node
const a = process.argv.slice(2), k = a.slice(0, 2).join(" "), mode = process.env.FAKE_GH_MODE;
if (a[0] === "--version") { console.log("gh version 2.97.0"); process.exit(0); }
if (mode === "offline") {
  process.stderr.write(k === "auth status" ? "github.com\\n  X Failed to log in to github.com account me (keyring)\\n  - The token in keyring is invalid.\\n" : 'Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host\\n');
  process.exit(1);
}
if (k === "auth status") process.exit(0);
process.stderr.write("GraphQL: API rate limit exceeded for user ID 1. (https://api.github.com/graphql)\\n");
process.exit(1);
`;

function project(): string {
  const proj = fixtureCopy("todo-app", { git: true });
  gitIn(proj, "remote", "add", "origin", "https://github.com/shrike-e2e/todo-app.git");
  return proj;
}

test("github: offline and rate limit end in plain words, never a spinner", { timeout: 240_000 }, async () => {
  const bin = join(mkdtempSync(join(tmpdir(), "shrike-e2e-gh-")), "gh");
  writeFileSync(bin, FAKE, { mode: 0o755 });

  const off = await launch({ SHRIKE_OPEN_FOLDER: project(), SHRIKE_GH_BIN: bin, FAKE_GH_MODE: "offline" });
  try {
    await openFolder(off.win);
    await key(off.win, "s");
    const ship = off.win.getByRole("dialog", { name: "Ship" });
    const setup = ship.getByRole("region", { name: "Set up GitHub" });
    await setup.waitFor({ timeout: 30_000 });
    assert.match(await setup.innerText(), /can't reach GitHub right now/);
    assert.doesNotMatch(await setup.innerText(), /gh auth login/);
    await off.win.waitForTimeout(300);
    await shot(off.app, "gh-offline", "rel");
  } finally {
    await off.cleanup();
  }

  const lim = await launch({ SHRIKE_OPEN_FOLDER: project(), SHRIKE_GH_BIN: bin, FAKE_GH_MODE: "ratelimit" });
  try {
    await openFolder(lim.win);
    await key(lim.win, "s");
    const ship = lim.win.getByRole("dialog", { name: "Ship" });
    await ship.getByRole("button", { name: "Review a pull request" }).click({ timeout: 30_000 });
    await ship.getByText(/rate limit is used up/).waitFor({ timeout: 45_000 });
    const review = ship.getByRole("region", { name: "Review a pull request" });
    await review.getByRole("button", { name: "Try again" }).waitFor();
    assert.equal(await review.getByText("Loading pull requests").count(), 0);
    await waitFor("the list to stop asking", async () => (await ship.locator(".animate-spin").count()) === 0, 5000).catch(() => {});
    await lim.win.waitForTimeout(300);
    await shot(lim.app, "gh-rate-limit", "rel");
  } finally {
    await lim.cleanup();
  }
});
