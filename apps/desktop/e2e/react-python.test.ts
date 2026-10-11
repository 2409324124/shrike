// React (Vite) + Python in the BUILT app, on copies of fixtures/react-fastapi and fixtures/react-django, with no .shrike config:
// setup finds both processes, the start runs what it found, a button click and a form submit each make one trip from the
// React handler through the API's request, its Python steps with values and its SQLite query, to a snap at the Python line.
// Each fixture runs twice: through Vite's /api proxy (same origin, traceparent) and cross-origin with VITE_API_URL (CORS).
// Run `pnpm build` first (or SHRIKE_E2E_APP=<a build kept apart from out/>). Skips without the fixture's venv or node_modules.
// Ports 4510/4511 (FastAPI) and 4520/4521 (Django).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { RunStatus } from "@shrike/schema";
import { actions, caption, dismissResult, fixtureCopy, flatten, key, launch, listening, mcpClient, shot, sleep, tripDom, waitFor } from "./helpers.ts";

const FIXTURES = join(import.meta.dirname, "../../../fixtures");
const status = (win: Page) => win.evaluate(() => window.shrike.getRunStatus()) as Promise<RunStatus>;
type Trip = NonNullable<Awaited<ReturnType<typeof tripDom>>>;
const dump = (t: Trip) => t.stations.map((s) => `${s.lane} | ${s.label} | ${s.where} | ${s.chip} | ${s.cls}`).join("\n");
const laneHeads = (win: Page) => win.evaluate(() => [...document.querySelectorAll<HTMLElement>(".th-lanehead > *")].map((el) => `${el.textContent ?? ""} (${el.title})`));

interface Case {
  fixture: "react-fastapi" | "react-django";
  web: number;
  api: number;
  webDir: string; // where the page's package.json and .env.local live
  apiDir: string;
  processes: string[]; // name | command | folder | address, as setup shows them
  // the button click, then the form submit
  click(guest: Page): Promise<string>;
  submit(guest: Page): Promise<string>;
  clickTrip: { request: string; step: RegExp; query: RegExp; where: RegExp };
  brokeTrip: { request: string; steps: RegExp[]; value: RegExp; query: RegExp; error: RegExp; where: RegExp; file: string; line: RegExp; caption: RegExp };
  readFile: string;
  helper: string; // the Python function that computes the wrong value
}

// Type like a person: fill() doesn't reach a <webview> guest reliably.
async function type(guest: Page, placeholder: string, text: string): Promise<void> {
  const input = guest.getByPlaceholder(placeholder);
  await input.click();
  await guest.keyboard.type(text);
  await waitFor(`${placeholder} to read "${text}"`, async () => (await input.inputValue()) === text, 5000);
}

