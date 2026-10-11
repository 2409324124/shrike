import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// The transactional outbox: every event is written here first, then relayed to the queue.
mkdirSync(".data", { recursive: true });
const outbox = new DatabaseSync(".data/outbox.db");
outbox.exec("CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, topic TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT)");
const insert = outbox.prepare("INSERT INTO outbox (topic, payload, created_at) VALUES (?, ?, ?) RETURNING id");
const sent = outbox.prepare("UPDATE outbox SET sent_at = ? WHERE id = ?");

export interface OutboxRow {
  id: number;
  topic: string;
  payload: Record<string, unknown>;
}

export function writeOutbox(topic: string, payload: Record<string, unknown>): OutboxRow {
  const row = insert.get(topic, JSON.stringify(payload), new Date().toISOString()) as { id: number };
  return { id: row.id, topic, payload };
}

export function markSent(id: number): void {
  sent.run(new Date().toISOString(), id);
}
