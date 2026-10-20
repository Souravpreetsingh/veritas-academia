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
3. Optionally replace the `String` role/status columns with enums and the
   JSON-encoded string columns with `Json`/`jsonb`.
4. Generate the PostgreSQL migration history and apply it with
   `npx prisma migrate deploy`.

> **Update (October 2026):** changing the provider is not sufficient on its
> own. The migration history in `prisma/migrations` is SQLite-dialect SQL
> (`DATETIME`, `TEXT` keys, `provider = "sqlite"` in `migration_lock.toml`) and
> can never be applied to PostgreSQL. The approved procedure is to generate a
> single PostgreSQL baseline migration against a clean database, verify
> `prisma migrate deploy` on a scratch database, and then use that history
> everywhere — including local development. Step 3 is optional modernization,
> not a requirement. `prisma db push` must never be used against production.
> Full procedure, connection-pooling guidance, and the durability matrix are in
> `docs/deployment-render.md` §4.

## Deliberately deferred

Refunds, earnings, payouts, notifications, messages, reviews and disputes will
be added in the migration for the phase that implements them — never pre-seeded
with fabricated data. Payment records exist since Phase 3E, but money movement
beyond the verified charge (refunds, transfers) is out of scope.

## Phase 3A — documents and analysis boundary

Added `Document`, `AnalysisJob`, and `AnalysisResult`.

- **`Document`** stores *metadata only*: `storageDriver`, `storageKey`
  (unique, server-generated), `originalName`, `contentType`, `sizeBytes`, a
  SHA-256 `checksumSha256`, and a `status`. The upload route records the checksum
  from the stored bytes; analysis refuses a document without one. File bytes
  live in private storage (`src/lib/storage`), never in the database. Ownership
  is `ownerId → User` (`onDelete: Cascade`); an optional `requestId →
  ServiceRequest` (`onDelete: SetNull`) detaches rather than destroys records.
- **`AnalysisJob`** references a document (`Cascade`) and the requesting user.
  It initially supported `SIMILARITY`/`AI_WRITING`; Phase 3F–3G adds
  `LOCAL_SIMILARITY` and `LLM_REVIEW`. `status` defaults to `UNCONFIGURED`;
  `provider` defaults to `"unconfigured"`. Provider metadata is JSON-encoded.
- **`AnalysisResult`** is one-per-job (`jobId @unique`). `similarityPercent`
  and `aiLikelihood` are **nullable by design** — `null` means "not produced",
  never a fabricated `0`. `matches` and `providerPayload` stay `null` until a
  real, authorised provider runs.

Provider state remains explicitly unconfigured; the platform cannot mark a job
`COMPLETED` without an actual analysis (enforced by
`canTransitionAnalysisStatus` in `src/lib/domain.ts`).

Migrations are additive — no existing rows are modified or destroyed.

## Phase 3B — secure document handling

Added `AuditEvent` and the upload/download machinery around the existing
`Document` model. See `docs/security.md` for the full control list.

- **`AuditEvent`** records security-relevant actions (`document.upload`,
  `document.download`, and their denied/blocked/failed variants). `actorId →
  User` uses `onDelete: SetNull` so history survives account deletion; the
  actor id is nulled, never the event. `metadata` is a JSON-encoded `String`
  holding **non-sensitive** context only (content type, size, reason) — never
  document bytes, credentials or tokens. Indexed by actor, action, target and
  timestamp.
- **Document status** flows `QUARANTINED → AVAILABLE` only via a CLEAN malware
  scan. With the scanner unconfigured, uploads are stored but remain
  `QUARANTINED` and are **never** downloadable (`isDocumentDownloadable`).
- **Uploads** (`POST /api/documents`) validate size (≤ 25 MB), extension,
  declared MIME type and magic-byte signature before persisting metadata; a
  database failure rolls back the stored object. **Downloads**
  (`GET /api/documents/[id]/download`) enforce ownership, block quarantined
  files, stream from private storage and set an attachment disposition with
  `X-Content-Type-Options: nosniff`.

Storage bytes never enter the database, and no public URL is ever issued for a
document.

## Phase 3C — instructor applications & approval

Adds the reviewer decision to `InstructorApplication` and links approval to a
real `InstructorProfile`. The applicant identity is always the authenticated
user; it is never taken from client input.

