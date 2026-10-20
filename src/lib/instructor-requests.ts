import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import {
  AUDIT_ACTIONS,
  canTransitionRequestStatus,
  isRequestStatus,
  type RequestStatus,
  type Role,
} from "@/lib/domain";
import {
  evaluateInstructorEligibility,
  type EligibilityResult,
} from "@/lib/instructor-eligibility";
import {
  ConflictError,
  ForbiddenError,
  IneligibleError,
  NotFoundError,
  ValidationError,
} from "@/lib/app-errors";
import {
  canDecideInstructorRequest,
  canViewInstructorRequest,
  type AuthUser,
} from "@/lib/authorization";


// ---------------------------------------------------------------------------
// Instructor request inbox + acceptance workflow.
//
// Server-side rules enforced here (never trusted to the client):
//   * The acting instructor is always the authenticated actor; any client
//     supplied id, role, price, currency or status is ignored.
//   * The instructor's current approval/active/suspension state is re-read
//     from the database on every mutation, so a pending, rejected, withdrawn,
//     inactive or suspended instructor can never decide a request.
//   * Only a request genuinely assigned to that instructor is visible or
//     actionable; anything else answers "not found" so another instructor's
//     request is not even confirmed to exist.
//   * Decisions use a conditional (compare-and-set) update on the status the
//     caller read, so simultaneous accept/decline attempts cannot both win.
//   * The price and currency snapshot recorded at creation is never touched.
//
// Kept free of `server-only` so the node:test suites can import it directly.
// ---------------------------------------------------------------------------

export const INSTRUCTOR_INBOX_PAGE_SIZE_DEFAULT = 20;
export const INSTRUCTOR_INBOX_PAGE_SIZE_MAX = 50;
export const INSTRUCTOR_INBOX_MAX_QUERY_LENGTH = 64;

export const DECISION_LIMITS = {
  declineReasonMin: 10,
  declineReasonMax: 2000,
} as const;

// --- Query parsing -----------------------------------------------------------

export interface InstructorRequestQuery {
  status: RequestStatus | null;
  page: number;
  pageSize: number;
}

export type ParsedInstructorRequestQuery =
  | { ok: true; value: InstructorRequestQuery }
  | { ok: false; errors: string[] };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Server-side validation of every instructor-controlled inbox parameter.
 * Invalid input is rejected rather than coerced, so a crafted query cannot
 * widen the visible queue or bypass pagination limits.
 */
export function parseInstructorRequestQuery(
  input: Record<string, string | string[] | undefined>,
): ParsedInstructorRequestQuery {
  const errors: string[] = [];

  let status: RequestStatus | null = null;
  const rawStatus = first(input.status);
  if (rawStatus !== undefined && rawStatus.trim() !== "") {
    if (!isRequestStatus(rawStatus)) {
      errors.push("Unknown request status filter.");
    } else {
      status = rawStatus;
    }
  }

  const rawPage = first(input.page);
  let page = 1;
  if (rawPage !== undefined && rawPage.trim() !== "") {
    const parsed = Number(rawPage);
    if (!Number.isInteger(parsed) || parsed < 1) {
      errors.push("Page must be a whole number of 1 or more.");
    } else {
      page = parsed;
    }
  }

  const rawSize = first(input.pageSize);
  let pageSize = INSTRUCTOR_INBOX_PAGE_SIZE_DEFAULT;
  if (rawSize !== undefined && rawSize.trim() !== "") {
    const parsed = Number(rawSize);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > INSTRUCTOR_INBOX_PAGE_SIZE_MAX) {
      errors.push(`Page size must be between 1 and ${INSTRUCTOR_INBOX_PAGE_SIZE_MAX}.`);
    } else {
      pageSize = parsed;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { status, page, pageSize } };
}

// --- Types -------------------------------------------------------------------

export interface InstructorRequestDocument {
  id: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  status: string;
  scanStatus: string;
}

export interface InstructorRequestSummary {
  id: string;
  reference: string;
  title: string;
  status: RequestStatus;
  amountMinor: number;
  currency: string;
  createdAt: Date;
  deadlineAt: Date | null;
  decisionAt: Date | null;
  studentName: string;
  serviceName: string;
  turnaroundHours: number;
  documentCount: number;
}

export interface InstructorRequestDetail extends InstructorRequestSummary {
  instructions: string | null;
  declineReason: string | null;
  serviceCode: string;
  /** InstructorProfile id of the assigned instructor. */
  instructorProfileId: string;
  instructorName: string;
  documents: InstructorRequestDocument[];
}

