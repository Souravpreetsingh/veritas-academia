import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Payment } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import {
  AUDIT_ACTIONS,
  canTransitionRequestStatus,
  isPaymentStatus,
  isRequestStatus,
  type PaymentStatus,
  type PaymentWebhookOutcome,
  type RequestStatus,
} from "@/lib/domain";
import {
  ConflictError,
  ConfigurationError,
  NotFoundError,
  ValidationError,
} from "@/lib/app-errors";
import {
  canPayServiceRequest,
  canViewServiceRequest,
  type AuthUser,
} from "@/lib/authorization";
import {
  paymentContext,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  type PaymentContext,
} from "@/lib/razorpay";

// Razorpay payment service.
//
// Order creation, checkout verification and webhook processing are separate
// entry points with separate trust assumptions. All three funnel into
// `applyVerifiedPaymentTx` — the single place in the codebase that can mark a
// payment PAID and the request PAID:
//
//   * creating an order never marks anything paid;
//   * a checkout callback counts only after a timing-safe signature check AND a
//     captured provider payment record that matches the stored snapshot;
//   * a webhook counts only after its signature is verified against the exact
//     raw body and it is applied idempotently.
//
// The amount and currency always come from the persisted request snapshot. The
// browser can never supply or alter them. Same convention as src/lib/audit.ts:
// no `server-only` import so the Node test suite can exercise the service with
// an injected fake gateway.

export const PAYMENT_LIMITS = {
  requestIdMax: 64,
  idMax: 128,
  signatureMax: 512,
  receiptMax: 40,
  failureCodeMax: 100,
  webhookBodyMax: 200_000,
} as const;

export interface PaymentSummary {
  id: string;
  status: PaymentStatus;
  amountMinor: number;
  currency: string;
  paidAt: Date | null;
  failureCode: string | null;
  failureAt: Date | null;
  createdAt: Date;
  provider: string;
}

export interface CreateOrderResult {
  paymentId: string;
  provider: string;
  orderId: string;
  /** Public key id for Razorpay Checkout; never a secret. */
  keyId: string;
  amountMinor: number;
  currency: string;
  requestReference: string;
  /** True when an existing active order was resumed instead of creating one. */
  resumed: boolean;
}

export interface VerifyCheckoutResult {
  status: "PAID" | "PENDING";
  requestStatus: RequestStatus | null;
  paidAt: Date | null;
}

export type WebhookOutcome = PaymentWebhookOutcome | "DUPLICATE" | "REJECTED";

export interface WebhookProcessingResult {
  httpStatus: number;
  outcome: WebhookOutcome;
}

export interface ParsedWebhookEvent {
  eventType: string;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  amountMinor: number | null;
  currency: string | null;
  status: string | null;
  errorCode: string | null;
}

// --- Input hygiene -----------------------------------------------------------

