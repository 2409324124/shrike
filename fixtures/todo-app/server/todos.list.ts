import { allTodos, getUser } from "./db.ts";
import type { TodoRow } from "./db.ts";

export function withOwner(todo: TodoRow) {
  const owner = getUser(todo.user_id);
  return { id: todo.id, title: todo.title, done: todo.done === 1, owner: owner ? owner.name : "Unknown" };
}

export function listTodosWithOwners() {
  const result = [];
  for (const todo of allTodos()) {
    result.push(withOwner(todo));
  }
  return result;
}
