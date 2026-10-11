// Empty in dev: Vite proxies /api to Django. Set VITE_API_URL to call Django directly (CORS, cookies included).
const BASE = import.meta.env.VITE_API_URL ?? "";

const csrfToken = () => /(?:^|;\s*)csrftoken=([^;]+)/.exec(document.cookie)?.[1] ?? "";

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", "X-CSRFToken": csrfToken(), ...init.headers },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchCsrf = () => call<{ ok: boolean }>("/api/csrf");
export const usernameAvailable = (u: string) => call<{ available: boolean }>(`/api/username?u=${encodeURIComponent(u)}`);
export const signup = (body: { username: string; email: string; plan: string }) =>
  call<{ id: number; credits: number }>("/api/signup", { method: "POST", body: JSON.stringify(body) });