const CASES: Case[] = [
  {
    fixture: "react-fastapi",
    web: 4510,
    api: 4511,
    webDir: "web",
    apiDir: "api",
    processes: ["web | npm run dev | web | http://localhost:4510", "api | .venv/bin/uvicorn main:app --reload --port 4511 | api | http://localhost:4511"],
    async click(guest) {
      await guest.getByRole("button", { name: "Add Coffee beans" }).click();
      await guest.getByText("1 items, $18.00").waitFor({ timeout: 15_000 });
      return 'Clicked "Add Coffee beans"';
    },
    async submit(guest) {
      await type(guest, "Email", "ada@example.com");
      await type(guest, "Promo code", "SAVE10");
      await guest.keyboard.press("Enter");
      await guest.getByText(/Checkout failed/).waitFor({ timeout: 15_000 });
      return 'Submitted "Place order"';
    },
    clickTrip: { request: "POST /api/cart", step: /^add_item\(\)$/, query: /^INSERT INTO cart_items/, where: /App\.tsx:4\d/ },
    brokeTrip: {
      request: "POST /api/checkout",
      steps: [/^checkout\(\)$/, /^place_order\(\)$/, /^discount_cents\(\)$/],
      value: /^subtotal_cents=1800, promo=.SAVE10. => 18000$/,
      query: /^INSERT INTO orders/,
      error: /CHECK constraint failed/,
      where: /orders\.py:35/,
      file: "api/main.py", // the dive opens where the failing function was called
      line: /^54\s+return orders\.place_order\(body\.email, body\.promo\)/,
      caption: /^place_order\(\) stopped because the database refused\.$/,
    },
    readFile: "api/orders.py",
    helper: "discount_cents",
  },
  {
    fixture: "react-django",
    web: 4520,
    api: 4521,
    webDir: "",
    apiDir: "backend",
    processes: ["app | npm run dev | . | http://localhost:4520", "api | .venv/bin/python manage.py runserver 4521 | backend | http://localhost:4521"],
    async click(guest) {
      await type(guest, "Username", "ada");
      await guest.getByRole("button", { name: "Check username" }).click();
      await guest.getByText("ada is free").waitFor({ timeout: 15_000 });
      return 'Clicked "Check username"';
    },
    async submit(guest) {
      await type(guest, "Email", "ada@example.com");
      await guest.keyboard.press("Enter");
      await guest.getByText(/Signup failed/).waitFor({ timeout: 15_000 });
      return 'Submitted "Create account"';
    },
    clickTrip: { request: "GET /api/username", step: /^username_available\(\)$/, query: /^SELECT .*accounts_account/, where: /App\.tsx:\d+/ },
    brokeTrip: {
      request: "POST /api/signup",
      steps: [/^signup\(\)$/, /^create_account\(\)$/, /^starting_credits\(\)$/],
      value: /^plan=.Pro. => None$/,
      query: /^INSERT INTO "accounts_account"/,
      error: /NOT NULL constraint failed: accounts_account\.credits/,
      where: /services\.py:12/,
      file: "backend/accounts/views.py",
      line: /^31\s+account = services\.create_account\(body\["username"\], body\["email"\], body\["plan"\]\)/,
      caption: /^create_account\(\) stopped because the database refused\.$/,
    },
    readFile: "backend/accounts/services.py",
    helper: "starting_credits",
  },
];

