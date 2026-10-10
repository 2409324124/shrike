import type { ShrikeApi } from "@shrike/schema";
import { toast } from "../stores/ui.ts";

declare global {
  interface Window {
    shrike: ShrikeApi;
    __shrikeMock?: boolean;
  }
}

export const api = (): ShrikeApi => window.shrike;

export function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // Electron wraps IPC rejections: "Error invoking remote method 'x': Error: real message"
  return msg.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, "");
}

/** Runs an api call; on failure shows a toast and resolves to undefined. */
export async function call<T>(fn: (a: ShrikeApi) => Promise<T>, what: string): Promise<T | undefined> {
  try {
    return await fn(api());
  } catch (e) {
    toast(`${what}: ${errorMessage(e)}`, "error");
    return undefined;
  }
}