function cleanId(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

function cleanSignature(value: unknown): string | null {
  return cleanId(value, PAYMENT_LIMITS.signatureMax);
}

function truncateCode(value: string | null): string | null {
  return value ? value.slice(0, PAYMENT_LIMITS.failureCodeMax) : null;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function toPaymentSummary(row: Payment): PaymentSummary | null {
  if (!isPaymentStatus(row.status)) return null;
  return {
    id: row.id,
    status: row.status,
    amountMinor: row.amountMinor,
    currency: row.currency,
    paidAt: row.paidAt,
    failureCode: row.failureCode,
    failureAt: row.failureAt,
    createdAt: row.createdAt,
    provider: row.provider,
  };
}

// --- Read model (student request page) ---------------------------------------

/**
 * Latest payment state for a request, visible to the owning student and to
 * administrators (same rule as the request itself). Returns null when the
 * viewer may not see the request or no payment exists.
 */
export async function getRequestPaymentSummary(
  actor: AuthUser,
  requestId: unknown,
): Promise<PaymentSummary | null> {
  const id = cleanId(requestId, PAYMENT_LIMITS.requestIdMax);
  if (!id) return null;

  const request = await prisma.serviceRequest.findUnique({
    where: { id },
    select: { id: true, studentId: true },
  });
  if (!request || !canViewServiceRequest(actor, request)) return null;

  const payment = await prisma.payment.findFirst({
    where: { requestId: request.id },
    orderBy: { createdAt: "desc" },
  });
  return payment ? toPaymentSummary(payment) : null;
}

// --- Order creation ----------------------------------------------------------

/**
 * Create (or resume) the Razorpay order for an owned, payable request.
 *
 * The amount and currency are read from the request row — never from the
 * caller. Creating an order changes nothing about the request: it stays
 * AWAITING_PAYMENT until verified payment evidence arrives.
 */
export async function createPaymentOrder(args: {
  actor: AuthUser;
  requestId: unknown;
  context?: PaymentContext;
  request?: Request;
}): Promise<CreateOrderResult> {
  const { actor, request } = args;
  const requestId = cleanId(args.requestId, PAYMENT_LIMITS.requestIdMax);
  if (!requestId) throw new NotFoundError("Request not found.");

  const existing = await prisma.serviceRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      reference: true,
      studentId: true,
      status: true,
      amountMinor: true,
      currency: true,
    },
  });
  if (!existing) throw new NotFoundError("Request not found.");

  if (!canPayServiceRequest(actor, existing)) {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.PAYMENT_ORDER_CREATE_DENIED,
      targetType: "ServiceRequest",
      targetId: existing.id,
      metadata: { reason: "not_owner" },
      request,
    });
    // 404, not 403: another student's request existence is never confirmed.
    throw new NotFoundError("Request not found.");
  }

  const from = isRequestStatus(existing.status) ? existing.status : null;
  if (from === "PAID" || !from || !canTransitionRequestStatus(from, "PAID")) {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.PAYMENT_ORDER_CREATE_DENIED,
      targetType: "ServiceRequest",
      targetId: existing.id,
      metadata: {
        reason: from === "PAID" ? "already_paid" : "invalid_transition",
        from: existing.status,
      },
      request,
    });
    throw new ConflictError(
      from === "PAID"
        ? "This request has already been paid."
        : "This request is not awaiting payment.",
    );
  }

  const context = args.context ?? paymentContext();

  // At most one active order per request: resume the existing one instead of
  // creating a duplicate (repeated clicks and page reloads land here).
  const active = await prisma.payment.findFirst({
    where: { requestId: existing.id, activeKey: existing.id },
  });
  if (active) {
    return {
      paymentId: active.id,
      provider: active.provider,
      orderId: active.providerOrderId,
      keyId: context.config.keyId,
      amountMinor: active.amountMinor,
      currency: active.currency,
      requestReference: existing.reference,
      resumed: true,
    };
  }

  const amountMinor = existing.amountMinor;
  const currency = existing.currency;
  if (!Number.isInteger(amountMinor) || amountMinor <= 0 || currency.trim() === "") {
    throw new ConflictError("This request has no chargeable amount.");
  }

  let providerOrder;
  try {
    providerOrder = await context.gateway.createOrder({
      amountMinor,
      currency,
      receipt: existing.reference.slice(0, PAYMENT_LIMITS.receiptMax),
      notes: { requestId: existing.id, reference: existing.reference },
    });
  } catch (error) {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.PAYMENT_ORDER_CREATE_DENIED,
      targetType: "ServiceRequest",
      targetId: existing.id,
      metadata: { reason: "provider_error" },
      request,
    });
    throw error;
  }

  try {
    const created = await prisma.payment.create({
      data: {
        requestId: existing.id,
        studentId: actor.id,
        provider: "RAZORPAY",
        providerOrderId: providerOrder.id,
        amountMinor,
        currency,
        status: "CREATED",
        activeKey: existing.id,
      },
    });
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.PAYMENT_ORDER_CREATED,
      targetType: "Payment",
      targetId: created.id,
      metadata: {
        reference: existing.reference,
        providerOrderId: providerOrder.id,
        amountMinor,
        currency,
      },
      request,
    });
    return {
      paymentId: created.id,
      provider: created.provider,
      orderId: providerOrder.id,
      keyId: context.config.keyId,
      amountMinor,
      currency,
      requestReference: existing.reference,
      resumed: false,
    };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // A concurrent initiation won the race. The provider order we just
      // created is intentionally left unreferenced: checkout always uses the
      // persisted order, so a discarded order can never be paid here.
      const winner = await prisma.payment.findFirst({
        where: { requestId: existing.id, activeKey: existing.id },
      });
      if (winner) {
        await recordAuditEvent({
          actorId: actor.id,
          action: AUDIT_ACTIONS.PAYMENT_ORDER_CREATE_DENIED,
          targetType: "Payment",
          targetId: winner.id,
          metadata: {
            reason: "concurrent_duplicate",
            discardedProviderOrderId: providerOrder.id,
          },
          request,
        });
        return {
          paymentId: winner.id,
          provider: winner.provider,
          orderId: winner.providerOrderId,
          keyId: context.config.keyId,
          amountMinor: winner.amountMinor,
          currency: winner.currency,
          requestReference: existing.reference,
          resumed: true,
        };
      }
    }
    // Local persistence failed: no misleading state exists (nothing is marked
    // paid) and the caller may safely retry; a fresh provider order will be
    // created on the retry.
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.PAYMENT_ORDER_CREATE_DENIED,
      targetType: "ServiceRequest",
      targetId: existing.id,
      metadata: { reason: "persistence_failed", providerOrderId: providerOrder.id },
      request,
    });
    throw new ConflictError(
      "The payment could not be initiated. Nothing was charged; please try again.",
    );
  }
}