- **Application statuses** changed to `PENDING | APPROVED | REJECTED |
  WITHDRAWN`. `APPROVED`, `REJECTED` and `WITHDRAWN` are **terminal**; only a
  `PENDING` row may be decided or withdrawn (`canTransitionApplicationStatus`).
- **`InstructorApplication.reviewedBy` → `User` (`onDelete: SetNull`)** records
  the acting administrator, so the row survives reviewer deletion. `reviewedAt`,
  `rejectionReason` and `reviewNotes` capture the decision; a rejection reason is
  mandatory.
- **`InstructorApplication.instructorProfile → InstructorProfile`
  (`instructorProfileId @unique`, `onDelete: SetNull`)** is the reliable
  applicant→profile link created on approval.
- **`activeKey` (`@unique`, nullable)** is the duplicate guard: it equals the
  applicant id *only while `PENDING`* and is nulled on every terminal
  transition. Because SQLite/PostgreSQL treat NULLs as distinct, this permits at
  most one open application per user while still allowing a fresh reapplication
  after `REJECTED`/`WITHDRAWN`. It is a database-level backstop; the
  `canReapply` service check is the first line of defence.
- **Approval** (in one transaction) is compare-and-set on `status = PENDING`:
  it upserts an approved+active `InstructorProfile`, sets `User.role =
  INSTRUCTOR`, and stamps `instructorProfileId`. Approval **never** grants
  `ADMIN`.
- **Instructor-path onboarding** (`POST /api/instructor/register`) creates the
  same rows as the student-applicant flow in one transaction — `User` (role
  `STUDENT`), `StudentProfile`, and a `PENDING` `InstructorApplication` with
  `activeKey = userId` — so the duplicate guard and the approval flow are
  unchanged. The role is never read from the request body.
- `InstructorService` (`code`, `name`, `amountMinor`, `currency`,
  `turnaroundHours`) is only writable by an eligible (approved, active,
  unsuspended instructor) account via `publishInstructorService`; uniqueness is
  `(instructorId, code)`.

All migrations remain additive; no existing rows are modified or destroyed.

## Phase 3D — instructor request inbox & decisions

Adds the instructor decision to `ServiceRequest` and the accept/decline
workflow around it.

- **`ServiceRequest.decisionAt` (`DateTime?`)** is stamped when the assigned
  instructor accepts or declines a request.
- **`ServiceRequest.declineReason` (`String?`)** holds the optional,
  student-visible decline reason; it is only ever set on `DECLINED`. No
  internal reviewer notes are stored on the request.
- **Transitions** (`canTransitionRequestStatus`):
  `AWAITING_PAYMENT → PAID → ACCEPTED | DECLINED`. Payment is verified before a
  decision: `AWAITING_PAYMENT` requests cannot be accepted or declined. `PAID`
  was previously reachable but not used for decisions; since Phase 3E it is the
  required pre-decision state. `ACCEPTED` and `DECLINED` remain terminal in
  this phase; fulfilment transitions are still owned by the phases that
  implement them.
- **Decisions** are compare-and-set on the status the caller was authorized
  against, so simultaneous accept/decline attempts cannot both succeed. A
  decision never modifies `amountMinor`, `currency`, `studentId` or
  `instructorId`.
- The migration is additive: two new nullable columns; no existing row is
  modified or destroyed.

## Phase 3E — Razorpay payments

Adds `Payment` and `PaymentWebhookEvent`. Amounts are integer minor units plus
an ISO currency code, copied from the request snapshot when the order is
created. See `docs/payments.md` for the full workflow.

- **`Payment`** links a `ServiceRequest` and the paying `User` (both
  `onDelete: Restrict` — financial history can never be orphaned). It stores
  the provider (`RAZORPAY`), `providerOrderId` (`@unique`),
  `providerPaymentId` (`@unique`, nullable until captured), `amountMinor`,
  `currency`, `status` (`CREATED | FAILED | PAID`), `paidAt`, and the latest
  safe `failureCode`/`failureAt`. No card data, bank data or raw provider
  payloads are stored.
