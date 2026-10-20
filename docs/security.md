# Document security controls

How private academic documents are protected. Files are confidential work, so
they are never public and are only served through authorized routes.

## Storage

- Bytes live in a private store (`src/lib/storage`), **outside** the public
  static directory. Only the local driver is implemented; the interface is
  designed so an S3-compatible driver can be added without changing callers.
- Storage keys are **server-generated** (`year/month/<uuid>.<ext>`) and never
  derived from user filenames, preventing traversal and collisions. Path
  traversal keys are rejected by the adapter (`StorageError`).
- Local objects are written with owner-only permissions where the platform
  supports it (`0700` directories, `0600` files).
- The database stores **metadata only** (`Document`), never file contents.

## Upload — `POST /api/documents`

1. **Authentication & role** — requires a signed-in `STUDENT` or `ADMIN`
   (`requireRole`).
2. **Size** — the body is read through a hard byte budget (25 MB file plus 1 MB
   multipart framing) that does not trust `Content-Length`; chunked requests
   that omit or understate it are still bounded, and oversized bodies receive
   **413** without being fully buffered. The parsed file is re-checked against
   the 25 MB limit.
3. **Type** — the filename extension, the declared MIME type and the file's
   magic-byte signature must all agree and be on the allow-list (PDF, DOC, DOCX,
   ODT, RTF, TXT). A mismatch is rejected (415).
4. **Ownership** — when a `requestId` is supplied, the caller must own the
   request (or be an admin); otherwise 403.
5. **Ordering** — the object is stored first, then metadata is persisted. If the
   database write fails, the stored object is removed so no orphan remains.
6. **Quarantine** — uploaded files are persisted `QUARANTINED` / `UNSCANNED`
   before any scan runs. A file only becomes `AVAILABLE` through the scan
   lifecycle below: a configured scanner must read the stored bytes, return a
   verified `CLEAN`, that result must be persisted, and the bytes must be
   re-verified (size + SHA-256) before a conditional release. With no scanner
   configured, or on any timeout/connection/protocol error, the file stays
   quarantined. A scanner can never fabricate `CLEAN`, and a stale `CLEAN`
   result can never release modified bytes.
7. **Audit** — success and every rejection reason are recorded (no contents).
   Scan outcomes are recorded as `document.scan.completed` /
   `document.scan.released` with engine, outcome, safe diagnostic code and
   attempt count only.

## Malware scan lifecycle

The scanner boundary is `src/lib/security/malware.ts`, the clamd adapter is
`src/lib/security/clamav.ts`, and the persisted lifecycle is
`src/lib/document-scan.ts`. No new npm dependency is used: the adapter speaks
clamd's `INSTREAM` protocol over a private TCP socket (`node:net`).

| Step | Control |
| --- | --- |
| Configuration | `MALWARE_SCANNER=unconfigured` (default) or `clamav` + `CLAMAV_HOST`/`CLAMAV_PORT`/`CLAMAV_TIMEOUT_MS`. Missing or invalid config is a typed failure, not a bypass. |
| Source of bytes | The exact stored object, read through the private `StorageAdapter`. Request bodies and client-supplied names/types are never scanned or trusted. |
| Integrity binding | The stored bytes must match the persisted `sizeBytes` and `checksumSha256`; the release update is additionally conditional on document id, `storageKey`, checksum, size and scan state. |
| Claim | `scanStatus=SCANNING` is set with a conditional update, so concurrent or duplicate scans cannot both claim a document. A crashed claim is reclaimable after a 10-minute lease. |
| Timeouts | Connect and total scan budgets are bounded by `CLAMAV_TIMEOUT_MS` (1–60 s, default 10 s). Timeout is a failure, never a pass. |
| Outcomes | `CLEAN` / `INFECTED` / typed `ERROR` (`not_configured`, `unsupported_engine`, `timeout`, `connect_failed`, `transport_error`, `malformed_response`, `size_exceeded`, `scanner_error`, plus integrity/storage codes). Anything other than `CLEAN` stays quarantined. |
| Infected files | Persisted `scanStatus=INFECTED` with a bounded signature name; terminal for that file version and never auto-retried or downloadable. |
| Retries | None in the request path. Re-scanning a quarantined file is a separate operator action (re-run the upload or the scan service); `UNSCANNED`/`ERROR` are reclaimable, `INFECTED` is not. |
| Diagnostics | Stored fields (`scanStatus`, `scanEngine`, `scanReason`, `scanSignature`, `scanAttempts`, `scanStartedAt`, `scannedAt`) and audit metadata contain no document content or raw scanner output. |

