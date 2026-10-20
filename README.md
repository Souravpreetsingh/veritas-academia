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

Requires **Node.js 22 or newer** (`unpdf` requires Node 22+).

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
| `npm run analysis:worker` | Process one bounded batch of due analysis jobs; schedule this externally |
| `npm run grant-admin -- --email=you@example.com --confirm` | Promote an existing user to ADMIN |

## Accounts, roles and access

Three roles exist: `STUDENT`, `INSTRUCTOR`, `ADMIN`.

- **Public registration** (`/register` → `POST /api/register`) always creates a
  `STUDENT`. The role is never read from the request body.
- **Instructor onboarding** (`/instructor/register` →
  `POST /api/instructor/register`) creates a `STUDENT` account plus a
  `PENDING` instructor application in one step — no student registration
  required. While pending, the applicant can sign in and is routed to the
  application-status screen (`/instructor/application`), never the student
  dashboard or instructor functionality.
- **Instructors** gain portal access only through an approved application and
  active profile; they must still be assigned to a request.
- Dedicated sign-in screens live at `/student/login` and `/instructor/login`.
  A session in one role never blocks the other portal's form (sign out to
  switch accounts), and post-login destinations are role-validated.
- **Administrators** are promoted only by running the local
  `npm run grant-admin -- --email=you@example.com --confirm` script — never
  through any web route. They sign in through the standard sign-in screens and
  review instructor applications at `/admin`.

The `/student/*` and `/instructor/*` portals are protected by server-side
layout guards (`src/app/student/layout.tsx`, `src/app/instructor/layout.tsx`);
the `/admin/*` dashboard is gated the same way
(`src/app/admin/layout.tsx`) and every admin page re-checks the role.
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

Razorpay variables are consumed by the payment phase. Storage and specialist
analysis provider placeholders are present but no real S3 or specialist
similarity/AI-writing adapter is connected. Local-corpus matching is built in.
LLM-assisted observations are optional and disabled by default: set
`LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL`, and
`LLM_EXTERNAL_PROCESSING_ENABLED=true` server-side, and the student must also
grant consent. Unconfigured capabilities fail closed and never return fabricated
results. See `.env.example` and `docs/analysis.md`.

Production deployment is planned separately: the database recommendation,
Render service topology, private object storage, malware scanning, rate
limiting, and the environment-variable matrix are documented in
`docs/deployment-render.md` (proposal; nothing is provisioned).

Analysis jobs are stored in the database and are not processed by the web
process. Run the operator worker (for example from cron) to process due jobs:

```bash
npm run analysis:worker
```

One invocation processes a bounded batch and exits. No scheduler is deployed by
this repository.

## Project status

Phases 1–2 and 3A–3G are implemented:

- Database schema + additive migrations (`prisma/`)
- Authentication with server-enforced roles
- Environment + secret handling
- Private storage interface (local dev adapter), document upload/quarantine and
  authorized download
- Instructor applications and the approved/active instructor service catalogue
- Administrator dashboard (`/admin`): real database-backed application and
  account counts, a filterable review queue, full application detail, and
  audited approve/reject decisions with mandatory rejection reasons
- Student service requests with the instructor inbox, accept/decline decisions,
  and verified Razorpay payment capture
- Document analysis MVP: deterministic local-corpus similarity, consent-gated
  LLM observations with grounded citations and safe output parsing, separate
  specialist similarity/AI-writing contracts, a database-backed work queue,
  bounded retries, normalized results, and instructor/student report UI
- Content Security Policy: per-request nonce, enforced framing/object/base
  baseline (`next.config.ts`), and a report-only full policy pending browser
  validation; the obsolete prototype screens and the `eval`-based renderer
  were removed (`src/proxy.ts`, `src/lib/security/csp.ts`)
- Automated test harness (`npm test`)

Not yet implemented: real specialist similarity/AI-writing adapters, a deployed
scheduler for the operator worker, a visual diff viewer, refunds/payouts, a
deployed malware scanner (the ClamAV adapter and scan lifecycle are implemented
and fail closed; no clamd service exists yet), and an S3 storage adapter. See
`docs/data-model.md` for SQLite → PostgreSQL notes, `docs/analysis.md` for the
analysis, privacy, and worker model, and `docs/deployment-render.md` for the
Render production plan.
