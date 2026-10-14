import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import type { ActionView, AppElement, Flow, FlowStep, ShrikeEvents } from "@shrike/schema";
import { addStep, failedCheck, findElement, Flows, flowsDir, listFlows, SAVE_DEBOUNCE_MS, type FlowDeps } from "./flows.ts";

type Sent = { channel: keyof ShrikeEvents; payload: unknown };

function fake(root: string, opts: { elements?: AppElement[]; broken?: string[]; url?: string; actions?: ActionView[] } = {}) {
  const sent: Sent[] = [];
  const calls: string[] = [];
  const notes: string[] = [];
  let listener: ((m: unknown) => void) | undefined;
  let saved: ((p: string) => void) | undefined;
  const waiters: ((p: unknown) => void)[] = [];
  let n = 0;
  const view = (id: string) => ({ id, label: id, status: opts.broken?.includes(id) ? "error" : "ok" }) as ActionView;
  const deps: FlowDeps = {
    root: () => root,
    drive: {
      appSnapshot: async () => ({ url: "http://localhost:5173/", title: "", text: "", elements: opts.elements ?? [] }),
      appClick: async (ref) => (calls.push(`click ${ref}`), { actionId: `click-${ref}` }),
      appType: async (ref, text, submit) => (calls.push(`type ${ref} ${text}${submit ? " +submit" : ""}`), { actionId: null }),
      appNavigate: async (url) => (calls.push(`open ${url}`), { actionId: `nav-${++n}` }),
      waitForAction: async (id) => view(id),
      sendRequest: async (req) => (calls.push(`send ${req.method} ${req.url}`), { response: { status: req.url.includes("bad") ? 409 : 200, statusText: "", headers: {}, body: "", durationMs: 1 }, actionId: `req-${++n}` }),
      listActions: () => opts.actions ?? [],
    },
    page: {
      url: () => opts.url,
      record: async (on) => void calls.push(`record ${on}`),
      listen: (cb) => ((listener = cb), () => (listener = undefined)),
    },
    emit: (channel, payload) => {
      sent.push({ channel, payload });
      if (channel === "flow:result") waiters.splice(0).forEach((w) => w(payload));
    },
    notify: (title, body) => void notes.push(`${title}: ${body}`),
    watchFiles: (_root, cb) => ((saved = cb), () => (saved = undefined)),
    secrets: { encrypt: (s) => Buffer.from(s).toString("base64"), decrypt: (s) => Buffer.from(s, "base64").toString() },
  };
  return {
    deps, sent, calls, notes,
    page: (m: unknown) => listener?.(m),
    save: (p: string) => saved?.(p),
    watching: () => !!saved,
    nextResult: () => new Promise<unknown>((r) => waiters.push(r)),
  };
}

const els: AppElement[] = [
  { ref: "e1", role: "textbox", name: "What needs doing?" },
  { ref: "e2", role: "button", name: "Add Todo" },
  { ref: "e3", role: "textbox", name: "Password" },
  { ref: "e4", role: "link", name: "Add Todo" },
];

test("steps: typing in one field collapses, names find their element", () => {
  let s: FlowStep[] = [];
  s = addStep(s, { type: "type", name: "Password", text: "x", secret: true });
  s = addStep(s, { type: "type", name: "Password", text: "x", secret: true, submit: true });
  s = addStep(s, { type: "click", name: "Go" });
  assert.deepEqual(s, [{ type: "type", name: "Password", text: "x", secret: true, submit: true }, { type: "click", name: "Go" }]);
  assert.equal(findElement(els, " add  todo ", ["button"])?.ref, "e2");
  assert.equal(findElement(els, "add todo", ["link"])?.ref, "e4");
  assert.equal(findElement(els, "doing", ["textbox"])?.ref, "e1");
  assert.equal(findElement(els, "nothing", ["button"]), undefined);
});