for (const c of CASES)
  for (const mode of ["proxy", "cors"] as const) {
    const src = join(FIXTURES, c.fixture);
    const missing = !existsSync(join(src, c.apiDir, ".venv/bin/python")) ? `no ${c.fixture}/${c.apiDir}/.venv (see its README)` : !existsSync(join(src, c.webDir, "node_modules/vite")) ? `no ${c.fixture} node_modules` : false;
    test(`${c.fixture} (${mode === "proxy" ? "Vite proxy" : "cross-origin, CORS"}): setup finds web and api, a click and a submit join React to Python to SQLite`, { timeout: 300_000, skip: missing }, async () => {
      assert.equal(listening([c.web, c.api]), "", `ports ${c.web} and ${c.api} must be free`);
      const proj = fixtureCopy(c.fixture);
      if (mode === "cors") writeFileSync(join(proj, c.webDir, ".env.local"), `VITE_API_URL=http://localhost:${c.api}\n`);
      if (c.fixture === "react-django") execFileSync(".venv/bin/python", ["manage.py", "migrate", "-v", "0"], { cwd: join(proj, c.apiDir) });
      const prefix = `rp-${c.fixture.slice(6)}-${mode}`;
      const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj, SHRIKE_HEADLESS: "1", FAKE_START_HINTS: "1" });
      try {
        await win.emulateMedia({ reducedMotion: "no-preference" });
        await win.getByRole("button", { name: "Open a folder" }).click();

        // Setup: both processes, each in its folder on the port the page calls, and SQLite expected.
        const setup = win.getByRole("dialog", { name: `Set up ${c.fixture}` });
        await setup.waitFor();
        const col = (label: RegExp) => setup.getByRole("textbox", { name: label }).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
        const [names, cmds, dirs, urls] = await Promise.all([col(/^Name of process/), col(/^Command for/), col(/^Folder for/), col(/^Address of/)]);
        assert.deepEqual(names.map((n, i) => `${n} | ${cmds[i]} | ${dirs[i] || "."} | ${urls[i]}`), c.processes);
        const expected = (await setup.getByRole("list", { name: "Expected places" }).innerText()).toUpperCase();
        for (const want of ["WEB", "API", "SQLITE"]) assert.match(expected, new RegExp(want), `expected places: ${expected}`);
        await sleep(400);
        await shot(app, "01-setup", prefix);

        await setup.getByRole("button", { name: "Run all" }).click();
        const st = await waitFor("web and api running", async () => {
          const s = await status(win);
          return s.state === "error" ? s : s.state === "running" && s.processes?.length === 2 && s.processes.every((p) => p.state === "running") ? s : undefined;
        }, 120_000);
        assert.equal(st.state, "running", st.error);
        const guest = await waitFor("the React page in the app pane", () => app.windows().find((p) => p.url().startsWith(`http://localhost:${c.web}`)), 60_000);
        await guest.locator("h1").waitFor({ timeout: 30_000 });
        await dismissResult(win, 5000);
        await sleep(1500);

        // The button click: React handler -> fetch -> the API's request -> its Python step -> its query.
        const clickLabel = await c.click(guest);
        const clicked = await waitFor(`the ${clickLabel} trip`, async () => (await actions(win)).find((a) => a.label === clickLabel && a.complete), 20_000);
        await win.locator(`.th-trip[data-trip="${clicked.id}"]`).waitFor();
        await sleep(1500);
        const ct = (await tripDom(win, clicked.id))!;
        console.log(`--- ${clickLabel} (${mode})\n${dump(ct)}`);
        const at = (t: Trip, pred: (s: Trip["stations"][number]) => boolean, what: string, from = 0) => {
          const i = t.stations.findIndex((s, k) => k >= from && pred(s));
          assert.ok(i >= 0, `${what} after station ${from}\n${dump(t)}`);
          return i;
        };
        let i = at(ct, (s) => s.kind === "client" && /^on(Click|Check)|^onAdd|onClick/.test(s.label), "the React handler");
        assert.match(ct.stations[i]!.where, c.clickTrip.where, "the click's React file:line");
        assert.equal(clicked.root.source?.file, join(c.webDir, "src/App.tsx"), "the component file from the project root (the page is served from its folder)");
        i = at(ct, (s) => s.kind === "client" && s.label.replace(`http://localhost:${c.api}`, "").startsWith(`fetch ${c.clickTrip.request}`), "the page's fetch", i + 1);
        i = at(ct, (s) => s.lane === "service:api" && s.label.startsWith(c.clickTrip.request), "the API's request", i + 1);
        i = at(ct, (s) => s.lane === "service:api" && c.clickTrip.step.test(s.label), "the Python step", i + 1);
        at(ct, (s) => s.lane.startsWith("data:sqlite") && c.clickTrip.query.test(s.label), "the SQLite query", i + 1);
        assert.ok(!ct.stations.some((s) => /OPTIONS/.test(s.label)), "no CORS preflight station");
        assert.equal(clicked.status, "ok");
        await shot(app, "02-click", prefix);

        // The form submit breaks deep in Python: the wrong value in a helper, then the SQLite write refuses it.
        const submitLabel = await c.submit(guest);
        const broke = await waitFor(`the ${submitLabel} trip`, async () => (await actions(win)).find((a) => a.label === submitLabel && a.complete), 20_000).catch(async (e) => { throw new Error(`${(e as Error).message}; trips: ${(await actions(win)).map((a) => `${a.label} (${a.status}${a.complete ? "" : ", open"})`).join(" | ")}`); });
        assert.equal(broke.status, "error");
        const trip = win.locator(`.th-trip[data-trip="${broke.id}"]`);
        await trip.waitFor();
        await trip.locator(".th-dive").waitFor({ timeout: 20_000 });
        await sleep(1200);
        const bt = (await tripDom(win, broke.id))!;
        console.log(`--- ${submitLabel} (${mode})\n${dump(bt)}\nverdict ${bt.verdict} | returned ${bt.returned}\ncaption ${await caption(win)}\nlanes ${(await laneHeads(win)).join(" ; ")}`);
        const b = c.brokeTrip;
        i = at(bt, (s) => s.kind === "client" && /^on/.test(s.label), "the React submit handler");
        assert.match(bt.stations[i]!.where, /App\.tsx:\d+/, "the submit's React file:line");
        i = at(bt, (s) => s.kind === "client" && s.label.replace(`http://localhost:${c.api}`, "").startsWith(`fetch ${b.request}`), "the page's fetch", i + 1);
        i = at(bt, (s) => s.lane === "service:api" && s.label.startsWith(b.request), "the API's request", i + 1);
        for (const step of b.steps) i = at(bt, (s) => s.lane === "service:api" && step.test(s.label), `${step}`, i + 1);
        const helper = flatten(broke.tree).find((e) => e.kind === "function" && e.name === `${c.helper}()`);
        assert.match(`${helper?.args?.join(", ")} => ${helper?.returned}`, b.value, "the helper computed the wrong value");
        const snap = at(bt, (s) => s.lane.startsWith("data:sqlite") && b.query.test(s.label), "the failing write", i + 1);
        assert.match(bt.stations[snap]!.cls, /\berror\b/);
        assert.match(bt.stations[snap]!.chip, b.error);
        assert.match(bt.stations[snap]!.where, b.where);
        assert.match(bt.verdict, /BROKE/);
        assert.equal(bt.returned, "Server error (500)", "the page called the server, which answered 500");
        assert.ok(!bt.stations.some((s) => /OPTIONS/.test(s.label)), "no CORS preflight station");
        const dive = trip.locator(".th-dive");
        assert.match(await dive.locator(".head .f").innerText(), new RegExp(b.file.replace(/[./]/g, "\\$&"), "i"));
        assert.match(await dive.locator(".th-ln.live").innerText(), b.line);
        assert.match(await caption(win), b.caption);
        assert.ok(flatten(broke.tree).some((e) => e.kind === "function" && e.source?.file.startsWith(`${c.apiDir}/`) && e.source.file.endsWith(".py")), "steps carry project-relative Python files");
        await shot(app, "03-broke-dive", prefix);

        // Files view opens on the Python file at the failing step.
        await key(win, "Escape");
        await win.getByRole("group", { name: "View" }).getByRole("button", { name: "FILES" }).click();
        await win.locator(".fm").waitFor();
        await waitFor("the Python file's card", async () => (await win.locator(".fm-card.focus").getAttribute("data-key")) === b.file, 15_000);
        await sleep(1200);
        await shot(app, "04-files", prefix);
        await win.getByRole("group", { name: "View" }).getByRole("button", { name: "THREAD" }).click();

        // What "Find the cause" reads: the trip, then the Python file and a search over Python code, through Shrike's MCP tools.
        const mcp = await mcpClient(app);
        try {
          const got = await mcp.call("get_action", { actionId: broke.id });
          assert.match(got, b.where, "the trip names the Python line");
          assert.match(await mcp.call("read_file", { path: c.readFile }), new RegExp(`def ${c.helper}\\(`));
          const hits = await mcp.call("search_code", { query: `def ${c.helper}` });
          assert.match(hits, /\.py:\d+/, `search finds Python: ${hits}`);
        } finally {
          await mcp.close();
        }

        await win.getByRole("banner").getByRole("button", { name: "Stop", exact: true }).click();
        await waitFor("ports to close", () => listening([c.web, c.api]) === "", 20_000);
      } catch (err) {
        await shot(app, "failure", prefix).catch(() => {});
        throw err;
      } finally {
        await cleanup();
      }
      await waitFor("ports to close", () => listening([c.web, c.api]) === "", 20_000);
    });
  }
