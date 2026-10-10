// Patches libraries the user's app loads from its own node_modules (and node:sqlite).
//
// An in-thread module.registerHooks resolve hook sees every import and require. When the app resolves
// one of the packages below, the hook loads that exact file synchronously (require(), which on Node 24
// also loads ESM into the same module cache) and patches its class prototypes before the importer runs.
// The app then gets the same, already patched, module instance. Prototypes are shared by every instance,
// so ESM namespaces need no rewriting. If anything fails, the app runs unpatched.
import module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { patchIoredis, patchLru } from "./cache.mjs";
import { patchPglite } from "./pglite.mjs";
import { quietly } from "./runtime.mjs";
import { patchSqlite } from "./sqlite.mjs";
import { patchDynamo } from "./drivers/dynamodb.mjs";
import { patchMongo, patchMongoPool } from "./drivers/mongodb.mjs";
import { patchMysql } from "./drivers/mysql.mjs";
import { patchPg } from "./drivers/pg.mjs";
import { hookPrismaEngine } from "./drivers/prisma.mjs";
import { patchRedis } from "./drivers/redis.mjs";
import { patchSqliteNative } from "./drivers/sqlite-native.mjs";

const PACKAGES = {
  ioredis: patchIoredis,
  "lru-cache": patchLru,
  "@electric-sql/pglite": patchPglite,
  pg: patchPg,
  "pg-pool": patchPg,
  "@neondatabase/serverless": patchPg,
  "better-sqlite3": patchSqliteNative,
  libsql: patchSqliteNative,
  "@aws-sdk/client-dynamodb": patchDynamo,
  "@aws-sdk/lib-dynamodb": patchDynamo,
};
// Files inside a package, whichever entry point (mysql2/promise, mongoose's own require) reached them.
const FILES = [
  [/\/mysql2\/lib\/(base\/)?(connection|pool)\.js$/, patchMysql],
  [/\/mongodb\/lib\/cmap\/connection\.js$/, patchMongo],
  [/\/mongodb\/lib\/core\/connection\/pool\.js$/, patchMongoPool],
  [/\/@redis\/client\/dist\/lib\/client\/index\.js$/, patchRedis],
];
// postgres.js exports a factory function; its stand-in wraps it (see drivers/postgres-entry.mjs).
const REDIRECT = { postgres: new URL("./drivers/postgres-entry.mjs", import.meta.url).href };
const require = createRequire(import.meta.url);
const done = new Set();

function patchFile(url, patch) {
  try {
    patch(require(fileURLToPath(url)), fileURLToPath(url));
  } catch {
    // ponytail: a module with top-level await can't be required; patch it a moment later instead.
    import(url).then((ns) => quietly(() => patch(ns)), () => {});
  }
}

export function hookLibraries() {
  hookPrismaEngine();
  // ponytail: needs module.registerHooks (Node >= 22.15); older Nodes record no database or cache calls.
  if (typeof module.registerHooks !== "function" || typeof process.getBuiltinModule !== "function") return;
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      const url = result?.url;
      if (!url || done.has(url)) return result;
      // quietly() returns undefined when Shrike is busy; then a later resolve retries.
      if (url === "node:sqlite") {
        if (quietly(() => (patchSqlite(process.getBuiltinModule("node:sqlite")), true))) done.add(url);
      } else if (Object.hasOwn(PACKAGES, specifier) && url.startsWith("file:")) {
        if (quietly(() => (patchFile(url, PACKAGES[specifier]), true))) done.add(url);
      } else if (Object.hasOwn(REDIRECT, specifier) && url.startsWith("file:")) {
        return { ...result, url: `${REDIRECT[specifier]}?of=${encodeURIComponent(url)}` };
      } else if (url.startsWith("file:")) {
        const hit = FILES.find(([re]) => re.test(url));
        if (hit && quietly(() => (patchFile(url, hit[1]), true))) done.add(url);
      }
      return result;
    },
  });
}
