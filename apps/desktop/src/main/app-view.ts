import type { BrowserWindow, BrowserWindowConstructorOptions, WebContents } from "electron";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { AppSnapshot, IngestMessage, PointPick } from "@shrike/schema";
import { headless } from "./headless.ts";
import { parseIngest } from "./ingest.ts";

const num = z.number().finite();
const pointMsg = z.object({
  type: z.literal("point"),
  cancelled: z.boolean().optional(),
  pick: z
    .object({
      selector: z.string().max(2000),
      text: z.string().max(200),
      role: z.string().max(60),
      rect: z.object({ x: num, y: num, width: num, height: num, viewportWidth: num, viewportHeight: num }),
      source: z.object({ file: z.string().min(1).max(4096), line: z.number().int().min(1), column: z.number().int().min(0).optional(), precision: z.enum(["exact", "approximate", "unavailable"]) }).optional(),
    })
    .optional(),
});

export interface AppViewOptions {
  bundlePath: string;
  appUrl(): string | undefined; // set while the run is "running"
  onMessage(msg: IngestMessage): void;
  onWarning(text: string): void;
}

/** The app pane's window.open: web pages open as a small sandboxed child window (kept off screen when headless); anything else is refused. */
export function popupPolicy(url: string): { action: "deny" } | { action: "allow"; overrideBrowserWindowOptions: BrowserWindowConstructorOptions } {
  if (!/^https?:/i.test(url) && url !== "about:blank") return { action: "deny" };
  return { action: "allow", overrideBrowserWindowOptions: { show: !headless, width: 520, height: 680, autoHideMenuBar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } } };
}

const rect = z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int().min(100), height: z.number().int().min(100) });
export const appWindowState = z.object({ displayId: z.number(), bounds: rect, fullScreen: z.boolean() });
type Rect = z.infer<typeof rect>;
const APP_WINDOW = { width: 1280, height: 860 };

/** Where the detached app window opens: its saved place while that display is still connected (kept inside it), else centred on the primary display. */
export function placeAppWindow(saved: unknown, displays: { id: number; workArea: Rect }[], primary: Rect): { bounds: Rect; fullScreen: boolean } {
  const s = appWindowState.safeParse(saved);
  const area = (s.success && displays.find((d) => d.id === s.data.displayId)?.workArea) || undefined;
  const a = area ?? primary;
  const width = Math.min(s.success ? s.data.bounds.width : APP_WINDOW.width, a.width);
  const height = Math.min(s.success ? s.data.bounds.height : APP_WINDOW.height, a.height);
  if (!s.success || !area) return { bounds: { x: Math.round(a.x + (a.width - width) / 2), y: Math.round(a.y + (a.height - height) / 2), width, height }, fullScreen: false };
  const b = s.data.bounds;
  const x = Math.min(Math.max(b.x, a.x), a.x + a.width - width);
  const y = Math.min(Math.max(b.y, a.y), a.y + a.height - height);
  return { bounds: { x, y, width, height }, fullScreen: s.data.fullScreen };
}

const NOT_OPEN = "The app isn't open yet. Press Run first.";
const MAX_SHOTS = 50;
const SHOT_WIDTH = 1280;

export class AppView {
  private opts: AppViewOptions;
  private guest?: WebContents;
  private scriptId?: string;
  private queue: Promise<void> = Promise.resolve(); // serializes attach + load
  // ponytail: in memory, last 50 only. Upgrade: write to the project's .shrike folder.
  private shots = new Map<string, string>(); // root action id -> PNG data URL
  private pointing = false;
  private resume?: string; // the page to reopen when the app moves between the dock and its own window
  onPoint?: (pick: PointPick | null) => void; // O1: null when the page cancelled

  constructor(opts: AppViewOptions) {
    this.opts = opts;
  }

  // Call once with the main window's webContents.
  watch(host: WebContents): void {
    host.on("did-attach-webview", (_e, guest) => void this.adopt(guest));
  }

  private async adopt(guest: WebContents): Promise<void> {
    this.guest = guest;
    // Sign-in popups (Firebase signInWithPopup, OAuth) need a real child window with its opener; it closes itself, or with the app.
    guest.setWindowOpenHandler(({ url }) => popupPolicy(url));
    const popups = new Set<BrowserWindow>();
    guest.on("did-create-window", (w) => (popups.add(w), w.once("closed", () => popups.delete(w))));
    guest.once("destroyed", () => {
      for (const w of popups) if (!w.isDestroyed()) w.close();
      if (this.guest === guest) this.guest = undefined;
    });
    guest.on("render-process-gone", (_e, d) => this.opts.onWarning(`\r\n[shrike] The app page crashed (${d.reason}). Press Reload to open it again.\r\n`));
    guest.debugger.on("message", (_e, method, params) => {
      if (method !== "Runtime.bindingCalled" || params?.name !== "__shrikeEmit") return;
      this.onBinding(String(params.payload));
    });
    guest.debugger.on("detach", () => {
      if (this.guest === guest) this.scriptId = undefined; // a guest left behind by a move must not clear the new one's script
    });
    const resume = this.resume;
    this.resume = undefined;
    if (this.opts.appUrl()) await this.load(resume).catch(() => {});
    else {
      const run = this.queue.then(() => this.ensureAttached(guest));
      this.queue = run.catch((err) => this.opts.onWarning(`\r\n[shrike] Couldn't attach the recorder: ${err.message}\r\n`));
      await this.queue;
    }
  }

