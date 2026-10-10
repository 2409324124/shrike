# 10 · Go to market

Everything here is a starting hypothesis. Test it with beta users before committing.

## Category and message

**Category:** ADE, Agentic Debugging Environment. Borrow the category name Orca made familiar to AI builders and own the debugging half of it.

| Use | Line |
|---|---|
| Headline | **Your app, recorded. Your agent, with eyes.** |
| Subhead | Shrike runs your app, records what it actually did, and lets your coding agent find the broken line, fix it, and prove the fix works. |
| For vibe coders | Stop pasting errors into chat. Click the button that's broken and watch Shrike find out why. |
| For developers | Click to code: every request, function, query and log behind a click, in order, on the line that ran. |
| For agent users | Give Claude Code runtime eyes. Shrike's MCP server shows it what your app really did. |
| Trust | Open source. Local-first. Runs your own agent on your own subscription. |

Avoid: "observability", "tracing", "spans", "AI-powered". Vibe coders don't search for those words.

## Competitors and our edge

| Alternative | What it does | Why Shrike |
|---|---|---|
| Pasting errors into Cursor / Claude | Model guesses from code and error text | Shrike's agent sees what actually ran, frontend to database |
| Chrome DevTools (and its MCP server) | Browser-side network and console | Stops at the browser; Shrike follows the request into backend functions and queries |
| Replay.io | Time-travel browser recordings | Browser-centric, aimed at developers; Shrike joins backend execution and is built for non-experts |
| Sentry / Spotlight | Error and trace monitoring, local dev overlay | Developer-oriented; no agent loop, no fix and verify |
| Jam, Multiplayer and similar | Bug reports and full-stack session capture for AI | Cloud-first capture for teams; Shrike is a local, open source environment where the agent acts and verifies |
| Built-in debugging in Lovable / Bolt / Replit | Platform-specific fixes | Shrike works on any local JS app, wherever it was built |

Re-check this table before launch. The space moves monthly.

## Pricing (draft)

| Plan | Price | Includes |
|---|---|---|
| **Open source** | Free | Full desktop app, recordings, timeline, API explorer, MCP server, all BYO agent brains |
| **Pro** | ~$15/month | Hosted key for the built-in agent with a monthly allowance, shareable links, synced settings, priority support |
| **Team** | ~$30/user/month | Shared recordings and comments, team history, SSO later |

The free tier must be genuinely complete for a solo user with their own agent. Paid plans sell convenience and collaboration, not unlocked basics.

## Channels

1. **Open source launch:** GitHub repo with a demo GIF of the killer demo in the README's first screen. Hacker News "Show HN", r/vibecoding, r/ClaudeAI, r/cursor, r/webdev.
2. **Builder communities:** Lovable, Bolt, Cursor and Claude Code Discords; X/Twitter build-in-public threads with short screen recordings ("watch Claude Code fix a bug it can actually see").
3. **MCP directories:** list the Shrike MCP server everywhere MCP servers are listed. It's a wedge for users who never open the desktop app.
4. **Content:** "Why your vibe-coded app breaks" series built from the bug corpus: each post is one bug category, a 30-second recording and the fix.
5. **Integrations:** a one-line "Debug with Shrike" README badge for templates and starter kits.

## Launch checklist

- [ ] Killer demo video (≤ 60s) and GIF
- [ ] README: headline, GIF, install, 3-step quickstart, philosophy, privacy summary
- [ ] Signed builds for macOS, Windows, Linux; auto-update working
- [ ] Sample project button works offline
- [ ] Docs site: quickstart, supported frameworks, agent brains setup, MCP setup, privacy, FAQ
- [ ] Privacy policy reviewed by a lawyer; security page matches [07-security-privacy.md](07-security-privacy.md)
- [ ] Opt-in analytics with an activation funnel: install → project opened → first Action → first agent run → first verified fix
- [ ] Discord or GitHub Discussions for support
- [ ] Trademark and domain check for the final name
