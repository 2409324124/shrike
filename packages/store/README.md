# @shrike/store

Not built yet. Today the desktop keeps live trips in memory (`apps/desktop/src/main/store.ts`) and writes each project's newest completed trips to an NDJSON file under the app's user data folder (`apps/desktop/src/main/sessions.ts`).

The plan: SQLite (better-sqlite3) for indexed rows, NDJSON blobs for payloads and rrweb chunks, `.shriketrace` import/export.

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
