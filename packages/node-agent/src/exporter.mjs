const MAX_QUEUE = 10_000;

export function createExporter(ingestUrl, token) {
  const fetch = globalThis.fetch; // captured before user code can patch it
  const url = ingestUrl.replace(/\/+$/, "") + "/ingest";
  let queue = [];

  function post(message) {
    try {
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-shrike-token": token ?? "" },
        body: JSON.stringify(message),
      })
        .then((r) => r.arrayBuffer())
        .catch(() => {});
    } catch {}
  }

  function flush() {
    if (!queue.length) return;
    const events = queue;
    queue = [];
    post({ type: "events", events });
  }

  setInterval(flush, 100).unref();
  process.on("beforeExit", flush);

  return {
    post,
    flush,
    push(event) {
      // ponytail: drops events when the ingest is unreachable for long; no retry.
      if (queue.length < MAX_QUEUE) queue.push(event);
    },
  };
}
