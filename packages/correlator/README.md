# @shrike/correlator

Turns raw collector output into the timeline.

## Owns

Events arrive already shaped as `DebugEvent`: the node, python and browser agents emit them, and the desktop converts OTLP spans in `main/otlp.ts`.

- Tree building per Action (parent links first, timestamps second)
- Source resolution with source maps, precision tags, framework-frame marking
- Deterministic heuristics and the What happened? checklist ([docs/05-agent.md](../../docs/05-agent.md#deterministic-heuristics-run-locally-no-ai))

```
src/
├── index.ts
├── tree.ts        # ActionView per Action
├── source.ts      # source maps (@jridgewell/trace-mapping), precision
├── relativize.ts  # bundler and file URLs -> repo-relative paths
├── flags.ts       # heuristics: slow, n-plus-one, sequential, waterfall, duplicates, swallowed, silent-failure
├── summary.ts     # WhatHappened builder
├── compare.ts     # before/after diff of two Actions
├── format.ts      # formatActionTree, the compact text tree agents read
└── util.ts
```

Place-aware (docs/12-feature-map.md): `external_call` and `cache_op` events get their own steps ("Stripe refused: …", "The cache answered (hit)", "Called auth (…)"), lines in `formatActionTree`, and flags `cache_never_hit` (3+ lookups, all missed) and `slow_outside` (one call over 100ms and over half the trip).

Pure functions where possible; no Electron imports, so it's testable with `node:test`.
