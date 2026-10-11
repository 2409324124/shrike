import { urlOf } from "../../../shared/http.ts";

export async function publish(topic: string, payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${urlOf.queue}/topics/${topic}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`queue said ${res.status}`);
}
