import express from "express";

const PRICING = `http://localhost:${process.env.PRICING_PORT ?? 4612}`;
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

async function priceLine(line) {
  const res = await fetch(`${PRICING}/price/${encodeURIComponent(line.sku)}?qty=${line.qty}`);
  if (!res.ok) throw new Error(`pricing answered ${res.status}`);
  return res.json();
}

async function buildQuote(cart) {
  const lines = [];
  for (const line of cart.lines) lines.push(await priceLine(line));
  return { lines, totalCents: lines.reduce((sum, l) => sum + l.cents, 0) };
}

app.post("/api/quote", async (req, res) => {
  try {
    res.json(await buildQuote(req.body));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

const port = Number(process.env.GATEWAY_PORT ?? 4611);
app.listen(port, () => console.log(`gateway on http://localhost:${port}`));
