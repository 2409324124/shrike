import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

mkdirSync(".data", { recursive: true });
const events = new DatabaseSync(".data/events.db");
events.exec("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, name TEXT NOT NULL, props TEXT NOT NULL, at TEXT NOT NULL)");
const insert = events.prepare("INSERT INTO events (name, props, at) VALUES (?, ?, ?)");

export async function trackEvent(name: string, props: Record<string, unknown>): Promise<void> {
  insert.run(name, JSON.stringify(props), new Date().toISOString());
}
