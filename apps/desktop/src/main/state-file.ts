import { createHash, randomBytes } from "node:crypto";
import { constants, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

// Shrike's own JSON state (userData, a project's .shrike). No Electron imports, so node:test drives it.

/** Copies a damaged file to <file>.broken-<hash> before a fallback can be saved over it. Same damage, same name: one copy, never an older one overwritten. */
export function keepBroken(file: string, text: string): void {
  const to = `${file}.broken-${createHash("sha1").update(text).digest("hex").slice(0, 8)}`;
  try {
    copyFileSync(file, to, constants.COPYFILE_EXCL);
    console.warn(`[shrike] ${file} couldn't be read, so Shrike kept a copy at ${to} and started it fresh.`);
  } catch {}
}

const parse = (file: string, text: string | undefined): unknown => {
  if (!text?.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    keepBroken(file, text);
    return undefined;
  }
};

/** The file's JSON; undefined when it is missing, empty or damaged (a damaged one is kept aside first). */
export const readJsonSync = (file: string): unknown => {
  let text: string | undefined;
  try {
    text = readFileSync(file, "utf8");
  } catch {}
  return parse(file, text);
};
export const readJson = async (file: string): Promise<unknown> => parse(file, await readFile(file, "utf8").catch(() => undefined));

/** A plain reason a save failed. */
export function saveError(file: string, err: unknown): Error {
  const code = (err as NodeJS.ErrnoException).code;
  const why =
    code === "EACCES" || code === "EPERM" ? "Shrike isn't allowed to write to that folder" : code === "EROFS" ? "the folder is read-only" : code === "ENOSPC" ? "the disk is full" : (err as Error).message;
  return new Error(`Shrike couldn't save ${basename(file)}: ${why}.`, { cause: err });
}

type Data = string | Uint8Array;
const tmpOf = (file: string) => `${file}.${randomBytes(4).toString("hex")}.tmp`;

/** Temp file then rename, so a crash or a full disk never leaves half a file. */
export async function writeAtomic(file: string, data: Data, mode?: number): Promise<void> {
  const tmp = tmpOf(file);
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(tmp, data, mode === undefined ? undefined : { mode });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw saveError(file, err);
  }
}

export function writeAtomicSync(file: string, data: Data, mode?: number): void {
  const tmp = tmpOf(file);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw saveError(file, err);
  }
}
