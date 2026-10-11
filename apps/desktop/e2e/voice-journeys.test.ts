// Voice acceptance journeys (docs/16): fixture WAVs played by the real ShrikeVoice helper (--wav) through pre-roll, Silero,
// Nemotron and the bundled planner into the built app, on a running todo-app copy with a local bare origin and a fake gh.
// Push-to-talk journeys take one WAV per press, in order; hands-free plays the rest back to back. Prints the gate numbers.
// Needs the helper built and the models (SHRIKE_E2E_MODELS, else the dev app's userData/models), linked, never copied.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { Page } from "playwright";
import { PLANNER_MODEL } from "../src/main/voice-planner-model.ts";
import { noiseWav } from "../../../fixtures/voice/eval.ts";
import { actions, addTodoAction, fixtureCopy, freePort, gitIn, launch, listening, openFolder, questReady, shot, sleep, typeTodo, waitFor } from "./helpers.ts";

const voice = join(import.meta.dirname, "../../../fixtures/voice");
const models = process.env.SHRIKE_E2E_MODELS ?? join(homedir(), "Library/Application Support/@shrike/desktop/models");
const helper = join(import.meta.dirname, "../native/voice/build/ShrikeVoice.app/Contents/MacOS/ShrikeVoice");
const skip = process.platform !== "darwin" ? "macOS only" : !existsSync(helper) ? "helper not built" : !existsSync(join(models, "asr/ready")) ? `no speech model in ${models}` : !existsSync(join(models, PLANNER_MODEL.file)) ? "no planner model" : false;
const P = "vj";

function linkModels(userData: string): void {
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      const to = join(userData, "models", relative(models, p));
      if (statSync(p).isDirectory()) (mkdirSync(to, { recursive: true }), walk(p));
      else linkSync(p, to);
    }
  };
  for (const id of ["asr", "vad", "turn"]) (mkdirSync(join(userData, "models", id), { recursive: true }), walk(join(models, id)));
  symlinkSync(join(models, PLANNER_MODEL.file), join(userData, "models", PLANNER_MODEL.file));
}

const dur = (f: string) => Number(/duration: ([\d.]+)/.exec(execFileSync("afinfo", [f], { encoding: "utf8" }))![1]);
const pct = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] ?? NaN;
type Ev = { t: number; type: string; id?: number; text?: string; speech?: boolean };
type W = { __ev: Ev[]; __echoes: string[] };
const events = (win: Page) => win.evaluate(() => (window as unknown as W).__ev);

/** Wait until no echo is on screen, so the next match belongs to the next turn. */
const quiet = (win: Page) => waitFor("the strip to clear", async () => (await win.locator("[data-voice-echo]").count()) === 0, 12_000);

/** Hold ⌥ Space while the helper plays the next WAV, let go after it; ms from key up to an echo matching `echo`. */
async function say(win: Page, wav: string, echo: RegExp | null): Promise<number> {
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await win.keyboard.down("Alt");
  await win.keyboard.down("Space");
  await sleep(dur(wav) * 1000 + 350);
  const up = await win.evaluate(() => performance.now());
  await win.keyboard.up("Space");
  await win.keyboard.up("Alt");
  if (!echo) return 0;
  const at = await win.waitForFunction((re) => ([...document.querySelectorAll("[data-voice-echo]")].some((e) => new RegExp(re, "i").test(e.textContent ?? "")) ? performance.now() : 0), echo.source, { polling: "raf", timeout: 10_000 });
  return (await at.jsonValue()) - up;
}

