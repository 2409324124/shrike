# apps/cloud

Optional paid layer, not started. Shrike works fully without it.

## Owns

- Accounts (Better Auth: GitHub, Google, email link)
- Billing (Stripe subscriptions)
- Hosted key for the built-in agent, metered per user
- Share links: upload a redacted `.shriketrace`, private link, expiry, revoke
- Web viewer for shared recordings (read-only timeline, code snapshot, replay)

## Planned layout

```
src/
├── index.ts            # Hono app
├── auth.ts
├── billing.ts          # Stripe webhooks, plan checks
├── ai-proxy.ts         # forwards to Anthropic, meters usage
├── shares.ts           # R2 upload, signed URLs, expiry
└── db/schema.ts        # Drizzle: users, plans, usage, shares
viewer/                 # React app reusing desktop timeline components
```

## Never

Receives source code or recordings except through an explicit share. Logs request bodies.

## Done when

Phase 10 of [docs/08-roadmap.md](../../docs/08-roadmap.md) passes.
