// @aws-sdk/client-dynamodb and @aws-sdk/lib-dynamodb: client.send(command) -> db_query.
// The DocumentClient runs commands through its own send, so both classes are patched; an inner send runs in lib context.
import { changeOf } from "../inspect.mjs";
import { hostKey } from "../place.mjs";
import { preview } from "../preview.mjs";
import { als, libCall } from "../runtime.mjs";
import { once } from "./common.mjs";

const places = new WeakMap();
const GENERIC = { kind: "data", id: "data:dynamodb", name: "DYNAMODB" };

function placeOf(config) {
  if (!config || typeof config !== "object") return GENERIC;
  const known = places.get(config);
  if (known) return known;
  places.set(config, GENERIC);
  als.exit(() =>
    (async () => {
      const ep = config.isCustomEndpoint !== false && typeof config.endpoint === "function" ? await config.endpoint() : undefined;
      const region = typeof config.region === "function" ? await config.region() : config.region;
      const where = ep?.hostname ? hostKey(ep.hostname, ep.port, ep.protocol === "https:" ? 443 : 80) : String(region ?? "aws");
      places.set(config, { kind: "data", id: `data:dynamodb:${where}`, name: `DYNAMODB · ${where}`, detail: where });
    })().catch(() => {}),
  );
  return GENERIC;
}

/** {S:"a"} -> "a", {N:"1"} -> 1, ... (DocumentClient inputs are plain already). */
export function plain(v) {
  if (!v || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(plain);
  const keys = Object.keys(v);
  if (keys.length === 1) {
    const [t] = keys;
    const x = v[t];
    if (t === "S" || t === "B") return t === "B" ? "<bytes>" : x;
    if (t === "N") return Number(x);
    if (t === "BOOL") return x;
    if (t === "NULL") return null;
    if (t === "L") return x.map(plain);
    if (t === "M") return plain(x);
    if (t === "SS" || t === "NS") return x;
  }
  const out = {};
  for (const k of keys) out[k] = plain(v[k]);
  return out;
}

const OPS = { PutItem: "insert", Put: "insert", UpdateItem: "update", Update: "update", DeleteItem: "delete", Delete: "delete" };
const pkOf = (key) => (key ? Object.values(plain(key)).map(String).join(", ") : undefined);

function patchSend(proto) {
  if (!proto || !once(proto)) return;
  const orig = proto.send;
  const patched = function send(command) {
    const name = String(command?.constructor?.name ?? "").replace(/Command$/, "");
    const input = command?.input ?? {};
    if (!name || typeof command?.resolveMiddleware !== "function") return orig.apply(this, arguments);
    const config = this.config;
    return libCall(
      patched,
      () => {
        const table = input.TableName ?? Object.keys(input.RequestItems ?? input.TransactItems ?? {})[0] ?? "";
        const args = {};
        for (const k of ["Key", "KeyConditionExpression", "FilterExpression", "UpdateExpression", "ConditionExpression", "ExpressionAttributeValues", "IndexName", "Limit", "Item"]) if (input[k] !== undefined) args[k] = k === "Item" ? Object.keys(plain(input[k])) : plain(input[k]);
        const statement = `${name}${table ? ` ${table}` : ""}`;
        return { origin: "db", kind: "db_query", name: statement, db: { system: "dynamodb", statement, params: Object.keys(args).length ? preview(args) : undefined }, place: placeOf(config) };
      },
      () => orig.apply(this, arguments),
      (event, out) => {
        event.place = places.get(config) ?? event.place;
        const op = OPS[name];
        if (op) {
          const table = input.TableName;
          const item = op === "insert" ? plain(input.Item) : plain(out?.Attributes ?? input.Key);
          const row = { pk: pkOf(input.Key ?? undefined) };
          event.change = changeOf({ op, table }, 1, op === "delete" ? { before: [item] } : { after: [item] });
          if (row.pk && event.change.rows?.[0]) event.change.rows[0].pk = row.pk;
        } else if (Array.isArray(out?.Items)) event.returned = `${out.Items.length} item${out.Items.length === 1 ? "" : "s"}`;
        else if (out && "Item" in out) event.returned = out.Item ? preview(plain(out.Item)) : "no item";
      },
      true,
    );
  };
  proto.send = patched;
}

/** @aws-sdk/client-dynamodb (DynamoDBClient) or @aws-sdk/lib-dynamodb (DynamoDBDocumentClient). */
export function patchDynamo(mod) {
  for (const cls of [mod?.DynamoDBClient, mod?.DynamoDBDocumentClient, mod?.DynamoDB, mod?.DynamoDBDocument]) {
    if (typeof cls?.prototype?.send !== "function") continue;
    // An own send on the class itself, so other AWS clients sharing the smithy base class stay untouched.
    if (!Object.hasOwn(cls.prototype, "send")) Object.defineProperty(cls.prototype, "send", { value: cls.prototype.send, writable: true, configurable: true });
    patchSend(cls.prototype);
  }
}
