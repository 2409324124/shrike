export type Todo = { id: number; title: string; done: boolean; owner: string };
export type DashboardStats = { openTodos: number; activeUsers: number };

export async function getTodos(): Promise<Todo[]> {
  const res = await fetch("/api/todos");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export async function createTodo(title: string): Promise<Todo> {
  const body = { title, userId: 1 };
  const res = await fetch("/api/todos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export async function toggleTodo(id: number, done: boolean): Promise<Todo> {
  const res = await fetch(`/api/todos/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ done }),
  });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export async function getDashboard(): Promise<DashboardStats> {
  const res = await fetch("/api/dashboard");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}
