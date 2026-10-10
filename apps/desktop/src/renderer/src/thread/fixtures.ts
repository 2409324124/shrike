import type { ActionView, DebugEvent, Place, SourceLocation, Status, TimelineNode } from "@shrike/schema";

// Realistic multi-place trips (shop-app, api-only, cron) for thread-layout tests and the scratch screenshot harness.
// Shapes follow docs/12-feature-map.md; places are what node-agent and main are specified to emit.

let seq = 0;
const hex = (n: number) => (++seq).toString(16).padStart(n, "0");
const at = (file: string, line: number): SourceLocation => ({ file, line, precision: "exact" });

export const P = {
  web: { id: "client:shop-web", kind: "client", name: "WEB · shop-web", detail: "localhost:5180" },
  api: { id: "service:api", kind: "service", name: "API", detail: "localhost:4100" },
  auth: { id: "service:auth", kind: "service", name: "AUTH", detail: "localhost:4101" },
  payments: { id: "service:payments", kind: "service", name: "PAYMENTS", detail: "localhost:4102" },
  sessions: { id: "cache:lru:sessions", kind: "cache", name: "LRU · sessions" },
  orders: { id: "data:pglite:orders", kind: "data", name: "POSTGRES · orders" },
  events: { id: "data:sqlite:events.db", kind: "data", name: "SQLITE · events.db" },
  stripe: { id: "outside:localhost:4199", kind: "outside", name: "Stripe (test double)", detail: "localhost:4199" },
  server: { id: "service:api-only", kind: "service", name: "API-ONLY", detail: "localhost:4300" },
  appDb: { id: "data:sqlite:app.db", kind: "data", name: "SQLITE · app.db" },
  worker: { id: "service:nightly", kind: "service", name: "NIGHTLY" },
  mail: { id: "outside:api.postmark.com", kind: "outside", name: "POSTMARK · api.postmark.com", detail: "api.postmark.com" },
} as const satisfies Record<string, Place>;

function tracer(t0: number) {
  const traceId = hex(32);
  const make = (e: Partial<DebugEvent> & Pick<DebugEvent, "kind" | "name" | "origin">, start: number, dur?: number): DebugEvent => ({ id: hex(16), traceId, status: "ok", startMs: t0 + start, durationMs: dur, ...e });
  const n = (event: DebugEvent, children: TimelineNode[] = []): TimelineNode => {
    for (const c of children) c.event.parentId = event.id;
    return { event, children };
  };
  return { make, n };
}

function view(root: DebugEvent, tree: TimelineNode[], status: Status): ActionView {
  for (const c of tree) c.event.parentId = root.id;
  return {
    id: root.id, traceId: root.traceId, trigger: root.trigger ?? "click", label: root.name, startMs: root.startMs, durationMs: root.durationMs ?? 0, status, complete: true, tree, root,
    summary: { headline: "", steps: [], stats: { files: 0, functions: 0, requests: 0, queries: 0, logs: 0, errors: 0, totalMs: root.durationMs ?? 0 } }, flags: [],
  };
}

export const PAY_BUTTON = { x: 40, y: 300, width: 360, height: 44, viewportWidth: 440, viewportHeight: 640 };

