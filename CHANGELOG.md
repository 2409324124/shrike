# Changelog

Notable changes to Shrike. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). While Shrike is 0.x, a minor version can change behaviour.

## [Unreleased]

### Added

- **Python function steps** for Python 3.12+ on FastAPI, Flask and Django: every call into your own code with argument and return values and the exact line, nested under the request, plus sqlite3 queries. No code changes needed.
- **Any backend through OpenTelemetry**: .NET, Go, Java and others that already use an OpenTelemetry SDK show their requests, queries, outside calls and errors in the Thread (basic tracing).
- **Use Shrike from your own Claude Code**: a Tools panel section with the `claude mcp add` command, a Shrike skill and a settings snippet that keeps code changes behind your click. The connection survives restarts; approval cards say which agent is asking.
- **Linux and Windows builds**: AppImage and `.deb` for Linux, an NSIS installer for Windows (not yet run on a Windows machine). Voice stays macOS only.
- **Checks before Run**: Shrike says in plain words when Node, a package manager, Python, Docker or git is missing or too old, how to get it, and offers Check again. It never installs anything itself.
- CI on macOS, Linux and Windows.

### Fixed

- Shrike no longer shows a crash dialog for errors in its main process; it logs them and keeps running. A crashed window reloads itself.
- Apps left running by a force-quit Shrike are stopped on the next launch, so their ports are free again.
- A damaged settings or project file is kept aside instead of being wiped, and saves are atomic.
- Clear reasons for a taken port, a dev command that asks a question, a URL on an unexpected port, expired Claude Code sign-in, rate limits, an offline network, GitHub failures and API client network errors. A failed agent run keeps its reason on screen with Try again.
- A run can no longer change files in another workspace after you switch.
- Large trips and output floods are capped, so the app stays responsive.
- Tools installed with nvm, fnm or asdf are found when Shrike is opened from Finder.
- The agent's quick send no longer follows redirects to outside servers.

## [0.1.0] - 2026-10-11

First public release for macOS on Apple Silicon, signed and notarised.

[Unreleased]: https://github.com/SumantxD/shrike/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/SumantxD/shrike/releases/tag/v0.1.0
