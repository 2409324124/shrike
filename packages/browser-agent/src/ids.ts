function hex(bytes: number): string {
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(bytes))) s += b.toString(16).padStart(2, "0");
  return s;
}

export const newTraceId = (): string => hex(16);
export const newEventId = (): string => hex(8);
export const ZERO_TRACE = "0".repeat(32);
