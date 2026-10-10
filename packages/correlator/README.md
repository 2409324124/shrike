# @shrike/correlator

Turns raw collector output into the timeline.

## Owns

- Adapters: OTel spans/logs, CDP events, browser-agent events, node-agent function events → `DebugEvent`
- Clock alignment across browser and server
- Tree building per Action (parent links first, timestamps second)
- Source resolution with source maps, precision tags, framework-frame marking
- Action completion (network idle + no pending renders)
- Deterministic heuristics and the What happened? checklist ([docs/05-agent.md](../../docs/05-agent.md#deterministic-heuristics-run-locally-no-ai))

```
src/
├── adapters/      # otel.ts, cdp.ts, browser.ts, node.ts
├── clock.ts
├── tree.ts
├── source.ts      # SourceMapConsumer cache, precision
├── actions.ts     # window close rules, stats
├── heuristics/    # slow, n-plus-one, sequential, waterfall, duplicates, swallowed, silent-failure
└── summary.ts     # WhatHappened builder
```

Place-aware (docs/12-feature-map.md): `external_call` and `cache_op` events get their own steps ("Stripe refused: …", "The cache answered (hit)", "Called auth (…)"), lines in `formatActionTree`, and flags `cache_never_hit` (3+ lookups, all missed) and `slow_outside` (one call over 100ms and over half the trip).

Pure functions where possible; no Electron imports, so it's testable with `node:test`.
