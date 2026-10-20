# Document analysis

Status: **local-corpus matching and LLM-assisted observations are implemented
with OpenAI or Google Gemini as the configured provider; specialist plagiarism
and AI-writing providers remain unconfigured.**

The platform has four deliberately separate capabilities. They use different job
types, result columns, and disclaimers, and one capability can never write
another capability's result:

| Capability | Job type | Where it runs | Output |
| --- | --- | --- | --- |
| Local corpus overlap | `LOCAL_SIMILARITY` | This server, deterministic | token-overlap percentage + exact local matches |
| LLM-assisted observations | `LLM_REVIEW` | Configured external LLM (OpenAI or Gemini), after student consent | model observations + similarity assistance grounded in real local matches + cautious AI-writing assistance |
| Specialist plagiarism | `SIMILARITY` | Future paid provider | provider score + source matches |
| Specialist AI-writing | `AI_WRITING` | Future paid provider | probabilistic likelihood + segments |

Unavailable capabilities fail closed. No score, source, citation, percentage,
finding, or completed report is fabricated.

See also: `docs/data-model.md` (schema) and `docs/security.md` (controls).

## Components

| File | Responsibility |
| --- | --- |
| `src/lib/analysis/types.ts` | Provider contracts, result types, safe error categories, disclaimers, LLM limits. |
| `src/lib/analysis/normalize.ts` | Strict validation before persistence; drops unknown metadata and invented match ids. |
| `src/lib/analysis/local-corpus.ts` | Explicit, bundled public-domain corpus. |
| `src/lib/analysis/local-similarity.ts` | Deterministic word-shingle matcher and `local-corpus` provider. |
| `src/lib/analysis/llm.ts` | Server-only OpenAI Chat Completions and Google Gemini Interactions adapters, shared prompt, grounding, timeouts, safe errors. |
| `src/lib/analysis/extract-text.ts` | Bounded PDF/DOCX/TXT extraction; rejects unsupported formats. |
| `src/lib/analysis/consent.ts` | Versioned, revocable student consent for external processing. |
| `src/lib/analysis/jobs.ts` | Initiation, authorization, DB claims, inline/specialist processing, retries, completion, safe summaries, worker discovery. |
| `src/lib/analysis/queries.ts` | Authorized instructor workbench read model. |
| `src/app/api/instructor/requests/[id]/analysis/route.ts` | Instructor job-initiation endpoint. |
| `src/app/api/student/requests/[id]/analysis-consent/route.ts` | Student consent grant/withdraw endpoint. |
| `src/components/AnalysisWorkbench.tsx` | Instructor report/status UI with separate sections. |
| `src/components/LlmConsentPanel.tsx` | Student-facing privacy notice and consent controls. |
| `scripts/process-analysis-jobs.mjs` | Operator-run worker: one bounded pass over due jobs. |
| `prisma/schema.prisma` | `AnalysisJob`, `AnalysisResult`, request consent fields. |

## Job types and durability

`AnalysisJob` remains the durable record for every capability.

- `LOCAL_SIMILARITY` and `LLM_REVIEW` are inline capabilities: one worker step
  extracts text, runs the capability, validates the output, and completes the
  job.
- `SIMILARITY` and `AI_WRITING` keep the asynchronous specialist
  submit/poll contract.
- `activeKey` (`documentId:type`, unique) allows one active job per document and
  type. Repeat initiation returns the existing active/completed job, so the same
  work cannot be started twice.
- `COMPLETED` is written only in the same transaction as a normalized
  `AnalysisResult`. A job is never completed merely because it was submitted.
- `attempts` counts actual analysis attempts (for the LLM, only immediately
  before the external call). `failureCount` counts transient failures. Both are
  bounded; only `TRANSIENT` and `RATE_LIMITED` errors retry.

### Worker and scheduling limitation

The database is the queue. There is **no in-memory production queue and no
scheduler deployed in this repository**. An operator must run:

```bash
npm run analysis:worker
```

One invocation processes a bounded batch (`ANALYSIS_WORKER_BATCH`, default 10,
maximum 50) of due jobs and exits. Schedule that command with cron, a platform
job runner, or a container task. Concurrent runs are safe because every
transition is a conditional claim. A worker crash leaves the job in the database;
the next run reclaims it after the lease.

Jobs created in the UI remain `PENDING` until that worker runs. The UI says so
and never shows a pending job as complete.

## Local corpus similarity

Provider id: `local-corpus`. Corpus id: `public-domain-v1`. Algorithm:
`word-shingle-v1`.

Algorithm:

1. Extract normalized plain text.
2. Tokenize into Unicode word tokens and NFKC-normalize/lowercase them.
3. Build every 8-token shingle in each permitted source.
4. Slide 8-token windows over the document and mark exact normalized shingle
   matches.
