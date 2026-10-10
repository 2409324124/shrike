import { mkdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// Seeded fresh on every start.
mkdirSync(".data", { recursive: true });
rmSync(".data/users.db", { force: true });
const db = new DatabaseSync(".data/users.db");
db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL);
  CREATE UNIQUE INDEX users_email ON users (email COLLATE NOCASE);
  INSERT INTO users (email, name) VALUES ('sam@example.com', 'Sam Rivera'), ('lee@example.com', 'Lee Chen');
`);

export interface User {
  id: number;
  email: string;
  name: string;
}

const byEmail = db.prepare("SELECT id, email, name FROM users WHERE email = ?");
const insert = db.prepare("INSERT INTO users (email, name) VALUES (?, ?) RETURNING id, email, name");
const all = db.prepare("SELECT id, email, name FROM users ORDER BY id");

export function findUserByEmail(email: string): User | undefined {
  return byEmail.get(email) as User | undefined;
}

export function insertUser(email: string, name: string): User {
  return insert.get(email, name) as unknown as User;
}

export function listUsers(): User[] {
  return all.all() as unknown as User[];
}