// --- Webhook payload parsing -------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}

function pickEntity(value: unknown): Record<string, unknown> | null {
  const wrapper = asRecord(value);
  return wrapper ? asRecord(wrapper.entity) : null;
}

/**
 * Extract the fields this service acts on from a verified Razorpay webhook
 * body. Unknown shapes return null; unknown extras are ignored.
 */
export function parseRazorpayWebhookEvent(body: unknown): ParsedWebhookEvent | null {
  const root = asRecord(body);
  const eventType = root ? asString(root.event) : null;
  if (!root || !eventType) return null;

  const payload = asRecord(root.payload) ?? {};
  const payment = pickEntity(payload.payment);
  const order = pickEntity(payload.order);
  const entity = payment ?? order;

  return {
    eventType,
    providerOrderId: payment
      ? asString(payment.order_id)
      : order
        ? asString(order.id)
        : null,
    providerPaymentId: payment ? asString(payment.id) : null,
    amountMinor: entity ? asInt(entity.amount) : null,
    currency: entity ? asString(entity.currency) : null,
    status: entity ? asString(entity.status) : null,
    errorCode: payment ? asString(payment.error_code) : null,
  };
}

// --- Verified-payment application (single writer) -----------------------------

interface ApplyArgs {
  paymentId: string;
  providerPaymentId: string | null;
  amountMinor: number | null;
  currency: string | null;
}

interface ApplyOutcome {
  outcome: "APPLIED" | "NOOP" | "MISMATCH";
  reason: string | null;
  requestStatus: RequestStatus | null;
  paidAt: Date | null;
  reference: string | null;
}

/**
 * The single writer that can mark a payment PAID, always inside the caller's
 * transaction so that the payment update, the request transition
 * (AWAITING_PAYMENT -> PAID) and any webhook-event row commit atomically.
 *
 * Compare-and-set updates make repeated and concurrent application safe: only
 * one caller can move CREATED/FAILED -> PAID, and the provider payment id is
 * unique, so one provider payment can never be applied to a second record.
 * Amount and currency are always compared against the stored snapshot.
 */
