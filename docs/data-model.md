# Data model

Phase 2 introduces the minimal schema required for authentication and the
future marketplace. Entities: `User`, `StudentProfile`, `InstructorProfile`,
`InstructorApplication`, `InstructorService`, `ServiceRequest`.

## Conventions

- **IDs** — `cuid()` strings, stable and URL-safe.
- **Timestamps** — `createdAt` (`now()`), `updatedAt` (`@updatedAt`).
- **Ownership** — `onDelete: Cascade` for profile rows owned by a `User`;
  `onDelete: Restrict` for `ServiceRequest` references so orders can never be
  orphaned by deleting an instructor or service.
- **Indexes** — on foreign keys and on frequently filtered columns
  (`role`, `suspended`, `status`, `isApproved`/`isActive`).

## SQLite ↔ PostgreSQL differences

The development database is SQLite, but the schema deliberately avoids
SQLite-only behaviour so production can move to PostgreSQL with minimal change.

| Concern | Phase 2 approach | On PostgreSQL |
| --- | --- | --- |
| Enums | Prisma `enum` is unsupported on SQLite, so roles/statuses are `String` columns constrained by the unions in `src/lib/domain.ts`. | Convert columns to native enums. |
| Money | `Decimal` is unsupported on SQLite, so amounts are stored as integer minor units (`amountMinor`) plus a `currency` code. | Keep integers (recommended) or switch to `Decimal(12, 2)`. |
| Lists/JSON | `expertise`, `qualifications`, `proposedServices` are JSON-encoded `String` columns. | Convert to `Json`/`jsonb` for querying. |
| Case sensitivity | SQLite `LIKE` is case-insensitive by default; Postgres is not. | Use explicit `mode: "insensitive"` in queries. |
| Concurrency | SQLite serialises writes. | Use transactions / row locks for race-prone transitions. |

## Migrating to PostgreSQL later

1. Change the `datasource` provider to `postgresql` in `prisma/schema.prisma`.
2. Point `DATABASE_URL` at the Postgres instance.
3. Replace the `String` role/status columns with enums and the JSON-encoded
   string columns with `Json`/`jsonb`.
4. Run `npx prisma migrate dev` against a clean database to generate the
   Postgres migration.

## Deliberately deferred

Payments, refunds, earnings, payouts, notifications, messages, reviews,
disputes and audit events will be added in the migration for the phase that
implements them — never pre-seeded with fabricated data.

## Phase 3A — documents and analysis boundary

Added `Document`, `AnalysisJob`, and `AnalysisResult`.

- **`Document`** stores *metadata only*: `storageDriver`, `storageKey`
  (unique, server-generated), `originalName`, `contentType`, `sizeBytes`, an
  optional `checksumSha256`, and a `status`. File bytes live in private storage
  (`src/lib/storage`), never in the database. Ownership is `ownerId → User`
  (`onDelete: Cascade`); an optional `requestId → ServiceRequest`
  (`onDelete: SetNull`) detaches rather than destroys records.
- **`AnalysisJob`** references a document (`Cascade`) and the requesting user.
  `type` is `SIMILARITY` or `AI_WRITING`; `status` defaults to `UNCONFIGURED`;
  `provider` defaults to `"unconfigured"`. Provider metadata is JSON-encoded.
- **`AnalysisResult`** is one-per-job (`jobId @unique`). `similarityPercent`
  and `aiLikelihood` are **nullable by design** — `null` means "not produced",
  never a fabricated `0`. `matches` and `providerPayload` stay `null` until a
  real, authorised provider runs.

Provider state remains explicitly unconfigured; the platform cannot mark a job
`COMPLETED` without an actual analysis (enforced by
`canTransitionAnalysisStatus` in `src/lib/domain.ts`).

Migrations are additive — no existing rows are modified or destroyed.
