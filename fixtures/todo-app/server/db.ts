import { DatabaseSync } from "node:sqlite";

export type TodoRow = { id: number; title: string; done: number; user_id: number };
export type UserRow = { id: number; name: string };
export type NewTodo = { title: string; userId?: number };

const db = new DatabaseSync(":memory:");

db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE todos (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    user_id INTEGER NOT NULL REFERENCES users(id)
  );
  INSERT INTO users (name) VALUES ('Maya Chen'), ('Sam Okafor');
  INSERT INTO todos (title, done, user_id) VALUES
    ('Write the launch email', 1, 1),
    ('Fix the signup page on mobile', 0, 2),
    ('Book the team offsite', 0, 1),
    ('Review pricing copy', 0, 2);
`);

export function allTodos() {
  return db.prepare("SELECT * FROM todos ORDER BY id").all() as TodoRow[];
}

export function getUser(id: number) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function insertTodo(todo: NewTodo) {
  return db
    .prepare("INSERT INTO todos (title, user_id) VALUES (?, ?) RETURNING *")
    .get(todo.title, todo.userId ?? null) as TodoRow;
}

export function setTodoDone(id: number, done: boolean) {
  return db
    .prepare("UPDATE todos SET done = ? WHERE id = ? RETURNING *")
    .get(done ? 1 : 0, id) as TodoRow | undefined;
}

export function countOpenTodos() {
  const row = db.prepare("SELECT COUNT(*) AS count FROM todos WHERE done = 0").get() as { count: number };
  return row.count;
}

export function countActiveUsers() {
  const row = db.prepare("SELECT COUNT(DISTINCT user_id) AS count FROM todos").get() as { count: number };
  return row.count;
}
