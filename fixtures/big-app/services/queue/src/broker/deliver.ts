import { dequeue, enqueue, subscribersOf, type Message } from "./topics.ts";

export async function drain(topic: string): Promise<void> {
  for (let msg = dequeue(topic); msg; msg = dequeue(topic)) {
    for (const url of subscribersOf(topic)) await deliver(url, msg);
  }
}

export async function deliver(url: string, msg: Message): Promise<void> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-message-id": String(msg.id) }, body: JSON.stringify(msg.body) });
    if (!res.ok) throw new Error(`subscriber said ${res.status}`);
  } catch (err) {
    console.warn(`delivery of message ${msg.id} failed:`, (err as Error).message);
    if (++msg.attempts < 3) enqueue(msg.topic, msg.body);
  }
}