export interface InstructorRequestList {
  items: InstructorRequestSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** Real counts per status for this instructor, regardless of the filter. */
  counts: Partial<Record<RequestStatus, number>>;
}

export interface InstructorDecisionResult {
  id: string;
  reference: string;
  status: RequestStatus;
  decisionAt: Date;
  declineReason: string | null;
}

const listInclude = {
  service: { select: { name: true, code: true, turnaroundHours: true } },
  instructor: { include: { user: { select: { id: true, name: true } } } },
  student: { select: { name: true } },
  _count: { select: { documents: true } },
} satisfies Prisma.ServiceRequestInclude;

type RequestListRow = Prisma.ServiceRequestGetPayload<{ include: typeof listInclude }>;

const detailInclude = {
  ...listInclude,
  documents: {
    orderBy: { createdAt: "asc" as const },
    select: {
      id: true,
      originalName: true,
      contentType: true,
      sizeBytes: true,
      status: true,
      scanStatus: true,
    },
  },
} satisfies Prisma.ServiceRequestInclude;

type RequestDetailRow = Prisma.ServiceRequestGetPayload<{ include: typeof detailInclude }>;

function toSummary(row: RequestListRow | RequestDetailRow): InstructorRequestSummary {
  return {
    id: row.id,
    reference: row.reference,
    title: row.title,
    status: (isRequestStatus(row.status) ? row.status : "DRAFT") as RequestStatus,
    amountMinor: row.amountMinor,
    currency: row.currency,
    createdAt: row.createdAt,
    deadlineAt: row.deadlineAt,
    decisionAt: row.decisionAt,
    // Student display name only — never email, suspension or other private data.
    studentName: row.student.name,
    serviceName: row.service.name,
    turnaroundHours: row.service.turnaroundHours,
    documentCount: row._count.documents,
  };
}

function toDetail(row: RequestDetailRow): InstructorRequestDetail {
  return {
    ...toSummary(row),
    instructions: row.instructions,
    declineReason: row.declineReason,
    serviceCode: row.service.code,
    instructorProfileId: row.instructorId,
    instructorName: row.instructor.user.name,
    documents: row.documents,
  };
}

// --- Actor state -------------------------------------------------------------

export interface InstructorActorState {
  userId: string;
  role: Role;
  suspended: boolean;
  profile: { id: string; isApproved: boolean; isActive: boolean } | null;
  eligibility: EligibilityResult;
}

/**
 * The authoritative instructor state for an actor, re-read from the database.
 * Used both to gate the UI and, on every mutation, to re-check eligibility so
 * a status change takes effect immediately even for a live session.
 */
export async function loadInstructorActorState(
  actor: AuthUser,
): Promise<InstructorActorState | null> {
  const user = await prisma.user.findUnique({
    where: { id: actor.id },
    include: { instructorProfile: { select: { id: true, isApproved: true, isActive: true } } },
  });
  if (!user) return null;

  const profile = user.instructorProfile;
  const eligibility = evaluateInstructorEligibility({
    role: user.role as Role,
    suspended: user.suspended,
    profile: profile ? { isApproved: profile.isApproved, isActive: profile.isActive } : null,
  });

  return {
    userId: user.id,
    role: user.role as Role,
    suspended: user.suspended,
    profile: profile ? { ...profile } : null,
    eligibility,
  };
}

// --- Inbox queries -----------------------------------------------------------

function emptyList(query: InstructorRequestQuery): InstructorRequestList {
  return {
    items: [],
    total: 0,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: 0,
    counts: {},
  };
}

/**
 * One page of requests assigned to the acting instructor, newest first.
 *
 * A non-instructor (including an administrator visiting for support) receives
 * an empty page rather than another instructor's queue; only requests whose
 * `instructorId` matches the caller's instructor profile can ever appear.
 */
export async function listInstructorRequests(args: {
  actor: AuthUser;
  query: InstructorRequestQuery;
}): Promise<InstructorRequestList> {
  const { actor, query } = args;

  // Re-read the authoritative account state: a suspended, demoted or
  // profile-less account sees an empty queue — never someone else's.
  const state = await loadInstructorActorState(actor);
  if (!state || state.role !== "INSTRUCTOR" || state.suspended || !state.profile) {
    return emptyList(query);
  }

  const where: Prisma.ServiceRequestWhereInput = {
    instructorId: state.profile.id,
    ...(query.status ? { status: query.status } : {}),
  };

  const [total, rows, grouped] = await Promise.all([
    prisma.serviceRequest.count({ where }),
    prisma.serviceRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: listInclude,
    }),
    prisma.serviceRequest.groupBy({
      by: ["status"],
      where: { instructorId: state.profile.id },
      _count: { _all: true },
    }),
  ]);

  const counts: Partial<Record<RequestStatus, number>> = {};
  for (const group of grouped) {
    if (isRequestStatus(group.status)) {
      counts[group.status] = group._count._all;
    }
  }

  return {
    items: rows.map(toSummary),
    total,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: total === 0 ? 0 : Math.ceil(total / query.pageSize),
    counts,
  };
}

