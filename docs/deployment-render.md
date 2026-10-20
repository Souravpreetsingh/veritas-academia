# Deploying Veritas Academia on Render

**Status: production proposal — no production resource has been provisioned.**
No production Render service, database, bucket, scanner, or scheduler has been
created; no production service has been modified. A separate **demo-only**
Blueprint (`render.yaml` at the repository root) is intentionally not the
production topology described here. Every platform statement below was verified
against Render's documentation and pricing in **October 2026** (links in
[Sources](#sources)).

> **Demo-only Blueprint:** `render.yaml` uses one Render web service with a
> persistent disk, SQLite, and local document storage. It exists so the app can
> be shown on Render; it does **not** satisfy the P0 blockers in section 13 and
> must not hold real student data or payments. Production must follow the
> Postgres + object-storage + clamd + worker topology below. The disk-backed
> service is paid, single-instance, briefly unavailable during deploys, leaves
> every upload quarantined, and does not run analysis jobs.

Where the document says **requires approval**, implementation must wait for an
explicit decision.

## 0. Scope

This plan covers:

1. managed PostgreSQL selection and a migration-readiness assessment,
2. a Render service topology (web + worker + database + object storage),
3. a private object-storage design for the existing `StorageAdapter`,
4. a malware-scanning integration contract,
5. a multi-instance-safe rate-limiting plan and trusted-proxy handling,
6. an environment-variable matrix,
7. release, rollback, health, and backup procedures.

It does **not** cover application features (refunds, admin tools, specialist
provider adapters) or anything that changes live infrastructure.

## 1. What the application requires

| Area | Current state |
| --- | --- |
| Framework | Next.js 16.4 (App Router), Node.js **22 or newer**, `next start` |
| Database | Prisma 6.19, **SQLite** provider for local dev; portable schema (12 models) but SQLite-dialect migration history |
| Sessions | next-auth v4 credentials, **JWT cookies** (no database session table) |
| Documents | Private `StorageAdapter`; only `local` implemented; uploads ≤ 25 MB; SHA-256 checksum; quarantine until a real CLEAN scan |
| Analysis | Database-backed job queue (`AnalysisJob`), one-pass worker script (`npm run analysis:worker`), no scheduler deployed |
| Payments | Razorpay orders/verification + signed webhook (raw body, event-id idempotency) |
| External calls | Optional LLM provider (consent-gated, disabled by default), future specialist providers |
| Security | Bounded request bodies, security headers, fail-closed scanner, role re-read from DB, owner-only audits |

Hard production requirements: a persistent SQL database, durable private object
storage, a scheduler for the analysis worker, and (before public exposure) rate
limiting on credential endpoints.

## 2. Render facts this plan relies on (verified October 2026)

| Fact | Detail |
| --- | --- |
| Regions | Oregon, Ohio, Virginia, Frankfurt, Singapore. Services in the same region share a private network. |
| Web service port | Must bind `0.0.0.0:$PORT`; default `PORT=10000`. |
| Deploy sequence | Build command → optional pre-deploy command (migrations; 30-min timeout; separate instance) → start command (15-min timeout). |
| Pre-deploy availability | Paid web services, private services, background workers only. |
| Ephemeral filesystem | All services lose local files on deploy/restart; cron jobs cannot attach disks. |
| Zero-downtime deploys | SIGTERM to the old instance after cutover; SIGKILL after the shutdown delay (default 30 s, configurable to 300 s). |
| Health checks | Optional HTTP path per web service; any 2xx/3xx within 5 s = healthy. New deploy cancelled if not all instances healthy within 15 min; running instance restarted after 60 s of failed checks. |
| Cron jobs | **Single-run guarantee**: at most one active run per cron job; overlapping scheduled runs are delayed. Runs capped at 12 h. Billed per second, **$1/month minimum**. |
| Background workers | Continuous processes with no inbound HTTP; must not exit. |
| Postgres connection limits | By RAM: < 8 GB → 100 connections; 8–16 GB → 200; 16–32 GB → 400; ≥ 32 GB → 500. |
| Postgres pooling | Integrated PgBouncer (transaction mode, port 6432), free, **paid plans only**; direct connections (5432) reserved for migrations/session-state clients. |
| Postgres backups | PITR: Hobby workspace 3 days, Pro 7 days. Logical exports retained 7 days. **No backups on Free.** |
| Postgres security | AES-256 at rest (incl. backups); external connections require TLS; internal TLS optional (`sslmode=require`, not `verify-ca/full`). External access can be IP-restricted or disabled. |
| Postgres Free plan | 1 GB, **expires 30 days after creation**, no backups, no pooling — development only. |
| Free web services | Spin down after 15 min idle; restarts possible; no scaling — not for production. |
| Node default | New services default to Node 24.21; pin with `NODE_VERSION`. `NODE_ENV=production` is set **at runtime only**. |
| Plan changes | Postgres plan changes cause minutes of downtime (seconds with HA); storage can only grow. |

### Pricing used in this document (compute, monthly)

| Item | Plan | Price |
| --- | --- | --- |
| Web service | `0.5c-512mb` / `1c-2g` | $7 / $25 |
| Cron job | `0.5c-512mb` | $0.00016/min while running, **$1 min/month** |
| Background worker | `0.5c-512mb` / `1c-2g` | $7 / $25 |
| Postgres | `0.1c-256mb` / `0.5c-1g` / `1c-2g` | $6 / $19 / $40 |
| Postgres storage | beyond 1 GB included | $0.30/GB-month |
| Workspace | Hobby / Pro | $0 / $25 (Pro adds 7-day PITR, HTTP request logs, 25 GB bandwidth) |
| Bandwidth | Hobby 5 GB / Pro 25 GB included | $0.15/GB after |

Document note: **downloads are streamed through the web service, so file
downloads count against Render outbound bandwidth.** Budget for it.

## 3. Production database: comparison and recommendation

### Options compared

| Criterion | **Render Postgres** | Neon (Launch) | Supabase (Pro) |
| --- | --- | --- | --- |
| Billing | Fixed per plan | Pay-as-you-go (CU-hours + storage) | $25/mo + compute add-ons |
| Small production cost | $6–19/mo | ≈ $19+/mo for 0.25 CU always-on + $0.35/GB | $25/mo (Micro, 1 GB RAM) |
| Free tier | 30-day expiry — dev only | Permanent (100 CU-h/mo) | 500 MB, pauses after 1 week |
| Scale to zero | No | Yes (disable on Launch) | No on paid |
| PITR | 3 days Hobby / 7 days Pro | 6 h free / up to 7 days Launch ($0.20/GB-mo) | Daily 7 days included; PITR +$100/mo |
| Connection limits | 100 at small sizes | Pooler included | 60 direct / 200 pooled (Micro) |
| Pooling | PgBouncer (transaction, 6432) | Built-in | Supavisor |
| Network path from Render | **Private network, same region** | Public TLS (private networking on Scale only) | Public TLS |
| Prisma | First-class (`directUrl` pattern) | First-class | First-class |
| Ops complexity | One vendor, one bill | Second vendor; branching is excellent | Second vendor; auth/storage we don't need |

### Recommendation

**Use Render Postgres in the same region and account as the web and worker
services.** Default plan `0.5c-1g` ($19/mo); `0.1c-256mb` ($6/mo) is acceptable
for a staging/soft-launch phase, and `1c-2g` ($40/mo) is the next step if
memory or connection pressure appears.

Why:

- **Private network** — the database is reachable over Render's internal
  network with no public-internet hop; this is the lowest-latency, smallest
  attack-surface option.
- **One vendor** — backups, PITR, and billing live beside the services; no
  cross-provider troubleshooting.
- **Connection budget** — the app needs a handful of connections (single web
  instance + cron), far below the 100-connection floor.
- **Prisma fit** — `prisma migrate deploy` works over the direct URL; the
  pooler is optional and only becomes relevant when scaling instances.

Trade-offs accepted:

- Hobby workspace PITR window is 3 days; upgrading the workspace to Pro ($25)
  extends it to 7 days and adds HTTP request logs. **Recommended once real
  payments and student documents are live.**
- Postgres plan changes cause brief downtime; size conservatively at creation.
- Storage growth is irreversible (can only increase).

**Neon** is the best alternative if predictable pay-per-use and instant
database branching for preview environments become priorities; the cost is a
second vendor and public-network database traffic. **Supabase** is not a fit:
its auth/storage features duplicate what the app already implements, and PITR
is a $100/month add-on.

Cost picture (monthly, production default):

| Configuration | Estimate |
| --- | --- |
| Minimal soft launch: web `0.5c-512mb`, cron, PG `0.1c-256mb`, R2 free tier, Hobby workspace | ≈ $14–20 |
| Recommended: web `1c-2g`, cron, PG `0.5c-1g`, R2, Pro workspace | ≈ $70–76 |
| + ClamAV private service `2c-4g` + 10 GB disk (if chosen) | + ≈ $87 |
| + Render Key Value `256mb` for rate limiting (if chosen) | + $10 |

## 4. Migration-readiness assessment (SQLite → PostgreSQL)

### What is portable (audited)

- **No SQLite-only behavior** is relied upon: no raw SQL, no
  `mode: "insensitive"`, no `Decimal`, no Prisma `enum`, no `Json` columns.
- Role/status columns are `String`; money is integer minor units + currency;
  lists are JSON-encoded strings — all valid on PostgreSQL.
- `cuid()` IDs, `@updatedAt`, `onDelete` rules, and the nullable-`activeKey`
  uniqueness trick (NULLs distinct) behave identically on PostgreSQL.
- Server-side queries avoid `LIKE` searches today, so no case-sensitivity
  regressions exist yet. Any future text search must use
  `mode: "insensitive"` on PostgreSQL.

### What is not portable

- `prisma/schema.prisma` declares `provider = "sqlite"`.
- `prisma/migrations/migration_lock.toml` declares `provider = "sqlite"`.
- All 9 migrations (init → `add_rate_limit_buckets`) are **SQLite-dialect SQL**
  (`DATETIME`, `TEXT` primary keys, SQLite defaults). They can never be
  applied to PostgreSQL.

**Changing `DATABASE_URL` alone is therefore not sufficient.**

### Required schema changes

| Change | Required? | Notes |
| --- | --- | --- |
| `provider = "postgresql"` | Yes | One-line datasource change. |
| New PostgreSQL baseline migration | Yes | See procedure below. |
| `directUrl = env("DIRECT_URL")` | Only if PgBouncer is enabled | Migrations use the direct URL; the app keeps using the pooled URL. Not needed for the recommended direct-connection setup. |
| Native enums / `Json` columns | No | Optional modernization; converting later is an additive migration. Avoid mixing into the cutover. |

### Baseline procedure (requires approval)

There is **no production data** and the local SQLite database is disposable, so
the cleanest path is a single PostgreSQL baseline:

1. Approve the provider, region, plan, and the end of SQLite support.
2. Switch `prisma/schema.prisma` to `provider = "postgresql"` and point
   `DATABASE_URL` at a scratch PostgreSQL database.
3. Archive the SQLite migration folder (keep the files for reference), then
   generate one baseline migration for PostgreSQL, e.g.:
   `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`
   saved as `prisma/migrations/<timestamp>_init/migration.sql` (or generated by
   `prisma migrate dev` against the scratch database).
4. Verify on the scratch database: `npx prisma migrate deploy` then
   `npx prisma migrate status` — must be clean.
5. Move local development to PostgreSQL as well (Docker or a dev database).
   Maintaining two providers requires two schema files and is not recommended.
6. First production deploy runs the pre-deploy command
   `npx prisma migrate deploy`.

**`prisma db push` is not the production migration strategy** and must not be
used against any environment that matters. `npm run db:reset` remains a
local-only convenience.

### Connection configuration

- **Default recommendation: direct connection** (internal URL, port 5432).
  No pooler, no `pgbouncer=true`, no `directUrl`. The app's concurrency is one
  web instance + one cron run, far below the 100-connection limit.
- Set an explicit Prisma pool per service to make exhaustion impossible to
  misdiagnose: append `?connection_limit=5` to `DATABASE_URL` for both web and
  worker (adjust to `cpu*2+1` if instance sizes change).
- **Scale path (requires approval when needed):** enable Render connection
  pooling, set `DATABASE_URL` to the pool URL (port 6432) with
  `?pgbouncer=true&connection_limit=5`, add `DIRECT_URL` (direct internal URL)
  and `directUrl` in the datasource. Pre-deploy migrations then run through
  the direct URL automatically.
- Keep `sslmode=require` in the internal URL; external/admin connections are
  TLS-enforced by Render.

### Migration execution during release

- Pre-deploy command on the **web service**: `npx prisma migrate deploy`.
  It runs once per deploy, before the new instance receives traffic, on a
  separate instance — exactly the "run migrations at release" pattern.
- The cron worker does not run migrations.
- Only additive migrations are allowed (existing policy): a code rollback
  never requires a schema rollback.

### Data durability matrix

| Data | Storage | Durability story |
| --- | --- | --- |
| Accounts, profiles, sessions (JWT) | PostgreSQL / client cookie | PITR + logical export; rotating `AUTH_SECRET` invalidates sessions |
| Payments + webhook events | PostgreSQL | PITR is the recovery path; event-id uniqueness prevents re-application |
| Audit events | PostgreSQL | Restored with PITR |
| Analysis jobs/results | PostgreSQL | DB is the queue; leases make crash recovery safe |
| Document bytes | Object storage | Versioning + checksum recorded in DB; back up bucket policy with the plan |
| Document metadata/checksums | PostgreSQL | Must be restored together with the bucket |

### Data migration

None needed: there is no production database yet. Local `dev.db` files stay
local and are not imported. If a pilot deployment accumulates data before the
final cutover, use `pg_dump`/`pg_restore` (documented in §11), never `db push`.

## 5. Render service topology

```
                    Internet
                       │  HTTPS (Render-managed TLS)
                       ▼
        ┌───────────────────────────────┐
        │  Web service (Next.js)        │
        │  auth · API · UI · uploads    │
        │  health: /api/health          │
        └───────┬───────────────┬───────┘
                │ private net   │ HTTPS (S3 API)
                ▼               ▼
     ┌──────────────────┐  ┌──────────────────────┐
     │ Render Postgres  │  │ Private object store │
     │ (same region)    │  │ (R2 / S3 / B2)       │
     └───────▲──────────┘  └──────────▲───────────┘
             │ private net             │
     ┌───────┴─────────────────────────┴───────┐
     │  Cron job: npm run analysis:worker      │
     │  (single-run guarantee, every minute)   │
     └───────────────────┬─────────────────────┘
                         │ private net (when approved)
                         ▼
              ┌────────────────────────┐
              │ ClamAV private service │
              │ (optional, approval)   │
              └────────────────────────┘
```

### Web service

| Setting | Value |
| --- | --- |
| Build command | `npm ci && npx prisma generate && npm run build` |
| Pre-deploy command | `npx prisma migrate deploy` |
| Start command | `npm run start` (Next.js binds `0.0.0.0:$PORT`) |
| Health check path | `/api/health` (implemented in this phase) |
| Compute | `0.5c-512mb` ($7) to start; `1c-2g` ($25) if CPU/memory metrics say so |
| Node | pin `NODE_VERSION=22` for parity with development |
| Auto-deploy | On commit (or After CI checks pass) |
| Shutdown delay | default 30 s is fine; raise to 60 s only if uploads are being cut mid-deploy |

`NODE_ENV=production` is set by Render at runtime only, so the build installs
devDependencies (TypeScript/Tailwind/Prisma CLI) as required. Do **not** set
`NODE_ENV` manually at build time or `next build` will lose its toolchain.

Do **not** attach a persistent disk for production: it disables zero-downtime
deploys and cannot be shared with the worker. Documents go to object storage
instead. The checked-in `render.yaml` is a deliberate demo-only exception (see
the note at the top); it is not the production configuration.

### Worker: Render Cron Job (recommended as-is)

The existing script runs **one bounded batch and exits** — a perfect match for a
Render cron job, and it needs **no code change**:

| Setting | Value |
| --- | --- |
| Build command | `npm ci && npx prisma generate` (skip `next build` to save pipeline minutes) |
| Command | `npm run analysis:worker` |
| Schedule | `*/1 * * * *` (every minute) — or `*/2` if runs regularly exceed a minute |
| Compute | `0.5c-512mb`; raise if PDF extraction is consistently CPU-bound |
| Env | worker column of the matrix (§9) |

Why cron instead of a background worker:

- Render **guarantees one active run per cron job**; overlapping scheduled runs
  are delayed, so there is no risk of unintentionally running multiple workers.
- The current process is a batch job, not a polling daemon.
- Even if runs ever overlap (manual triggers), the queue is safe: claims are
  compare-and-set, leases expire after 5 minutes, and retries are bounded.

Cost: prorated per second with a $1/month minimum — roughly $1–7/month for
typical batch runtimes.

**Alternative (requires a code change and approval):** a Render Background
Worker needs a process that never exits. That means adding an opt-in poll loop
(e.g. `ANALYSIS_WORKER_POLL_MS`), SIGTERM handling that finishes the current
job, and a small test. Not required for the recommended design.

### Job lifecycle guarantees (already implemented)

| Concern | Behavior |
| --- | --- |
| Concurrency | CAS claim (`QUEUED` + `nextAttemptAt <= now`); one winner per job |
| Stale leases | 5-minute lease; a crashed worker's job is reclaimable |
| Retries | ≤ 3 attempts, ≤ 3 transient failures; backoff 60 s → 15 min |
| Worker restart | Jobs are never left "running": lease expiry returns them to the queue |
| Duplicate provider submissions | Stable idempotency key per job; one result per job (`@unique`) |
| Graceful shutdown | Cron: runs finish or are killed at 12 h; a SIGKILL mid-job is recovered by lease expiry. Web: Next.js finishes in-flight responses within the shutdown delay |
| Resource limits | PDF parsing is in-process (CPU/memory-bound) — keep the worker on its own instance so it cannot degrade web traffic; see blockers (§13) |

### External integrations

- **Razorpay webhook URL:** `https://<web-service-host>/api/webhooks/razorpay`
  (custom domain recommended: `https://<domain>/api/webhooks/razorpay`).
  Raw-body signature verification and event-id idempotency are implemented;
  the endpoint fails closed (503) when `RAZORPAY_WEBHOOK_SECRET` is unset.
- **LLM provider:** disabled by default; enabled only with explicit consent
  flags (§9). Calls run in the worker/cron.
- **Specialist providers:** still `unconfigured`; they fail closed.

## 6. Private document storage

### Why local storage cannot go to production

Render filesystems are ephemeral: every deploy/restart deletes `./private-storage`,
and a second instance cannot see the first instance's files. Uploads and analysis
would silently lose data. **A shared private object store is a launch blocker.**

### Provider comparison (S3-compatible)

| Provider | Storage | Egress | Notes |
| --- | --- | --- | --- |
| **Cloudflare R2** (recommended) | $0.015/GB-month (10 GB free) | **Free** | S3 API; private by default; global endpoint; no region choice |
| AWS S3 | $0.023/GB-month | Billed per GB | Best IAM story; pick region nearest Render (e.g. `us-west-2` for Oregon); PrivateLink available on Pro |
| Backblaze B2 | $6.95/TB-month (~$0.007/GB) | Free up to 3× storage, then $0.01/GB | S3 API; cheapest at volume |

**Recommendation: Cloudflare R2** — no egress fees (all downloads already pass
through the web service), 10 GB free comfortably covers an early launch
(hundreds of documents), and the S3 API works with the standard AWS SDK.

### Bucket and key rules (non-negotiable)

- Bucket is **private**: no public bucket, no `r2.dev` public access, no static
  website endpoint, anonymous access blocked.
- Server holds a scoped API token (single bucket, read/write objects only).
- TLS-only endpoint; server-side encryption at rest (R2/S3 default AES-256).
- **No presigned URLs are returned to clients.** Downloads keep flowing through
  the authorized streaming proxy (`GET /api/documents/[id]/download`), which
  re-checks ownership/quarantine and writes an audit event.
- Storage keys stay server-generated and opaque (never derived from user
  input). Keep the driver name recorded in `Document.storageDriver` so mixed
  local/object data remains readable during migration.
- Versioning enabled (protects against accidental overwrite/delete), with a
  lifecycle rule to expire old versions only after a documented policy exists.
- Bucket CORS: none needed (no browser direct access).
- Retention/deletion: objects are deleted only by an explicit application flow;
  no lifecycle auto-deletion of live documents.

### Adapter design (no implementation without approval)

The existing `StorageAdapter` interface maps cleanly:

| Adapter method | S3 operation |
| --- | --- |
| `put(data, contentType, originalName)` | `PutObject` (SSE, content-type, metadata, checksum) |
| `get(key)` | `GetObject` bounded to `MAX_UPLOAD_BYTES` |
| `getStream(key)` | `GetObject` → `ReadableStream` (downloads) |
| `exists(key)` | `HeadObject` |
| `remove(key)` | `DeleteObject` (rollback/failure paths only) |

Implementation notes: register a second driver (`s3`) behind the existing
factory; keep the SHA-256 checksum flow unchanged (recorded at upload, verified
by analysis); stream uploads/reads so a 25 MB object is not double-buffered;
map all provider errors to `StorageError` so callers keep current behavior.

### Backup, retention, deletion

- The database remains the source of truth for metadata + checksums; bucket
  versioning is the object-level safety net.
- Back up the bucket configuration (CORS/lifecycle/versioning) and the access
  token policy with the infrastructure docs.
- Deletion policy: application-driven only; when a delete flow is added, it must
  delete the object first (or tolerate orphans) and keep the audit trail.

## 7. Malware scanning

### Status

The scanner adapter and the persisted scan lifecycle are **implemented**; no
ClamAV (clamd) service is deployed in any environment yet, and no end-to-end
scan against a live daemon has been performed. The default remains fail-closed:
with `MALWARE_SCANNER=unconfigured`, every upload is stored but stays
`QUARANTINED` and can never be downloaded or analysed. Setting an unknown
engine name is also fail-closed. Nothing may report `CLEAN` without a real
scan.

| Component | Location |
| --- | --- |
| Scanner boundary / typed outcomes | `src/lib/security/malware.ts` |
| ClamAV INSTREAM TCP adapter | `src/lib/security/clamav.ts` |
| Persisted claim → scan → release lifecycle | `src/lib/document-scan.ts` |
| Upload / download / analysis / attachment gates | `src/app/api/documents/route.ts`, `.../[id]/download/route.ts`, `src/lib/analysis/jobs.ts`, `src/lib/service-requests.ts` |

### Deployment model — ClamAV private service (recommended)

Run the official `clamav/clamav` image as a **private-network-only** service
(e.g. a Render private service or an internal Docker network) with a persistent
disk for the signature database. No npm dependency is added: the web service
speaks clamd's `INSTREAM` protocol over TCP. Prefer ClamAV over a managed
scanning API because document bytes never leave the trust boundary, which
matches the consent-first posture; a managed API would require a subprocessor
disclosure and privacy review.

| Criterion | ClamAV private service | Managed scanning API |
| --- | --- | --- |
| Data location | Stays inside the deployment | Files leave the trust boundary |
| Cost | ≈ $25–87/mo fixed (service + disk) | Usage-based per scan |
| Ops | Signature updates, memory tuning, health checks | None |
| Availability | Self-contained | External dependency; outages mean quarantine |

### Configuration

| Variable | Value |
| --- | --- |
| `MALWARE_SCANNER` | `unconfigured` (default) or `clamav` |
| `CLAMAV_HOST` | Private-network hostname/IP of clamd. Never a public endpoint. |
| `CLAMAV_PORT` | `3310` (default) |
| `CLAMAV_TIMEOUT_MS` | 1000–60000; default `10000`. Total per-file budget. |
| Daemon `StreamMaxLength` | Must be ≥ 26 MB (the app caps uploads at 25 MB) or clamd rejects the stream with `INSTREAM size limit exceeded. ERROR`, which the app treats as a failed scan. |
| Daemon `MaxScanSize` / `MaxFileSize` | Must also accommodate 25 MB. |

The app enforces the same 25 MB cap (`MAX_UPLOAD_BYTES`) before scanning, so a
larger stream is never sent. Size a small instance with the signature database
in mind (ClamAV memory is dominated by signatures); validate `1c-2g` before
settling on `2c-4g`.

### Health verification (after provisioning)

1. Confirm the daemon is reachable **only** on the private network and that the
   web service resolves `CLAMAV_HOST`.
2. Set `MALWARE_SCANNER=clamav`, `CLAMAV_HOST`, `CLAMAV_PORT` and restart the
   web service.
3. Negative check: upload a normal allowed file while the daemon is stopped and
   confirm the document is `QUARANTINED` / `ERROR` (never `AVAILABLE`).
4. Positive check: with the daemon running, upload the same file and confirm it
   becomes `AVAILABLE` with `scanStatus=CLEAN`.
5. Infection check: upload the EICAR test string as an allowed file type and
   confirm it becomes `QUARANTINED` / `INFECTED` with a bounded signature name,
   and that download and analysis are refused.
6. Verify the daemon's own signature-update logs; a stale signature database is
   an operational risk, not an application override.

### Timeout and failure behavior

- Connect and total-scan timeouts are bounded by `CLAMAV_TIMEOUT_MS`; every
  timeout, connection failure, protocol error, truncated/unknown response or
  transport-crash is an `ERROR`.
- `ERROR` persists safe diagnostics (`scanStatus`, `scanEngine`, `scanReason`,
  `scanAttempts`, timing) and leaves the document quarantined. Raw scanner
  output, document bytes and filenames never enter logs or audit metadata.
- There are no retries in the request path. The upload succeeds and stays
  quarantined rather than failing the user for an infrastructure problem.
- Scan results are bound to the exact stored file version: the bytes must match
  the persisted size and SHA-256, and the release update is conditional on the
  document id, storage key, checksum, size and scan state. A file changed after
  scanning cannot inherit the earlier `CLEAN`.

### Quarantine and retry

- Quarantined documents are invisible to download, analysis initiation and
  request attachment.
- `UNSCANNED` and `ERROR` documents are retryable through the scan service; a
  `SCANNING` claim left by a crash is reclaimable after the 10-minute lease.
- `INFECTED` is terminal for that file version and is never auto-retried.
- There is no automated re-scan scheduler or admin release UI yet. An operator
  retry means re-running the upload (which re-scans) or invoking the scan
  service operationally once a tool exists. Never update `status`/`scanStatus`
  by hand.

### Remaining production steps

1. Provision the private clamd service and persistent signature disk.
2. Apply the configuration above and run the health verification checklist.
3. Record the scanner as a subprocessor-free internal dependency in the
   deployment runbook; document signature-update expectations.
4. Keep `MALWARE_SCANNER=unconfigured` in every environment until steps 1–2
   pass; uploads remain safely quarantined in the meantime.

## 8. Rate limiting and trusted proxy behavior

### Implemented in Phase 2

A fixed-window rate limiter now guards the sensitive endpoints.

- Core: `src/lib/rate-limit.ts` (algorithm, keys, store) and
  `src/lib/rate-limit-guard.ts` (HTTP mapping + per-endpoint guards).
- Storage: the `rate_limit_buckets` table (additive migration
  `20261019182220_add_rate_limit_buckets`) — one row per
  `(scope, HMAC(identifier), windowStart)`, written with a single atomic
  upsert (`count = count + 1`). No in-memory counters are used anywhere.
- Privacy: only HMAC-SHA256 digests are stored; raw IPs, emails and user ids
  never enter the table. The digest secret is `RATE_LIMIT_HASH_SECRET`, falling
  back to `AUTH_SECRET`/`NEXTAUTH_SECRET`.
- Failure policy: when the store cannot be reached, protected endpoints fail
  closed with `503` — there is deliberately no unbounded or process-local
  fallback. Exceeding a limit returns `429` with a consistent non-sensitive
  body and a `Retry-After` header.
- Expiry: windows advance on fixed boundaries; rows older than 24 h are
  removed opportunistically (`cleanupExpiredBuckets`).

| Endpoint | Key | Limit |
| --- | --- | --- |
| Login (source) | trusted client IP, or one shared fallback bucket while trust is off | 60/hour |
| Login (account) | normalized email hash | 10/minute |
| Student registration | source (as above) | 5/hour |
| Instructor onboarding | source (as above) | 5/hour |
| Upload | authenticated user id | 30/hour |
| Payment order creation | authenticated user id | 10/minute |
| Payment verification | authenticated user id | 30/hour |
| Webhook | disabled; rely on signature + event-id idempotency | — |

### Deployment assumptions and limitations

- **Single host today:** the shared store is the SQLite database, so counters
  are shared across processes but not across hosts. The planned Render Postgres
  migration (§4) makes the same table multi-instance-safe on one database;
  until then, do not run more than one web instance against separate SQLite
  files.
- **Source keying depends on trusted proxy headers.** While
  `TRUST_PROXY_HEADERS=false`, every unidentified client shares the single
  `login.source` / registration source bucket — bounded, but coarse, and a
  deliberate denial-of-service surface for an attacker who exhausts it. Enable
  trust only after the verification below; if headers turn out spoofable,
  keep trust off and key login/registration limits by the account dimension
  where possible.
- Failed-login lockouts (`exponential lockout after 5 failures`) are **not**
  implemented: they change authentication behavior beyond plain throttling.
  The per-account `10/minute` window bounds guessing instead.

### Trusted proxy / `x-forwarded-for`

Findings:

- The audit helper previously read the **leftmost** `X-Forwarded-For` value
  (falling back to `X-Real-IP`) with no trust gate.
- Render's staff stated (2021) "we set the first IP in the list to the real
  client IP", while a later community report (2024) says Render does not
  clear/reset a client-supplied header and only appends. These statements
  conflict, and Render publishes **no documented guarantee**.
- Therefore proxy headers must be treated as **untrusted by default**.

Change made in this phase: `src/lib/request-ip.ts` ignores proxy headers unless
`TRUST_PROXY_HEADERS=true`; audit events store `null` until an operator has
verified the deployed behavior. Authorization and payment decisions never use
this value; when trust is enabled it also becomes the coarse per-source
rate-limit bucket key (§8 above).

Verification procedure (run in staging before enabling):

1. Deploy with `TRUST_PROXY_HEADERS=true` in a **non-production** environment.
2. Make a request with a spoofed header:
   `curl -H "X-Forwarded-For: 203.0.113.77" https://<staging>/api/auth/...`
   (any endpoint that writes an audit event with the request).
3. Compare the recorded `AuditEvent.ipAddress` value with and without the
   spoofed header.
4. If the spoofed value is never recorded, Render overwrites the first entry and
   trust can be enabled in production. If it is recorded, keep
   `TRUST_PROXY_HEADERS=false` and key rate limits by account/user id.

Never use client IPs for authorization, payment decisions, or webhook
verification (the webhook already uses HMAC signatures).

## 9. Environment-variable matrix

Legend: **W** = web service, **C** = cron worker, **both** = identical value in
both services. "Build" marks variables that must exist before `next build`
(`NEXT_PUBLIC_*` is inlined at build time).

| Variable | Applies to | Class | Purpose / notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | both (build + runtime) | Required | Render internal Postgres URL; append `?sslmode=require&connection_limit=5` |
| `DIRECT_URL` | W (pre-deploy) | Optional | Only if connection pooling is enabled; used by `prisma migrate` |
| `AUTH_SECRET` | W | Required | 32-byte base64; rotating invalidates all sessions |
| `NEXTAUTH_URL` | W | Required | `https://<host>`; must match the public URL |
| `NEXT_PUBLIC_APP_URL` | W (build) | Required | Public base URL; baked into the bundle at build |
| `RAZORPAY_KEY_ID` | W | Required (payments) | Server-side only |
| `RAZORPAY_KEY_SECRET` | W | Required (payments) | Server-side only |
| `RAZORPAY_WEBHOOK_SECRET` | W | Required (webhook) | Unset → webhook fails closed (503) |
| `STORAGE_DRIVER` | both | Required | `local` only for dev; `s3`/`r2` once the adapter is approved |
| `STORAGE_LOCAL_ROOT` | dev only | Dev | Never used in production |
| `S3_*` (endpoint/bucket/region/keys) | both | Future | Names finalized with the adapter implementation |
| `MALWARE_SCANNER` | W | Feature-gated | `unconfigured` (default) or `clamav` |
| `CLAMAV_HOST` | W | Feature-gated | Private-network hostname/IP of clamd (required for `clamav`) |
| `CLAMAV_PORT` | W | Feature-gated | Daemon port; default `3310` |
| `CLAMAV_TIMEOUT_MS` | W | Feature-gated | Per-file scan budget (1000–60000 ms; default `10000`) |
| `SIMILARITY_PROVIDER` | both | Feature-gated | Specialist provider id; `unconfigured` fails closed |
| `AI_WRITING_PROVIDER` | both | Feature-gated | As above |
| `ANALYSIS_API_BASE_URL` / `ANALYSIS_API_KEY` | both | Feature-gated | Specialist provider credentials |
| `ANALYSIS_WORKER_BATCH` | C | Optional | Batch size (default 10, clamped 1–50) |
| `LLM_PROVIDER` | both | Feature-gated | `unconfigured` (default) or `openai` |
| `LLM_API_KEY` | both | Feature-gated | Server-side only |
| `LLM_MODEL` | both | Feature-gated | Model id supported by the account |
| `LLM_EXTERNAL_PROCESSING_ENABLED` | both | Feature-gated | Must be exactly `true`; student consent still required per request |
| `LLM_TIMEOUT_MS` / `LLM_MAX_OUTPUT_TOKENS` | both | Optional | Clamped server-side |
| `TRUST_PROXY_HEADERS` | W | Optional | `false` until proxy behavior is verified (§8); also gates the per-source rate-limit key |
| `RATE_LIMIT_HASH_SECRET` | W | Optional | Hashes rate-limit identifiers; defaults to `AUTH_SECRET` (§8) |
| `NODE_VERSION` | both | Recommended | `22` for parity with development |
| `PORT` | W | Platform | Provided by Render (default 10000); do not set |
| `NODE_ENV` | both | Platform | Set by Render at runtime; do not set manually |
| `RENDER*` | both | Platform | Informational; provided by Render |

Rules: keep secrets server-side (never `NEXT_PUBLIC_*`); use a Render
environment group for the shared database/storage/provider variables; update
docs when a variable is added; never commit `.env`.

## 10. Release, rollback, health, and operations

### First provisioning (requires approval — none of this was done)

1. Create the Render workspace (Hobby; Pro recommended with real payments).
2. Create Postgres (same region as the services), 1 GB initial storage,
   restrict/disable external access, note the internal URL.
3. Create the web service from the repository branch; set the build/pre-deploy/
   start commands, health path `/api/health`, `NODE_VERSION`, and envs.
4. Create the cron job (build `npm ci && npx prisma generate`, command
   `npm run analysis:worker`, schedule `*/1 * * * *`).
5. Provision object storage + scanner only after their approvals.
6. Promote the first ADMIN with `npm run grant-admin` (run once from a shell
   with production `DATABASE_URL` — never via a web route).

### Ongoing releases

- Push to the linked branch → build → pre-deploy `prisma migrate deploy` →
  new instance → health checks → traffic cutover → old instance SIGTERM.
- Migrations must stay additive; if a deploy fails, Render keeps the previous
  version running and the failed build never receives traffic.
- Health/readiness: `/api/health` returns 200 only while the database is
  reachable (2 s probe budget); otherwise 503 and Render withholds/restarts
  the instance. The response contains no secrets or internals.

### Rollback

- Use Render's instant rollback (Hobby keeps 5 builds; code only — never
  roll back the database; additive migrations make this safe).