5. Group contiguous matched tokens into passages and report source/target
   offsets and short excerpts.

The displayed percentage is **the share of the document's extracted word tokens
covered by at least one exact normalized 8-token match** in the bundled corpus.
It is not a plagiarism probability, not internet-wide detection, and not an
academic-database check. Per-match `similarityPercent` remains `null` because
the matcher reports only exact runs, not a fabricated similarity score.

The corpus is small, explicit static data (public-domain Project Gutenberg
excerpts in `local-corpus.ts`). Runtime code passes only that corpus. A source's
optional `documentId` is a hard self-exclusion guard, and private student
submissions must never be added to a shared corpus. Deployments outside the
United States must independently verify the copyright status of every source;
`The Great Gatsby`, for example, is marked public domain in the United States.

The local matcher never fetches websites, accepts private cross-account
documents, or reads another request's material. Replacing the corpus requires a
documented legal basis and an update to the corpus id/version/docs.

## LLM-assisted observations

Two server-only providers can be selected with `LLM_PROVIDER`; both use plain
server-side `fetch` (no SDK required, no model id hard-coded in code):

| Provider id | API | Endpoint |
| --- | --- | --- |
| `openai` | OpenAI Chat Completions | `https://api.openai.com/v1/chat/completions` |
| `gemini` | Google Gemini Interactions API (v1beta) | `https://generativelanguage.googleapis.com/v1beta/interactions` |

The model provides two clearly separated assistance outputs inside one
`LLM_REVIEW` result (see "Two assistance outputs" below): similarity assistance
grounded in real local matches, and cautious AI-writing assistance.

### Server configuration (all server-only)

```dotenv
# Option A — OpenAI:
LLM_PROVIDER="openai"
LLM_API_KEY="<secret>"
LLM_MODEL="<an existing model id supported by the account>"

# Option B — Google Gemini:
LLM_PROVIDER="gemini"
GEMINI_API_KEY="<secret>"
GEMINI_MODEL="gemini-3.8-flash"

# Required in both cases:
LLM_EXTERNAL_PROCESSING_ENABLED="true"
# Optional, clamped (shared):
LLM_TIMEOUT_MS="45000"          # default 45s, cap 120s
LLM_MAX_OUTPUT_TOKENS="1800"    # default 1800, cap 4000
```

Credentials are provider-scoped: the Gemini adapter reads only `GEMINI_API_KEY`
and `GEMINI_MODEL`, and the OpenAI adapter reads only `LLM_API_KEY` and
`LLM_MODEL`. A credential is never sent to another provider's endpoint, even if
`LLM_PROVIDER` changes while the process is running.

`LLM_PROVIDER="unconfigured"` is the default and disables the capability. The
adapter reports `NOT_CONFIGURED` when the provider is unconfigured, external
processing is not explicitly enabled, or the key/model is missing. It reports
`UNAVAILABLE` for an unimplemented provider id. It never invents a model name.

### Model choice (verified against official documentation)

Checked on 2026-10-19 against
`https://ai.google.dev/gemini-api/docs/models` and
`https://ai.google.dev/gemini-api/docs/structured-output` (both updated
2026-10-13/15):

- **Recommended default: `gemini-3.8-flash`** — current stable Flash model
  documented for complex analysis workflows and structured JSON output.
- Cost-oriented alternative: `gemini-3.5-flash-lite`.
- The Gemini 2.5 family is now limited to accounts that already used it; Google
  recommends 3.5 Flash-Lite or 3.8 Flash for new projects. Do not default a new
  integration to `gemini-2.5-*`.

The operator sets the exact model id; the repository never hard-codes one. The
adapter sends only `generation_config.max_output_tokens` (no sampling
parameters), so model-specific parameter restrictions do not break the call.

The Gemini request also sets `store: false`, so the interaction is not retained
server-side for later retrieval. The Interactions API documents no idempotency
key: unlike the OpenAI path, a crash after the provider responded but before the
result was committed can produce one duplicate interaction on retry. Local
attempt/failure budgets still bound total work, and the UI never shows a job as
completed without a validated stored result.

The API key is read only inside the server adapter, sent only in the provider's
auth header (`Authorization` for OpenAI, `x-goog-api-key` for Gemini; never in a
URL or body), and never returned in statuses, errors, summaries, logs, or client
code.

### Consent and external-processing policy

An LLM call requires **both**:

1. `LLM_EXTERNAL_PROCESSING_ENABLED=true`; and
2. explicit student consent on the request (`llmProcessingConsentAt` +
   `llmProcessingConsentVersion` matching the current notice version,
   `llm-review-2026-10-18`). A new notice version requires renewed consent.

