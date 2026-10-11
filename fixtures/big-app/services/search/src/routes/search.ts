import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson, send } from "../../../shared/http.ts";
import { reindex } from "../handlers/reindex.ts";
import { relatedFor } from "../handlers/related.ts";

export async function relatedRoute(req: IncomingMessage, res: ServerResponse) {
  const { names } = await readJson(req);
  send(res, 200, await relatedFor((names as string[]) ?? []));
}

export async function reindexRoute(_req: IncomingMessage, res: ServerResponse) {
  send(res, 200, await reindex());
}
