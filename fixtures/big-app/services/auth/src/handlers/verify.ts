import { isExpired, lookupSession, touchSession, type Session } from "../domain/sessions.ts";

export function verifySession(token: string): Session | undefined {
  const session = lookupSession(token);
  if (!session || isExpired(session)) return undefined;
  return touchSession(token, session);
}
