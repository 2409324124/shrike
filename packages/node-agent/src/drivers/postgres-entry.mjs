// Stands in for the app's `postgres` package (libs.mjs redirects it here); ?of= is the real entry file.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { wrapPostgres } from "./postgresjs.mjs";

const real = createRequire(import.meta.url)(fileURLToPath(new URL(import.meta.url).searchParams.get("of")));
const postgres = wrapPostgres(real?.default ?? real);
export { postgres as default, postgres as "module.exports" };