test("B1 record: page steps and explorer requests in time order, secrets sealed, saved to .shrike/flows", async () => {
  const root = mkdtempSync(join(tmpdir(), "shrike-flows-"));
  const explorer = { id: "x1", trigger: "explorer", startMs: 0, tree: [{ event: { kind: "http_request", http: { method: "POST", url: "/v1/users", reqHeaders: { traceparent: "00-a-b-01", "content-type": "application/json", authorization: "Bearer abcdefgh12345678" }, reqBody: '{"email":"a@b.c"}' } }, children: [] }] } as unknown as ActionView;
  const f = fake(root, { url: "http://localhost:5173/todos?x=1", actions: [explorer] });
  const flows = new Flows(f.deps);
  await flows.startRecording();
  assert.deepEqual(f.calls, ["record true"]);
  f.page({ type: "flow_step", step: { type: "type", name: "What needs doing?", text: "milk" } });
  f.page({ type: "flow_step", step: { type: "click", name: "Add Todo" } });
  await new Promise((r) => setTimeout(r, 10));
  explorer.startMs = Date.now();
  await new Promise((r) => setTimeout(r, 10));
  f.page({ type: "flow_step", step: { type: "type", name: "Password", text: "hunter2", secret: true } });
  f.page({ type: "flow_step", step: { type: "type", name: "Password", text: "hunter2", secret: true, submit: true } });
  f.page({ type: "hello", source: "browser", url: "http://localhost:5173/done" }); // caused by the submit: not a step
  f.page({ type: "flow_step", step: { type: "rm -rf", name: "x" } }); // the page is untrusted
  const live = f.sent.filter((s) => s.channel === "flow:recording").at(-1)!.payload as { steps: FlowStep[] };
  assert.equal(live.steps.find((s) => s.secret)?.text, "••••••", "the renderer never sees a secret");

  const flow = (await flows.stopRecording("Add a todo"))!;
  assert.equal(flow.id, "add-a-todo");
  assert.deepEqual(flow.steps, [
    { type: "navigate", url: "/todos?x=1" },
    { type: "type", name: "What needs doing?", text: "milk" },
    { type: "click", name: "Add Todo" },
    { type: "request", request: { method: "POST", url: "/v1/users", headers: { "content-type": "application/json", authorization: "[redacted:authorization]" }, body: '{"email":"a@b.c"}' } },
    { type: "type", name: "Password", secret: true, submit: true, text: `enc:${Buffer.from("hunter2").toString("base64")}` },
  ]);
  assert.ok(!readFileSync(join(flowsDir(root), "add-a-todo.json"), "utf8").includes("hunter2"));
  assert.deepEqual(f.calls.at(-1), "record false");
  assert.equal(f.sent.filter((s) => s.channel === "flow:recording").at(-1)!.payload, null);
  assert.equal((await flows.list()).length, 1);

  // A second flow with the same name gets its own id; an empty name discards; ids are checked.
  await flows.startRecording();
  f.page({ type: "flow_step", step: { type: "click", name: "Add Todo" } });
  assert.equal((await flows.stopRecording("Add a todo"))!.id, "add-a-todo-2");
  await flows.startRecording();
  f.page({ type: "flow_step", step: { type: "click", name: "Add Todo" } });
  assert.equal(await flows.stopRecording("  "), null);
  await assert.rejects(flows.run("../../etc/passwd"), /Not a flow id/);
  await flows.remove("add-a-todo-2");
  assert.deepEqual((await listFlows(root)).map((x) => x.id), ["add-a-todo"]);
});

test("#54 a page's flow_step outside a recording does nothing, even through a listener it kept", async () => {
  const f = fake(mkdtempSync(join(tmpdir(), "shrike-flows-")));
  let kept: ((m: unknown) => void) | undefined;
  const listen = f.deps.page.listen;
  f.deps.page.listen = (cb) => ((kept = cb), listen(cb));
  const flows = new Flows(f.deps);
  f.page({ type: "flow_step", step: { type: "click", name: "Pay" } });
  await flows.startRecording();
  await flows.stopRecording("  ");
  const before = f.sent.length;
  kept!({ type: "flow_step", step: { type: "click", name: "Pay" } });
  assert.equal(f.sent.length, before);
  assert.equal(flows.recording, false);
});