- Environment-variable changes require a redeploy (or restart with the same
  vars) to take effect.

## 11. Backup, restore, and disaster recovery

| Layer | Mechanism | Retention |
| --- | --- | --- |
| Postgres PITR | Render automatic (paid) | 3 days (Hobby) / 7 days (Pro) |
| Postgres logical exports | Manual dashboard export (`.dir.tar.gz`) | 7 days |
| Offsite SQL backups (recommended) | Cron `pg_dump` → object storage, per Render's guide | Own policy (e.g. 30–90 days) |
| Documents | Bucket versioning + provider durability | Until deleted by policy |
| Metadata + checksums | PITR / exports | Same as Postgres |

Restore procedure (outline): restore PITR into a new instance → validate →
point `DATABASE_URL` at the restored instance → verify checksums against the
bucket → only then delete the old instance. Test this in staging before
payments go live. **Deleting a database deletes its backups.**

## 12. Security and reliability review

| Checklist item | Finding |
| --- | --- |
| Worker concurrency / stale leases | Safe: CAS claims, 5-min lease, bounded retries (verified in code) |
| DB connection exhaustion | Not currently possible (one web + cron); pin `connection_limit` anyway |
| DB unavailability | Requests fail with 500s; health endpoint reports 503; PITR is the recovery path |
| Missing env vars | Fail fast: `requireEnv` errors name the variable; feature flags fail closed |
| Failed storage operations | Upload rolls back metadata; downloads return 410; errors never mark files clean |
| Failed scans | Fail closed to typed `ERROR` → quarantined; never `CLEAN` |
| Webhook retries / duplicates | HMAC + event-id uniqueness + single verified transition path |
| Private documents / cross-user access | Owner/assigned-instructor/admin only; quarantined files never downloadable; 404-not-403 for cross-user ids |
| Secret redaction | No env values or bodies are logged; the worker logs error names only; avoid adding request-body logging |
| Content Security Policy | Enforced framing/object/base baseline plus a report-only full policy (nonce-based, no `unsafe-eval`); promotion checklist in `docs/security.md` |
| Graceful shutdown | Render SIGTERM + configurable delay; queue survives via leases |
| PDF/DOCX resource exhaustion | DOCX has archive-bomb guards; PDF parsing remains in-process → keep the worker isolated (blocker §13) |

