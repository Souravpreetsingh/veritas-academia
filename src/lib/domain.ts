// Domain constants.
//
// Prisma `enum` is not supported on SQLite, so role/status columns are stored
// as String. These unions are the single source of truth for valid values and
// are enforced on every server write. See docs/data-model.md.

export const ROLES = ["STUDENT", "INSTRUCTOR", "ADMIN"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export const APPLICATION_STATUSES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "WITHDRAWN",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export function isApplicationStatus(value: unknown): value is ApplicationStatus {
  return (
    typeof value === "string" &&
    (APPLICATION_STATUSES as readonly string[]).includes(value)
  );
}

// Only a PENDING application may be decided or withdrawn. APPROVED, REJECTED
// and WITHDRAWN are terminal; a new submission is required to try again.
const APPLICATION_STATUS_TRANSITIONS: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
  PENDING: ["APPROVED", "REJECTED", "WITHDRAWN"],
  APPROVED: [],
  REJECTED: [],
  WITHDRAWN: [],
};

export function canTransitionApplicationStatus(
  from: ApplicationStatus,
  to: ApplicationStatus,
): boolean {
  return (APPLICATION_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

export function isTerminalApplicationStatus(status: ApplicationStatus): boolean {
  return status !== "PENDING";
}

/**
 * Reapplication policy: a user may submit a new application only when they have
 * no open (PENDING) application and are not already an APPROVED instructor.
 * A REJECTED or WITHDRAWN application may be followed by a fresh submission.
 */
export function canReapply(hasPending: boolean, hasApproved: boolean): boolean {
  return !hasPending && !hasApproved;
}

// Request lifecycle. Transitions are validated server-side in a later phase;
// only the allowed values are defined here.
export const REQUEST_STATUSES = [
  "DRAFT",
  "AWAITING_PAYMENT",
  "PAID",
  "ACCEPTED",
  "IN_PROGRESS",
  "REPORT_READY",
  "DELIVERED",
  "COMPLETED",
  "DECLINED",
  "CANCELLED",
  "REFUNDED",
  "DISPUTED",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export function isRequestStatus(value: unknown): value is RequestStatus {
  return (
    typeof value === "string" && (REQUEST_STATUSES as readonly string[]).includes(value)
  );
}

// Permitted request-status transitions OWNED BY THIS PHASE. A student may submit
// a draft for payment (DRAFT -> AWAITING_PAYMENT) or abandon it (DRAFT ->
// CANCELLED). A submitted request becomes PAID only when verified payment
// evidence is applied (AWAITING_PAYMENT -> PAID) — a provider order or a client
// callback is not a payment. The assigned instructor may then accept or decline
// a PAID request (PAID -> ACCEPTED | DECLINED), so payment always precedes the
// decision. Every remaining transition (delivery, completion, ...) is
// intentionally left empty here and defined by the phase that owns it, so this
// module can never grant a transition no feature implemented.
const REQUEST_STATUS_TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  DRAFT: ["AWAITING_PAYMENT", "CANCELLED"],
  AWAITING_PAYMENT: ["PAID"],
  PAID: ["ACCEPTED", "DECLINED"],
  ACCEPTED: [],
  IN_PROGRESS: [],
  REPORT_READY: [],
  DELIVERED: [],
  COMPLETED: [],
  DECLINED: [],
  CANCELLED: [],
  REFUNDED: [],
  DISPUTED: [],
};

export function canTransitionRequestStatus(
  from: RequestStatus,
  to: RequestStatus,
): boolean {
  return (REQUEST_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

/** Pure authorization decision: is `role` a member of `allowed`? */
export function isRoleAllowed(role: Role, allowed: readonly Role[]): boolean {
  return allowed.includes(role);
}

// Security audit action identifiers. Stored in AuditEvent.action.
export const AUDIT_ACTIONS = {
  DOCUMENT_UPLOAD: "document.upload",
  DOCUMENT_UPLOAD_DENIED: "document.upload.denied",
  DOCUMENT_UPLOAD_FAILED: "document.upload.failed",
  DOCUMENT_DOWNLOAD: "document.download",
  DOCUMENT_DOWNLOAD_DENIED: "document.download.denied",
  DOCUMENT_DOWNLOAD_BLOCKED_QUARANTINE: "document.download.blocked_quarantine",
  DOCUMENT_SCAN_COMPLETED: "document.scan.completed",
  DOCUMENT_SCAN_RELEASED: "document.scan.released",

  INSTRUCTOR_APPLICATION_SUBMITTED: "instructor.application.submitted",
  INSTRUCTOR_APPLICATION_SUBMIT_DENIED: "instructor.application.submit.denied",
  INSTRUCTOR_APPLICATION_WITHDRAWN: "instructor.application.withdrawn",
  INSTRUCTOR_APPLICATION_APPROVED: "instructor.application.approved",
  INSTRUCTOR_APPLICATION_REJECTED: "instructor.application.rejected",
  INSTRUCTOR_APPLICATION_REVIEW_DENIED: "instructor.application.review.denied",
  INSTRUCTOR_APPLICATION_DECISION_CONFLICT: "instructor.application.decision.conflict",

  INSTRUCTOR_SERVICE_PUBLISHED: "instructor.service.published",
  INSTRUCTOR_SERVICE_PUBLISH_DENIED: "instructor.service.publish.denied",

  REQUEST_CREATED: "request.created",
  REQUEST_CREATE_DENIED: "request.create.denied",
  REQUEST_SUBMITTED: "request.submitted",
  REQUEST_SUBMIT_DENIED: "request.submit.denied",
  REQUEST_ACCEPTED: "request.accepted",
  REQUEST_ACCEPT_DENIED: "request.accept.denied",
  REQUEST_DECLINED: "request.declined",
  REQUEST_DECLINE_DENIED: "request.decline.denied",

  PAYMENT_ORDER_CREATED: "payment.order.created",
  PAYMENT_ORDER_CREATE_DENIED: "payment.order.create.denied",
  PAYMENT_VERIFIED: "payment.verified",
  PAYMENT_VERIFICATION_DENIED: "payment.verification.denied",
  PAYMENT_MISMATCH: "payment.mismatch",
  PAYMENT_WEBHOOK_REJECTED: "payment.webhook.rejected",
  PAYMENT_WEBHOOK_IGNORED: "payment.webhook.ignored",

  ANALYSIS_JOB_CREATED: "analysis.job.created",
  ANALYSIS_JOB_CREATE_DENIED: "analysis.job.create.denied",
  ANALYSIS_JOB_SUBMITTED: "analysis.job.submitted",
  ANALYSIS_JOB_COMPLETED: "analysis.job.completed",
  ANALYSIS_JOB_FAILED: "analysis.job.failed",
  ANALYSIS_JOB_RETRY_SCHEDULED: "analysis.job.retry_scheduled",
  ANALYSIS_LLM_CONSENT_GRANTED: "analysis.llm_consent.granted",
  ANALYSIS_LLM_CONSENT_WITHDRAWN: "analysis.llm_consent.withdrawn",
  ANALYSIS_LLM_CONSENT_DENIED: "analysis.llm_consent.denied",
} as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

// Payment lifecycle for the Razorpay integration (src/lib/payments.ts).
//
// A row is CREATED together with its provider order. FAILED records a verified
// failed payment attempt on an order that may still succeed later. PAID is
// terminal and is only ever set from verified provider evidence — never from an
// order creation or a client callback.
export const PAYMENT_STATUSES = ["CREATED", "FAILED", "PAID"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return (
    typeof value === "string" && (PAYMENT_STATUSES as readonly string[]).includes(value)
  );
}

const PAYMENT_STATUS_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  CREATED: ["FAILED", "PAID"],
  FAILED: ["PAID"],
  PAID: [],
};

export function canTransitionPaymentStatus(
  from: PaymentStatus,
  to: PaymentStatus,
): boolean {
  return (PAYMENT_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

export function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return status === "PAID";
}

// How a signature-verified provider webhook event was processed. Stored in
// PaymentWebhookEvent.outcome for the audit trail.
export const PAYMENT_WEBHOOK_OUTCOMES = [
  "APPLIED",
  "NOOP",
  "IGNORED",
  "MISMATCH",
  "FAILURE_RECORDED",
] as const;
export type PaymentWebhookOutcome = (typeof PAYMENT_WEBHOOK_OUTCOMES)[number];

export const DOCUMENT_STATUSES = ["AVAILABLE", "QUARANTINED", "DELETED"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export function isDocumentStatus(value: unknown): value is DocumentStatus {
  return (
    typeof value === "string" && (DOCUMENT_STATUSES as readonly string[]).includes(value)
  );
}

// Malware-scan state for the exact stored object. UNSCANNED and ERROR are
// retryable; SCANNING is a short-lived claim; CLEAN is required before upload
// release. INFECTED is terminal for the current file version.
export const DOCUMENT_SCAN_STATUSES = [
  "UNSCANNED",
  "SCANNING",
  "CLEAN",
  "INFECTED",
  "ERROR",
] as const;
export type DocumentScanStatus = (typeof DOCUMENT_SCAN_STATUSES)[number];

export function isDocumentScanStatus(value: unknown): value is DocumentScanStatus {
  return (
    typeof value === "string" &&
    (DOCUMENT_SCAN_STATUSES as readonly string[]).includes(value)
  );
}

// Four deliberately separate capabilities:
//   LOCAL_SIMILARITY  deterministic matching against the configured local corpus
//   LLM_REVIEW        model-generated observations grounded in the document and
//                     supplied local matches (never a plagiarism/AI score)
//   SIMILARITY        future specialist plagiarism provider
//   AI_WRITING        future specialist AI-writing detector
export const ANALYSIS_JOB_TYPES = [
  "LOCAL_SIMILARITY",
  "LLM_REVIEW",
  "SIMILARITY",
  "AI_WRITING",
] as const;
export type AnalysisJobType = (typeof ANALYSIS_JOB_TYPES)[number];

export function isAnalysisJobType(value: unknown): value is AnalysisJobType {
  return (
    typeof value === "string" && (ANALYSIS_JOB_TYPES as readonly string[]).includes(value)
  );
}

/** Local matching and LLM review run in-process; no external queued provider. */
export function isInlineAnalysisType(
  type: AnalysisJobType,
): type is "LOCAL_SIMILARITY" | "LLM_REVIEW" {
  return type === "LOCAL_SIMILARITY" || type === "LLM_REVIEW";
}

/** Only LLM review sends document text to a third party in this phase. */
export function requiresExternalProcessingConsent(type: AnalysisJobType): boolean {
  return type === "LLM_REVIEW";
}

export const ANALYSIS_JOB_STATUSES = [
  "UNCONFIGURED",
  "PENDING",
  "QUEUED",
  "PROCESSING",
  "RETRYABLE",
  "COMPLETED",
  "FAILED",
] as const;
export type AnalysisJobStatus = (typeof ANALYSIS_JOB_STATUSES)[number];

export function isAnalysisJobStatus(value: unknown): value is AnalysisJobStatus {
  return (
    typeof value === "string" &&
    (ANALYSIS_JOB_STATUSES as readonly string[]).includes(value)
  );
}

// Safe error categories shared by provider adapters and job persistence.
export const ANALYSIS_ERROR_CATEGORIES = [
  "CONFIGURATION",
  "TRANSIENT",
  "RATE_LIMITED",
  "PERMANENT",
  "INVALID_RESULT",
  "CONTENT_REJECTED",
] as const;
export type AnalysisErrorCategory = (typeof ANALYSIS_ERROR_CATEGORIES)[number];

export function isAnalysisErrorCategory(value: unknown): value is AnalysisErrorCategory {
  return (
    typeof value === "string" &&
    (ANALYSIS_ERROR_CATEGORIES as readonly string[]).includes(value)
  );
}

// Permitted analysis-job status transitions.
//
//   PENDING     accepted locally, not yet submitted (database-backed queue)
//   QUEUED      submitted; waiting for the provider
//   PROCESSING  provider is working
//   RETRYABLE   a transient failure occurred; a worker may retry until the
//               bounded attempt/failure budget is exhausted
//   COMPLETED   terminal; only written with a normalized result in the same
//               transaction, never from an unconfigured/fake adapter
//   FAILED      terminal; permanent/configuration/invalid-result failures or an
//               exhausted retry budget. A fresh job may be initiated later.
const ANALYSIS_STATUS_TRANSITIONS: Record<AnalysisJobStatus, readonly AnalysisJobStatus[]> = {
  UNCONFIGURED: ["PENDING", "FAILED"],
  PENDING: ["QUEUED", "RETRYABLE", "FAILED"],
  QUEUED: ["PROCESSING", "COMPLETED", "RETRYABLE", "FAILED"],
  PROCESSING: ["QUEUED", "COMPLETED", "RETRYABLE", "FAILED"],
  RETRYABLE: ["PENDING", "QUEUED", "PROCESSING", "FAILED"],
  COMPLETED: [],
  FAILED: [],
};

export function canTransitionAnalysisStatus(
  from: AnalysisJobStatus,
  to: AnalysisJobStatus,
): boolean {
  return (ANALYSIS_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

export function isTerminalAnalysisStatus(status: AnalysisJobStatus): boolean {
  return status === "COMPLETED" || status === "FAILED";
}

/** Active work is anything that still occupies the one-active-job slot. */
export function isActiveAnalysisStatus(status: AnalysisJobStatus): boolean {
  return !isTerminalAnalysisStatus(status) && status !== "UNCONFIGURED";
}

/**
 * Uniqueness key for active work: one active job per document and analysis
 * type. Terminal jobs release the key so a later, explicitly initiated run can
 * proceed without ever duplicating in-flight/billable work.
 */
export function analysisActiveKey(documentId: string, type: AnalysisJobType): string {
  return `${documentId}:${type}`;
}

/** The portal a role is allowed to reach by default. */
export function homePathForRole(role: Role): string {
  switch (role) {
    case "INSTRUCTOR":
      return "/instructor";
    case "ADMIN":
      return "/admin";
    case "STUDENT":
    default:
      return "/student";
  }
}
