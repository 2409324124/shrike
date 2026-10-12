// AP20 to AP23 in the BUILT app: the Routes page. fixtures/py-api-only (FastAPI serves /openapi.json): filled exactly from
// the spec, Try it, the body check, Save as test. fixtures/api-only (no spec): Fill in examples through the fake brain,
// reviewed and accepted per route, never sent. Uses ports 4821 and 4822. The py case skips without fixtures/py-api-only/.venv.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import type { RunStatus } from "@shrike/schema";
import { actions, dismissResult, launch, listening, questReady, shot, sleep, waitFor } from "./helpers.ts";

const FIX = join(import.meta.dirname, "../../../fixtures");
const status = (win: Page) => win.evaluate(() => window.shrike.getRunStatus()) as Promise<RunStatus>;
const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)])) : []);

async function openRoutes(win: Page) {
  await win.getByRole("button", { name: /Open the API explorer/ }).click();
  const sheet = win.getByRole("region", { name: "API client" });
  await sheet.getByRole("button", { name: "Routes", exact: true }).click();
  await sheet.getByRole("listbox", { name: "Routes by group" }).waitFor();
  return sheet;
}

const py = join(FIX, "py-api-only");
const pyReady = existsSync(join(py, ".venv/bin/python")) && spawnSync(join(py, ".venv/bin/python"), ["-c", "import sys; assert sys.version_info >= (3, 12)"]).status === 0;

test("py-api-only: the Routes page fills from FastAPI's /openapi.json; Try it, the body check and Save as test", { skip: !pyReady && "needs fixtures/py-api-only/.venv (see its README)", timeout: 300_000 }, async () => {
  const PORT = 4821;
  assert.equal(listening([PORT]), "", `${PORT} must be free`);
  const config = join(py, ".shrike/config.json");
  const original = readFileSync(config, "utf8");
  writeFileSync(config, JSON.stringify({ processes: [{ name: "api", command: `.venv/bin/uvicorn main:app --port ${PORT}`, url: `http://localhost:${PORT}/health` }] }));
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: py });
  try {
    await win.getByRole("button", { name: "Open a folder" }).click();
    await win.getByRole("dialog", { name: "Set up py-api-only" }).getByRole("button", { name: "Run", exact: true }).click();
    await questReady(win);
    await dismissResult(win, 3000);
    const sheet = await openRoutes(win);

    await sheet.getByText(`localhost:${PORT}/openapi.json`).waitFor({ timeout: 30_000 });
    const keys = await sheet.locator(".ap-rrow").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-key")));
    console.log(`routes: ${JSON.stringify(keys)}`);
    assert.deepEqual([...keys].sort(), ["GET /health", "GET /orders/:order_id", "GET /products", "POST /orders"]);
    await sheet.locator('.ap-rrow[data-key="POST /orders"]').click();
    const doc = sheet.getByRole("article", { name: "POST /orders" });
    await doc.getByText("Create Order").waitFor();
    for (const chip of ["OpenAPI", "In your code"]) await doc.locator(".ap-src", { hasText: chip }).waitFor();
    const body = doc.getByRole("region", { name: "Request body" });
    for (const field of ["customer", "lines", "sku", "qty", "coupon"]) await body.locator(".ap-schema-name", { hasText: new RegExp(`^${field}$`) }).first().waitFor();
    assert.ok((await body.locator(".ap-req-mark").count()) >= 3, "required fields are marked");
    assert.match(await body.getByLabel("Example body").innerText(), /"customer": "customer"/);
    assert.doesNotMatch(await body.getByLabel("Example body").innerText(), /"string"/, "placeholders from field names, not type names");
    const responses = await doc.getByRole("region", { name: "Responses" }).locator(".ap-pill").allInnerTexts();
    assert.deepEqual(responses, ["200", "422"]);
    assert.match(await doc.locator(".ap-link").innerText(), /^main\.py:\d+$/, "the handler's file:line");
    await sleep(400);
    await shot(app, "01-spec-route", "routes");

    // Keyboard: ↓ moves the selection, / searches.
    await sheet.locator('.ap-rrow[data-key="POST /orders"]').focus();
    await win.keyboard.press("ArrowUp");
    await waitFor("the selection to move", async () => (await sheet.locator('.ap-rrow[aria-selected="true"]').getAttribute("data-key")) !== "POST /orders");
    await win.keyboard.press("/");
    await win.keyboard.type("order_id");
    await waitFor("the search to filter", async () => (await sheet.locator(".ap-rrow").count()) === 1);
    await sheet.getByRole("article", { name: "GET /orders/:order_id" }).getByText("order_id", { exact: true }).waitFor();
    await shot(app, "02-search-keyboard", "routes");
    await sheet.getByRole("textbox", { name: "Search routes" }).press("Escape");

    // Try it opens the editor filled from the spec; nothing is sent.
    const before = (await actions(win)).length;
    await sheet.locator('.ap-rrow[data-key="POST /orders"]').click();
    await doc.getByRole("button", { name: "Try it" }).click();
    const editor = sheet.getByRole("textbox", { name: "Body" });
    await editor.waitFor();
    assert.equal(await sheet.getByRole("textbox", { name: "URL", exact: true }).inputValue(), "/orders");
    assert.match(await editor.inputValue(), /"customer"/);
    await sleep(1500);
    assert.equal((await actions(win)).length, before, "Try it never sends");

    // The body check warns in plain words and doesn't block Send.
    await editor.fill(JSON.stringify({ customer: "ana@corner.cafe", lines: [{ sku: "BEANS", qty: "3" }], coupn: "WELCOME10" }));
    const warn = sheet.getByRole("list", { name: "Doesn't match the API's schema" });
    await warn.getByText("lines[0].qty should be a whole number, not text.").waitFor();
    await warn.getByText("coupn isn't a field the API knows. Did you mean coupon?").waitFor();
    await shot(app, "03-body-check", "routes");
    await sheet.getByRole("button", { name: "Send", exact: true }).click();
    await waitFor("the explorer trip", async () => (await actions(win)).slice(before).find((a) => a.label === "Sent POST /orders" && a.complete), 20_000);
    await sheet.locator(".ap-pill", { hasText: "200" }).first().waitFor();
    await shot(app, "04-sent-anyway", "routes");

    // Save as test: the request and res.status eq 200 in the project's collection.
    await sheet.getByRole("button", { name: "Routes", exact: true }).click();
    await sheet.locator('.ap-rrow[data-key="POST /orders"]').click();
    await doc.getByRole("button", { name: "Save as test" }).click();
    await win.getByText(/as a test in/).waitFor();
    const saved = files(join(py, ".shrike/api")).filter((f) => f.endsWith(".bru") && !/(collection|folder)\.bru$/.test(f));
    assert.equal(saved.length, 1, saved.join());
    const bru = readFileSync(saved[0]!, "utf8");
    assert.match(bru, /res\.status: eq 200/);
    assert.match(bru, /"customer"/);
    await shot(app, "05-saved-as-test", "routes");
  } catch (err) {
    await shot(app, "py-failure", "routes").catch(() => {});
    throw err;
  } finally {
    writeFileSync(config, original);
    rmSync(join(py, ".shrike/api"), { recursive: true, force: true });
    await cleanup();
  }
  await waitFor(`${PORT} to close`, () => listening([PORT]) === "", 20_000);
});

