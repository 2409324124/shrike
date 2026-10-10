import express from "express";
import type { NextFunction, Request, Response } from "express";
import { getDashboard } from "./dashboard.ts";
import { createTodo, listTodos, toggleTodo } from "./todos.controller.ts";

const app = express();
app.use(express.json());

app.get("/api/todos", listTodos);
app.post("/api/todos", createTodo);
app.patch("/api/todos/:id", toggleTodo);
app.get("/api/dashboard", getDashboard);

// Express only treats 4-argument middleware as an error handler.
app.use(function handleError(err: Error, req: Request, res: Response, next: NextFunction) {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(Number(process.env.SERVER_PORT ?? 3001), function onListen() {
  console.log(`API ready on port ${process.env.SERVER_PORT ?? 3001}`);
});