async function applyVerifiedPaymentTx(
  tx: Prisma.TransactionClient,
  args: ApplyArgs,
): Promise<ApplyOutcome> {
  const payment = await tx.payment.findUnique({ where: { id: args.paymentId } });
  if (!payment) {
    return { outcome: "MISMATCH", reason: "payment_not_found", requestStatus: null, paidAt: null, reference: null };
  }

  if (args.amountMinor === null || args.currency === null) {
    return { outcome: "MISMATCH", reason: "missing_amount", requestStatus: null, paidAt: null, reference: null };
  }
  if (
    args.amountMinor !== payment.amountMinor ||
    args.currency.toUpperCase() !== payment.currency.toUpperCase()
  ) {
    return { outcome: "MISMATCH", reason: "amount_currency", requestStatus: null, paidAt: null, reference: null };
  }

  const request = await tx.serviceRequest.findUnique({
    where: { id: payment.requestId },
    select: { reference: true, status: true },
  });
  const reference = request?.reference ?? null;
  const requestStatus = request && isRequestStatus(request.status) ? request.status : null;

  if (payment.status === "PAID") {
    if (payment.providerPaymentId === args.providerPaymentId) {
      return { outcome: "NOOP", reason: "already_paid", requestStatus, paidAt: payment.paidAt, reference };
    }
    if (payment.providerPaymentId === null && args.providerPaymentId !== null) {
      // Upgrade an order-level success (order.paid carries no payment id) with
      // the captured payment id from the later payment.captured event.
      await tx.payment.updateMany({
        where: { id: payment.id, providerPaymentId: null },
        data: { providerPaymentId: args.providerPaymentId },
      });
      return { outcome: "NOOP", reason: "payment_id_merged", requestStatus, paidAt: payment.paidAt, reference };
    }
    return { outcome: "MISMATCH", reason: "order_already_paid", requestStatus, paidAt: payment.paidAt, reference };
  }

  const now = new Date();
  const updated = await tx.payment.updateMany({
    where: { id: payment.id, status: { in: ["CREATED", "FAILED"] } },
    data: {
      status: "PAID",
      providerPaymentId: args.providerPaymentId,
      paidAt: now,
      activeKey: null,
      failureCode: null,
      failureAt: null,
    },
  });
  if (updated.count === 0) {
    const current = await tx.payment.findUnique({ where: { id: payment.id } });
    if (current?.status === "PAID" && current.providerPaymentId === args.providerPaymentId) {
      return { outcome: "NOOP", reason: "already_paid", requestStatus, paidAt: current.paidAt, reference };
    }
    return { outcome: "MISMATCH", reason: "concurrent_change", requestStatus, paidAt: null, reference };
  }

  // Payment always precedes the instructor decision: AWAITING_PAYMENT -> PAID
  // in the same transaction. A request that is not awaiting payment (e.g. the
  // duplicate delivery of the same evidence) is left untouched.
  await tx.serviceRequest.updateMany({
    where: { id: payment.requestId, status: "AWAITING_PAYMENT" },
    data: { status: "PAID" },
  });
  const after = await tx.serviceRequest.findUnique({
    where: { id: payment.requestId },
    select: { status: true },
  });
  return {
    outcome: "APPLIED",
    reason: null,
    requestStatus: after && isRequestStatus(after.status) ? after.status : null,
    paidAt: now,
    reference,
  };
}

/** Record a verified failed attempt without ever overwriting a success. */
async function markPaymentAttemptFailed(paymentId: string, errorCode: string | null): Promise<void> {
  await prisma.payment.updateMany({
    where: { id: paymentId, status: { in: ["CREATED", "FAILED"] } },
    data: {
      status: "FAILED",
      failureCode: truncateCode(errorCode),
      failureAt: new Date(),
    },
  });
}

// --- Checkout verification ----------------------------------------------------

