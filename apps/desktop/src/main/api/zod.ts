// zod for API client payloads crossing into main (renderer IPC and MCP).
import { z } from "zod";
import type { ApiRequest, RouteGuess } from "@shrike/schema";

const s = (max = 8192) => z.string().max(max);
export const kvZ = z.object({ name: s(1024), value: s(1024 * 1024), enabled: z.boolean(), secret: z.boolean().optional() });
const kvList = z.array(kvZ).max(500);
export const authZ = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inherit") }),
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer"), token: s(64 * 1024) }),
  z.object({ type: z.literal("basic"), username: s(), password: s() }),
  z.object({ type: z.literal("apikey"), key: s(1024), value: s(64 * 1024), placement: z.enum(["header", "query"]) }),
]);
const big = s(10 * 1024 * 1024);
export const bodyZ = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.enum(["json", "text", "xml"]), data: big }),
  z.object({ type: z.literal("form-urlencoded"), fields: kvList }),
  z.object({ type: z.literal("multipart"), fields: z.array(kvZ.extend({ file: z.boolean().optional() })).max(500) }),
  z.object({ type: z.literal("graphql"), query: big, variables: big }),
]);
export const assertionZ = z.object({ expr: s(1024), op: s(64), value: s(64 * 1024), enabled: z.boolean() });
export const requestZ: z.ZodType<ApiRequest> = z.object({
  path: s(1024),
  name: z.string().trim().min(1).max(200),
  seq: z.number().int().min(0).max(1e9).optional(),
  method: z.string().min(1).max(16).regex(/^[A-Za-z]+$/),
  url: s(16 * 1024),
  params: kvList,
  pathParams: kvList,
  headers: kvList,
  body: bodyZ,
  auth: authZ,
  vars: z.object({ pre: kvList, post: kvList }),
  assertions: z.array(assertionZ).max(200),
  scripts: z.object({ pre: big.optional(), post: big.optional(), tests: big.optional() }),
  settings: z.object({ timeoutMs: z.number().int().min(0).max(600_000).optional(), followRedirects: z.boolean().optional(), maxRedirects: z.number().int().min(0).max(50).optional(), verifyTls: z.boolean().optional(), encodeUrl: z.boolean().optional() }),
  docs: big.optional(),
}) as z.ZodType<ApiRequest>;
export const envZ = z.object({ name: z.string().trim().min(1).max(200), vars: kvList });
export const sendOptsZ = z.object({ collectionId: s(64).optional(), environment: s(200).optional(), sendId: s(128).optional(), resendOf: z.string().regex(/^[0-9a-f]{16}$/).optional() }).optional();
export const idZ = z.string().regex(/^[0-9a-f]{12}$/);
export const relZ = z.string().max(1024);
export const importKindZ = z.enum(["curl", "postman", "openapi", "bruno", "routes"]);
export const codeLangZ = z.enum(["curl", "fetch", "axios", "python", "httpie"]);
const methodZ = z.string().regex(/^[A-Za-z]{3,7}$/);
const routePathZ = s(1024).regex(/^\//);
export const routeRefsZ = z.array(z.object({ method: methodZ, path: routePathZ }).strict()).min(1).max(100);
const schemaZ = z.record(z.string(), z.unknown()).refine((v) => JSON.stringify(v).length < 256 * 1024, "schema too big");
export const routeGuessZ: z.ZodType<RouteGuess> = z
  .object({
    method: methodZ,
    path: routePathZ,
    summary: s(300).optional(),
    params: z.array(z.object({ name: s(200).min(1), in: z.enum(["path", "query", "header"]), required: z.boolean(), type: s(60).optional(), enum: z.array(s(200)).max(50).optional(), description: s(500).optional(), example: s(2000).optional() }).strict()).max(40),
    body: z.object({ example: s(64 * 1024), schema: schemaZ }).strict().optional(),
    responses: z.array(z.object({ status: s(16), description: s(500).optional(), schema: schemaZ.optional(), example: s(64 * 1024).optional() }).strict()).max(20),
  })
  .strict() as z.ZodType<RouteGuess>;
