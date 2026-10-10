import type { Todo } from "./api.ts";

type Props = { todos: Todo[]; onToggle: (todo: Todo) => void };

export function TodoList({ todos, onToggle }: Props) {
  if (todos.length === 0) return <p className="empty">Nothing here yet. Add your first todo above.</p>;
  return (
    <ul className="todo-list">
      {todos.map((todo) => (
        <li key={todo.id} className={todo.done ? "todo done" : "todo"}>
          <input
            type="checkbox"
            checked={todo.done}
            onChange={() => onToggle(todo)}
            aria-label={todo.title}
          />
          <span className="todo-title">{todo.title}</span>
          <span className="todo-owner">{todo.owner}</span>
        </li>
      ))}
    </ul>
  );
}
