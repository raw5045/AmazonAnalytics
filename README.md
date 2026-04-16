# Amazon SFR Analytics

Weekly Amazon Search Frequency Rank (SFR) analytics. Admin uploads CSV reports from Seller Central; users analyze keyword trends.

## Status

Phase 0 (Foundation) — rubric upload and schema approval.

## Architecture

See `docs/superpowers/specs/2026-04-15-amazon-sfr-analytics-design.md`.

## Local development

Prereqs: Node 20+, pnpm, Neon account, Clerk account, Cloudflare R2 bucket.

1. `cp .env.example .env.local` and fill values
2. `pnpm install`
3. `pnpm db:migrate`
4. `pnpm db:seed`
5. Terminal A: `pnpm dev`
6. Terminal B: `pnpm inngest:dev`
7. Sign up at http://localhost:3000/sign-up
8. Promote yourself to admin: `pnpm admin:promote` (requires `INITIAL_ADMIN_EMAIL` in `.env.local`)

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Next.js dev server |
| `pnpm inngest:dev` | Inngest local dev server |
| `pnpm test` | Unit tests |
| `pnpm test:integration` | Integration tests (requires DB) |
| `pnpm typecheck` | TypeScript |
| `pnpm db:generate` | Generate migrations from schema changes |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:seed` | Seed app_settings |
| `pnpm db:studio` | Drizzle Studio |
| `pnpm admin:promote` | Promote INITIAL_ADMIN_EMAIL to admin |

## Deployment

Vercel (auto-deploys on push to `main`). Env vars must be configured in Vercel dashboard. Clerk webhook URL must point at the deployed `/api/webhooks/clerk`.
