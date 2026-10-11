import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "./state-file.ts";
import type { MemoryNote } from "@shrike/schema";

// A5: .shrike/memory.md, a plain list people can read and edit. One note per "- " line:
//   - userId must be a number (server/todos.controller.ts:18) <!-- id:ab12 by:agent at:1760000000000 -->
// Lines a person adds by hand (no comment) still load; their id is a hash of the text.

const HEADER = "# Shrike memory\n\nThings Shrike's agent learned about this project. Edit freely: one note per line.\n";
const META = /\s*<!--\s*id:(\S+)\s+by:(agent|user)\s+at:(\d+)\s*-->\s*$/;
const WHERE = /\s*\(([^()\s]+?):(\d+)\)\s*$|\s*\(([^()\s:]+\.[\w]+)\)\s*$/;

export const memoryPath = (root: string) => join(root, ".shrike", "memory.md");

function noteOf(raw: string): MemoryNote | undefined {
  const m = /^\s*[-*]\s+(.+)$/.exec(raw);
  if (!m) return undefined;
  let body = m[1]!;
  const meta = META.exec(body);
  if (meta) body = body.slice(0, meta.index);
  let file: string | undefined;
  let line: number | undefined;
  const w = WHERE.exec(body);
  if (w) {
    file = w[1] ?? w[3];
    line = w[2] ? Number(w[2]) : undefined;
    body = body.slice(0, w.index);
  }
  const text = body.trim();
  if (!text) return undefined;
  return {
    id: meta?.[1] ?? createHash("sha1").update(raw.trim()).digest("hex").slice(0, 8),
    text,
    ...(file ? { file } : {}),
    ...(line ? { line } : {}),
    createdAt: meta ? Number(meta[3]) : 0,
    by: (meta?.[2] as MemoryNote["by"] | undefined) ?? "user",
  };
}

export function parseMemory(text: string): MemoryNote[] {
  return text.split(/\r?\n/).map(noteOf).filter((n) => n !== undefined);
}

const formatLine = (n: MemoryNote) => {
  const text = n.text.replace(/\s+/g, " ").replace(/<!--|-->/g, "").trim();
  const where = n.file ? ` (${n.file}${n.line ? `:${n.line}` : ""})` : "";
  return `- ${text}${where} <!-- id:${n.id} by:${n.by} at:${n.createdAt} -->`;
};

export function formatMemory(notes: MemoryNote[]): string {
  const lines = notes.map(formatLine);
  return `${HEADER}\n${lines.join("\n")}${lines.length ? "\n" : ""}`;
}

const readText = async (root: string): Promise<string> => {
  try {
    return await readFile(memoryPath(root), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
};

export const loadMemory = async (root: string): Promise<MemoryNote[]> => parseMemory(await readText(root));

// Writes go through a temp file so a crash never leaves half a list.
const save = (root: string, text: string) => writeAtomic(memoryPath(root), text);

let chain: Promise<unknown> = Promise.resolve(); // serialize read-modify-write
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
};

// Edits touch only note lines: headings, prose and hand-made bullets a person wrote stay as they are.
export function addMemory(root: string, note: Omit<MemoryNote, "id" | "createdAt">): Promise<{ note: MemoryNote; all: MemoryNote[] }> {
  return serial(async () => {
    const before = await readText(root);
    const all = parseMemory(before);
    const text = note.text.replace(/\s+/g, " ").trim().slice(0, 300);
    if (!text) throw new Error("The note is empty.");
    const same = all.find((n) => n.text.toLowerCase() === text.toLowerCase() && n.file === note.file && n.line === note.line);
    if (same) return { note: same, all };
    const created: MemoryNote = { id: randomBytes(4).toString("hex"), text, createdAt: Date.now(), by: note.by, ...(note.file ? { file: note.file } : {}), ...(note.file && note.line ? { line: note.line } : {}) };
    const base = before.trim() ? before.replace(/\s*$/, "\n") : `${HEADER}\n`;
    await save(root, `${base}${formatLine(created)}\n`);
    return { note: created, all: [...all, created] };
  });
}

export function removeMemory(root: string, id: string): Promise<MemoryNote[]> {
  return serial(async () => {
    const before = await readText(root);
    const lines = before.split(/(?<=\n)/);
    const kept = lines.filter((l) => noteOf(l.replace(/\r?\n$/, ""))?.id !== id);
    if (kept.length !== lines.length) await save(root, kept.join(""));
    return parseMemory(kept.join(""));
  });
}
