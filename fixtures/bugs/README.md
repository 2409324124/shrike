# fixtures/bugs

The agent eval corpus. One folder per bug, each a patch on top of a fixture:

```
001-wrong-field-name/
├── bug.patch       # applied to fixtures/todo-app or fixtures/next-app
├── complaint.txt   # the user's words
├── expected.json   # { file, line, category }
└── scenario.json   # fails before the fix, passes after
```

The starting list of 15 bugs and the scoring rules are in [docs/09-testing.md](../../docs/09-testing.md#agent-eval-corpus-fixturesbugs). Results go in `RESULTS.md` (date, brain, model, scores).