## Request body limits

Every route that reads a request body uses the bounded helpers in
`src/lib/request-body.ts` (`readBodyBytesWithLimit`, `readBodyTextWithLimit`,
`readJsonBodyWithLimit`) instead of unbounded `request.json()`,
`request.text()`, or `request.formData()`:

| Route body | Budget |
| --- | --- |
| JSON endpoints (auth'd services) | 128 KB |
| Raw text (decline reason) | 256 KB |
| `POST /api/webhooks/razorpay` (unauthenticated) | 256 KB |
| `POST /api/documents` (multipart) | 25 MB + 1 MB framing |

The reader enforces the budget while streaming and cancels the request stream
past it, so a chunked request without `Content-Length` cannot force unbounded
buffering. `Content-Length` is only used as a fast-path rejection hint.

## Download — `GET /api/documents/[id]/download`

1. **Authentication** — requires a signed-in user (`STUDENT`/`INSTRUCTOR`/
   `ADMIN`).
2. **Authorization** — owner, admin, or the instructor assigned to the linked
   request only. Unauthorized callers get **404** (not 403) so document
   existence is not leaked.
3. **Quarantine** — a document is served only when it is `AVAILABLE` **and** has
   a persisted `CLEAN` scan (`isDocumentDownloadable`). Quarantined, unscanned,
   infected, errored or deleted documents are refused with **423**, and legacy
   `AVAILABLE` rows that were never scanned fail closed the same way.
4. **Streaming** — the object is streamed from private storage, never buffered
   wholesale and never served statically.
5. **Response hardening** —
   `Content-Disposition: attachment` (no inline execution),
   `Content-Type` restricted to the allow-list (`application/octet-stream`
   otherwise), `X-Content-Type-Options: nosniff`, `Cache-Control: private,
   no-store`.
6. **Audit** — successful and blocked downloads are recorded.

## Audit trail — `AuditEvent`

Security actions are appended to `audit_events` by `src/lib/audit.ts`. Logging
is best-effort (failures never break the request) and stores only non-sensitive
context. `actorId` uses `onDelete: SetNull`, so history is retained after an
account is deleted.

The recorded IP address is advisory metadata only. Proxy headers
(`x-forwarded-for` / `x-real-ip`) are ignored unless `TRUST_PROXY_HEADERS` is
exactly `true` (`src/lib/request-ip.ts`). The value is never used for
authorization or payment decisions; since Phase 2 it may additionally serve as
the coarse per-source rate-limit bucket key (`src/lib/rate-limit.ts`). See
`docs/deployment-render.md` for the verification procedure before enabling it.

## Instructor applications & approval

The instructor-application workflow is authorized entirely server-side; the
browser only supplies applicant details.

1. **Submission** — two server-validated entry points, both enforcing at most
   one `PENDING` application per account and never granting instructor
   capability before approval:
   - `POST /api/instructor/applications` — requires a signed-in `STUDENT`
     (existing student-applicant flow). The applicant id is always the
     authenticated user.
   - `POST /api/instructor/register` — **public instructor onboarding**. Creates
     the unified account and the `PENDING` application in one transaction with
     the role fixed to `STUDENT`; a body-supplied role is ignored and the
     password uses the same policy as student registration.

   Input is validated and normalized (email canonicalised,
   expertise/qualifications de-duplicated). While an application is pending the
   account is still a `STUDENT`: the instructor layout routes it to the public
   application-status screen, and every instructor capability stays denied until
   an administrator approves the application.
2. **Review** (`GET /api/admin/applications`, `GET
   /api/admin/applications/[id]`, `POST /api/admin/applications/[id]/decision`)
   — `ADMIN` only. Listing supports a status filter and pagination; the acting
   administrator comes from the session, never the body. The dashboard pages
   (`/admin`, `/admin/applications`) render the same data for administrators
   only: the admin layout and each page re-check the role server-side, and
   unauthenticated visitors are redirected to sign-in.
3. **Decision** — approve, or reject **with a mandatory reason**. The decision is
   compare-and-set on `status = PENDING`, so simultaneous decisions cannot both
   succeed; the loser receives a conflict and the conflict is audited. Applicants
   can never decide their own application, even if they have been granted
   administrator privileges (the denied self-review is audited). Approval
   creates an approved+active `InstructorProfile` and promotes the user to
   `INSTRUCTOR` — never `ADMIN`.
4. **Withdrawal** (`POST /api/instructor/applications/[id]/withdraw`) — the
   owner only, and only while `PENDING`.
5. **Eligibility enforcement** — publishing a service
   (`POST /api/instructor/services`) re-reads the account and applies
   `evaluateInstructorEligibility` (role `INSTRUCTOR`, not suspended, approved &
   active profile). The same rule gates catalogue visibility and request
   acceptance. Every denial is audited.
6. **Audit** — `instructor.application.submitted`,
   `instructor.application.submit.denied`, `instructor.application.withdrawn`,
   `instructor.application.approved`, `instructor.application.rejected`,
   `instructor.application.review.denied`,
   `instructor.application.decision.conflict`,
   `instructor.service.published` and `instructor.service.publish.denied` are
   recorded with non-sensitive metadata only.

Qualification documents are **not** part of this phase and are never stored in
public storage.

## Instructor request inbox & decisions

The instructor request workflow is authorized entirely server-side; the browser
supplies at most an optional decline reason.

1. **Visibility** — the inbox lists only requests whose `instructorId` matches
   the signed-in instructor's profile, re-read from the database on every
   request. A non-instructor (including an administrator visiting for support)
   receives an empty page rather than another instructor's queue. A request
   detail answers **404** — never 403 — for a reference the viewer is not
   entitled to, so another instructor's request is not even confirmed to exist.
2. **Decisions** (`POST /api/instructor/requests/[id]/accept`,
   `POST /api/instructor/requests/[id]/decline`) — `INSTRUCTOR` role only, and
   the service re-checks the actor's live account state:
   `evaluateInstructorEligibility` (role `INSTRUCTOR`, not suspended, approved &
   active profile) plus assignment to the request. Pending, rejected,
   withdrawn, unapproved, inactive or suspended instructors are refused and
   every denial is audited.
3. **Transitions** — accept and decline move `PAID → ACCEPTED | DECLINED` only
   (`canTransitionRequestStatus`). A request still awaiting verified payment
   cannot be decided; the attempt receives a conflict and is audited. The
   update is compare-and-set on the status the caller was authorized against, so
   simultaneous accept/decline attempts cannot both succeed; the loser receives
   a conflict. Decisions are terminal and cannot be rewritten.
4. **Price integrity** — `amountMinor` and `currency` are never read from the
   request body and never modified by a decision; the snapshot created from the
   service row stands.
5. **Decline reason** — optional, 10–2000 characters when provided, stored on
   the request and shown only to the owning student (and in the instructor's own
   view). No internal notes are stored or exposed to anyone.
6. **Documents** — request documents are only visible through the assigned
   request, and downloads continue to use the authorized download route (owner,
   admin, or assigned instructor only; quarantine and content-type restrictions
   unchanged). Raw storage keys are never exposed.
7. **Audit** — `request.accepted`, `request.declined`, `request.accept.denied`
   and `request.decline.denied` are recorded with non-sensitive metadata
   (reference, from/to status, whether a reason was supplied).

## Razorpay payments

Payments are verified entirely server-side. The browser triggers checkout and
reports its result, but **only verified provider evidence** can mark a request
paid. See `docs/payments.md` for the operator setup.

1. **Secrets** — `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` (legacy alias
   `RAZORPAY_SECRET`) and `RAZORPAY_WEBHOOK_SECRET` are server-only. They are
   never returned in an API response, embedded in client code, or written to
   logs/audit metadata. Missing credentials produce a safe configuration error
   (503) — never a simulated success. The only value sent to the browser is the
   publishable key id, returned by the authenticated order endpoint.
2. **Amount integrity** — the order amount and currency are read from the
   persisted `ServiceRequest` snapshot. Client-supplied amounts, currencies,
   student ids and statuses are ignored entirely. The payment row copies the
   snapshot, and verification compares the provider's captured amount/currency
   against it.
3. **Order creation** (`POST /api/student/requests/[id]/payment`) — requires a
   signed-in `STUDENT`; the service re-checks that the actor owns the request
   and that it is `AWAITING_PAYMENT`. Other students, instructors and admins are
   refused, and unauthorized callers get **404** so request existence is not
   leaked. One active order per request is enforced by `Payment.activeKey`
   (`@unique`); repeated calls resume the same order. Creating an order never
   marks the request paid.
4. **Checkout verification** (`POST /api/student/requests/[id]/payment/verify`)
   — the Razorpay signature over `order_id|payment_id` is checked
   **timing-safely**, the order must be a local payment of this request and
   student, and the provider record must be independently fetched (`captured`,
   same order/payment id, exact amount/currency). The signed callback alone is
   never trusted, and `paid: true` from the client is never read. Repeated
   callbacks are idempotent; a different payment id for an already-paid order
   is a conflict/mismatch.
5. **Webhooks** (`POST /api/webhooks/razorpay`) — the signature is verified over
   the **exact raw body** with the webhook secret before any parsing. Invalid
   deliveries get 400; unconfigured webhooks get 503; unexpected failures get
   500 so the provider retries. Every verified event is recorded once in
   `PaymentWebhookEvent` (`eventId` unique, or a SHA-256 of the raw body when
   the header is absent). Events are processed atomically with the state change
   they describe. Unknown orders, unsupported event types and stale failures
   are acknowledged without changing payment/decision state.
6. **One payment, one request** — `providerOrderId` and `providerPaymentId` are
   unique; attempting to apply the same captured payment to a second request is
   rejected as a mismatch and never marks it paid. A mismatch never mutates the
   amount, currency, student or assignment.
7. **State separation** — order creation is not payment, a checkout callback is
   not proof, and payment is not a decision. `CREATED | FAILED` never satisfy
   the request, and a failed/cancelled/abandoned checkout leaves the request
   `AWAITING_PAYMENT`. Only a verified `captured` payment moves the request to
   `PAID`, after which the existing instructor accept/decline workflow applies.
   Failures never overwrite a success; `PAID` is terminal.
8. **Data minimization** — no card/bank data, CVV, tokens or raw provider
   payloads are stored. Audit and webhook rows keep identifiers, amounts,
   currency, safe status/error codes and reasons only. Logs contain only the
   error name, never credentials or PII.
9. **Audit** — `payment.order.created`, `payment.order.create.denied`,
   `payment.verified`, `payment.verification.denied`, `payment.mismatch`,
   `payment.webhook.rejected` and `payment.webhook.ignored` are recorded with
   non-sensitive metadata.

Refunds, payouts/earnings, saved cards and automatic reconciliation tooling are
**not** implemented in this phase. A decline after payment is recorded as a
request decision; money movement remains a manual/provider-dashboard concern.

## Document analysis — local matching, LLM consent, and provider execution

Four capabilities are deliberately separate: local-corpus similarity, LLM
observations, specialist plagiarism, and specialist AI-writing detection. See
`docs/analysis.md` for the full contract, algorithm, and operator model.

1. **Initiation** (`POST /api/instructor/requests/[id]/analysis`) — `INSTRUCTOR`
   role only. The service re-reads the actor from the database and requires an
   approved, active, unsuspended instructor profile. The request must be assigned
   to that instructor (otherwise **404**, not 403, so another instructor's
   request is not confirmed to exist), must be `PAID` or `ACCEPTED` (verified
   payment), and the document must be released (`AVAILABLE` **and**
   `scanStatus = CLEAN`), owned by the request's
   student, attached to that request, within the upload size limit, and carry the
   SHA-256 checksum recorded at upload. Quarantined, unscanned, infected,
   deleted, and checksum-less legacy records are refused with **409** before
   storage or provider access.
2. **Fail-closed capabilities.** Local matching is built in and needs no
   credentials. An LLM request additionally requires
   `LLM_EXTERNAL_PROCESSING_ENABLED=true`, a complete server-only provider
   configuration (OpenAI or Gemini), and explicit student consent. With
   `SIMILARITY_PROVIDER` / `AI_WRITING_PROVIDER` set to `unconfigured` (or an
   unimplemented id), those capabilities return a safe configuration error and
   create **no job and no result**.
3. **Student LLM consent is explicit, versioned, and revocable.** The consent
   endpoint accepts only the owning student's request id and a boolean. It
   stores `llmProcessingConsentAt` + `llmProcessingConsentVersion` on the
   request and audits grant/withdraw. Only consent matching the current notice
   version counts, so a notice change requires renewal. Consent is offered only
   for `PAID` or `ACCEPTED` requests; another student's request returns 404. The
   instructor endpoint refuses to create an LLM job without it, and every
   processing attempt re-checks it. Withdrawal cannot recall an in-flight call,
   but no new external call may start.
4. **Execution re-checks every attempt.** Before reading bytes, processing
   re-verifies instructor eligibility/assignment, paid request state, document
   ownership/association, release state (`AVAILABLE` + `CLEAN`), storage driver,
   and (for `LLM_REVIEW`) current consent. If any check fails, the job becomes
   `FAILED` with a fixed safe message; no provider call is made. A document that
   is quarantined or loses its `CLEAN` scan after initiation is never sent.
5. **Bytes only through private storage.** Specialist providers receive exact
   file bytes obtained via `StorageAdapter.get()`, content type, size, checksum,
   and a stable idempotency key. Neither storage keys nor the platform's storage
   client are exposed to the adapter or client. Uploads record SHA-256 from the
   exact stored bytes; before extraction or submission, size and checksum are
   re-verified, and a missing checksum or mismatch fails permanently without
   sending bytes.
6. **Extraction is bounded.** PDF (≤300 pages), DOCX, and UTF-8 TXT are
   supported; legacy DOC/RTF/ODT and unknown formats are rejected. DOCX archives
   are preflighted before parsing: at most 2,048 entries, ≤50 MB declared per
   entry, ≤100 MB declared total, and every entry is re-inflated under a hard
   output budget so a crafted central directory cannot understate the real
   decompressed size (see `docs/analysis.md`). Extracted text is between 20 and
   120,000 characters. LLM input is capped at 60,000 characters, and the LLM
   response body is read through a fixed byte budget. Extraction runs only
   server-side and is never logged.
7. **LLM data minimization.** The model receives extracted text and short
   supplied local-match excerpts, not filenames, raw bytes, storage keys,
   payments, or account credentials. It cannot introduce sources: citation
   quotes must be located verbatim in the document, explanations for unknown
   match ids are dropped, and neither provider is given tools or search access.
   Model-supplied URLs/scores are ignored. Writing-pattern observations are
   qualitative — the schema has no likelihood/confidence field to invent, and
   their false-positive limitation is persisted with the result. Model output is
   labelled as observation, never proof of plagiarism or AI authorship.
8. **No fabricated or conflated results.** Only validated completion can write
   `COMPLETED` + `AnalysisResult` (in one transaction). Unavailable scores are
   `null`, never `0`. Invalid scores, offsets, output, or a provider-job mismatch
   are rejected as `INVALID_RESULT` with no result row. Local, LLM, specialist
   similarity, and specialist AI outcomes use separate job types and result
   columns. AI metadata includes a probabilistic, non-proof disclaimer.
9. **Duplicate/billable submission protection.** A unique `activeKey`
   (`documentId:type`) allows one active job per document and type; concurrent
   initiation loses the race and receives the winning job. Repeat initiation for
   completed work returns the existing result instead of billing again. Provider
   submissions carry an `analysis-job:<id>` idempotency key, and worker claims
   use compare-and-set updates. Result insertion is unique per job. LLM attempts
   are counted only immediately before the external call.
10. **Bounded retries, no in-memory queue.** The database is the queue.
    `attempts` (max 3 actual attempts) and `failureCount` (max 3 transient
    failures) with exponential backoff prevent unbounded retries. Only
    `TRANSIENT` and `RATE_LIMITED` categories retry; configuration, permanent,
    content-rejected, and invalid-result failures are terminal. A crashed worker
    leaves durable state that the operator-run worker can reclaim after the
    lease.
11. **Data minimization in persistence.** `providerMeta` and result `metadata`
    store only allow-listed normalized fields. Raw provider responses, provider
    error text, full document text, credentials, and storage keys are never
    persisted in analysis tables, returned by safe summaries, or written to
    audit metadata. Bounded matched/source excerpts (≤400 chars) and grounded
    citation-review excerpts are intentionally part of the report evidence.
    `AnalysisResult.providerPayload` is intentionally always `null`.
12. **Key secrecy.** `LLM_API_KEY` and `GEMINI_API_KEY` are server-only. They
    are never returned in provider statuses/errors, safe summaries, audit
    events, logs, or browser code, and a provider credential is never sent to a
    different provider's endpoint. The adapters never read or log a provider
    error body.
13. **Audit.** `analysis.job.created`, `analysis.job.create.denied`,
    `analysis.job.submitted`, `analysis.job.completed`,
    `analysis.job.retry_scheduled`, `analysis.job.failed`, and the LLM consent
    grant/withdraw events record only non-sensitive ids, type/provider,
    category/code, attempt counts, and timing.
14. **Read access.** `getAnalysisJobSummary()` returns a whitelisted projection
    to the document owner, the assigned instructor, or an admin; everyone else
    receives `null`. `getAnalysisOverview()` is limited to the assigned
    instructor or an admin; the student consent panel is limited to the owning
    student. Administrator support access is read-only for analysis initiation.

## Content Security Policy (Phase 4)

`src/proxy.ts` (Next.js 16 renamed middleware to proxy) emits the full
report-only policy on every HTML page; the enforced baseline is set in
`next.config.ts`. The policy itself is built in `src/lib/security/csp.ts`.
The proxy excludes API routes, build assets and prefetches — the report-only
policy is document scoped; the enforced baseline applies to every response.

| Header | Status | Contents |
| --- | --- | --- |
| `Content-Security-Policy` | **Enforced** | `frame-ancestors 'none'; object-src 'none'; base-uri 'self'` — emitted by `next.config.ts` for every response. Deliberately the only directives that cannot affect rendering, scripts, styles, fonts or payments. |
| `Content-Security-Policy-Report-Only` | **Report-only (temporary)** | The full policy, emitted per request by `src/proxy.ts`: `default-src 'self'`; nonce-based `script-src` with `'strict-dynamic'`, no `'unsafe-eval'`/`'unsafe-inline'`; `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`; `img-src 'self' data: blob:`; `font-src 'self' data: https://fonts.gstatic.com`; `connect-src 'self' https://*.razorpay.com`; `frame-src https://*.razorpay.com`; `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`; `frame-ancestors 'none'`; `upgrade-insecure-requests`. |

### How it works

- A fresh 128-bit random nonce is generated per request and forwarded on the
  **request** headers (`x-nonce` and the full policy). Next.js parses the
  nonce and stamps its framework, page-bundle and inline hydration/streaming
  scripts with it while server-rendering; the nonce is never sent as a
  response header.
- The enforced baseline is deliberately **not** emitted by the proxy. Next.js
  folds a response `Content-Security-Policy` header back into the request it
  renders; a nonce-less enforced header from the proxy would overwrite the
  nonce-bearing request policy and Next would tag no scripts at all (observed
  locally before the split). Only `next.config.ts` sets the enforced header;
  the report-only header still carries the same nonce as the request policy.
- The full policy is report-only, so no request is blocked by it. Violations
  appear in the browser console; there is no `report-to`/`report-uri`
  collector (that would need a reporting endpoint, which is not provisioned).
- `style-src` keeps `'unsafe-inline'` because React renders inline style
  attributes (`animationDelay` on `/` and the auth screens). Adding a nonce to
  `style-src` would make browsers ignore `'unsafe-inline'` for those
  attributes and break them.
- External origins are exactly the two real integrations: Google Fonts
  (`src/app/layout.tsx`) and Razorpay Checkout
  (`src/components/PayNowPanel.tsx`). Razorpay is allowed as
  `https://*.razorpay.com` because `checkout.js` uses several subdomains
  (checkout, api, cdn, lumberjack*) and constructs a region-specific API host
  at runtime; a pinned list would break checkout when Razorpay changes hosts.
- Development adds `'unsafe-eval'` and `ws:`/`wss:` only (the documented
  Next.js dev requirement). `tests/csp.test.mjs` asserts those can never
  appear in a production policy.
- `/` renders per request (`force-dynamic`) so its scripts receive a nonce.
  `/_not-found` is still statically generated and is the one page a future
  enforced policy would leave without a nonce.

### Before promoting the full policy to enforced

1. In a real browser against both `next dev` and a production build, confirm
   zero CSP violations on `/`, `/login`, `/register`, `/student`,
   `/instructor`, `/student/documents`, an upload + download, and a Razorpay
   test-mode checkout (script load, iframe, telemetry, form submission).
2. Confirm hydration and client-side navigation work with nonced scripts.
3. Cover `/_not-found` (dynamic custom `not-found`, or accept it as the single
   nonce-less page), or use the experimental SRI path.
4. Promote by moving the full policy to the enforced header **in
   `src/proxy.ts`** (it already carries the nonce, so the response/request
   fold is harmless) and removing the baseline entry from `next.config.ts` so
   only one `Content-Security-Policy` header is emitted; then re-run
   `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run build`.

`tests/csp.test.mjs` checks construction, nonce freshness, header shape and
wiring, and that each CSP header has a single source; it does not replace
browser validation.

## Not yet implemented (explicit)

- A **deployed** malware scanner: the ClamAV adapter and scan lifecycle exist,
  but no clamd service is provisioned and no deployment has been verified
  end-to-end. `MALWARE_SCANNER` remains `unconfigured`, so uploads stay
  quarantined.
- Real specialist similarity/AI-writing provider adapters.
- A deployed scheduler for the analysis worker; `npm run analysis:worker` must
  be scheduled by an operator.
- A visual diff/highlighting viewer and a formal human misconduct workflow.
- An automated re-scan scheduler/admin tool for quarantined documents; today a
  retry means re-running the upload or invoking the scan service operationally.
- Refund/payout automation, admin quarantine release, and at-rest encryption or
  object-store lifecycle policies.

## Production deployment checklist

These guarantees are the operator/platform's responsibility; the application
cannot enforce them by itself. See the severity-ranked audit findings for the
evidence behind each item.

1. **Secrets** — set `AUTH_SECRET`, `DATABASE_URL`, storage, payment, and LLM
   credentials only in the server environment; never commit `.env`. Rotating
   `AUTH_SECRET` invalidates every outstanding session.
2. **Transport** — terminate TLS and add HSTS at the proxy/platform
   (`Strict-Transport-Security: max-age=63072000`). The app sets
   `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, and
   `Permissions-Policy` globally (`next.config.ts`).
3. **Rate limiting** — implemented (Phase 2): fixed-window limiter in
   `src/lib/rate-limit.ts` + `src/lib/rate-limit-guard.ts`, durable counters in
   the `rate_limit_buckets` table, 429 with `Retry-After`, fail-closed 503 when
   the store is unavailable. Login/registration/upload/payment-initiation are
   covered; the webhook is intentionally exempt (signature + event-id
   idempotency). Counters are shared across processes on the same database but
   not across hosts; enable `TRUST_PROXY_HEADERS` only after the verification in
   `docs/deployment-render.md` §8. See that section for the exact limits and
   remaining assumptions.
4. **Edge body limits** — cap request body size at the proxy as defense in
   depth on top of the in-app budgets.
5. **Worker scheduling** — run `npm run analysis:worker` from cron/systemd/a
   container scheduler. On Render, use a Cron Job: it guarantees at most one
   active run, matching this one-pass script. Concurrent runs are safe
   (compare-and-set claims); graceful shutdown (SIGTERM) lets the current batch
   finish so fewer jobs wait for lease expiry. There is no external queue
   service by design. See `docs/deployment-render.md` §5.
6. **Malware scanning** — the adapter and lifecycle are implemented
   (`src/lib/security/clamav.ts`, `src/lib/document-scan.ts`), but **no clamd
   daemon is deployed**. Uploads stay quarantined until a reachable scanner is
   configured; verify the deployment as described in
   `docs/deployment-render.md` §7. Never release quarantine by hand-editing the
   database, and never point `CLAMAV_HOST` at a public endpoint.
7. **Storage** — for multi-instance/serverless deployments, implement shared
   private object storage behind `StorageAdapter` and enable at-rest
   encryption/versioning. Back up documents and metadata together. Render
   deployments must not use the local driver (ephemeral filesystem); the
   R2/S3-compatible design is in `docs/deployment-render.md` §6.
8. **Extraction isolation** — PDF parsing is CPU/memory-bound and runs
   in-process; for untrusted public uploads, run the analysis worker in a
   resource-limited container/process. DOCX has in-process archive-bomb guards.
9. **Dependency hygiene** — rerun `npm audit --omit=dev` after dependency
   changes. As of the October 2026 audit, remaining advisories are
   development/build-time only or in unreachable CLI transitive paths; the
   `deepmerge-ts` override can be removed once Prisma ships a fixed 6.x release.
10. **Health checks** — configure the platform health-check path as
   `/api/health`. It returns 200 only while the database is reachable (bounded
   to a 2-second probe), and 503 otherwise; the body carries no secrets.
11. **Content Security Policy** — enforced framing/object/base baseline
    (`next.config.ts`) plus a per-request nonce-based report-only full policy
    (`src/proxy.ts`). Complete the promotion checklist in the CSP section above
    in a real browser before moving the full policy to the enforced header.