## 13. Prioritized production blockers

**P0 — must be resolved before any public deployment**

1. Provision Render Postgres and regenerate the PostgreSQL baseline (§4).
2. Implement the S3-compatible storage adapter and private bucket (§6) —
   otherwise every deploy destroys uploaded documents.
3. Provision the malware scanner (§7): the adapter and scan lifecycle are
   implemented, but no clamd service exists, so uploads stay quarantined and
   the document workflow is unusable until it is deployed and verified.
4. ~~Rate-limit login/registration (§8).~~ **Implemented in Phase 2**; before
   launch, complete the trusted-proxy verification (§8) and the Postgres
   migration (§4) before running multiple instances.
5. Create the cron worker (§5) — otherwise analysis jobs never run.

**P1 — before real payments/student data**

6. Pro workspace for 7-day PITR + HTTP request logs, or an offsite `pg_dump`
   cron, with a tested restore.
7. HSTS at the platform/proxy; `NODE_VERSION` pinned; health path configured.
8. Bandwidth budget (downloads count against 5 GB Hobby allowance).

**P2 — hardening/scale**

9. Isolate PDF extraction (resource-limited worker) — residual from the audit.
10. Content-Security-Policy — implemented in Phase 4: the `eval`-based
    renderer and the obsolete prototype screen tree are removed,
    `src/proxy.ts` emits a nonce-based report-only full policy, and
    `next.config.ts` enforces the framing/object/base baseline. Promote to
    fully enforced after the browser checklist in `docs/security.md`.
