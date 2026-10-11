import type { IncomingMessage, ServerResponse } from "node:http";
import { send } from "../../../shared/http.ts";
import { recommendationsFor } from "../handlers/forUser.ts";

export async function recsRoute(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>) {
  send(res, 200, await recommendationsFor(Number(params.userId)));
}