  private onBinding(payload: string): void {
    let msg: IngestMessage | null = null;
    let raw: unknown;
    try {
      raw = JSON.parse(payload);
    } catch {}
    if ((raw as { type?: unknown } | undefined)?.type === "point") return this.onPointMsg(raw);
    try {
      msg = parseIngest(raw);
    } catch {}
    if (!msg) return;
    // The page is untrusted: it may only speak for the browser side.
    if (msg.type === "events")
      for (const e of msg.events) {
        e.origin = "browser";
        // The root is sent at open (no duration) and again at close; shoot only at open.
        if (e.kind === "user_action" && !e.parentId && e.durationMs === undefined && (e.trigger === "click" || e.trigger === "submit")) void this.capture(e.id);
      }
    try {
      this.opts.onMessage(msg);
    } catch (err) {
      console.error("[shrike] browser event handling failed", err);
    }
  }

  private async ensureAttached(guest: WebContents): Promise<void> {
    const d = guest.debugger;
    if (!d.isAttached()) {
      d.attach("1.3");
      this.scriptId = undefined;
      await d.sendCommand("Runtime.enable");
      await d.sendCommand("Page.enable");
      await d.sendCommand("Runtime.addBinding", { name: "__shrikeEmit" });
    }
    if (this.scriptId) await d.sendCommand("Page.removeScriptToEvaluateOnNewDocument", { identifier: this.scriptId }).catch(() => {});
    this.scriptId = undefined;
    let source: string;
    try {
      source = await readFile(this.opts.bundlePath, "utf8");
    } catch {
      this.opts.onWarning(`\r\n[shrike] Browser recording is off: ${this.opts.bundlePath} is missing. Run "pnpm --filter @shrike/browser-agent build".\r\n`);
      return;
    }
    const r = (await d.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source })) as { identifier: string };
    this.scriptId = r.identifier;
  }

  // Loads the app URL (or `url`) into the app pane with the recorder injected.
  load(url?: string): Promise<void> {
    const run = this.queue.then(() => this.loadNow(url ?? this.opts.appUrl()));
    this.queue = run.catch(() => {});
    return run;
  }

  private async loadNow(url: string | undefined): Promise<void> {
    const guest = this.guest;
    if (!guest || guest.isDestroyed() || !url) throw new Error(NOT_OPEN);
    try {
      await this.ensureAttached(guest);
    } catch (err) {
      this.opts.onWarning(`\r\n[shrike] Couldn't attach the recorder: ${(err as Error).message}\r\n`);
    }
    try {
      await guest.loadURL(url);
    } catch (err) {
      // ERR_ABORTED happens when a newer navigation (or an HMR reload) replaces this one.
      if (!String((err as Error).message).includes("ERR_ABORTED")) this.opts.onWarning(`\r\n[shrike] Couldn't open ${url}: ${(err as Error).message}\r\n`);
    }
  }

  /** Call before the app moves to the other host: the next guest opens the page this one is on. */
  handOff(): void {
    this.resume = this.currentUrl();
  }

  async reload(): Promise<void> {
    const guest = this.guest;
    if (!guest || guest.isDestroyed()) throw new Error(NOT_OPEN);
    const current = guest.getURL();
    await this.load(current.startsWith("http") ? current : undefined);
  }

  private async capture(actionId: string): Promise<void> {
    const guest = this.guest;
    if (!guest || guest.isDestroyed() || this.shots.has(actionId)) return;
    try {
      const img = await guest.capturePage();
      if (img.isEmpty()) return;
      const small = img.getSize().width > SHOT_WIDTH ? img.resize({ width: SHOT_WIDTH, quality: "good" }) : img;
      this.shots.set(actionId, small.toDataURL());
      while (this.shots.size > MAX_SHOTS) this.shots.delete(this.shots.keys().next().value!);
    } catch {}
  }

  shot(actionId: string): string | null {
    return this.shots.get(actionId) ?? null;
  }

  clearShots(): void {
    this.shots.clear();
  }

  currentUrl(): string | undefined {
    const url = this.guest && !this.guest.isDestroyed() ? this.guest.getURL() : undefined;
    return url?.startsWith("http") ? url : undefined;
  }

  private async call<T>(expr: string): Promise<T> {
    const guest = this.guest;
    if (!guest || guest.isDestroyed() || !guest.debugger.isAttached() || !this.currentUrl()) throw new Error(NOT_OPEN);
    const r = (await guest.debugger.sendCommand("Runtime.evaluate", {
      expression: `(() => { if (!window.__shrike) throw new Error("Shrike's recorder isn't loaded in this page."); return window.__shrike.${expr}; })()`,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "The page threw an error.");
    return r.result?.value as T;
  }

  // The page may only answer a point mode Shrike asked for.
  private onPointMsg(raw: unknown): void {
    const m = pointMsg.safeParse(raw);
    if (!m.success || !this.pointing) return;
    this.pointing = false;
    this.onPoint?.(m.data.pick && !m.data.cancelled ? (m.data.pick as PointPick) : null);
  }

  async startPointMode(): Promise<void> {
    await this.call<void>("point(true)");
    this.pointing = true;
  }

  async cancelPointMode(): Promise<void> {
    this.pointing = false;
    await this.call<void>("point(false)").catch(() => {});
  }

  snapshot(): Promise<AppSnapshot> {
    return this.call<AppSnapshot>("snapshot()");
  }

  async click(ref: string): Promise<string | null> {
    return (await this.call<string | null>(`click(${JSON.stringify(ref)})`)) ?? null;
  }

  async type(ref: string, text: string, submit?: boolean): Promise<string | null> {
    return (await this.call<string | null>(`type(${JSON.stringify(ref)}, ${JSON.stringify(text)}, ${submit === true})`)) ?? null;
  }
}