/** shop-app "Pay now": web → api → auth → sessions hit → orders → at the same time (charge card → payments → Stripe 400, save event) → snaps at Stripe. */
export function payNow(t0: number): ActionView {
  const { make, n } = tracer(t0);
  const root = make({ kind: "user_action", origin: "browser", name: 'Clicked "Pay now"', trigger: "click", status: "error", source: at("web/src/Checkout.tsx", 42), target: PAY_BUTTON }, 0, 96);
  const stripeBody = JSON.stringify({ error: { type: "invalid_request_error", message: "Amount must be at least 50 cents" } });
  const tree = [
    n(make({ kind: "http_request", origin: "browser", place: P.web, name: "POST /api/pay", status: "error", source: at("web/src/api.ts", 18), http: { method: "POST", url: "/api/pay", status: 402, reqBody: '{"orderId":7,"amount":30}' } }, 2, 92), [
      n(make({ kind: "http_request", origin: "server", place: P.api, name: "POST /api/pay", status: "error", source: at("services/api/index.ts", 21), http: { method: "POST", url: "/api/pay", status: 402 } }, 4, 88), [
        n(make({ kind: "function", origin: "server", place: P.api, name: "pay()", status: "error", source: at("services/api/pay.ts", 9), args: ["req { POST /api/pay body: { orderId: 7, amount: 30 } }", "res"], error: { message: "Payment failed" } }, 5, 86), [
          n(make({ kind: "external_call", origin: "server", place: P.auth, name: "POST http://localhost:4101/verify", source: at("services/api/auth.ts", 6), http: { method: "POST", url: "http://localhost:4101/verify", status: 200 } }, 6, 14), [
            n(make({ kind: "http_request", origin: "server", place: P.auth, name: "POST /verify", source: at("services/auth/index.ts", 12), http: { method: "POST", url: "/verify", status: 200 } }, 8, 10), [
              n(make({ kind: "function", origin: "server", place: P.auth, name: "verifySession()", source: at("services/auth/session.ts", 8), callSite: at("services/auth/index.ts", 14), args: ["'sess_91'"], returned: "{ userId: 3 }" }, 9, 8), [
                n(make({ kind: "cache_op", origin: "server", place: P.sessions, name: "get session:91", cache: { op: "get", key: "session:91", hit: true }, source: at("services/auth/session.ts", 10) }, 10, 1)),
              ]),
            ]),
          ]),
          n(make({ kind: "db_query", origin: "db", place: P.orders, name: "SELECT", db: { system: "postgresql", statement: "SELECT * FROM orders WHERE id = $1", params: "[ 7 ]" }, source: at("services/api/orders.ts", 14) }, 22, 6)),
          n(make({ kind: "function", origin: "server", place: P.api, name: "chargeCard()", status: "error", source: at("services/api/pay.ts", 30), callSite: at("services/api/pay.ts", 16), args: ["{ orderId: 7, amount: 30 }"], error: { message: "Payment failed" } }, 30, 58), [
            n(make({ kind: "external_call", origin: "server", place: P.payments, name: "POST http://localhost:4102/charge", status: "error", source: at("services/api/pay.ts", 32), http: { method: "POST", url: "http://localhost:4102/charge", status: 402 } }, 31, 56), [
              n(make({ kind: "http_request", origin: "server", place: P.payments, name: "POST /charge", status: "error", source: at("services/payments/index.ts", 10), http: { method: "POST", url: "/charge", status: 402 } }, 33, 52), [
                n(make({ kind: "function", origin: "server", place: P.payments, name: "createCharge()", status: "error", source: at("services/payments/charge.ts", 5), callSite: at("services/payments/index.ts", 12), args: ["{ amount: 30, currency: 'usd' }"], error: { message: "Stripe said no: Amount must be at least 50 cents" } }, 34, 50), [
                  n(make({ kind: "external_call", origin: "server", place: P.stripe, name: "POST http://localhost:4199/v1/charges", status: "error", source: at("services/payments/charge.ts", 9), http: { method: "POST", url: "http://localhost:4199/v1/charges", status: 400, resBody: stripeBody } }, 36, 46)),
                ]),
              ]),
            ]),
          ]),
          n(make({ kind: "function", origin: "server", place: P.api, name: "saveEvent()", source: at("services/api/events.ts", 4), callSite: at("services/api/pay.ts", 17), args: ["'payment_attempted'", "{ orderId: 7 }"] }, 30, 12), [
            n(make({ kind: "db_query", origin: "db", place: P.events, name: "INSERT", db: { system: "sqlite", statement: "INSERT INTO events (kind, data) VALUES (?, ?)" }, source: at("services/api/events.ts", 6) }, 31, 10)),
          ]),
        ]),
      ]),
    ]),
  ];
  return view(root, tree, "error");
}