test("voice journeys with real audio: find the break, PRs, Hindi, a push behind a spoken yes, stop, did you mean, hands-free", { skip, timeout: 900_000 }, async () => {
  const web = await freePort();
  const api = await freePort();
  const ports = [web, api];
  const proj = fixtureCopy("todo-app", { ports: { 5173: web, 3001: api }, git: true });
  const remote = join(dirname(proj), "origin.git");
  gitIn(dirname(proj), "init", "-q", "--bare", "-b", "main", remote);
  gitIn(proj, "remote", "add", "origin", remote);
  gitIn(proj, "push", "-q", "-u", "origin", "main");
  const remoteCommits = () => Number(gitIn(remote, "rev-list", "--count", "main"));
  const ghDir = mkdtempSync(join(tmpdir(), "shrike-e2e-fakegh-"));
  writeFileSync(join(ghDir, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "fake-gh-voice.mjs")}" "$@"\n`, { mode: 0o755 });
  const noise = noiseWav(20);
  const userData = mkdtempSync(join(tmpdir(), "shrike-e2e-data-"));
  linkModels(userData);

  const a = (f: string) => join(voice, "audio", f);
  const j = (f: string) => join(voice, "journeys", f);
  const ptt = [a("en02.wav"), a("en03.wav"), a("hr03.wav"), a("hi01.wav"), a("en06.wav"), a("en07.wav"), j("yes.wav"), j("haan-ji.wav"), j("server-print.wav"), j("todo-file.wav"), a("en07.wav"), j("yes.wav"), j("stop.wav")];
  const simple: [string, RegExp][] = [[a("en01.wav"), /logs/], [a("en17.wav"), /network/], [a("en13.wav"), /API/], [a("hx01.wav"), /logs/], [a("hx11.wav"), /network/], [a("hr01.wav"), /logs/], [a("hi09.wav"), /broke/], [a("hi03.wav"), /Next step/]];
  const hands = [a("en01.wav"), noise, a("hx11.wav"), j("chatter.wav"), a("en13.wav")];
  const wavs = [...ptt, ...simple.map((s) => s[0]), ...hands];
  const { app, win, cleanup } = await launch({ SHRIKE_OPEN_FOLDER: proj, SHRIKE_GH_BIN: join(ghDir, "gh"), SHRIKE_FAKE_GH_DIR: ghDir, SHRIKE_VOICE_ARGS: JSON.stringify(["--wav", wavs.join("|")]) }, userData);
  const gates: string[] = [];
  const gate = (name: string, target: string, measured: string) => (gates.push(`${name.padEnd(48)} ${measured.padEnd(36)} (gate: ${target})`), console.log(`GATE ${name}: ${measured} (gate: ${target})`));
  let step = 0;
  const snap = (name: string) => shot(app, `${String(++step).padStart(2, "0")}-${name}`, P);
  try {
    await win.emulateMedia({ reducedMotion: "reduce" });
    await openFolder(win);
    await win.locator('section[aria-label="Shrike"]').waitFor({ timeout: 60_000 });
    await win.evaluate(() => {
      const w = window as unknown as W & { shrike: { on(c: string, f: (e: Ev) => void): void } };
      w.__ev = [];
      w.__echoes = [];
      w.shrike.on("voice:event", (e) => e.type !== "level" && w.__ev.push({ t: performance.now(), type: e.type, id: e.id, text: e.text, speech: e.speech }));
      new MutationObserver(() => {
        for (const el of document.querySelectorAll("[data-voice-echo]")) {
          const t = (el.textContent ?? "").replace(/^\W+/, "").trim();
          if (t && w.__echoes.at(-1) !== t) w.__echoes.push(t);
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });

    // First press starts the helper and loads the models; "next step" with no trip yet is a harmless miss.
    await win.locator("body").click({ position: { x: 5, y: 600 } });
    await say(win, ptt[0]!, null);
    await sleep(2500);
    assert.equal(await win.getByText("English only until the voice download finishes").count(), 0, "Nemotron, not the Apple fallback");
    await quiet(win);

    // The app runs, Add Todo breaks it (the planted bug): a trip with a snap.
    await win.getByRole("banner").getByRole("button", { name: "Run", exact: true }).click();
    await questReady(win);
    const guest = await waitFor("the todo app", () => app.windows().find((p) => p.url().startsWith(`http://localhost:${web}`)), 90_000);
    await guest.getByText("Fix the signup page on mobile").waitFor({ timeout: 30_000 });
    const closeSetup = win.getByRole("button", { name: "Close setup" });
    if (await closeSetup.isVisible({ timeout: 2000 }).catch(() => false)) await closeSetup.click();
    await typeTodo(guest, "buy milk");
    await guest.getByRole("button", { name: "Add Todo" }).click();
    const broken = await addTodoAction(win);
    await win.locator(`.th-trip[data-trip="${broken.id}"]`).waitFor({ timeout: 15_000 });
    const opened = (await actions(win)).find((x) => x.label === "Opened /" && x.complete);
    if (opened) await win.locator(`.th-trip[data-trip="${opened.id}"]`).click({ position: { x: 20, y: 12 } }).catch(() => {}); // focus away from the break first
    await win.locator("body").click({ position: { x: 5, y: 600 } });
    await sleep(800);
    await quiet(win);
    const simpleMs: number[] = [];

    // 1. English "where did it break": the failing trip and its snap get the focus.
    simpleMs.push(await say(win, ptt[1]!, /broke/));
    await waitFor("the broken trip focused", async () => (await win.locator(".th-trip.focus").getAttribute("data-trip")) === broken.id, 5000);
    const focusCls = await win.locator(".th-trip.focus .th-st.focus").getAttribute("class");
    assert.match(String(focusCls), /\berror\b/, `the focused station is the break: ${focusCls}`);
    await sleep(600);
    await snap("where-did-it-break");
    await quiet(win);

    // 2. Hinglish "PR 42 kholo": the PR panel on #42 (fake gh).
    simpleMs.push(await say(win, ptt[2]!, /PR 42/));
    const prPanel = win.locator("[data-pr-panel]");
    await waitFor("the PR panel on #42", async () => /#42/.test(await prPanel.locator(":scope > header").innerText().catch(() => "")), 15_000);
    assert.match(await prPanel.locator(":scope > header").innerText(), /Dark mode for the todo list/);
    await sleep(400);
    await snap("pr-42-kholo");
    await quiet(win);

    // 3. Hindi "लॉग्स दिखाओ": the logs.
    simpleMs.push(await say(win, ptt[3]!, /logs/));
    await win.getByRole("region", { name: "Logs" }).waitFor({ timeout: 5000 });
    await sleep(400);
    await snap("hindi-logs");
    await quiet(win);

    // 4. "look at all the open pull requests": the list of open PRs.
    simpleMs.push(await say(win, ptt[4]!, /pull requests/));
    const list = win.getByRole("list", { name: "Open pull requests" });
    await list.waitFor({ timeout: 15_000 });
    for (const n of ["#7", "#42", "#57"]) await list.getByText(n, { exact: true }).waitFor();
    await sleep(400);
    await snap("open-prs");
    await quiet(win);

    // 5. "stage all files and push them": a card that waits; nothing leaves without a yes.
    writeFileSync(join(proj, "NOTES.md"), "voice e2e\n");
    const before = remoteCommits();
    await say(win, ptt[5]!, null);
    const card = win.locator("[data-voice-plan]");
    await waitFor("the plan card", async () => (await card.getAttribute("data-state").catch(() => "")) === "needs_yes", 10_000);
    const steps = await card.locator("[data-step-state]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
    assert.ok(steps.length >= 2, steps.join(" / "));
    assert.match(steps.at(-1)!, /Push/);
    await card.getByText("Leaves your Mac").waitFor();
    await sleep(1500);
    assert.equal(remoteCommits(), before, "nothing pushed before yes");
    await snap("card-waits");

    // 6. A spoken "yes": the plan runs; main's own push approval asks before anything leaves.
    await say(win, ptt[6]!, null);
    const allow = win.getByRole("region", { name: "Agent request" }).first();
    await allow.waitFor({ timeout: 15_000 });
    assert.match(await allow.innerText(), /Send 1 commit to GitHub\?/);
    assert.equal(remoteCommits(), before, "still nothing pushed");
    await sleep(300);
    await snap("after-yes-main-asks");

    // 7. "हाँ जी" answers it: one commit reaches the local bare origin.
    await say(win, ptt[7]!, null);
    await waitFor("the push", async () => remoteCommits() === before + 1, 20_000);
    assert.match(gitIn(remote, "log", "-1", "--format=%s", "main"), /^Voice: /);
    await waitFor("the card to finish", async () => (await card.getAttribute("data-state").catch(() => "done")) !== "running", 10_000);
    await sleep(400);
    await snap("pushed-after-haan");
    await win.keyboard.press("Escape");
    await quiet(win);

    // 8. A command only the planner understands: "what did the server print" opens the terminal.
    await win.locator("body").click({ position: { x: 5, y: 600 } });
    const plannerMs = await say(win, ptt[8]!, /terminal/);
    await snap("planner-terminal");
    await quiet(win);

    // 9. "open the todo file" (TodoForm or TodoList): did you mean chips; a chip opens the file.
    await say(win, ptt[9]!, null);
    const chips = win.locator("[data-voice-chips]");
    await chips.getByText("Did you mean").waitFor({ timeout: 10_000 });
    await chips.getByRole("button", { name: /TodoList/ }).waitFor();
    await snap("did-you-mean");
    await chips.getByRole("button", { name: /TodoList/ }).click();
    await win.locator(".fv").waitFor({ timeout: 5000 });
    await waitFor("TodoList.tsx in the file view", async () => /TodoList/i.test(await win.locator(".fv .fv-head .f").innerText().catch(() => "")), 5000);
    await sleep(600);
    await snap("chip-opened-file");
    await win.keyboard.press("Escape");
    await quiet(win);

    // 10. "stop" while a plan runs (git is slow here): the push never happens.
    writeFileSync(join(proj, "MORE.md"), "stop me\n");
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as typeof globalThis & { __stage?: unknown };
      ipcMain.removeHandler("shrike:scmStage");
      ipcMain.handle("shrike:scmStage", async () => {
        g.__stage = true;
        await new Promise((r) => setTimeout(r, 5000)); // a slow repo; the real stage is skipped, nothing is lost
      });
    });
    const before2 = remoteCommits();
    await say(win, ptt[10]!, null);
    await waitFor("the second card", async () => (await card.getAttribute("data-state").catch(() => "")) === "needs_yes", 10_000);
    await say(win, ptt[11]!, null);
    await waitFor("the plan running", async () => (await card.getAttribute("data-state").catch(() => "")) === "running", 5000);
    await snap("plan-running");
    await say(win, ptt[12]!, null);
    await waitFor("the plan stopped", async () => (await card.getAttribute("data-state").catch(() => "")) === "stopped", 8000);
    assert.match(await card.innerText(), /Stopped/i);
    await snap("stopped-card");
    await sleep(5500);
    assert.equal(remoteCommits(), before2, "stop: nothing pushed");
    assert.equal(await win.getByRole("region", { name: "Agent request" }).count(), 0, "stop: no push was even asked");
    await snap("stopped");
    await win.keyboard.press("Escape");
    await quiet(win);

    // 11. Simple commands, release to action, for the latency gate.
    const missed: string[] = [];
    for (const [w, re] of simple) {
      const ms = await say(win, w, /\w/).catch(() => -1);
      const said = await win.locator("[data-voice-echo]").allInnerTexts().catch(() => []);
      if (ms >= 0 && said.some((t) => new RegExp(re.source, "i").test(t))) simpleMs.push(ms);
      else missed.push(`${w.split("/").pop()}: ${said.join(" ").replace(/\s+/g, " ") || "nothing"}`);
      await quiet(win).catch(() => win.keyboard.press("Escape"));
    }
    if (missed.length) console.log("simple commands not understood:", missed.join(" | "));
    gate("Simple commands understood (synthetic clips)", "per-language gates on real recordings", `${simple.length - missed.length} of ${simple.length}`);
    console.log("simple release-to-action samples (ms):", simpleMs.map(Math.round).join(" "));
    gate("Simple command, release to action, p50 / p95", "250 / 400 ms", `${Math.round(pct(simpleMs, 0.5))} / ${Math.round(pct(simpleMs, 0.95))} ms (n=${simpleMs.length})`);
    gate("Planner command, release to action", "700 / 1000 ms", `${Math.round(plannerMs)} ms (n=1)`);

    // 12. Hands-free: three commands with pauses, 20 s of fan noise and a stretch of chatter between; no false actions.
    for (let i = 0; i < 3 && (await win.locator('[role="region"][aria-label="Logs"], [role="region"][aria-label="Network"], [role="region"][aria-label="API client"]').count()); i++) (await win.keyboard.press("Escape"), await sleep(300));
    const echoesBefore = (await win.evaluate(() => (window as unknown as W).__echoes)).length;
    await win.getByRole("button", { name: "Hands-free: keep listening" }).click();
    await win.getByRole("region", { name: "Logs" }).waitFor({ timeout: 30_000 });
    await snap("hands-free-logs");
    await win.getByRole("region", { name: "Network" }).waitFor({ timeout: 60_000 });
    await snap("hands-free-network");
    await win.getByRole("region", { name: "API client" }).waitFor({ timeout: 30_000 });
    await sleep(1500);
    await snap("hands-free-api");
    const echoes = (await win.evaluate(() => (window as unknown as W).__echoes)).slice(echoesBefore);
    const acted = echoes.filter((e) => !/^(Hands-free is (on|off)|Didn't catch that|Didn't hear anything)$/.test(e));
    console.log("hands-free echoes:", echoes.join(" | "));
    assert.deepEqual(acted, ["Showing logs", "Showing network", "Showing the API client"], "only the three commands acted");
    await win.getByRole("button", { name: /Hands-free is on/ }).click().catch(() => {});

    // Gates from the helper's own events: first partial after speech starts; memory of the helper and the planner.
    const ev = await events(win);
    const firsts: number[] = [];
    for (const id of new Set(ev.filter((e) => e.type === "partial").map((e) => e.id))) {
      const onset = ev.find((e) => e.id === id && e.type === "vad" && e.speech);
      const first = ev.find((e) => e.id === id && e.type === "partial");
      if (onset && first) firsts.push(first.t - onset.t);
    }
    gate("First partial words after speech starts, p50 / p95", "300 ms target (decision measured 0.8 to 1 s)", `${Math.round(pct(firsts, 0.5))} / ${Math.round(pct(firsts, 0.95))} ms (n=${firsts.length})`);
    const planner = await app.evaluate(({ app: a }) => a.getAppMetrics().find((m) => m.serviceName === "Shrike voice planner" || m.name === "Shrike voice planner")?.memory.workingSetSize ?? 0);
    const ps = execFileSync("ps", ["-axo", "pid=,rss=,command="], { encoding: "utf8" }).split("\n").find((l) => l.includes("ShrikeVoice.app") && l.includes(userData));
    const helperRss = ps ? Number(ps.trim().split(/\s+/)[1]) : 0;
    gate("Helper resident memory", "1.0 GB", `${Math.round(helperRss / 1024)} MB RSS`);
    gate("Planner resident memory", "2.6 GB", `${Math.round(planner / 1024)} MB working set`);
    gate("Voice in total", "3.6 GB", `${Math.round((helperRss + planner) / 1024)} MB`);
  } catch (e) {
    await shot(app, "fail", P).catch(() => {});
    console.log("echoes:", await win.evaluate(() => (window as unknown as W).__echoes?.join(" | ")).catch(() => ""));
    console.log(await win.evaluate(() => (window as unknown as W).__ev?.map((e) => `${Math.round(e.t)} ${e.type}:${e.id ?? ""}:${e.text ?? ""}`).join("\n")).catch(() => ""));
    throw e;
  } finally {
    console.log(`\nVOICE GATES\n${gates.join("\n")}`);
    await cleanup();
    rmSync(userData, { recursive: true, force: true });
    rmSync(dirname(noise), { recursive: true, force: true });
    rmSync(ghDir, { recursive: true, force: true });
    await waitFor("every port free", () => listening(ports) === "", 60_000).catch(() => {});
  }
});
