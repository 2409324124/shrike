import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson, send } from "../../../shared/http.ts";
import { listAll, listFeatured } from "../db/productRepo.ts";
import { getProduct } from "../handlers/product.ts";
import { quoteItems } from "../handlers/quote.ts";

export async function listRoute(_req: IncomingMessage, res: ServerResponse) {
  send(res, 200, await listFeatured());
}

export async function exportRoute(_req: IncomingMessage, res: ServerResponse) {
  send(res, 200, await listAll());
}

export async function productRoute(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>) {
  const product = await getProduct(Number(params.id));
  send(res, product ? 200 : 404, product ?? { error: "No such product" });
}

export async function quoteRoute(req: IncomingMessage, res: ServerResponse) {
  const { productIds } = await readJson(req);
  send(res, 200, await quoteItems((productIds as number[]) ?? []));
}
