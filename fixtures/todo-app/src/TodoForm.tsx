import { useState, type FormEvent } from "react";
import { createTodo, type Todo } from "./api.ts";

type Props = { onAdded: (todo: Todo) => void };

export function TodoForm({ onAdded }: Props) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setError(false);
    try {
      const todo = await createTodo(title.trim());
      onAdded(todo);
      setTitle("");
    } catch {
      setError(true);
    }
  }

  return (
    <form className="todo-form" onSubmit={handleSubmit}>
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="What needs doing?"
        aria-label="New todo"
      />
      <button type="submit">Add Todo</button>
      {error && <p className="form-error" role="alert">Something went wrong</p>}
    </form>
  );
}
