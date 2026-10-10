import http from "node:http";
import { LRUCache } from "lru-cache";

const sessions = new LRUCache<string, { user: string }>({ max: 100 });

function verify(id: string) {
  let session = sessions.get(id);
  if (!session) {
    session = { user: `user${id}` };
    sessions.set(id, session);
  }
  return session;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname !== "/verify") return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(verify(url.searchParams.get("id") ?? "")));
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  console.log(`listening ${typeof address === "object" && address ? address.port : ""}`);
});
