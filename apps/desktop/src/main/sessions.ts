import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActionView, DebugEvent, IngestMessage, TimelineNode } from "@shrike/schema";

// "Pick up where you left off": each project's trips in <userData>/sessions/<hash>.ndjson.
// Line 1 is {root, name, at, actionIds}; then one {"events": [...]} line per trip, root event first.
// Events are already redacted by the store, so nothing new is exposed by writing them.

// ponytail: the newest 2000 trips per project, rewritten whole on change. Upgrade: append-only with compaction.
export const MAX_ACTIONS = 2000;
const SERVER_OUTPUT_ID = "0".repeat(16);

export interface SessionMeta {
  root: string;
  name: string;
  at: number;
  actionIds: string[];
}

export const sessionFile = (dir: string, root: string) => join(dir, `${createHash("sha1").update(root).digest("hex").slice(0, 16)}.ndjson`);

const flatten = (nodes: TimelineNode[]): DebugEvent[] => nodes.flatMap((n) => [n.event, ...flatten(n.children)]);

const keep = (views: ActionView[]) => views.filter((v) => v.complete && v.id !== SERVER_OUTPUT_ID).slice(-MAX_ACTIONS);

export async function saveSession(dir: string, root: string, name: string, views: ActionView[], at = Date.now()): Promise<void> {
  const trips = keep(views);
  const meta: SessionMeta = { root, name, at, actionIds: trips.map((v) => v.id) };
  const lines = [JSON.stringify(meta), ...trips.map((v) => JSON.stringify({ events: [v.root, ...flatten(v.tree)] }))];
  await mkdir(dir, { recursive: true });
  const file = sessionFile(dir, root);
  const tmp = `${file}.${randomBytes(3).toString("hex")}.tmp`;
  await writeFile(tmp, `${lines.join("\n")}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

/** The saved trips of one project, as event lists (root first). Damaged lines are skipped. */
export async function loadSession(dir: string, root: string): Promise<DebugEvent[][]> {
  let text: string;
  try {
    text = await readFile(sessionFile(dir, root), "utf8");
  } catch {
    return [];
  }
  const out: DebugEvent[][] = [];
  for (const line of text.split("\n").slice(1)) {
    try {
      const events = (JSON.parse(line) as { events?: unknown }).events;
      if (Array.isArray(events) && events.length && typeof events[0]?.id === "string" && events[0].kind === "user_action") out.push(events as DebugEvent[]);
    } catch {}
  }
  return out;
}

/** Feeds saved trips back into the store, each closed as soon as it lands. */
export function restore(handle: (msg: IngestMessage) => void, trips: DebugEvent[][]): void {
  for (const events of trips) {
    handle({ type: "events", events });
    handle({ type: "action_end", actionId: events[0]!.id, at: Date.now() });
  }
}

/** The most recently used project that has trips. */
export async function lastSession(dir: string): Promise<SessionMeta | null> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".ndjson"));
  } catch {
    return null;
  }
  let best: SessionMeta | null = null;
  for (const n of names) {
    try {
      const text = await readFile(join(dir, n), "utf8");
      const meta = JSON.parse(text.slice(0, text.indexOf("\n"))) as SessionMeta;
      if (typeof meta.root === "string" && Array.isArray(meta.actionIds) && meta.actionIds.length && (!best || meta.at > best.at)) best = meta;
    } catch {}
  }
  return best;
}

/** Saves the open project's trips when they change and restores them when a project opens. Call tick() every second or so. */
export class SessionSync {
  private opts: { dir: string; root(): string | undefined; name(): string; list(): ActionView[]; handle(msg: IngestMessage): void };
  private root?: string;
  private ready = false; // the open project's saved trips are back; only then may saving overwrite the file
  private last = "";
  private busy = false;

  constructor(opts: SessionSync["opts"]) {
    this.opts = opts;
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const root = this.opts.root();
      if (root !== this.root) {
        this.root = root;
        this.ready = false;
        this.last = "";
        if (!root) return;
        restore(this.opts.handle, await loadSession(this.opts.dir, root));
        this.ready = true;
        return;
      }
      if (!root || !this.ready) return;
      const trips = keep(this.opts.list());
      const sig = trips.map((v) => `${v.id}:${v.status}`).join(",");
      if (sig === this.last) return;
      this.last = sig;
      // ponytail: an emptied list (Clear) isn't saved, so the last real session survives. Upgrade: clear it explicitly.
      if (trips.length) await saveSession(this.opts.dir, root, this.opts.name(), trips);
    } catch (err) {
      console.error("[shrike] session save failed", err);
    } finally {
      this.busy = false;
    }
  }
}
