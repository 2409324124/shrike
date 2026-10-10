# @shrike/store

Local persistence. SQLite (better-sqlite3) for indexed rows, NDJSON blobs for payloads and rrweb chunks, `.shriketrace` import/export.

- DDL and retention rules: [docs/04-data-model.md](../../docs/04-data-model.md#sqlite-schema-local)
- Only ever receives already-redacted data

```
src/
├── db.ts          # open, migrations
├── migrations/
├── events.ts      # insert batches, query by action/file, FTS search
├── blobs.ts       # NDJSON append, blob_ref read
├── sessions.ts    # retention
└── trace-file.ts  # .shriketrace zip import/export
```
