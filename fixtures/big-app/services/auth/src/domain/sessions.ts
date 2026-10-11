import { LRUCache } from "lru-cache";

export interface Session {
  userId: number;
  name: string;
  email: string;
  expiresAt: number;
}

const IDLE_MS = 30 * 60_000;
// Signed-in sessions by token. ponytail: one demo shopper, seeded on start.
const sessions = new LRUCache<string, Session>({ max: 10_000 });
sessions.set("demo-token", { userId: 1, name: "Maya", email: "maya@example.com", expiresAt: Date.now() + IDLE_MS });

export function lookupSession(token: string): Session | undefined {
  return sessions.get(token);
}

export function isExpired(session: Session): boolean {
  return session.expiresAt < Date.now();
}

export function touchSession(token: string, session: Session): Session {
  const fresh = { ...session, expiresAt: Date.now() + IDLE_MS };
  sessions.set(token, fresh);
  return fresh;
}