/** shop-app "View orders": the cache misses, the database answers, the cache is filled. With hit=true the second load is served from the cache. */
export function ordersLoad(t0: number, hit: boolean): ActionView {
  const { make, n } = tracer(t0);
  const root = make({ kind: "user_action", origin: "browser", name: 'Clicked "My orders"', trigger: "click", source: at("web/src/Nav.tsx", 12), target: { x: 300, y: 14, width: 90, height: 28, viewportWidth: 440, viewportHeight: 640 } }, 0, hit ? 9 : 31);
  const inner = hit
    ? [n(make({ kind: "cache_op", origin: "server", place: P.sessions, name: "get orders:7", cache: { op: "get", key: "orders:7", hit: true }, source: at("services/api/orders.ts", 8) }, 5, 1))]
    : [
        n(make({ kind: "cache_op", origin: "server", place: P.sessions, name: "get orders:7", cache: { op: "get", key: "orders:7", hit: false }, source: at("services/api/orders.ts", 8) }, 5, 1)),
        n(make({ kind: "db_query", origin: "db", place: P.orders, name: "SELECT", db: { system: "postgresql", statement: "SELECT * FROM orders WHERE user_id = $1", params: "[ 3 ]" }, source: at("services/api/orders.ts", 10) }, 7, 18)),
        n(make({ kind: "cache_op", origin: "server", place: P.sessions, name: "set orders:7", cache: { op: "set", key: "orders:7" }, source: at("services/api/orders.ts", 11) }, 26, 1)),
      ];
  const tree = [
    n(make({ kind: "http_request", origin: "browser", place: P.web, name: "GET /api/orders", source: at("web/src/api.ts", 9), http: { method: "GET", url: "/api/orders", status: 200 } }, 1, hit ? 7 : 29), [
      n(make({ kind: "http_request", origin: "server", place: P.api, name: "GET /api/orders", source: at("services/api/index.ts", 17), http: { method: "GET", url: "/api/orders", status: 200 } }, 2, hit ? 5 : 27), [
        n(make({ kind: "function", origin: "server", place: P.api, name: "listOrders()", source: at("services/api/orders.ts", 6), args: ["req { GET /api/orders }", "res"] }, 3, hit ? 3 : 25), inner),
      ]),
    ]),
  ];
  return view(root, tree, "ok");
}

/** api-only: curl POST /api/signup, refused by sqlite with a 409. */
export function curlSignup(t0: number): ActionView {
  const { make, n } = tracer(t0);
  const command = `curl -X POST localhost:4300/api/signup -d '{"email":"maya@example.com"}'`;
  const root = make({ kind: "user_action", origin: "server", name: "POST /api/signup (from curl)", trigger: "server", status: "error", caller: { kind: "curl", label: "curl", command } }, 0, 12);
  const err = "UNIQUE constraint failed: users.email";
  const tree = [
    n(make({ kind: "http_request", origin: "server", place: P.server, name: "POST /api/signup", status: "error", source: at("src/server.ts", 22), http: { method: "POST", url: "/api/signup", status: 409, reqHeaders: { "user-agent": "curl/8.7.1" } } }, 0, 12), [
      n(make({ kind: "function", origin: "server", place: P.server, name: "signup()", status: "error", source: at("src/users.ts", 8), args: ["req { POST /api/signup body: { email: 'maya@example.com' } }", "res"], error: { message: err } }, 1, 10), [
        n(make({ kind: "function", origin: "server", place: P.server, name: "insertUser()", status: "error", source: at("src/db.ts", 20), callSite: at("src/users.ts", 11), args: ["{ email: 'maya@example.com' }"], error: { message: err } }, 2, 6), [
          n(make({ kind: "db_query", origin: "db", place: P.appDb, name: "INSERT", status: "error", db: { system: "sqlite", statement: "INSERT INTO users (email) VALUES (?)" }, error: { message: err }, source: at("src/db.ts", 22) }, 3, 4)),
        ]),
      ]),
    ]),
  ];
  return view(root, tree, "error");
}

/** api-only: the nightly cron job reads yesterday's signups and emails a summary. */
export function cronNightly(t0: number): ActionView {
  const { make, n } = tracer(t0);
  const root = make({ kind: "user_action", origin: "server", name: "Nightly report", trigger: "server", caller: { kind: "cron", label: "cron · nightly 02:00", command: "node src/nightly.ts" } }, 0, 412);
  const tree = [
    n(make({ kind: "function", origin: "server", place: P.worker, name: "nightlyReport()", source: at("src/nightly.ts", 5), args: [] }, 1, 410), [
      n(make({ kind: "db_query", origin: "db", place: P.appDb, name: "SELECT", db: { system: "sqlite", statement: "SELECT COUNT(*) FROM users WHERE created_at > ?" }, source: at("src/nightly.ts", 7) }, 2, 3)),
      n(make({ kind: "log", origin: "server", place: P.worker, name: "log", log: { level: "info", message: "signups yesterday { count: 14 }" }, source: at("src/nightly.ts", 9) }, 6)),
      n(make({ kind: "external_call", origin: "server", place: P.mail, name: "POST https://api.postmark.com/email", source: at("src/nightly.ts", 11), http: { method: "POST", url: "https://api.postmark.com/email", status: 200 } }, 8, 401)),
    ]),
  ];
  return view(root, tree, "slow");
}
