// Bruno assertions: "res.status: eq 200", "res.body.id: isNumber". Pure, no code runs.
import type { ApiAssertion, ApiAssertionResult } from "@shrike/schema";
import { asText, evalPath, interpolate, type ResLike, type Scope } from "./vars.ts";

const literal = (raw: string): unknown => {
  const t = raw.trim();
  if (t === "") return "";
  if (t === "undefined") return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return /^'.*'$/.test(t) ? t.slice(1, -1) : t;
  }
};
const list = (raw: string): unknown[] => {
  const t = raw.trim();
  const v = literal(t);
  return Array.isArray(v) ? v : t.split(",").map((x) => literal(x));
};
const loose = (a: unknown, b: unknown) => a === b || (typeof a !== "object" && typeof b !== "object" && String(a) === String(b)) || JSON.stringify(a) === JSON.stringify(b);
// ponytail: length cap and a nested-quantifier check stop (a+)+ style patterns from a cloned repo's flow freezing main. Upgrade: run in a worker with a timeout.
const regex = (raw: string) => {
  if (raw.length > 200 || /\([^)]*[+*}][^)]*\)[+*{]/.test(raw)) throw new Error("That pattern is too complex to check safely.");
  const m = /^\/(.*)\/([a-z]*)$/.exec(raw.trim());
  return m ? new RegExp(m[1]!, m[2]) : new RegExp(raw.trim());
};
const isEmpty = (v: unknown) => v === "" || v === null || v === undefined || (Array.isArray(v) && !v.length) || (typeof v === "object" && v !== null && !Object.keys(v).length);

const OPS: Record<string, (a: unknown, raw: string) => boolean> = {
  eq: (a, r) => loose(a, literal(r)),
  neq: (a, r) => !loose(a, literal(r)),
  gt: (a, r) => Number(a) > Number(literal(r)),
  gte: (a, r) => Number(a) >= Number(literal(r)),
  lt: (a, r) => Number(a) < Number(literal(r)),
  lte: (a, r) => Number(a) <= Number(literal(r)),
  in: (a, r) => list(r).some((x) => loose(a, x)),
  notIn: (a, r) => !list(r).some((x) => loose(a, x)),
  contains: (a, r) => (Array.isArray(a) ? a.some((x) => loose(x, literal(r))) : asText(a).includes(String(literal(r)))),
  notContains: (a, r) => !OPS.contains!(a, r),
  startsWith: (a, r) => asText(a).startsWith(String(literal(r))),
  endsWith: (a, r) => asText(a).endsWith(String(literal(r))),
  matches: (a, r) => regex(r).test(asText(a).slice(0, 10_000)),
  notMatches: (a, r) => !regex(r).test(asText(a).slice(0, 10_000)),
  between: (a, r) => {
    const [lo, hi] = list(r).map(Number);
    return Number(a) >= lo! && Number(a) <= hi!;
  },
  length: (a, r) => (Array.isArray(a) || typeof a === "string" ? a.length === Number(literal(r)) : false),
  isEmpty: (a) => isEmpty(a),
  isNotEmpty: (a) => !isEmpty(a),
  isNull: (a) => a === null,
  isDefined: (a) => a !== undefined,
  isUndefined: (a) => a === undefined,
  isTruthy: (a) => !!a,
  isFalsy: (a) => !a,
  isNumber: (a) => typeof a === "number" && Number.isFinite(a),
  isString: (a) => typeof a === "string",
  isBoolean: (a) => typeof a === "boolean",
  isArray: (a) => Array.isArray(a),
  isJson: (a) => typeof a === "object" && a !== null,
};
export const ASSERT_OPS = Object.keys(OPS);

export function runAssertions(list: ApiAssertion[], res: ResLike, scope: Scope): ApiAssertionResult[] {
  return list
    .filter((a) => a.enabled)
    .map((a) => {
      const op = OPS[a.op];
      if (!op) return { ...a, ok: false, error: `Unknown check "${a.op}".` };
      try {
        const actual = evalPath(interpolate(a.expr, scope), res);
        return { ...a, ok: op(actual, interpolate(a.value, scope)), actual: actual === undefined ? "undefined" : asText(actual).slice(0, 200) };
      } catch (err) {
        return { ...a, ok: false, error: (err as Error).message };
      }
    });
}
