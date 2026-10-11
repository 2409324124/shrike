import { publish } from "../clients/queue.ts";
import { markSent, type OutboxRow } from "../db/outbox.ts";

export async function relayOutbox(row: OutboxRow): Promise<void> {
  await publish(row.topic, row.payload);
  markSent(row.id);
}
