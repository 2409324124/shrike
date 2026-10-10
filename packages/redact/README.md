# @shrike/redact

Removes secrets before anything is stored, shown, sent to an agent or exported. Runs on ingest, on every MCP tool output, and on export.

Rules and order: [docs/07-security-privacy.md](../../docs/07-security-privacy.md#redaction-rules-shrikeredact).

```
src/
├── index.ts       # redactEvent, redactValue, redactHeaders
├── keys.ts        # sensitive key patterns
├── shapes.ts      # known secret formats
├── entropy.ts
└── env.ts         # load .env* values to match
```

Every rule has a `node:test` check with a positive and a negative sample. Changes here need review.