/**
 * Verify a Razorpay Checkout result for an owned request.
 *
 * Trust chain: timing-safe signature check first, then the callback must match
 * a local payment of this request, then the provider's own record must show the
 * payment captured for this order with the stored amount/currency. Only then is
 * verified evidence applied. Repeated calls are idempotent.
 */
export async function verifyCheckoutPayment(args: {
  actor: AuthUser;
  requestId: unknown;
  orderId: unknown;
  paymentId: unknown;
  signature: unknown;
  context?: PaymentContext;
  request?: Request;
}): Promise<VerifyCheckoutResult> {
  const { actor, request } = args;
  const requestId = cleanId(args.requestId, PAYMENT_LIMITS.requestIdMax);
  const providerOrderId = cleanId(args.orderId, PAYMENT_LIMITS.idMax);
  const providerPaymentId = cleanId(args.paymentId, PAYMENT_LIMITS.idMax);
  const signature = cleanSignature(args.signature);

  if (!requestId || !providerOrderId || !providerPaymentId || !signature) {
    throw new ValidationError("Payment verification failed.");
  }

  const existing = await prisma.serviceRequest.findUnique({
    where: { id: requestId },
    select: { id: true, studentId: true, status: true },
  });
  if (!existing) throw new NotFoundError("Request not found.");

  if (!canPayServiceRequest(actor, existing)) {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.PAYMENT_VERIFICATION_DENIED,
      targetType: "ServiceRequest",
      targetId: existing.id,
      metadata: { reason: "not_owner" },
      request,
    });
    throw new NotFoundError("Request not found.");
  }

  const context = args.context ?? paymentContext();

  // 1) Timing-safe checkout signature (documented Razorpay protocol:
  //    HMAC-SHA256 of "<order_id>|<payment_id>" with the key secret).
  if (
    !verifyCheckoutSignature(
      { orderId: providerOrderId, paymentId: providerPaymentId, signature },
      context.config.keySecret,
    )
  ) {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.PAYMENT_VERIFICATION_DENIED,
      targetType: "ServiceRequest",
      targetId: existing.id,
      metadata: { reason: "signature", providerOrderId },
      request,
    });
    throw new ValidationError("Payment verification failed.");
  }

  // 2) The callback must belong to a local payment of THIS request and student.
  const local = await prisma.payment.findUnique({ where: { providerOrderId } });
  if (!local || local.requestId !== existing.id || local.studentId !== actor.id) {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.PAYMENT_MISMATCH,
      targetType: "ServiceRequest",
      targetId: existing.id,
      metadata: { reason: "order_not_linked", providerOrderId },
      request,
    });
    throw new NotFoundError("Request not found.");
  }

  // 3) Idempotent replay: already paid by this same provider payment.
  if (local.status === "PAID") {
    if (local.providerPaymentId === providerPaymentId) {
      return {
        status: "PAID",
        requestStatus: isRequestStatus(existing.status) ? existing.status : null,
        paidAt: local.paidAt,
      };
    }
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.PAYMENT_MISMATCH,
      targetType: "Payment",
      targetId: local.id,
      metadata: { reason: "order_already_paid", providerOrderId, providerPaymentId },
      request,
    });
    throw new ConflictError("This order has already been paid.");
  }

  // 4) Trusted provider record. The signed callback alone is never treated as
  //    payment evidence: the payment must exist at the provider, belong to this
  //    order, and match the stored amount/currency snapshot exactly.
  const providerPayment = await context.gateway.fetchPayment(providerPaymentId);

  if (providerPayment.id !== providerPaymentId || providerPayment.orderId !== providerOrderId) {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.PAYMENT_MISMATCH,
      targetType: "Payment",
      targetId: local.id,
      metadata: {
        reason: "order_mismatch",
        providerOrderId,
        providerPaymentId,
        providerOrderIdSeen: providerPayment.orderId,
      },
      request,
    });
    throw new ValidationError("Payment verification failed.");
  }
  if (
    providerPayment.amountMinor !== local.amountMinor ||
    providerPayment.currency.toUpperCase() !== local.currency.toUpperCase()
  ) {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.PAYMENT_MISMATCH,
      targetType: "Payment",
      targetId: local.id,
      metadata: {
        reason: "amount_currency",
        expectedAmountMinor: local.amountMinor,
        expectedCurrency: local.currency,
        receivedAmountMinor: providerPayment.amountMinor,
        receivedCurrency: providerPayment.currency,
      },
      request,
    });
    throw new ValidationError("Payment verification failed.");
  }
  if (providerPayment.status === "failed") {
    await markPaymentAttemptFailed(local.id, providerPayment.errorCode);
    throw new ValidationError("The payment attempt failed.");
  }
  if (providerPayment.status !== "captured") {
    // authorized / created: funds are not captured yet. The webhook confirms
    // the final state; nothing is marked paid here.
    return {
      status: "PENDING",
      requestStatus: isRequestStatus(existing.status) ? existing.status : null,
      paidAt: null,
    };
  }

  // 5) Apply the verified evidence (same workflow as the webhook).
  let applied: ApplyOutcome;
  try {
    applied = await prisma.$transaction((tx) =>
      applyVerifiedPaymentTx(tx, {
        paymentId: local.id,
        providerPaymentId,
        amountMinor: providerPayment.amountMinor,
        currency: providerPayment.currency,
      }),
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      await recordAuditEvent({
        actorId: actor.id,
        action: AUDIT_ACTIONS.PAYMENT_MISMATCH,
        targetType: "Payment",
        targetId: local.id,
        metadata: { reason: "payment_id_reuse", providerPaymentId },
        request,
      });
      throw new ValidationError("Payment verification failed.");
    }
    throw error;
  }

  if (applied.outcome === "MISMATCH") {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.PAYMENT_MISMATCH,
      targetType: "Payment",
      targetId: local.id,
      metadata: {
        reason: applied.reason ?? "apply_mismatch",
        providerOrderId,
        providerPaymentId,
      },
      request,
    });
    throw new ValidationError("Payment verification failed.");
  }

  if (applied.outcome === "APPLIED") {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.PAYMENT_VERIFIED,
      targetType: "Payment",
      targetId: local.id,
      metadata: {
        source: "checkout",
        reference: applied.reference,
        providerOrderId,
        providerPaymentId,
        amountMinor: local.amountMinor,
        currency: local.currency,
      },
      request,
    });
  }

  return { status: "PAID", requestStatus: applied.requestStatus, paidAt: applied.paidAt };
}

