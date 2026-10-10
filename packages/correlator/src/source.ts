import { FlattenMap, GREATEST_LOWER_BOUND, LEAST_UPPER_BOUND, type TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import type { SourceLocation } from "@shrike/schema";
import { relativize } from "./relativize.ts";

interface Frame {
  fn?: string;
  url: string;
  line: number;
  column: number;
}

const SKIP = [/node_modules/, /\/@vite\//, /\/@react-refresh/, /\/@id\//, /(^|\/)chunk-[\w-]+\.js/, /browser-agent/];

export function parseStack(stack: string): Frame[] {
  const frames: Frame[] = [];
  for (const raw of stack.split("\n")) {
    const m = /^\s*at\s+(?:(.*?)\s+\()?([a-z][\w+.-]*:\/\/.+?):(\d+):(\d+)\)?\s*$/i.exec(raw);
    if (!m || raw.includes("eval at ")) continue;
    const fn = m[1]?.replace(/^async\s+/, "").replace(/^new\s+/, "").replace(/\s+\[as [^\]]+\]$/, "");
    frames.push({ ...(fn ? { fn } : {}), url: m[2]!, line: Number(m[3]), column: Number(m[4]) });
  }
  return frames;
}

// ponytail: short-lived per-URL cache so one action's requests share a fetch, while a reload of an
// edited file (same URL) picks up the new map soon after. Upgrade: invalidate from main's file watcher.
const TTL_MS = 2000;
const cache = new Map<string, { at: number; map: Promise<TraceMap | null> }>();

function decodeDataUrl(u: string): string {
  const comma = u.indexOf(",");
  const meta = u.slice(5, comma);
  const data = u.slice(comma + 1);
  return /;base64$/i.test(meta) ? Buffer.from(data, "base64").toString("utf8") : decodeURIComponent(data);
}

async function loadMap(url: string, loadText: (url: string) => Promise<string>): Promise<TraceMap | null> {
  try {
    const text = await loadText(url);
    const refs = [...text.matchAll(/\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/gm)];
    const ref = refs.at(-1)?.[1];
    if (!ref) return null;
    // FlattenMap also reads index maps (sections), which Turbopack serves for its dev chunks.
    if (ref.startsWith("data:")) return new FlattenMap(decodeDataUrl(ref), url);
    const mapUrl = new URL(ref, url).href;
    return new FlattenMap(await loadText(mapUrl), mapUrl);
  } catch {
    return null;
  }
}

function getMap(url: string, loadText: (url: string) => Promise<string>): Promise<TraceMap | null> {
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && now - hit.at < TTL_MS) return hit.map;
  if (cache.size > 200) cache.clear();
  const map = loadMap(url, loadText);
  cache.set(url, { at: now, map });
  return map;
}

export async function resolveBrowserStack(
  stack: string,
  projectRoot: string,
  loadText: (url: string) => Promise<string>,
): Promise<SourceLocation | undefined> {
  try {
    // A bundler chunk mixes app code and libraries, so a frame is only skipped once its map says node_modules.
    for (const frame of parseStack(stack).filter((f) => !SKIP.some((re) => re.test(f.url))).slice(0, 12)) {
      const fn = frame.fn ? { functionName: frame.fn } : {};
      const map = await getMap(frame.url, loadText);
      if (map) {
        const needle = { line: frame.line, column: frame.column - 1 };
        let pos = originalPositionFor(map, { ...needle, bias: GREATEST_LOWER_BOUND });
        if (pos.source === null) pos = originalPositionFor(map, { ...needle, bias: LEAST_UPPER_BOUND });
        if (pos.source !== null && pos.line !== null) {
          if (/node_modules\/|^turbopack:\/\/\/\[turbopack\]|webpack\/(runtime|bootstrap)/.test(pos.source)) continue;
          const file = relativize(pos.source, projectRoot);
          if (file) return { file, line: pos.line, column: pos.column + 1, ...fn, precision: "exact" };
        }
      }
      const file = relativize(frame.url, projectRoot);
      return file ? { file, line: frame.line, column: frame.column, ...fn, precision: "approximate" } : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
