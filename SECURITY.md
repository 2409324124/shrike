# Security policy

Shrike runs inside your app and gives a coding agent tools, so security reports get priority.

## Reporting a problem

Please don't open a public issue. Report it privately through [GitHub's private vulnerability reporting](https://github.com/SumantxD/shrike/security/advisories/new), or email st72365@gmail.com with "Shrike security" in the subject.

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a reply within 3 days. Once a fix is released we'll credit you in the advisory, unless you'd rather stay anonymous.

## What counts

Especially welcome:

- A secret (token, password, key, cookie) reaching storage, the screen, an agent or an export without being redacted
- An agent changing code, running a shell command or reaching a non-project host without the user's click
- Another local process reading or driving Shrike's ingest or MCP server without its token
- A recorder (`packages/*-agent`) crashing the user's app or exposing its data
- A malicious project (its `.shrike/` files, scripts or MCP config) taking actions the user didn't approve

How Shrike is meant to behave is described in [docs/07-security-privacy.md](docs/07-security-privacy.md).

## Supported versions

Only the latest release gets security fixes while Shrike is in 0.x.