// --- Webhook processing -------------------------------------------------------

async function recordWebhookEvent(input: {
  eventId: string;
  eventType: string;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  outcome: PaymentWebhookOutcome;
  paymentId: string | null;
}): Promise<void> {
  try {
    await prisma.paymentWebhookEvent.create({ data: input });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // A concurrent delivery already recorded this event; the first write wins.
  }
}

/**
 * Process a Razorpay webhook. The signature is verified against the exact raw
 * body BEFORE parsing; every verified event is recorded once (unique event id)
 * and applied through the same idempotent workflow as checkout verification.
 *
 * HTTP semantics: 400/413 reject invalid deliveries; 200 covers applied,
 * duplicate, no-op, ignored and mismatched events (retrying never helps);
 * unexpected failures bubble up as 500 so the provider retries.
 */
export async function processRazorpayWebhook(args: {
  rawBody: unknown;
  signature: unknown;
  eventId?: unknown;
  context?: PaymentContext;
  request?: Request;
}): Promise<WebhookProcessingResult> {
  const { request } = args;
  const rawBody = typeof args.rawBody === "string" ? args.rawBody : null;
  const signature = cleanSignature(args.signature);

  if (!rawBody) return { httpStatus: 400, outcome: "REJECTED" };

  if (rawBody.length > PAYMENT_LIMITS.webhookBodyMax) {
    await recordAuditEvent({
      actorId: null,
      action: AUDIT_ACTIONS.PAYMENT_WEBHOOK_REJECTED,
      metadata: { reason: "body_too_large", size: rawBody.length },
      request,
    });
    return { httpStatus: 413, outcome: "REJECTED" };
  }

  const context = args.context ?? paymentContext();
  const webhookSecret = context.config.webhookSecret;
  if (!webhookSecret) {
    await recordAuditEvent({
      actorId: null,
      action: AUDIT_ACTIONS.PAYMENT_WEBHOOK_REJECTED,
      metadata: { reason: "webhook_not_configured" },
      request,
    });
    throw new ConfigurationError("Webhooks are not configured on this server.");
  }

  // The signature covers the exact raw bytes; parsing happens afterwards.
  if (!signature || !verifyWebhookSignature(rawBody, signature, webhookSecret)) {
    await recordAuditEvent({
      actorId: null,
      action: AUDIT_ACTIONS.PAYMENT_WEBHOOK_REJECTED,
      metadata: { reason: "signature" },
      request,
    });
    return { httpStatus: 400, outcome: "REJECTED" };
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    await recordAuditEvent({
      actorId: null,
      action: AUDIT_ACTIONS.PAYMENT_WEBHOOK_REJECTED,
      metadata: { reason: "malformed_json" },
      request,
    });
    return { httpStatus: 400, outcome: "REJECTED" };
  }

  const event = parseRazorpayWebhookEvent(body);
  if (!event) {
    await recordAuditEvent({
      actorId: null,
      action: AUDIT_ACTIONS.PAYMENT_WEBHOOK_REJECTED,
      metadata: { reason: "malformed_event" },
      request,
    });
    return { httpStatus: 400, outcome: "REJECTED" };
  }

  // Idempotency key: the provider's event id header when present, otherwise a
  // hash of the exact raw body (retries re-deliver byte-identical bodies).
  const eventId =
    cleanId(args.eventId, PAYMENT_LIMITS.idMax) ??
    `body:${createHash("sha256").update(rawBody).digest("hex")}`;

  const existingEvent = await prisma.paymentWebhookEvent.findUnique({ where: { eventId } });
  if (existingEvent) return { httpStatus: 200, outcome: "DUPLICATE" };

  const isSuccessEvent =
    event.eventType === "payment.captured" || event.eventType === "order.paid";
  const isFailureEvent = event.eventType === "payment.failed";

  const providerOrderId = event.providerOrderId;
  const payment = providerOrderId
    ? await prisma.payment.findUnique({ where: { providerOrderId } })
    : null;

  if (!providerOrderId || !payment || (!isSuccessEvent && !isFailureEvent)) {
    const reason = !providerOrderId
      ? "no_order_reference"
      : !payment
        ? "unknown_order"
        : "unsupported_event";
    await recordWebhookEvent({
      eventId,
      eventType: event.eventType,
      providerOrderId,
      providerPaymentId: event.providerPaymentId,
      outcome: "IGNORED",
      paymentId: payment?.id ?? null,
    });
    await recordAuditEvent({
      actorId: null,
      action: AUDIT_ACTIONS.PAYMENT_WEBHOOK_IGNORED,
      targetType: "Payment",
      targetId: payment?.id,
      metadata: { reason, eventType: event.eventType, providerOrderId },
      request,
    });
    return { httpStatus: 200, outcome: "IGNORED" };
  }

  return isFailureEvent
    ? processFailureEvent({ event, eventId, payment })
    : processSuccessEvent({ event, eventId, payment, request });
}