- **`activeKey` (`@unique`, nullable)** is the single-active-order guard: it
  equals the `requestId` while the payment is not yet `PAID`, and is nulled
  atomically when verified payment succeeds. NULLs are distinct, so a paid
  request may retain historical rows while never allowing a second active
  order.
- **Uniqueness backstops**: `providerOrderId` and `providerPaymentId` are
  unique, so one provider order (or captured payment) can never be attached to
  two local payments/requests. A database constraint (`P2002`) is the final
  arbiter under concurrency.
- **`PaymentWebhookEvent`** records every signature-verified delivery once:
  `eventId` (`@unique`; the provider's event id, or `sha256(rawBody)` when the
  header is absent), `eventType`, provider ids, outcome (`APPLIED | NOOP |
  IGNORED | MISMATCH | FAILURE_RECORDED`) and the matched payment
  (`onDelete: SetNull`). The event row is written in the same transaction as
  the state change it describes.
- **Status transitions** are one-way: `CREATED → FAILED → PAID`, where `PAID`
  is terminal. Failure markers never overwrite success. The single writer is
  `applyVerifiedPaymentTx` in `src/lib/payments.ts`; it compares the provider
  amount/currency with the stored snapshot and compare-and-sets the payment and
  request (`AWAITING_PAYMENT → PAID`) in one transaction.
- Migrations are additive: two new tables and their indexes only.

## Phase 3F–3G — analysis engine and LLM-assisted MVP

Refines the existing `AnalysisJob`/`AnalysisResult` boundary into a durable
execution lifecycle, then adds deterministic local-corpus matching and
consent-gated LLM observations. Specialist providers remain unconfigured. See
`docs/analysis.md` for the full capability, privacy, and operator model.

- **`AnalysisJob.requestId → ServiceRequest` (`SetNull`)** snapshots the request
  the document was authorised under. It is an audit association; execution
  always re-reads and re-verifies the live document/request link.
- **Job types**: `LOCAL_SIMILARITY`, `LLM_REVIEW`, `SIMILARITY`, `AI_WRITING`.
  One result per job. Local and LLM jobs run inline in one worker step;
  specialist jobs retain submit/poll.
- **Statuses** are `UNCONFIGURED | PENDING | QUEUED | PROCESSING | RETRYABLE |
  COMPLETED | FAILED`. `COMPLETED` is reachable only from a validated result;
  `COMPLETED` and `FAILED` are terminal. Transient failures use `RETRYABLE` and a
  bounded retry budget rather than re-opening a terminal row.
- **`AnalysisJob.activeKey` (`@unique`, nullable)** is `documentId:type` while a
  job is active and `NULL` on `COMPLETED`/`FAILED`. This is the database backstop
  that prevents duplicate active work; repeat initiation returns the existing
  job. Completed work is also returned instead of creating a second job.
- **Provider tracking**: `providerJobId`, `providerStatus`,
  `providerVersion`, and safe, allow-listed `providerMeta` JSON. No raw provider
  payloads, full document text, credentials or storage keys are stored.
- **Attempts and safe errors**: `attempts` counts actual analysis attempts (for
  the LLM, incremented immediately before the external call); `failureCount`
  counts transient failures (including polls). `errorCategory` (an allow-listed
  union), `errorCode` (safe machine code) and `errorMessage` (fixed user-safe
  message) replace raw provider error text. `submittedAt`, `startedAt`,
  `lastAttemptAt`, `nextAttemptAt`, `completedAt`, and `failedAt` make retries
  and lease recovery possible without an in-memory queue.
- **`AnalysisResult`** stores:
  - `segments` for specialist AI offsets/likelihoods;
  - `observations` for LLM-generated overview, quality notes, grounded citation
    review, real-match explanations, instructor questions, summary, and
    limitations;
  - `providerVersion` and safe `metadata` (provider/model versions, threshold,
    corpus/algorithm/token counts, extraction version/page count, token usage,
    disclaimers).

  Local jobs write only `similarityPercent` + `matches`; LLM jobs write only
  `observations`; specialist similarity/AI jobs write only their own columns.
  Missing scores remain `null`, never `0`. Stored matches/observations may
  include bounded excerpts (400 chars for matches, up to 1,000 for located
  citation quotes) but never full document text. `providerPayload` remains for
  schema compatibility but is never populated.
