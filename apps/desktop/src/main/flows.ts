import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ActionView, ApiAssertion, AppElement, AppSnapshot, DebugEvent, Flow, FlowStep, HttpRequestSpec, HttpResponseSpec, ShrikeEvents } from "@shrike/schema";
import { redactEvent, redactText } from "@shrike/redact";
import { runAssertions } from "./api/assert.ts";
import { writeAtomic } from "./state-file.ts";

// B1 record, B2 replay, B3 keep watching. Flows live in <project>/.shrike/flows/<id>.json.
// Electron-free: main/ipc.ts wires the page, the app driver, notifications and file watching in.

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STEP_WAIT_MS = 20_000;
const FIND_MS = 5000; // an element may appear a moment after the previous step
// ponytail: a fixed pause after the last save so HMR or the server restart lands first. Upgrade: wait for the server hello.
export const SAVE_DEBOUNCE_MS = 2000;
const SECRET_SHOWN = "••••••";

const pageStep = z.object({
  type: z.enum(["click", "type"]),
  name: z.string().min(1).max(200),
  text: z.string().max(10_000).optional(),
  submit: z.boolean().optional(),
  secret: z.boolean().optional(),
});
const pageMsg = z.object({ type: z.literal("flow_step"), step: pageStep });
const helloMsg = z.object({ type: z.literal("hello"), source: z.literal("browser"), url: z.string().max(8192) });

export interface Driver {
  appSnapshot(): Promise<AppSnapshot>;
  appClick(ref: string): Promise<{ actionId: string | null }>;
  appType(ref: string, text: string, submit?: boolean): Promise<{ actionId: string | null }>;
  appNavigate(url: string): Promise<{ actionId: string | null }>;
  waitForAction(id: string, timeoutMs?: number): Promise<ActionView | undefined>;
  sendRequest(req: HttpRequestSpec): Promise<{ response: HttpResponseSpec; actionId: string }>;
  listActions(): ActionView[];
}

export interface FlowDeps {
  root(): string | undefined;
  drive: Driver;
  page: {
    url(): string | undefined; // the app pane's current page, if open
    record(on: boolean): Promise<void>;
    listen(cb: (msg: unknown) => void): () => void; // raw binding messages from the page
  };
  emit<K extends keyof ShrikeEvents>(channel: K, payload: ShrikeEvents[K]): void;
  notify(title: string, body: string): void;
  watchFiles(root: string, cb: (path: string) => void): () => void;
  secrets?: { encrypt(s: string): string; decrypt(s: string): string }; // OS keychain (Electron safeStorage)
  first?(kind: "saved" | "passed", name: string): void; // AP: [Request Saved] / [Assertion Passed], main keeps it to once per project
}

// ---- storage ----

export const flowsDir = (root: string) => join(root, ".shrike", "flows");

export function checkId(id: string): string {
  if (!ID.test(id)) throw new Error(`Not a flow id: ${id}`);
  return id;
}