async function processSuccessEvent(args: {
  event: ParsedWebhookEvent;
  eventId: string;
  payment: Payment;
  request?: Request;
}): Promise<WebhookProcessingResult> {
  const { event, eventId, payment, request } = args;

  let applied: ApplyOutcome;
  try {
    applied = await prisma.$transaction(async (tx) => {
      const outcome = await applyVerifiedPaymentTx(tx, {
        paymentId: payment.id,
        providerPaymentId: event.providerPaymentId,
        amountMinor: event.amountMinor,
        currency: event.currency,
      });
      // The event row commits atomically with the effects it describes, so a
      // crash can never mark an event processed without applying it.
      await tx.paymentWebhookEvent.create({
        data: {
          eventId,
          eventType: event.eventType,
          providerOrderId: event.providerOrderId,
          providerPaymentId: event.providerPaymentId,
          outcome: outcome.outcome,
          paymentId: payment.id,
        },
      });
      return outcome;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = await prisma.paymentWebhookEvent.findUnique({ where: { eventId } });
      if (winner) return { httpStatus: 200, outcome: "DUPLICATE" };
      // The clash was the provider payment id: it is already applied to another
      // local payment, so this request must not be marked paid.
      await recordWebhookEvent({
        eventId,
        eventType: event.eventType,
        providerOrderId: event.providerOrderId,
        providerPaymentId: event.providerPaymentId,
        outcome: "MISMATCH",
        paymentId: payment.id,
      });
      await recordAuditEvent({
        actorId: null,
        action: AUDIT_ACTIONS.PAYMENT_MISMATCH,
        targetType: "Payment",
        targetId: payment.id,
        metadata: {
          source: "webhook",
          reason: "payment_id_reuse",
          providerPaymentId: event.providerPaymentId,
        },
        request,
      });
      return { httpStatus: 200, outcome: "MISMATCH" };
    }
    throw error;
  }

  if (applied.outcome === "APPLIED") {
    await recordAuditEvent({
      actorId: null,
      action: AUDIT_ACTIONS.PAYMENT_VERIFIED,
      targetType: "Payment",
      targetId: payment.id,
      metadata: {
        source: "webhook",
        eventType: event.eventType,
        reference: applied.reference,
        providerOrderId: event.providerOrderId,
        providerPaymentId: event.providerPaymentId,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
      },
      request,
    });
  } else if (applied.outcome === "MISMATCH") {
    await recordAuditEvent({
      actorId: null,
      action: AUDIT_ACTIONS.PAYMENT_MISMATCH,
      targetType: "Payment",
      targetId: payment.id,
      metadata: {
        source: "webhook",
        reason: applied.reason ?? "apply_mismatch",
        eventType: event.eventType,
        providerOrderId: event.providerOrderId,
        providerPaymentId: event.providerPaymentId,
      },
      request,
    });
  }
  return { httpStatus: 200, outcome: applied.outcome };
}

async function processFailureEvent(args: {
  event: ParsedWebhookEvent;
  eventId: string;
  payment: Payment;
}): Promise<WebhookProcessingResult> {
  let outcome: PaymentWebhookOutcome | "DUPLICATE";
  try {
    outcome = await prisma.$transaction(async (tx) => {
      let result: PaymentWebhookOutcome = "NOOP";
      const current = await tx.payment.findUnique({ where: { id: args.payment.id } });
      // A failure event must never overwrite a verified success; a stale
      // failure for an older attempt is recorded without touching the order.
      if (current && current.status !== "PAID") {
        const updated = await tx.payment.updateMany({
          where: { id: args.payment.id, status: { in: ["CREATED", "FAILED"] } },
          data: {
            status: "FAILED",
            failureCode: truncateCode(args.event.errorCode),
            failureAt: new Date(),
          },
        });
        if (updated.count > 0) result = "FAILURE_RECORDED";
      }
      await tx.paymentWebhookEvent.create({
        data: {
          eventId: args.eventId,
          eventType: args.event.eventType,
          providerOrderId: args.event.providerOrderId,
          providerPaymentId: args.event.providerPaymentId,
          outcome: result,
          paymentId: args.payment.id,
        },
      });
      return result;
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { httpStatus: 200, outcome: "DUPLICATE" };
    throw error;
  }

  return { httpStatus: 200, outcome };
}
