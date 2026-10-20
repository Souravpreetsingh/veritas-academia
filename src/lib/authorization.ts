import type { Role } from "@/lib/domain";

// Pure authorization decisions. Kept free of Next.js/Prisma imports so they can
// be unit-tested directly and reused by every route handler.

export interface AuthUser {
  id: string;
  role: Role;
}

export function isRequestOwner(userId: string, request: { studentId: string }): boolean {
  return request.studentId === userId;
}

/** Who may attach a document to a service request: its owner, or an admin. */
export function canUploadToRequest(user: AuthUser, request: { studentId: string }): boolean {
  return user.role === "ADMIN" || isRequestOwner(user.id, request);
}

export interface AccessibleDocument {
  ownerId: string;
  request?: { instructor?: { userId: string } | null } | null;
}

/** Identity-based access: owner, admin, or the instructor assigned to the request. */
export function canAccessDocument(user: AuthUser, document: AccessibleDocument): boolean {
  if (user.role === "ADMIN") return true;
  if (document.ownerId === user.id) return true;
  if (user.role === "INSTRUCTOR" && document.request?.instructor?.userId === user.id) {
    return true;
  }
  return false;
}

/**
 * A document is downloadable only after a verified CLEAN scan released it.
 * Status alone is insufficient: a legacy/inconsistent AVAILABLE row that was
 * never scanned must stay inaccessible. Missing scan state fails closed.
 */
export function isDocumentDownloadable(document: {
  status: string;
  scanStatus?: string | null;
}): boolean {
  return document.status === "AVAILABLE" && document.scanStatus === "CLEAN";
}

// --- Instructor applications -------------------------------------------------

/** Only administrators may list, view, approve or reject applications. */
export function canReviewApplications(user: AuthUser): boolean {
  return user.role === "ADMIN";
}

/**
 * Only students may submit an instructor application. Instructors (already
 * approved) and admins must not use the applicant flow.
 */
export function canSubmitInstructorApplication(user: AuthUser): boolean {
  return user.role === "STUDENT";
}

/** A user may view their own application; administrators may view any. */
export function canViewApplication(user: AuthUser, application: { userId: string }): boolean {
  return user.role === "ADMIN" || application.userId === user.id;
}

// --- Instructor portal access ------------------------------------------------

export type InstructorPortalAccess = "allow" | "application-status" | "deny";

/**
 * Where a visitor to /instructor should go. Only verified instructors and
 * administrators may enter the protected portal. A student with an application
 * on file is sent to the application-status screen (never granted instructor
 * functionality); everyone else is sent to their own portal.
 */
export function instructorPortalAccess(
  role: Role,
  hasApplication: boolean,
): InstructorPortalAccess {
  if (role === "INSTRUCTOR" || role === "ADMIN") return "allow";
  return hasApplication ? "application-status" : "deny";
}

/** An applicant may withdraw their own application (admin review uses decide). */
export function canWithdrawApplication(user: AuthUser, application: { userId: string }): boolean {
  return application.userId === user.id;
}

// --- Service requests --------------------------------------------------------

/**
 * Only students may create service requests. Instructors must never open
 * requests against themselves or peers, and admins act through support tooling
 * rather than the student request flow.
 */
export function canCreateServiceRequest(user: AuthUser): boolean {
  return user.role === "STUDENT";
}

/** A student may view their own request; administrators may view any. */
export function canViewServiceRequest(user: AuthUser, request: { studentId: string }): boolean {
  return user.role === "ADMIN" || isRequestOwner(user.id, request);
}

/** Only the owning student may submit their request for payment. */
export function canSubmitServiceRequest(user: AuthUser, request: { studentId: string }): boolean {
  return isRequestOwner(user.id, request);
}

// --- Payments ---------------------------------------------------------------

/**
 * Only the owning student may initiate or verify payment for a request. The
 * amount itself is never decided here — it always comes from the persisted
 * request price snapshot on the server.
 */
export function canPayServiceRequest(user: AuthUser, request: { studentId: string }): boolean {
  return user.role === "STUDENT" && isRequestOwner(user.id, request);
}

// --- Instructor request inbox & decisions -----------------------------------

/**
 * The assigned instructor may view a request; administrators may view any for
 * support. No other instructor — and no student — may see it, even by guessing
 * a reference.
 */
export function canViewInstructorRequest(
  user: AuthUser,
  request: { instructor: { userId: string } },
): boolean {
  if (user.role === "ADMIN") return true;
  return user.role === "INSTRUCTOR" && request.instructor.userId === user.id;
}

/**
 * Only the assigned instructor may accept or decline. Administrator support
 * access is read-only: it never grants a decision (and the service layer
 * additionally re-checks the instructor's current approval/active/suspension
 * state against the database before any mutation).
 */
export function canDecideInstructorRequest(
  user: AuthUser,
  request: { instructor: { userId: string } },
): boolean {
  return user.role === "INSTRUCTOR" && request.instructor.userId === user.id;
}

// --- Analysis ----------------------------------------------------------------

/**
 * Payment must have been verified before analysis. PAID is the post-payment
 * state; ACCEPTED means the instructor already decided on a paid request.
 * DRAFT/AWAITING_PAYMENT (unpaid) and DECLINED/CANCELLED are never eligible.
 */
export function isPaidRequestStatusForAnalysis(status: string): boolean {
  return status === "PAID" || status === "ACCEPTED";
}

export interface AnalysisInitiationContext {
  instructorUserId: string;
  requestId: string;
  studentId: string;
  requestStatus: string;
  documentOwnerId: string;
  documentRequestId: string | null;
  documentStatus: string;
  documentScanStatus: string;
}

/**
 * Only the assigned instructor may initiate analysis, only after verified
 * payment, and only for an AVAILABLE document with a persisted CLEAN scan that
 * belongs to the request's student and is attached to that request.
 * Quarantined, unscanned, infected and deleted documents are never eligible to
 * be sent to a provider.
 *
 * Approval/active/suspension state is deliberately NOT part of this pure
 * helper: the service re-reads it from the database on every action.
 */
export function canInitiateAnalysis(
  user: AuthUser,
  context: AnalysisInitiationContext,
): boolean {
  return (
    user.role === "INSTRUCTOR" &&
    context.instructorUserId === user.id &&
    isPaidRequestStatusForAnalysis(context.requestStatus) &&
    context.documentRequestId === context.requestId &&
    context.documentOwnerId === context.studentId &&
    context.documentStatus === "AVAILABLE" &&
    context.documentScanStatus === "CLEAN"
  );
}
