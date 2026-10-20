# Razorpay payments

How a service request becomes paid, and what an operator must configure for the
Razorpay test/live environments. The security controls are summarised in
`docs/security.md`; this document covers the workflow, setup and recovery.

## Lifecycle

```
DRAFT ──submit──▶ AWAITING_PAYMENT ──verified capture──▶ PAID ──accept/decline──▶ ACCEPTED | DECLINED
```

- Creating a Razorpay order **does not** change the request; it stays
  `AWAITING_PAYMENT`.
- Checkout success in the browser is only a signal. The server verifies the
  checkout signature, then fetches the payment from Razorpay and requires
  `captured` with the exact stored amount/currency.
- The webhook (`payment.captured`, `order.paid`) is an independent confirmation
  path. Either verified path produces the same persisted result, exactly once.
- `payment.failed` records a failed attempt and leaves the request payable.
  A failure never overwrites a verified success.
- Only `PAID` requests are decidable by the instructor. Payment is not a
  decision, and a decision never rewrites payment state.
- Refunds, payouts/earnings, saved cards and partial payments are **out of
  scope** for this phase.

## Data

`Payment` (one row per order) stores:

| Field | Meaning |
| --- | --- |
| `providerOrderId` | Razorpay order id (unique) |
| `providerPaymentId` | Razorpay payment id (unique, null until captured) |
| `amountMinor`, `currency` | Copy of the request snapshot at order creation |
| `status` | `CREATED`, `FAILED`, `PAID` (PAID is terminal) |
| `activeKey` | `requestId` while not PAID; nulled on success. Unique — one active order per request |
| `failureCode`, `failureAt` | Latest safe failure marker only |
| `paidAt` | Set only by verified evidence |

`PaymentWebhookEvent` stores one row per verified delivery: `eventId` (unique;
provider event id or `sha256(rawBody)`), event type, provider ids, outcome
(`APPLIED`, `NOOP`, `IGNORED`, `MISMATCH`, `FAILURE_RECORDED`) and the matched
payment. The row commits in the same transaction as the effects it describes.

No card data, bank data, CVV, tokens or raw provider payloads are stored.

## Environment

Server-only (never prefix with `NEXT_PUBLIC_`):

| Variable | Required | Purpose |
| --- | --- | --- |
| `RAZORPAY_KEY_ID` | yes | API key id |
| `RAZORPAY_KEY_SECRET` | yes | API key secret (legacy alias `RAZORPAY_SECRET` also read) |
| `RAZORPAY_WEBHOOK_SECRET` | recommended | Webhook signing secret; without it the webhook endpoint returns 503 |

Missing key id/secret → order creation fails with a safe **503 configuration
error**; no order is created and nothing is simulated. The publishable key id is
delivered only through the authenticated order response.

## API endpoints

| Endpoint | Auth | Behaviour |
| --- | --- | --- |
| `POST /api/student/requests/[id]/payment` | student session | Creates or resumes the single active order. Body is ignored. Returns `{ paymentId, provider, orderId, keyId, amountMinor, currency, requestReference, resumed }` |
| `POST /api/student/requests/[id]/payment/verify` | student session | Accepts `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }`; returns `{ status: "PAID" \| "PENDING", requestStatus, paidAt }` |
| `POST /api/webhooks/razorpay` | signature | Raw body verified before parsing; deduplicated and applied transactionally |

Error semantics: `400` invalid input/signature/body, `404` not owner or unknown
request (existence is not leaked), `409` request not payable / already paid,
`502` provider failure, `503` configuration missing. The webhook returns `400`
or `413` for invalid deliveries, `200` for anything that should not be retried
(applied, duplicate, ignored, mismatch), `503` when unconfigured, and `500` for
unexpected failures so Razorpay retries.

## Razorpay dashboard setup

1. Create test-mode API keys and put them in `.env` (never commit real values).
2. Enable **auto-capture** for the account so checkout payments arrive as
   `captured`. Without it, checkout verification returns `PENDING` and the
   request stays unpaid until a capture event arrives.
3. Add a webhook:
   - URL: `https://<your-public-host>/api/webhooks/razorpay`
   - Secret: the same value as `RAZORPAY_WEBHOOK_SECRET`
   - Events: `payment.captured`, `payment.failed`, `order.paid`
4. For local development, expose the app through a tunnel (for example
   `ngrok http 3000`) and use the tunnel URL in a **test-mode** webhook. Keep
   the tunnel and secret out of version control.

The webhook verifies `X-Razorpay-Signature` over the exact raw bytes. Do not put
a body-rewriting proxy in front of it. `X-Razorpay-Event-Id` is used as the
idempotency key when present; otherwise the SHA-256 of the raw body is used, so
retries are still deduplicated.

## Test strategy

`tests/payments.test.mjs` runs the real services against `prisma/test.db` with a
fake `RazorpayGateway`; no test reaches the network or performs a transaction.
It covers: unauthenticated/foreign order creation, amount/currency tampering,
ineligible states, duplicate/concurrent initiation, invalid checkout and
webhook signatures, raw-body handling, duplicate/out-of-order webhooks,
amount/order/payment mismatches, payment-id reuse across requests, provider
failure, correct persisted state, and absence of secrets in client code.

## Recovery

- **Checkout succeeded but the page was closed** — the webhook still confirms
  the payment; the student's request page reflects the persisted state on
  refresh. The student can also re-run verification by paying again only if no
  active payment exists (Paid rows are terminal).
- **Webhook not configured/missed** — checkout verification is the primary path
  for the tab that completed the payment. For a capture that only the provider
  knows about, inspect the Razorpay dashboard. There is no admin reconciliation
  UI in this phase; do not hand-edit statuses without verified provider
  evidence, and record any manual intervention.
- **Provider outage during verification** — the request stays
  `AWAITING_PAYMENT`; the verify call returns 502 and can be retried. The
  webhook will also retry on 5xx.
- **Duplicate deliveries** — safe by design: one event row, one state
  transition, `DUPLICATE`/`NOOP` outcomes.

## Explicitly deferred

Refunds, partial refunds, payouts, instructor earnings, saved payment methods,
invoices, disputes, automated reconciliation and admin payment tooling. A
decline after payment does not trigger an automatic refund.