test("B2 replay: drives by name, unseals secrets, records the result; a red watched flow notifies once", async () => {
  const root = mkdtempSync(join(tmpdir(), "shrike-flows-"));
  const f = fake(root, { elements: els, broken: ["click-e2"] });
  const flows = new Flows(f.deps);
  await flows.save("Add a todo", [
    { type: "navigate", url: "/" },
    { type: "type", name: "What needs doing?", text: "milk" },
    { type: "type", name: "Password", text: "hunter2", secret: true, submit: true },
    { type: "click", name: "Add Todo" },
  ]);
  f.calls.length = 0;
  const r = await flows.run("add-a-todo", true);
  assert.deepEqual(f.calls, ["open /", "type e1 milk", "type e3 hunter2 +submit", "click e2"]);
  assert.deepEqual(r, { ok: false, actionIds: ["nav-1", "click-e2"] });
  const saved = (await flows.list())[0]!;
  assert.equal(saved.lastRun?.ok, false);
  assert.deepEqual(saved.lastRun?.actionIds, ["nav-1", "click-e2"]);
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0]!, /"Add a todo" broke: Clicked|click-e2 broke/);
  await flows.run("add-a-todo", true); // still red: no second notification
  assert.equal(f.notes.length, 1);
  assert.deepEqual(f.sent.filter((s) => s.channel === "flow:result").at(-1)!.payload, { flowId: "add-a-todo", ok: false, actionIds: ["nav-2", "click-e2"], watched: true });

  // API-only: request flows; a 4xx answer is red.
  await flows.save("Users", [{ type: "request", request: { method: "GET", url: "/v1/users" } }]);
  await flows.save("Bad", [{ type: "request", request: { method: "POST", url: "/v1/bad" } }]);
  assert.equal((await flows.run("users")).ok, true);
  assert.equal((await flows.run("bad")).ok, false);
  // AP Save as test: the rows decide (an expected 409 passes), the first save and the first pass each say so once.
  const firsts: string[] = [];
  f.deps.first = (kind, name) => void firsts.push(`${kind} ${name}`);
  await flows.save("Dup is refused", [{ type: "request", request: { method: "POST", url: "/v1/bad", name: "Dup" }, assert: [{ expr: "res.status", op: "eq", value: "409", enabled: true }] }]);
  await flows.save("Dup is fine", [{ type: "request", request: { method: "POST", url: "/v1/bad" }, assert: [{ expr: "res.status", op: "eq", value: "201", enabled: true }, { expr: "res.status", op: "eq", value: "409", enabled: false }] }]);
  assert.equal((await flows.run("dup-is-refused")).ok, true);
  assert.equal((await flows.run("dup-is-fine")).ok, false);
  assert.equal(failedCheck([{ expr: "res.status", op: "eq", value: "201", enabled: true }], { status: 409, statusText: "", headers: {}, body: "", durationMs: 1 }, "Dup"), "Dup: res.status was 409, expected eq 201");
  assert.equal(failedCheck([{ expr: "res.body", op: "matches", value: "(a+)+$", enabled: true }], { status: 200, statusText: "", headers: {}, body: `${"a".repeat(40)}!`, durationMs: 1 }, "Evil"), "Evil: That pattern is too complex to check safely.", "a cloned repo's pattern can't freeze main");
  assert.deepEqual(firsts, ["saved Dup is refused", "saved Dup is fine", "passed Dup is refused"]);

  // A missing element stops the run with plain words instead of hanging.
  const g = fake(root, { elements: [] });
  await new Flows(g.deps).save("Ghost", [{ type: "click", name: "Nope" }]);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let settled = false;
    const p = new Flows(g.deps).run("ghost").finally(() => (settled = true));
    while (!settled) {
      await new Promise((res) => setImmediate(res));
      mock.timers.tick(200);
    }
    assert.equal((await p).ok, false);
  } finally {
    mock.timers.reset();
  }
});

test("B3 keep watching: every N minutes, and once after a burst of saves", async () => {
  const root = mkdtempSync(join(tmpdir(), "shrike-flows-"));
  const f = fake(root, { elements: els });
  const flows = new Flows(f.deps);
  await flows.save("Add", [{ type: "click", name: "Add Todo" }]);
  await flows.list(); // sync: this project is the watched one
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    await flows.setWatch("add", { mode: "interval", minutes: 5 });
    f.calls.length = 0;
    mock.timers.tick(4 * 60_000);
    assert.deepEqual(f.calls, []);
    let done = f.nextResult();
    mock.timers.tick(60_000);
    assert.deepEqual(await done, { flowId: "add", ok: true, actionIds: ["click-e2"], watched: true });

    await flows.setWatch("add", { mode: "save" });
    assert.ok(f.watching());
    f.calls.length = 0;
    mock.timers.tick(10 * 60_000);
    assert.deepEqual(f.calls, [], "no interval once it watches saves");
    done = f.nextResult();
    f.save("src/App.tsx");
    f.save(".shrike/flows/add.json"); // our own writes don't count
    mock.timers.tick(SAVE_DEBOUNCE_MS - 1);
    f.save("src/App.tsx");
    mock.timers.tick(SAVE_DEBOUNCE_MS);
    await done;
    assert.deepEqual(f.calls, ["click e2"], "one run for the burst");

    await flows.setWatch("add", null);
    assert.ok(!f.watching());
    const flow = (await flows.list())[0] as Flow;
    assert.equal(flow.watch, undefined);
  } finally {
    flows.stopWatching();
    mock.timers.reset();
  }
});
