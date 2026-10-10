import { useEffect, useState } from "react";
import { getDashboard, getTodos, toggleTodo, type DashboardStats, type Todo } from "./api.ts";
import { TodoForm } from "./TodoForm.tsx";
import { TodoList } from "./TodoList.tsx";

export function App() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  useEffect(() => {
    getTodos()
      .then(setTodos)
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  async function handleToggle(todo: Todo) {
    const updated = await toggleTodo(todo.id, !todo.done);
    setTodos((current) => current.map((t) => (t.id === updated.id ? updated : t)));
  }

  async function loadDashboard() {
    setStatsLoading(true);
    try {
      setStats(await getDashboard());
    } catch {
      setStats(null);
    } finally {
      setStatsLoading(false);
    }
  }

  return (
    <main className="app">
      <header className="header">
        <h1>Todos</h1>
        <p>Everything your team needs to get done.</p>
      </header>

      <TodoForm onAdded={(todo) => setTodos((current) => [...current, todo])} />

      {loading ? (
        <p className="empty">Loading todos...</p>
      ) : loadError ? (
        <p className="form-error" role="alert">Something went wrong</p>
      ) : (
        <TodoList todos={todos} onToggle={handleToggle} />
      )}

      <section className="dashboard">
        <button type="button" className="secondary" onClick={loadDashboard} disabled={statsLoading}>
          {statsLoading ? "Loading..." : "Load dashboard"}
        </button>
        {stats && (
          <dl className="stats">
            <div>
              <dt>Open todos</dt>
              <dd>{stats.openTodos}</dd>
            </div>
            <div>
              <dt>Active people</dt>
              <dd>{stats.activeUsers}</dd>
            </div>
          </dl>
        )}
      </section>
    </main>
  );
}