- **Consent fields**: `ServiceRequest.llmProcessingConsentAt` and
  `llmProcessingConsentVersion` record the owning student's explicit,
  revocable consent for external LLM processing. Only consent matching the
  current notice version counts, and consent is required in addition to
  `LLM_EXTERNAL_PROCESSING_ENABLED=true`.
- **Constraints/invariants**: `activeKey @unique` (one active job per
  document+type), `AnalysisResult.jobId @unique` (one result per job), and
  compare-and-set status updates. Completion and result insertion occur in one
  transaction; a concurrent result insert is reconciled without overwriting the
  existing evidence. An index on `(status, nextAttemptAt)` supports the
  DB-backed worker query.
- **Migration** `20261018180400_llm_analysis_mvp`: additive `observations` and
  consent columns only. The prior analysis foundation migration likewise copied
  existing rows intact during Prisma's SQLite table rebuild.

Worker scheduling is **not** deployed. The database is the queue;
`npm run analysis:worker` performs one bounded batch and must be scheduled by an
operator. Report UI is implemented for the instructor and consent UI for the
student; specialist adapters and provider webhooks remain future work.

## Phase 2 (security) — rate-limit counters

`RateLimitBucket` backs the fixed-window rate limiter described in
`docs/security.md` and `docs/deployment-render.md` §8.

- **One row per `(scope, keyHash, windowStart)`** with an atomic `count`
  (`INSERT ... ON CONFLICT DO UPDATE SET count = count + 1`), so concurrent
  requests cannot race past a limit. `scope` names the protected endpoint
  dimension (e.g. `login.source`, `upload.user`), and `windowStart` is the
  fixed window boundary the attempt belongs to.
- **`keyHash` is an HMAC-SHA256 digest** of a privacy-conscious identifier
  (trusted client IP, normalized email hash, or user id). Raw IPs, emails,
  user ids, passwords, sessions and tokens never enter this table.
- **Expiry is implicit**: rows are inert once their window has passed and are
  deleted opportunistically after 24 h (`cleanupExpiredBuckets` in
  `src/lib/rate-limit.ts`). There is no in-memory variant; a store failure makes
  protected endpoints fail closed with `503`.
- **Migration** `20261019182220_add_rate_limit_buckets`: additive — creates the
  `rate_limit_buckets` table and its two indexes only. On PostgreSQL the same
  table becomes multi-instance-safe; on SQLite it is shared across processes on
  one host, not across hosts.

## Launch hardening — document scan state

Adds the persisted malware-scan state to `Document` so a `CLEAN` result is
bound to the exact stored file version and can be audited. Migration
`20261019194149_add_document_scan_state` adds columns only; for SQLite, Prisma
rebuilds the table and copies every existing column value unchanged.

- **`scanStatus` (`String @default("UNSCANNED")`, indexed)** is one of
  `UNSCANNED | SCANNING | CLEAN | INFECTED | ERROR` (`DOCUMENT_SCAN_STATUSES` in
  `src/lib/domain.ts`). `SCANNING` is a conditional claim (10-minute lease) so
  duplicate/concurrent scans cannot both run; `CLEAN` is required before release;
  `INFECTED` is terminal for that file version and never auto-retried.
- **`status` remains the release flag.** A document is served/analysable only
  when `status = "AVAILABLE"` **and** `scanStatus = "CLEAN"`
  (`isDocumentDownloadable`, `canInitiateAnalysis`). The DB default for
  `status` is still `AVAILABLE`, so rows created before this phase (or by tools
  that do not set scan state) are **not** accessible: the missing `CLEAN` scan
  fails closed.
- **`scanEngine`, `scanReason`, `scanSignature`** are bounded diagnostics:
  engine id, typed failure code (e.g. `not_configured`, `timeout`,
  `malformed_response`, `integrity_mismatch`, `release_conflict`), and the
  scanner signature name for infections. They never contain document content or
  raw scanner output.
- **`scanAttempts`, `scanStartedAt`, `scannedAt`** support retry accounting and
  stale-claim reclaim. Release is a second conditional update on document id,
  `storageKey`, `checksumSha256`, `sizeBytes` and scan state, and storage is
  re-read immediately before release (`src/lib/document-scan.ts`).
