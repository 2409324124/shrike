import type { Request, Response } from "express";
import { insertTodo, setTodoDone } from "./db.ts";
import { listTodosWithOwners, withOwner } from "./todos.list.ts";

export function listTodos(req: Request, res: Response) {
  res.json(listTodosWithOwners());
}

export function toggleTodo(req: Request, res: Response) {
  const todo = setTodoDone(Number(req.params.id), req.body.done === true);
  res.status(todo ? 200 : 404).json(todo ? withOwner(todo) : { error: "Todo not found" });
}

export async function createTodo(req: Request, res: Response) {
  const { title } = req.body;
  console.log("creating todo", { title });
  if (!title) return res.status(400).json({ error: "Title is required" });
  const todo = insertTodo({ title, userId: req.body.user });
  res.status(201).json(withOwner(todo));
}