The student grants or withdraws consent from their request page. The instructor
endpoint refuses to create an LLM job without consent (409), and every processing
attempt re-checks it. Withdrawal cannot recall an in-flight call, but no new call
may start. Consent and withdrawal are audited.

Only extracted text, short supplied local-match excerpts, and minimal technical
metadata (content type and extracted character count) are sent. The provider does
not receive storage keys, raw file bytes, filenames, payment data, or account
credentials. Match source titles and URLs are deliberately omitted from the
prompt.

### Two assistance outputs

The result keeps the two capabilities separate in distinct fields, so an
instructor can always tell what is grounded in real comparison data and what is
a model observation:

| Capability | Fields | What the model may do | Limitations shown |
| --- | --- | --- | --- |
| Similarity assistance | `citationReview`, `matchExplanations` | Locate short document passages for citation review; explain *only* local matches supplied by the matcher, by `matchId` | Matches come only from the local corpus matcher; the model cannot search the internet, institutional repositories, or academic databases, and no similarity percentage is produced by the LLM. |
| AI-writing assistance | `writingPatternObservations` | Describe observable surface writing patterns with cautious explanations, including benign alternatives | Not evidence of AI authorship; no likelihood/confidence number exists; short, edited, translated, formulaic, or non-native English writing can show similar patterns. |

`writingPatternObservations` entries are `{ pattern, explanation }` pairs. The
schema deliberately has **no** numeric likelihood/confidence field for this
capability, so an invented calibration cannot be represented or displayed. A
fixed false-positive limitation (`LLM_WRITING_PATTERN_DISCLAIMER`) is persisted
with any result that contains writing-pattern observations and is shown next to
the section in the report.

### What the model may produce

The system prompt describes the model as a writing assistant, explicitly **not**
a plagiarism detector or AI-authorship detector. It may return only:

- a neutral document overview;
- structure and writing-quality observations;
- citation-review suggestions, expressed as exact short document quotes plus a
  reason;
- explanations of real supplied local matches, by `matchId`;
- cautious writing-pattern observations (qualitative only, see above);
- neutral instructor investigation questions;
- a grounded summary and limitations.

The server then:

- locates every citation quote verbatim (whitespace-insensitive) in the
  extracted text; unlocatable quotes are dropped;
- replaces the model's quote text with the actual document slice;
- drops explanations for any match id not produced by the local matcher;
- keeps writing-pattern observations qualitative and bounded; no score field
  exists to accept;
- never accepts a model-supplied source record, URL, or score as structured
  result data, and drops unknown fields;
- keeps free-text observations as model-generated text under the observation
  disclaimer rather than treating them as verified facts;
- rejects malformed JSON and over-limit output with a safe `INVALID_RESULT`;
- stores the model disclaimer with the result.

Model output is **not proof of plagiarism or AI authorship**. The UI labels it
as model-generated observation and requires human review.

### Bounds and failure handling

| Control | Value |
| --- | --- |
| Extracted text per document | minimum 20, maximum 120,000 characters |
| PDF pages | maximum 300 |
| LLM input | 60,000 characters |
| LLM raw output | 24,000 characters |
| LLM response timeout | 45s default, 120s cap |
| LLM output tokens | 1,800 default, 4,000 cap |
| Local matches supplied to prompt | 25 |
| Citation passages stored | 20 |
| Match explanations stored | 50 |
| Writing-pattern observations stored | 8 (max 300 + 600 characters each) |

Timeouts, network failures, and 429/5xx responses are retryable with exponential
backoff and a bounded budget. 429 covers both rate limits and quota exhaustion;
either way the job becomes `RETRYABLE` and is never marked completed.
Authentication/configuration errors, content rejection, invalid JSON, invalid
output, and schema violations are terminal and store only a fixed safe message.
Provider error bodies are never read or logged.

For Gemini specifically, only a `completed` interaction is accepted. An
`incomplete` interaction (for example, the output-token budget was hit), a
`failed`/interrupted interaction, an error object, or an interaction with no
`model_output` text is handled as a safe terminal validation failure — partial
JSON is never parsed or persisted. A 404 (model not available to the account)
is a terminal configuration error.

A stable `Idempotency-Key` (`analysis-job:<job id>`) is sent on every OpenAI
request, and the attempt counter increments immediately before the call. A
worker crash after the provider responds retries with the same key, so OpenAI
can avoid a second billable run. The Gemini Interactions API documents no
idempotency key, so a crash in that same window can create one duplicate
interaction; local attempt and failure budgets still bound total work either
way.

## Extraction

`extractDocumentText()` supports:

- PDF via `unpdf`;
- DOCX via `mammoth` raw text;
- UTF-8 `text/plain`.

