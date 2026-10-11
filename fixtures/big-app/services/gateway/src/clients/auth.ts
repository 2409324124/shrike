import { urlOf } from "../../../shared/http.ts";

export interface Session {
  userId: number;
  name: string;
  email: string;
}

export async function verifySession(token: string): Promise<Session | undefined> {
  const res = await fetch(`${urlOf.auth}/sessions/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  return res.ok ? res.json() : undefined;
}
