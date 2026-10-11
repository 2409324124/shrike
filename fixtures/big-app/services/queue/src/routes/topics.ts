import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson, send } from "../../../shared/http.ts";
import { enqueue } from "../broker/topics.ts";
import { drain } from "../broker/deliver.ts";

// Accept now, deliver right after: the publisher never waits for subscribers.
export async function publishRoute(req: IncomingMessage, res: ServerResponse, params: Record<string, string>) {
  const topic = params.topic!;
  const id = enqueue(topic, await readJson(req));
  send(res, 202, { id, topic });
  setImmediate(() => drain(topic));
}
