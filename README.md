# Turnint / Veritas Academia

An academic document-analysis marketplace connecting students with instructors.
This repository is being built incrementally; see **Project status** below.

## Tech stack

- **Next.js 16** (App Router, Turbopack) + **React 19** + **TypeScript**
- **Tailwind CSS v3** with the "Neon Tokyo" design tokens (`tailwind.config.ts`)
- **Prisma 6** ORM — SQLite for local development, PostgreSQL-ready
- **next-auth v4** (stable) credentials authentication with server-enforced roles
- **bcryptjs** password hashing
- Private local document storage behind an adapter interface

## Getting started

```bash
# 1. Install dependencies
npm install

# 2. Create your local environment file
copy .env.example .env        # (macOS/Linux: cp .env.example .env)

# 3. Generate AUTH_SECRET and put it in .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# 4. Create the local database and apply migrations
npm run db:migrate

# 5. Start the dev server
npm run dev
```

Open http://localhost:3000.

### Local scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run db:migrate` | Create/apply a development migration |
| `npm run db:generate` | Regenerate the Prisma client |
| `npm run db:studio` | Open Prisma Studio |
| `npm run db:reset` | Drop and recreate the local database |
| `npm test` | Run the automated test suite (uses a dedicated `prisma/test.db`) |
| `npm run grant-admin -- --email=you@example.com --confirm` | Promote an existing user to ADMIN |

## Accounts, roles and access

Three roles exist: `STUDENT`, `INSTRUCTOR`, `ADMIN`.

- **Public registration** (`/register` → `POST /api/register`) always creates a
  `STUDENT`. The role is never read from the request body.
- **Instructors** will gain access only through an approved application
  (implemented in a later phase).
- **Administrators** are promoted only by running the local
  `npm run grant-admin` script — never through any web route.

The `/student/*` and `/instructor/*` portals are protected by server-side
layout guards (`src/app/student/layout.tsx`, `src/app/instructor/layout.tsx`).
Administrators may view both portals for support purposes.

### Session & suspension policy

- Sessions are encrypted JWT cookies with a 7-day `maxAge`.
- The JWT carries only `id` + `role` for fast UI decisions.
- **Authoritative** role and suspension state are re-read from the database on
  every protected request (`src/lib/session.ts`), so suspending a user takes
  effect immediately, without waiting for the token to expire.
- Rotating `AUTH_SECRET` invalidates all outstanding sessions at once.

## Environment variables

All variables are documented in `.env.example`. Required for local development:

- `DATABASE_URL` — SQLite file URL, e.g. `file:./dev.db`
- `AUTH_SECRET` — random 32-byte base64 string
- `NEXTAUTH_URL` / `NEXT_PUBLIC_APP_URL` — e.g. `http://localhost:3000`

Placeholders for later phases (Razorpay, S3 storage, analysis providers) are
present but not yet consumed. Analysis providers default to `unconfigured` and
never return fabricated results.

## Project status

Phase 1 (audit), Phase 2 (foundation) and Phase 3A (data model) are complete:

- Database schema + migrations (`prisma/`)
- Authentication with server-enforced roles
- Environment + secret handling
- Private storage interface (local dev adapter)
- Analysis-provider interface (explicitly unconfigured)
- `Document`, `AnalysisJob`, `AnalysisResult` models (metadata only; no file
  bytes in the database and no fabricated analysis results)
- Automated test harness (`npm test`)

Not yet implemented: document-upload endpoints, instructor approval, request
lifecycle, real document analysis, Razorpay payments, report delivery, payouts,
administrator dashboard.
See `docs/data-model.md` for the SQLite → PostgreSQL migration notes.
