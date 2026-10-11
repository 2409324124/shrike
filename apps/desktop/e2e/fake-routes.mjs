// The "Fill in examples" brain for e2e (fake-claude.mjs hands it main/api/routes.ts guessPrompt). Answers for the routes asked,
// the way a real agent reads fixtures/api-only/src/server.ts: POST /v1/users wants { email, name } and can answer 201, 200, 400, 409.

const KNOWN = {
  "POST /v1/users": {
    summary: "Creates a user, or returns the one already registered with that email",
    params: [],
    body: { example: { email: "sam@example.com", name: "Sam Rivera" }, required: ["email", "name"] },
    responses: [
      { status: "201", description: "Created", example: { id: 1, email: "sam@example.com", name: "Sam Rivera" } },
      { status: "200", description: "Already registered: the existing user", example: { id: 1, email: "sam@example.com", name: "Sam Rivera" } },
      { status: "400", description: "Missing email or name", example: { error: "Send an email and a name." } },
      { status: "409", description: "The email is taken in another case", example: { error: "Sam@Example.com is already registered." } },
    ],
  },
  "GET /v1/users": { summary: "Lists users", params: [], responses: [{ status: "200", description: "All users", example: [{ id: 1, email: "sam@example.com", name: "Sam Rivera" }] }] },
  "GET /health": { summary: "Readiness check", params: [], responses: [{ status: "200", description: "Up", example: { ok: true } }] },
};

export function answer(goal) {
  const asked = [...goal.matchAll(/^- ([A-Z]+) (\/\S*)/gm)].map((m) => `${m[1]} ${m[2]}`);
  const routes = asked.map((k) => ({ method: k.split(" ")[0], path: k.split(" ")[1], ...(KNOWN[k] ?? { params: [], responses: [{ status: "200" }] }) }));
  return `I read the handlers in src/server.ts.\n\n\`\`\`json\n${JSON.stringify({ routes }, null, 2)}\n\`\`\``;
}