/**
 * A single request by reference.
 *
 * Returns `null` for a missing request AND for one the viewer is not entitled
 * to (a different instructor, or a student), so the caller can answer 404
 * without disclosing that another instructor's request exists.
 */
export async function getInstructorRequest(
  actor: AuthUser,
  reference: unknown,
): Promise<InstructorRequestDetail | null> {
  if (typeof reference !== "string" || reference.trim() === "" || reference.length > 64) {
    return null;
  }

  const row = await prisma.serviceRequest.findUnique({
    where: { reference },
    include: detailInclude,
  });
  if (!row) return null;
  if (!canViewInstructorRequest(actor, row)) return null;

  return toDetail(row);
}

// --- Decisions ---------------------------------------------------------------

type DecisionAction = "ACCEPT" | "DECLINE";

function denialAction(action: DecisionAction): string {
  return action === "ACCEPT"
    ? AUDIT_ACTIONS.REQUEST_ACCEPT_DENIED
    : AUDIT_ACTIONS.REQUEST_DECLINE_DENIED;
}

function targetStatus(action: DecisionAction): RequestStatus {
  return action === "ACCEPT" ? "ACCEPTED" : "DECLINED";
}

interface DecisionContext {
  actorUserId: string;
  profileId: string;
  requestId: string;
  reference: string;
  from: RequestStatus;
}

/**
 * Shared authorization + transition gate for both decisions.
 *
 * Every failure path is audited and answers with a safe error: an ineligible
 * actor gets 403, and a request the actor is not assigned to gets 404 (never
 * 403) so the existence of another instructor's request is not disclosed.
 */
async function prepareDecision(args: {
  actor: AuthUser;
  requestId: unknown;
  action: DecisionAction;
  request?: Request;
}): Promise<DecisionContext> {
  const { actor, requestId, action, request } = args;
  const denied = denialAction(action);

  if (typeof requestId !== "string" || requestId.trim() === "" || requestId.length > 64) {
    throw new NotFoundError("Request not found.");
  }

  // Re-read the authoritative account state — never the session copy.
  const state = await loadInstructorActorState(actor);
  if (!state) {
    await recordAuditEvent({
      actorId: null,
      action: denied,
      metadata: { reason: "actor_not_found" },
      request,
    });
    throw new ForbiddenError("You do not have permission to perform this action.");
  }

  if (!state.eligibility.eligible || !state.profile) {
    await recordAuditEvent({
      actorId: state.userId,
      action: denied,
      metadata: { reason: "ineligible_instructor", reasons: state.eligibility.reasons },
      request,
    });
    throw new IneligibleError(
      "Your instructor account is not eligible to respond to service requests.",
      state.eligibility.reasons,
    );
  }

  const existing = await prisma.serviceRequest.findUnique({
    where: { id: requestId },
    include: { instructor: { select: { userId: true } } },
  });
  if (!existing) throw new NotFoundError("Request not found.");

  // Shared pure rule: only the assigned instructor may decide.
  if (!canDecideInstructorRequest({ id: state.userId, role: state.role }, existing)) {
    await recordAuditEvent({
      actorId: state.userId,
      action: denied,
      targetType: "ServiceRequest",
      targetId: existing.id,
      metadata: { reason: "not_assigned" },
      request,
    });
    // 404 so an unassigned instructor cannot confirm the request exists.
    throw new NotFoundError("Request not found.");
  }

  const from = isRequestStatus(existing.status) ? existing.status : null;
  const to = targetStatus(action);
  if (!from || !canTransitionRequestStatus(from, to)) {
    await recordAuditEvent({
      actorId: state.userId,
      action: denied,
      targetType: "ServiceRequest",
      targetId: existing.id,
      metadata: { reason: "invalid_transition", from: existing.status, to },
      request,
    });
    throw new ConflictError(
      from === "AWAITING_PAYMENT"
        ? "The student's payment must be verified before this request can be decided."
        : action === "ACCEPT"
          ? "This request can no longer be accepted."
          : "This request can no longer be declined.",
    );
  }

  return {
    actorUserId: state.userId,
    profileId: state.profile.id,
    requestId: existing.id,
    reference: existing.reference,
    from,
  };
}