11. Admin quarantine-release tooling with dual control; object lifecycle rules.
12. Observability: log drain, metrics, alerting on failed scans/jobs.

## 14. Changes made in this phase

| Change | File |
| --- | --- |
| Health endpoint for Render checks | `src/app/api/health/route.ts` (new) |
| Bounded DB probe | `src/lib/health.ts` (new) |
| Trusted-proxy gate for audit IPs | `src/lib/request-ip.ts` (new), `src/lib/audit.ts` |
| Tests | `tests/request-ip.test.mjs`, `tests/health.test.mjs` (new) |
| Env documentation | `.env.example` (Postgres note, `DIRECT_URL` placeholder, `TRUST_PROXY_HEADERS`) |
| Planning document | `docs/deployment-render.md` (this file) |

No database provider change, no storage adapter, and no scheduler were
implemented by that planning work — each requires approval. The malware-scan
adapter and lifecycle were added later in Phase 3 (§7), but no clamd service is
provisioned. (The rate limiter was added in Phase 2; see §8.) Phase 4 removed
the obsolete prototype screen tree and its `eval`-based renderer and added the
Content-Security-Policy proxy (report-only full policy; enforcement checklist
in `docs/security.md`).

## 15. Decisions requiring approval

1. **Database** — Render Postgres as default, region, plan (`0.5c-1g`?), and
   the PostgreSQL baseline procedure (including ending SQLite support).