Legacy `.doc`, RTF, ODT, and unknown formats fail with a safe
`unsupported_document_format` message. Extraction runs only after the
authorization/quarantine/integrity checks and is never logged.

DOCX archives are preflighted before any parser touches them
(`DOCX_ARCHIVE_LIMITS`): at most 2,048 entries, at most 50 MB declared
uncompressed per entry, at most 100 MB declared total. Declared sizes are
untrusted, so every entry is additionally re-inflated once under a hard output
budget and the real size must equal the declared size. This rejects classic zip
bombs even when the central directory understates the real decompression, and it
happens before `mammoth` is imported. A guard failure is a safe content
rejection with no result row.

PDF parsing remains the weak point: page count is bounded, but a single
pathological page can still consume significant CPU/memory in-process. Run the
worker under an enforced memory/CPU limit for hostile input (see the production
checklist in `docs/security.md`).

## Authorization and execution checks

Initiation (`POST /api/instructor/requests/[id]/analysis`, `INSTRUCTOR` only):

- actor's live account: role `INSTRUCTOR`, not suspended, instructor profile
  approved and active;
- request assigned to that instructor (otherwise 404);
- request `PAID` or `ACCEPTED` (verified payment);
- document exists, is owned by the request's student, is attached to that
  request, and has been released (`status = AVAILABLE` **and**
  `scanStatus = CLEAN`; quarantined, unscanned, infected and deleted documents
  are rejected);
- document size is within the upload limit and a SHA-256 checksum is recorded;
- storage driver matches;
- for `LLM_REVIEW`, current student consent;
- a configured provider.

Every processing attempt re-checks:

- document still released (`AVAILABLE` + `CLEAN`), same owner, still attached to
  the request;
- request still paid/accepted;
- initiating instructor still assigned, approved, active, unsuspended;
- storage driver still matches;
- current LLM consent (for `LLM_REVIEW`, checked again immediately before the
  claim and external call).

File bytes are fetched only through the private `StorageAdapter` after these
checks. Uploads record SHA-256 from the stored bytes; analysis refuses a
document without a checksum, and verifies size plus SHA-256 before extraction or
any provider call. A missing checksum or mismatch fails without sending content.

Students can see the consent panel only for their own requests. Administrators
have a read-only instructor-page view. `getAnalysisOverview()` returns `null`
for any other actor.

## Result semantics

- `similarityPercent` and `aiLikelihood` are nullable. `null` means
  unavailable/not produced; it is never replaced with `0`. An explicit `0` from
  a real provider is preserved.
- Scores outside `0..100`, invalid offsets/lengths, or a result attributed to a
  different provider job are rejected; no result row is written.
- `LOCAL_SIMILARITY` writes `similarityPercent` + `matches`, including short
  matched/source excerpts and offsets. It writes no AI likelihood and no
  observations.
- `LLM_REVIEW` writes `observations` (overview, quality, grounded citation
  review, real-match explanations, writing-pattern observations, questions,
  summary, limitations). It writes no similarity percentage, source matches, or
  AI likelihood; writing-pattern observations are qualitative only.
- Specialist `SIMILARITY` and `AI_WRITING` remain separate typed jobs and result
  columns. AI metadata includes a probabilistic, non-proof disclaimer.
- Stored excerpts are bounded (400 characters) and are part of the report
  evidence; raw document text is still not stored in the analysis tables.
- `metadata` retains only allow-listed fields: provider/model versions,
  threshold, corpus/algorithm/shingle/token counts, limitations, token usage,
  extraction version/page count, and disclaimers. Raw provider payloads and
  arbitrary keys are dropped. `AnalysisResult.providerPayload` is retained for
  schema compatibility but is never populated.

The student-facing UI uses the same result rows; the instructor workbench shows
all four sections separately and displays pending/processing/failed/unavailable
states without inventing a result.

## Adding a specialist provider later

1. Implement the adapter contract in `types.ts` with server-only credentials.
2. Map all errors to `AnalysisProviderError` and normalize output with
   `normalize.ts`.
3. Register it in `getSimilarityProvider()` / `getAiWritingProvider()` behind
   `SIMILARITY_PROVIDER` / `AI_WRITING_PROVIDER`.
4. Add credentials to `.env.example` and the deployment secret store. Never use a
   `NEXT_PUBLIC_` prefix.
5. Keep the operator-run worker/scheduler running. Do not add an in-memory queue.
6. Do not invent endpoints, response fields, pricing, or licensing assumptions.

## Out of scope

- Real specialist plagiarism/AI-writing adapters.
- A deployed scheduler; the worker command must be scheduled by the operator.
- Internet-wide or academic-database source discovery/fetching.
- A visual diff/highlighting viewer.
- Provider webhooks, billing reconciliation, refunds, and a human misconduct
  workflow.
