# Contributing to Shrike

Thanks for helping. Shrike is a debugger for people who build web apps with AI, so the bar is simple: every change should make it easier to see what an app did and fix it.

## Ways to help

- **Report a bug**: [open an issue](https://github.com/SumantxD/shrike/issues/new/choose) with the bug form. Steps to reproduce and your stack matter most.
- **Ask for your stack**: Shrike records Node and Python 3.12+ today, and any backend through OpenTelemetry. Use the "Support my stack" form so we can see what people need. Want to build it yourself? [docs/writing-a-recorder.md](docs/writing-a-recorder.md) shows how.
- **Ask a question or share an idea**: use [Discussions](https://github.com/SumantxD/shrike/discussions), not issues.
- **Fix something**: issues labelled [`good first issue`](https://github.com/SumantxD/shrike/labels/good%20first%20issue) are small and well described. [`help wanted`](https://github.com/SumantxD/shrike/labels/help%20wanted) are bigger.
- **Try it on Linux or Windows**: Windows has never run on a real machine and Linux has only run in Docker. A report from either is a real contribution.

Before starting something larger than a bug fix, open an issue or discussion first so we can agree on the approach. It saves you from a pull request that can't be merged.

## Set up

You need Node 24 (22.18 or newer works), pnpm 10 and git. Python 3.12+ is only needed for the Python recorder tests. Xcode is only needed for voice on macOS.

```sh
git clone https://github.com/SumantxD/shrike.git
cd shrike
pnpm install
pnpm dev          # runs the desktop app
pnpm typecheck
pnpm test         # unit tests, about a minute
```

`pnpm e2e` builds the app and runs the Playwright end-to-end tests. Most e2e files can be run alone, for example `cd apps/desktop && node --test e2e/demo.test.ts`. Windows open without taking focus; set `SHRIKE_HEADLESS=1` to hide them. See [docs/09-testing.md](docs/09-testing.md).

## Where things are

| Path | What it is |
|---|---|
| `apps/desktop` | The Electron app: main process, preload, renderer |
| `packages/node-agent`, `packages/browser-agent`, `packages/python-agent` | Recorders that run inside the user's app |
| `packages/correlator`, `packages/redact`, `packages/scanner` | Pure logic: building trips, removing secrets, finding routes |
| `packages/mcp-server`, `packages/agent` | The tools agents use, and the agent hosts |
| `packages/schema` | Types shared across processes |
| `design-system` | Tokens and the component catalogue for anything visual |
| `fixtures` | Small broken apps Shrike is tested against |
| `docs` | Product, architecture and decisions. Start with [docs/01-product.md](docs/01-product.md) |

## The rules

These keep Shrike safe to run inside other people's apps. [CLAUDE.md](CLAUDE.md) has the full list; it applies to people and coding agents alike.

1. **Small, focused pull requests.** One change per PR. No new dependencies or abstractions unless the change needs them.
2. **Recorders never break the host app.** Code in `packages/*-agent` has minimal dependencies, wraps every hook, and must not crash or slow the user's app.
3. **Secrets never leak.** `@shrike/redact` runs before anything is stored, shown, sent to an agent or exported. Never add a path around it.
4. **Agents never change code by themselves.** Code changes go through `propose_patch` and the user's click. Don't add tools that apply code, run shell commands or reach outside the project.
5. **Validate at boundaries.** Anything crossing a process boundary is checked with zod; types come from `@shrike/schema`.
6. **One test per non-trivial change.** The smallest check that fails if the logic breaks, using `node:test`. UI work gets a Playwright check or a screenshot in the PR.
7. **Visual work follows the design system.** Tokens from `design-system/tokens.ts`, no hard-coded colours, and new elements get an ID in `design-system/README.md`.
8. **Keep docs true.** If your change makes a doc wrong, fix the doc in the same PR. User-facing text follows [docs/06-design.md](docs/06-design.md): plain words, no em dashes.
9. **Agent prompts are tested.** Changing `prompts/agent/` means re-running the agent eval and putting the result in the PR.

## Taking an issue

- **Good first issues aren't assigned.** The first pull request that meets the acceptance criteria gets merged. No need to ask first.
- **Help wanted and add-your-stack issues have one owner at a time.** Comment that you're taking it; it's yours for 7 days. Open a draft pull request in that time so we can agree on the approach, or it opens up again.
- Please keep to two open pull requests at a time.

## Pull requests

- Branch from `main`. Keep your branch up to date by rebasing.
- Commit messages are short and say what changed, in plain words: `Find tools the user's terminal finds`, not `fix: stuff`.
- Fill in the PR template. Link the issue with `Fixes #123`.
- CI must pass on macOS and Linux. Windows runs a smaller set of checks while support is new.
- AI-assisted contributions are welcome. You are responsible for every line, so read and test what your agent wrote, and say in the PR that you used one.

A maintainer reviews every PR. Expect a first reply within 48 hours. If a PR goes quiet for two weeks after review comments, it may be closed; you can always reopen it.

## Maintainer and decisions

Shrike is maintained by [@SumantxD](https://github.com/SumantxD), who has the final say on scope and design. Product and architecture decisions are written down in `docs/` (especially [docs/02-architecture.md](docs/02-architecture.md) and [docs/03-tech-stack.md](docs/03-tech-stack.md)). If you think one is wrong, open a discussion and make the case; don't change it inside an unrelated PR.

Releases follow [docs/RELEASING.md](docs/RELEASING.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Conduct and security

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately as described in [SECURITY.md](SECURITY.md), never in a public issue.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