/**
 * Accept a request assigned to the acting instructor. The price/currency
 * snapshot is left untouched, and the decision timestamp is recorded.
 */
export async function acceptServiceRequest(args: {
  actor: AuthUser;
  requestId: unknown;
  request?: Request;
}): Promise<InstructorDecisionResult> {
  const context = await prepareDecision({
    actor: args.actor,
    requestId: args.requestId,
    action: "ACCEPT",
    request: args.request,
  });

  const now = new Date();
  // Compare-and-set: only a row still in the status the caller was authorized
  // against can move. A concurrent decline (or a second accept) loses here.
  const cas = await prisma.serviceRequest.updateMany({
    where: {
      id: context.requestId,
      instructorId: context.profileId,
      status: context.from,
    },
    data: { status: "ACCEPTED", decisionAt: now },
  });
  if (cas.count === 0) {
    await recordAuditEvent({
      actorId: context.actorUserId,
      action: AUDIT_ACTIONS.REQUEST_ACCEPT_DENIED,
      targetType: "ServiceRequest",
      targetId: context.requestId,
      metadata: { reason: "concurrent_conflict", expectedFrom: context.from },
      request: args.request,
    });
    throw new ConflictError("This request was just updated by another action. Refresh and try again.");
  }

  await recordAuditEvent({
    actorId: context.actorUserId,
    action: AUDIT_ACTIONS.REQUEST_ACCEPTED,
    targetType: "ServiceRequest",
    targetId: context.requestId,
    metadata: { reference: context.reference, from: context.from, to: "ACCEPTED" },
    request: args.request,
  });

  return {
    id: context.requestId,
    reference: context.reference,
    status: "ACCEPTED",
    decisionAt: now,
    declineReason: null,
  };
}

export interface RawDeclineInput {
  reason?: unknown;
}

function normalizeDeclineReason(
  value: unknown,
): { ok: true; value: string | null } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, message: "The decline reason must be text." };
  }
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (
    trimmed.length < DECISION_LIMITS.declineReasonMin ||
    trimmed.length > DECISION_LIMITS.declineReasonMax
  ) {
    return { ok: false, message: "The decline reason must be between 10 and 2000 characters." };
  }
  return { ok: true, value: trimmed };
}

/**
 * Decline a request assigned to the acting instructor, with an optional
 * student-visible reason. Only `input.reason` is ever read from client input —
 * every other value supplied alongside it is ignored.
 */
export async function declineServiceRequest(args: {
  actor: AuthUser;
  requestId: unknown;
  input?: RawDeclineInput;
  request?: Request;
}): Promise<InstructorDecisionResult> {
  const context = await prepareDecision({
    actor: args.actor,
    requestId: args.requestId,
    action: "DECLINE",
    request: args.request,
  });

  const reason = normalizeDeclineReason(args.input?.reason);
  if (!reason.ok) {
    await recordAuditEvent({
      actorId: context.actorUserId,
      action: AUDIT_ACTIONS.REQUEST_DECLINE_DENIED,
      targetType: "ServiceRequest",
      targetId: context.requestId,
      metadata: { reason: "validation" },
      request: args.request,
    });
    throw new ValidationError("Please correct the highlighted fields.", {
      reason: reason.message,
    });
  }

  const now = new Date();
  const cas = await prisma.serviceRequest.updateMany({
    where: {
      id: context.requestId,
      instructorId: context.profileId,
      status: context.from,
    },
    data: { status: "DECLINED", decisionAt: now, declineReason: reason.value },
  });
  if (cas.count === 0) {
    await recordAuditEvent({
      actorId: context.actorUserId,
      action: AUDIT_ACTIONS.REQUEST_DECLINE_DENIED,
      targetType: "ServiceRequest",
      targetId: context.requestId,
      metadata: { reason: "concurrent_conflict", expectedFrom: context.from },
      request: args.request,
    });
    throw new ConflictError("This request was just updated by another action. Refresh and try again.");
  }

  await recordAuditEvent({
    actorId: context.actorUserId,
    action: AUDIT_ACTIONS.REQUEST_DECLINED,
    targetType: "ServiceRequest",
    targetId: context.requestId,
    metadata: {
      reference: context.reference,
      from: context.from,
      to: "DECLINED",
      hasReason: reason.value !== null,
    },
    request: args.request,
  });

  return {
    id: context.requestId,
    reference: context.reference,
    status: "DECLINED",
    decisionAt: now,
    declineReason: reason.value,
  };
}