2. **Pooling** — start without PgBouncer (recommended) or enable it now with
   `DIRECT_URL`/`directUrl`.
3. **Object storage** — provider (R2 recommended), bucket configuration, and
   implementation of the `s3` adapter.
4. **Malware scanner service** — approve creating the ClamAV private service
   (recommended) vs a managed API. The adapter and lifecycle are implemented and
   fail closed; what remains is provisioning, private networking, and the §7
   verification checklist.
5. **Rate limiting** — resolved in Phase 2: the database-backed fixed-window
   limiter was chosen (no new vendor). (The Key Value + `rate-limiter-flexible`
   option remains the alternative if write load on Postgres becomes a concern.)
6. **Scheduler** — cron every minute as recommended, and batch size.
7. **Workspace plan** — Hobby vs Pro (backup window / request logs).
8. **Proxy trust** — enabling `TRUST_PROXY_HEADERS` only after the §8
   verification procedure passes.
9. **Backups** — PITR only vs PITR + offsite `pg_dump` cron, and retention.
10. **Repo/branch** — Render requires a pushed branch; committing and pushing
    the current uncommitted work is the operator's decision (not done here).

## Sources

- Render Postgres (create/connect, limits, encryption): https://render.com/docs/postgresql-creating-connecting
- Render Postgres backups/PITR: https://render.com/docs/postgresql-backups
- Render connection pooling (PgBouncer): https://render.com/docs/postgresql-connection-pooling
- Render cron jobs (single-run guarantee): https://render.com/docs/cronjobs
- Render deploys (pre-deploy, ephemeral FS, SIGTERM): https://render.com/docs/deploys
- Render health checks: https://render.com/docs/health-checks
- Render web services (port binding): https://render.com/docs/web-services
- Render environment variables / Node version: https://render.com/docs/environment-variables, https://render.com/docs/node-version
- Render compute plans and pricing: https://render.com/docs/compute-plans, https://render.com/pricing
- Render free-tier limitations: https://render.com/docs/free
- Render `X-Forwarded-For` statements: https://feedback.render.com/features/p/send-the-correct-x-forwarded-for
- Neon pricing/plans: https://neon.com/pricing
- Supabase pricing: https://supabase.com/pricing
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Backblaze B2 pricing: https://www.backblaze.com/cloud-storage/pricing
