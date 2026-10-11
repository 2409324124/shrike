import { PORTS } from "../../../shared/http.ts";

export interface Message {
  id: number;
  topic: string;
  body: Record<string, unknown>;
  attempts: number;
}

// ponytail: an in-memory broker with one consumer per topic; a restart loses what's queued. Upgrade: a real broker.
const queues = new Map<string, Message[]>();
const subscribers: Record<string, string[]> = {
  "order.placed": [`http://localhost:${PORTS.notifications}/events/order-placed`],
};
let nextId = 1;

export function enqueue(topic: string, body: Record<string, unknown>): number {
  const msg = { id: nextId++, topic, body, attempts: 0 };
  queues.set(topic, [...(queues.get(topic) ?? []), msg]);
  return msg.id;
}

export function dequeue(topic: string): Message | undefined {
  return queues.get(topic)?.shift();
}

export function subscribersOf(topic: string): string[] {
  return subscribers[topic] ?? [];
}