test("api-only: no spec, so Fill in examples asks the agent (read-only); each guess is reviewed, accepted ones are saved, nothing is sent", { timeout: 300_000 }, async () => {
  const PORT = 4822;
  const root = join(FIX, "api-only");
  assert.equal(listening([PORT]), "", `${PORT} must be free`);
  const config = join(root, ".shrike/config.json");
  const original = readFileSync(config, "utf8");
  writeFileSync(config, JSON.stringify({ processes: [{ name: "api", command: `API_PORT=${PORT} npm run dev`, url: `http://localhost:${PORT}/health` }] }));
  const brain = mkdtempSync(join(tmpdir(), "shrike-e2e-routes-brain-"));
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: root, FAKE_CLAUDE_DIR: brain, FAKE_CLAUDE_DELAY: "60" });
  try {
    await win.getByRole("button", { name: "Open a folder" }).click();
    await win.getByRole("dialog", { name: "Set up api-only" }).getByRole("button", { name: "Run", exact: true }).click();
    await waitFor("the API running", async () => ((await status(win)).state === "running" ? true : undefined), 60_000);
    await win.getByText("This project has no web page.").waitFor();
    await dismissResult(win, 3000);
    const sheet = await openRoutes(win);

    await sheet.getByText("No OpenAPI spec found, so routes come from your code.").waitFor();
    const keys = await sheet.locator(".ap-rrow").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-key")));
    assert.deepEqual([...keys].sort(), ["GET /health", "GET /v1/users", "POST /v1/users"]);
    await sheet.locator('.ap-rrow[data-key="POST /v1/users"]').click();
    const doc = sheet.getByRole("article", { name: "POST /v1/users" });
    await doc.getByRole("region", { name: "Request body" }).getByText("Not described yet.").waitFor();
    await sleep(3500); // the [Skill Acquired] window from the start goes away on its own
    await shot(app, "06-code-only", "routes");

    const before = (await actions(win)).length;
    await sheet.getByRole("button", { name: "Fill in examples" }).click();
    assert.equal(await sheet.locator(".ap-rrow input[type=checkbox]:checked").count(), 3, "every route without a spec is picked");
    await sleep(300);
    await shot(app, "07-pick-routes", "routes");
    await sheet.getByRole("button", { name: "Guess 3 routes" }).click();
    await sheet.getByRole("status").getByText("Your agent is reading the handlers").waitFor();
    await shot(app, "08-guessing", "routes");
    const review = sheet.getByLabel("Guesses to review");
    await review.waitFor({ timeout: 60_000 });
    assert.equal(await review.getByRole("article").count(), 3);
    const post = review.getByRole("article", { name: "Guess for POST /v1/users" });
    await post.locator(".ap-src", { hasText: "Guessed from code" }).waitFor();
    assert.match(await post.getByLabel("Example body").innerText(), /"email": "sam@example.com"/);
    assert.deepEqual(await post.getByRole("region", { name: "Responses" }).locator(".ap-pill").allInnerTexts(), ["201", "200", "400", "409"]);
    await sleep(300);
    await shot(app, "09-review-guesses", "routes");

    const call = readFileSync(join(brain, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((c) => /^Fill in examples/.test(c.goal));
    assert.ok(call, "the guess ran through the agent");
    for (const t of ["send_request", "save_request", "propose_patch"]) assert.match(call.disallowed ?? "", new RegExp(`mcp__shrike__${t}\\b`), `${t} is denied to the guess run`);

    await review.getByRole("article", { name: "Guess for GET /health" }).getByRole("button", { name: "Skip" }).click();
    await post.getByRole("button", { name: "Accept" }).click();
    await review.getByRole("article", { name: "Guess for GET /v1/users" }).getByRole("button", { name: "Accept" }).click();
    await review.waitFor({ state: "detached" });
    const guessed = JSON.parse(readFileSync(join(root, ".shrike/api/guessed-routes.json"), "utf8")) as { method: string; path: string }[];
    assert.deepEqual(guessed.map((g) => `${g.method} ${g.path}`).sort(), ["GET /v1/users", "POST /v1/users"]);
    const reqs = files(join(root, ".shrike/api")).filter((f) => f.endsWith(".bru") && !/(collection|folder)\.bru$/.test(f));
    assert.equal(reqs.length, 2, reqs.join());
    assert.match(readFileSync(reqs.find((f) => f.includes("POST"))!, "utf8"), /Guessed from code/);

    await sheet.locator('.ap-rrow[data-key="POST /v1/users"]').click();
    for (const chip of ["In your code", "Guessed from code"]) await doc.locator(".ap-src", { hasText: chip }).waitFor();
    await doc.getByRole("region", { name: "Request body" }).locator(".ap-schema-name", { hasText: /^email$/ }).waitFor();
    assert.equal(await sheet.locator('.ap-rrow[data-key="GET /health"] .ap-rguess-dot').count(), 0, "a skipped guess isn't saved");
    await shot(app, "10-accepted", "routes");

    await doc.getByRole("button", { name: "Try it" }).click();
    const editor = sheet.getByRole("textbox", { name: "Body" });
    assert.match(await editor.inputValue(), /"email": "sam@example.com"/);
    await editor.fill(JSON.stringify({ email: "lee@example.com", user: "Lee" }));
    const warn = sheet.getByRole("list", { name: "Doesn't match the API's schema" });
    await warn.getByText("name is missing. The API needs it.").waitFor();
    await warn.getByText("user isn't a field the API knows.").waitFor();
    await shot(app, "11-guess-body-check", "routes");
    assert.equal((await actions(win)).length, before, "guessing, accepting and Try it never sent a request");
  } catch (err) {
    await shot(app, "api-failure", "routes").catch(() => {});
    throw err;
  } finally {
    writeFileSync(config, original);
    rmSync(join(root, ".shrike/api"), { recursive: true, force: true });
    rmSync(brain, { recursive: true, force: true });
    await cleanup();
  }
  await waitFor(`${PORT} to close`, () => listening([PORT]) === "", 20_000);
});
