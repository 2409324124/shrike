import { createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";

function App() {
  const [quote, setQuote] = useState(null);

  async function getQuote(sku) {
    setQuote(null);
    const res = await fetch("/api/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lines: [{ sku, qty: 2 }] }) });
    const body = await res.json();
    setQuote(res.ok ? `Total: ${(body.totalCents / 100).toFixed(2)}` : "Couldn't get a quote");
  }

  return h(
    "main",
    null,
    h("h1", null, "Polyglot Tea"),
    h("button", { onClick: () => getQuote("tea") }, "Quote 2 tins of tea"),
    h("button", { onClick: () => getQuote("book") }, "Quote 2 tea books"),
    quote && h("p", { role: "status" }, quote),
  );
}

createRoot(document.getElementById("root")).render(h(App));