export async function listFlows(root: string): Promise<Flow[]> {
  let names: string[];
  try {
    names = (await readdir(flowsDir(root))).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Flow[] = [];
  for (const n of names.sort()) {
    try {
      const f = JSON.parse(await readFile(join(flowsDir(root), n), "utf8")) as Flow;
      if (f && typeof f.name === "string" && Array.isArray(f.steps)) out.push({ ...f, id: n.slice(0, -5) });
    } catch {} // a hand-broken file is skipped, not fatal
  }
  return out;
}

export async function loadFlow(root: string, id: string): Promise<Flow> {
  const f = (await listFlows(root)).find((x) => x.id === checkId(id));
  if (!f) throw new Error("That flow isn't saved anymore.");
  return f;
}

export async function writeFlow(root: string, flow: Flow): Promise<void> {
  await writeAtomic(join(flowsDir(root), `${checkId(flow.id)}.json`), `${JSON.stringify(flow, null, 2)}\n`);
}

export async function removeFlow(root: string, id: string): Promise<void> {
  await rm(join(flowsDir(root), `${checkId(id)}.json`), { force: true });
}

export async function newId(root: string, name: string): Promise<string> {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "flow";
  const taken = new Set((await listFlows(root)).map((f) => f.id));
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

// ---- steps ----

/** Typing in the same field twice in a row (change, then Enter) is one step. */
export function addStep(steps: FlowStep[], step: FlowStep): FlowStep[] {
  const last = steps.at(-1);
  if (step.type === "type" && last?.type === "type" && last.name === step.name) {
    return [...steps.slice(0, -1), { ...step, ...(last.submit || step.submit ? { submit: true } : {}) }];
  }
  return [...steps, step];
}

/** What the renderer may see: never a secret's text. */
export const shown = (steps: FlowStep[]): FlowStep[] => steps.map((s) => (s.secret ? { ...s, text: SECRET_SHOWN } : s));

/** A request the API explorer sent, as a replayable step (already redacted by the store). */
export function requestStep(view: ActionView): FlowStep | undefined {
  const e = view.tree.find((n) => n.event.kind === "http_request")?.event;
  if (!e?.http) return undefined;
  const headers = Object.fromEntries(Object.entries(e.http.reqHeaders ?? {}).filter(([k]) => k.toLowerCase() !== "traceparent"));
  return { type: "request", request: { method: e.http.method, url: e.http.url, ...(Object.keys(headers).length ? { headers } : {}), ...(e.http.reqBody !== undefined ? { body: e.http.reqBody } : {}) } };
}

/** Redaction before storing: request headers and bodies, and typed text that isn't a secret (secrets are encrypted instead). */
export function redactStep(s: FlowStep): FlowStep {
  if (s.type === "request" && s.request) {
    const fake = { id: "", traceId: "", origin: "explorer", kind: "http_request", name: "", startMs: 0, status: "ok", http: { method: s.request.method, url: s.request.url, reqHeaders: s.request.headers, reqBody: s.request.body } } satisfies DebugEvent;
    const h = redactEvent(fake).http!;
    const assert = s.assert?.map((a) => ({ ...a, value: redactText(a.value) }));
    return { ...s, request: { method: h.method, url: h.url, ...(h.reqHeaders ? { headers: h.reqHeaders } : {}), ...(h.reqBody !== undefined ? { body: h.reqBody } : {}), ...(s.request.name ? { name: s.request.name } : {}) }, ...(assert ? { assert } : {}) };
  }
  if (s.type === "type" && !s.secret && s.text) return { ...s, text: redactText(s.text) };
  return s;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const CLICK_ROLES = ["button", "link", "checkbox", "radio", "tab", "menuitem"];
const TEXT_ROLES = ["textbox", "searchbox", "combobox", "spinbutton"];

/** The element a recorded name points at: an exact name (preferring the step's roles), else the only partial match. */
export function findElement(els: AppElement[], name: string, roles: string[]): AppElement | undefined {
  const q = norm(name);
  const rank = (list: AppElement[]) => [...list].sort((a, b) => Number(roles.includes(b.role)) - Number(roles.includes(a.role)));
  const exact = rank(els.filter((e) => norm(e.name) === q));
  if (exact[0]) return exact[0];
  const partial = els.filter((e) => norm(e.name).includes(q) && roles.includes(e.role));
  return partial.length === 1 ? partial[0] : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- the controller ----

interface Recording {
  root: string;
  startedAt: number;
  steps: { step: FlowStep; at: number }[];
  lastUrl?: string;
  shown: number; // steps last sent to the renderer
  off(): void;
}

export class Flows {
  private deps: FlowDeps;
  private root?: string;
  private rec?: Recording;
  private running = new Map<string, Promise<{ actionIds: string[]; ok: boolean }>>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private unwatch?: () => void;
  private saveTimer?: ReturnType<typeof setTimeout>;

  constructor(deps: FlowDeps) {
    this.deps = deps;
  }

  private need(): string {
    const root = this.deps.root();
    if (!root) throw new Error("No project is open.");
    return root;
  }

  async list(): Promise<Flow[]> {
    await this.sync();
    return listFlows(this.need());
  }

  private async changed(root: string): Promise<void> {
    const all = await listFlows(root);
    this.deps.emit("flows:update", all);
    if (this.root === root) this.schedule(all);
  }

  /** Call when the open project may have changed: re-arms Keep watching for the new one. */
  async sync(): Promise<void> {
    if (this.rec && this.collect(this.rec).length !== this.rec.shown) this.publish(this.rec); // explorer requests have no page event
    const root = this.deps.root();
    if (root === this.root) return;
    this.stopWatching();
    this.root = root;
    if (this.rec && this.rec.root !== root) await this.cancelRecording();
    if (root) this.schedule(await listFlows(root));
  }

  // ---- B1 recording ----

  get recording(): boolean {
    return !!this.rec;
  }

  async startRecording(): Promise<void> {
    const root = this.need();
    if (this.rec) return;
    const rec: Recording = { root, startedAt: Date.now(), steps: [], shown: -1, off: () => {} };
    this.rec = rec;
    const url = this.deps.page.url();
    if (url) {
      rec.lastUrl = url;
      rec.steps.push({ step: { type: "navigate", url: pathOf(url) }, at: rec.startedAt });
    }
    rec.off = this.deps.page.listen((raw) => this.onPage(rec, raw));
    await this.deps.page.record(true).catch(() => {}); // api-only projects have no page; explorer requests still count
    this.publish(rec);
  }

  private onPage(rec: Recording, raw: unknown): void {
    if (this.rec !== rec) return;
    const step = pageMsg.safeParse(raw);
    if (step.success) {
      const s = step.data.step as FlowStep;
      const last = rec.steps.at(-1);
      const merged = addStep(last ? [last.step] : [], s);
      if (last && merged.length === 1) rec.steps[rec.steps.length - 1] = { step: merged[0]!, at: Date.now() };
      else rec.steps.push({ step: s, at: Date.now() });
      return this.publish(rec);
    }
    const hello = helloMsg.safeParse(raw);
    if (!hello.success) return;
    // A new page: keep recording in it, and note the page change unless a click just caused it.
    void this.deps.page.record(true).catch(() => {});
    const last = rec.steps.at(-1);
    const byClick = last && (last.step.type === "click" || last.step.submit) && Date.now() - last.at < 3000;
    const path = pathOf(hello.data.url);
    if (!byClick && path !== (rec.lastUrl && pathOf(rec.lastUrl))) {
      rec.steps.push({ step: { type: "navigate", url: path }, at: Date.now() });
      this.publish(rec);
    }
    rec.lastUrl = hello.data.url;
  }

  private publish(rec: Recording): void {
    const steps = this.collect(rec);
    rec.shown = steps.length;
    this.deps.emit("flow:recording", { steps: shown(steps) });
  }

  /** Page steps plus the API explorer's requests since recording began, in time order. */
  private collect(rec: Recording): FlowStep[] {
    const requests = this.deps.drive
      .listActions()
      .filter((a) => a.trigger === "explorer" && a.startMs >= rec.startedAt)
      .flatMap((a) => {
        const step = requestStep(a);
        return step ? [{ step, at: a.startMs }] : [];
      });
    return [...rec.steps, ...requests].sort((a, b) => a.at - b.at).map((x) => x.step);
  }

  private async cancelRecording(): Promise<void> {
    const rec = this.rec;
    if (!rec) return;
    this.rec = undefined;
    rec.off();
    await this.deps.page.record(false).catch(() => {});
    this.deps.emit("flow:recording", null);
  }

  /** Stop; an empty name discards the recording. */
  async stopRecording(name: string): Promise<Flow | null> {
    const rec = this.rec;
    if (!rec) return null;
    const steps = this.collect(rec);
    await this.cancelRecording();
    const title = name.trim();
    const useful = steps.filter((s) => s.type !== "navigate");
    if (!title || !useful.length) return null;
    return this.save(title, steps);
  }

  async save(name: string, steps: FlowStep[]): Promise<Flow> {
    const root = this.need();
    const flow: Flow = { id: await newId(root, name), name: name.trim().slice(0, 120), steps: steps.map((s) => this.seal(s)) };
    await writeFlow(root, flow);
    await this.changed(root);
    if (flow.steps.some((s) => s.type === "request")) this.deps.first?.("saved", flow.name);
    return flow;
  }

  private seal(s: FlowStep): FlowStep {
    if (!s.secret) return redactStep(s);
    const { text, ...rest } = s;
    if (text === undefined || !this.deps.secrets) return rest; // replay will ask for it to be recorded again
    try {
      return { ...rest, text: `enc:${this.deps.secrets.encrypt(text)}` };
    } catch {
      return rest; // no keychain: never fall back to clear text
    }
  }

  async remove(id: string): Promise<void> {
    const root = this.need();
    await removeFlow(root, id);
    await this.changed(root);
  }

  // ---- B2 replay ----

  run(id: string, watched = false): Promise<{ actionIds: string[]; ok: boolean }> {
    const busy = this.running.get(id);
    if (busy) return busy;
    const p = this.runNow(id, watched).finally(() => this.running.delete(id));
    this.running.set(id, p);
    return p;
  }

  private async runNow(id: string, watched: boolean): Promise<{ actionIds: string[]; ok: boolean }> {
    const root = this.need();
    const flow = await loadFlow(root, id);
    const actionIds: string[] = [];
    let ok = true;
    let why = "";
    for (const [i, step] of flow.steps.entries()) {
      try {
        const r = await this.step(step);
        if (r.actionId) {
          actionIds.push(r.actionId);
          const view = await this.deps.drive.waitForAction(r.actionId, STEP_WAIT_MS);
          if (view?.status === "error" && !r.asserted) {
            ok = false;
            why ||= `${view.label} broke`;
          }
        }
        if (r.failed) {
          ok = false;
          why ||= r.failed;
        }
      } catch (err) {
        ok = false;
        why ||= `Step ${i + 1} couldn't run: ${err instanceof Error ? err.message : String(err)}`;
        break;
      }
    }
    const before = flow.lastRun?.ok;
    // Re-read: the watch may have changed while this ran.
    const fresh = await loadFlow(root, id).catch(() => undefined);
    if (fresh) {
      await writeFlow(root, { ...fresh, lastRun: { at: Date.now(), ok, actionIds } });
      await this.changed(root);
    }
    this.deps.emit("flow:result", { flowId: id, ok, actionIds, watched });
    if (ok && flow.steps.some((s) => s.assert?.some((a) => a.enabled))) this.deps.first?.("passed", flow.name);
    if (watched && !ok && before !== false) this.deps.notify(`"${flow.name}" broke`, why || "A flow you are watching stopped working.");
    return { actionIds, ok };
  }

  private async step(s: FlowStep): Promise<{ actionId: string | null; failed?: string; asserted?: boolean }> {
    const d = this.deps.drive;
    if (s.type === "wait") {
      await sleep(Math.min(Math.max(s.ms ?? 500, 0), 10_000));
      return { actionId: null };
    }
    if (s.type === "navigate") {
      if (!s.url) throw new Error("navigate has no address");
      return d.appNavigate(s.url);
    }
    if (s.type === "request") {
      if (!s.request) throw new Error("request has nothing to send");
      const { response, actionId } = await d.sendRequest(s.request);
      const what = s.request.name ?? `${s.request.method} ${s.request.url}`;
      if (s.assert?.some((a) => a.enabled)) return { actionId, asserted: true, failed: failedCheck(s.assert, response, what) }; // the rows decide, so a test can expect a 409
      return { actionId, failed: response.status >= 400 ? `${what} answered ${response.status}` : undefined };
    }
    if (!s.name) throw new Error(`${s.type} has no element name`);
    const el = await this.find(s.name, s.type === "click" ? CLICK_ROLES : TEXT_ROLES);
    if (s.type === "click") return d.appClick(el.ref);
    return d.appType(el.ref, this.unseal(s), s.submit);
  }

  private unseal(s: FlowStep): string {
    if (!s.secret) return s.text ?? "";
    if (!s.text?.startsWith("enc:") || !this.deps.secrets) throw new Error(`"${s.name}" is a password field and its value isn't saved on this machine. Record the flow again.`);
    return this.deps.secrets.decrypt(s.text.slice(4));
  }

  private async find(name: string, roles: string[]): Promise<AppElement> {
    for (let i = 0; ; i++) {
      const el = findElement((await this.deps.drive.appSnapshot()).elements, name, roles);
      if (el) return el;
      if (i * 200 >= FIND_MS) throw new Error(`nothing named "${name}" on the page`);
      await sleep(200);
    }
  }

  // ---- B3 keep watching ----

  async setWatch(id: string, watch: Flow["watch"] | null): Promise<void> {
    const root = this.need();
    const flow = await loadFlow(root, id);
    const { watch: _, ...rest } = flow;
    await writeFlow(root, watch ? { ...rest, watch } : rest);
    await this.sync();
    await this.changed(root);
  }

  private schedule(flows: Flow[]): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
    for (const f of flows) {
      if (f.watch?.mode !== "interval") continue;
      const minutes = Math.min(Math.max(f.watch.minutes ?? 5, 1), 24 * 60);
      this.timers.set(f.id, setInterval(() => void this.run(f.id, true).catch(() => {}), minutes * 60_000));
    }
    const onSave = flows.some((f) => f.watch?.mode === "save");
    if (onSave && !this.unwatch && this.root) this.unwatch = this.deps.watchFiles(this.root, (p) => this.onSaved(p));
    if (!onSave) this.stopFileWatch();
  }

  private onSaved(path: string): void {
    if (path.startsWith(".shrike/")) return; // our own writes (flows, memory) are not the user's saves
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.runSaved(), SAVE_DEBOUNCE_MS);
  }

  private async runSaved(): Promise<void> {
    const root = this.root;
    if (!root) return;
    for (const f of await listFlows(root)) if (f.watch?.mode === "save") await this.run(f.id, true).catch(() => {});
  }

  private stopFileWatch(): void {
    this.unwatch?.();
    this.unwatch = undefined;
    clearTimeout(this.saveTimer);
  }

  stopWatching(): void {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
    this.stopFileWatch();
  }
}

/** The first assertion row that didn't hold, in plain words. */
export function failedCheck(rows: ApiAssertion[], res: HttpResponseSpec, what: string): string | undefined {
  let body: unknown = res.body;
  try {
    body = JSON.parse(res.body);
  } catch {}
  const bad = runAssertions(rows, { status: res.status, headers: res.headers, body, responseTime: res.durationMs }, {}).find((r) => !r.ok);
  return bad && `${what}: ${bad.error ?? `${bad.expr} was ${bad.actual}, expected ${bad.op} ${bad.value}`.trim()}`;
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return url;
  }
}
