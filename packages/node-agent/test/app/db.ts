import { DatabaseSync } from "node:sqlite";

export interface NewTodo {
  title: string;
  userId?: number;
}

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL, user_id INTEGER NOT NULL)");

export function insertTodo(todo: NewTodo) {
  return db.prepare("INSERT INTO todos (title, user_id) VALUES (?, ?)").run(todo.title, todo.userId ?? null);
}

export function listTodos() {
  return db.prepare("SELECT id, title FROM todos ORDER BY id").all();
}
