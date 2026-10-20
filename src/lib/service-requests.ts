import { randomBytes } from "node:crypto";
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
import { evaluateInstructorEligibility } from "@/lib/instructor-eligibility";
import {
  ConflictError,
  ForbiddenError,
  IneligibleError,
  NotFoundError,
  ValidationError,
} from "@/lib/app-errors";
import {
  canCreateServiceRequest,
  canSubmitServiceRequest,
  canViewServiceRequest,
  type AuthUser,
} from "@/lib/authorization";

// ---------------------------------------------------------------------------
// Student service-request creation, document association and submission.
//
// Server-side rules enforced here (never trusted to the client):
//   * The student identity is taken from the authenticated actor, never the body.
//   * The instructor must currently be eligible (approved, active, not suspended).
//   * The chosen service must be active AND owned by that instructor.
//   * The turnaround must equal the value the service actually offers.
//   * The price and currency are SNAPSHOTTED from the database row, so a later
//     price change cannot rewrite an existing request and a tampered body can
//     never change what the student is asked to pay.
//   * Documents must be owned by the student, scanned (AVAILABLE) and not yet
//     attached elsewhere; association happens in the same transaction as the
//     request so a failure leaves no orphaned rows.
//
// This module deliberately does NOT mark a request paid, accepted or analysed;
// those belong to later phases.
//
// Kept free of `server-only` so the node:test suites can import it directly.
// ---------------------------------------------------------------------------

export const LIMITS = {
  titleMin: 3,
  titleMax: 160,
  instructionsMin: 10,
  instructionsMax: 4000,
  maxDocuments: 20,
  /** Window in which an identical draft is treated as an accidental resubmit. */
  duplicateWindowMs: 90_000,
} as const;

export interface RawRequestInput {
  serviceId?: unknown;
  title?: unknown;
  instructions?: unknown;
  turnaroundHours?: unknown;
  deadlineAt?: unknown;
  documentIds?: unknown;
}

export interface NormalizedRequestInput {
  serviceId: string;
  title: string;
  instructions: string | null;
  turnaroundHours: number;
  deadlineAt: Date | null;
  documentIds: string[];
}

export type RequestValidationResult =
  | { ok: true; value: NormalizedRequestInput }
  | { ok: false; fields: Record<string, string> };

function toInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

function normalizeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 64 ? trimmed : null;
}

function normalizeDocumentIds(value: unknown): { ids: string[]; error?: string } {
  if (value === undefined || value === null) return { ids: [] };
  if (!Array.isArray(value)) return { ids: [], error: "Documents must be a list." };

  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return { ids: [], error: "Documents must be a list of ids." };
    const trimmed = entry.trim();
    if (trimmed === "" || trimmed.length > 64) return { ids: [], error: "One or more document ids are invalid." };
    if (!ids.includes(trimmed)) ids.push(trimmed);
  }
  if (ids.length > LIMITS.maxDocuments) {
    return { ids: [], error: `You may attach at most ${LIMITS.maxDocuments} documents.` };
  }
  return { ids };
}

/**
 * Pure validation of the create-request body. Does not touch the database; the
 * caller re-checks service ownership, eligibility and turnaround against the
 * stored service afterwards.
 */
export function parseRequestInput(raw: RawRequestInput): RequestValidationResult {
  const fields: Record<string, string> = {};

  const serviceId = normalizeId(raw.serviceId);
  if (!serviceId) fields.serviceId = "Select the service you want to request.";

  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (title.length < LIMITS.titleMin || title.length > LIMITS.titleMax) {
    fields.title = `Provide a title (${LIMITS.titleMin}–${LIMITS.titleMax} characters).`;
  }

  let instructions: string | null = null;
  const rawInstructions = typeof raw.instructions === "string" ? raw.instructions.trim() : "";
  if (rawInstructions.length < LIMITS.instructionsMin || rawInstructions.length > LIMITS.instructionsMax) {
    fields.instructions = `Describe your requirements (${LIMITS.instructionsMin}–${LIMITS.instructionsMax} characters).`;
  } else {
    instructions = rawInstructions;
  }

  const turnaroundHours = toInt(raw.turnaroundHours);
  if (turnaroundHours === null || turnaroundHours < 1) {
    fields.turnaroundHours = "Select a turnaround option.";
  }

  let deadlineAt: Date | null = null;
  if (raw.deadlineAt !== undefined && raw.deadlineAt !== null && raw.deadlineAt !== "") {
    if (typeof raw.deadlineAt !== "string") {
      fields.deadlineAt = "Provide a valid deadline.";
    } else {
      const parsed = new Date(raw.deadlineAt);
      if (Number.isNaN(parsed.getTime())) {
        fields.deadlineAt = "Provide a valid deadline.";
      } else {
        deadlineAt = parsed;
      }
    }
  }

  const docs = normalizeDocumentIds(raw.documentIds);
  if (docs.error) fields.documentIds = docs.error;

  if (Object.keys(fields).length > 0) return { ok: false, fields };

  return {
    ok: true,
    value: {
      serviceId: serviceId as string,
      title,
      instructions,
      turnaroundHours: turnaroundHours as number,
      deadlineAt,
      documentIds: docs.ids,
    },
  };
}

const REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Human-readable, non-sequential reference, e.g. `REQ-2026-K7P2M9`. */
export function generateReference(now: Date): string {
  const year = now.getUTCFullYear();
  const bytes = randomBytes(6);
  let code = "";
  for (let i = 0; i < bytes.length; i += 1) {
    code += REFERENCE_ALPHABET[bytes[i]! % REFERENCE_ALPHABET.length];
  }
  return `REQ-${year}-${code}`;
}

export interface ServiceRequestSummary {
  id: string;
  reference: string;
  title: string;
  status: RequestStatus;
  amountMinor: number;
  currency: string;
  createdAt: Date;
  deadlineAt: Date | null;
  instructorName: string;
  serviceName: string;
  turnaroundHours: number;
  documentCount: number;
}

export interface ServiceRequestDocument {
  id: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  status: string;
  scanStatus: string;
}

export interface ServiceRequestDetail extends ServiceRequestSummary {
  instructions: string | null;
  instructorId: string;
  serviceId: string;
  serviceCode: string;
  /** When the assigned instructor accepted or declined; null until then. */
  decisionAt: Date | null;
  /**
   * Student-visible decline reason (set only on DECLINED). Internal review
   * notes are never stored on the request and never exposed here.
   */
  declineReason: string | null;
  documents: ServiceRequestDocument[];
  /** Explicit, revocable student consent for external LLM processing. */
  llmProcessingConsentAt: Date | null;
  llmProcessingConsentVersion: string | null;
}

const requestInclude = {
  service: { select: { name: true, code: true, turnaroundHours: true } },
  instructor: { include: { user: { select: { name: true } } } },
  _count: { select: { documents: true } },
} satisfies Prisma.ServiceRequestInclude;

type RequestRow = Prisma.ServiceRequestGetPayload<{ include: typeof requestInclude }>;

function toSummary(row: RequestRow): ServiceRequestSummary {
  return {
    id: row.id,
    reference: row.reference,
    title: row.title,
    status: row.status as RequestStatus,
    amountMinor: row.amountMinor,
    currency: row.currency,
    createdAt: row.createdAt,
    deadlineAt: row.deadlineAt,
    instructorName: row.instructor.user.name,
    serviceName: row.service.name,
    turnaroundHours: row.service.turnaroundHours,
    documentCount: row._count.documents,
  };
}

/**
 * Verify each requested document id may be attached: it must exist, be owned by
 * the student, be scanned/available, and not already belong to another request.
 * Rejections use one generic message so a caller cannot probe for the existence
 * of other users' documents.
 */
async function assertAttachableDocuments(actorId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;

  const documents = await prisma.document.findMany({
    where: { id: { in: ids } },
    select: { id: true, ownerId: true, status: true, scanStatus: true, requestId: true },
  });

  const byId = new Map(documents.map((doc) => [doc.id, doc] as const));

  for (const id of ids) {
    const doc = byId.get(id);
    // Missing, not owned, or indirectly revealing another user's doc: same error.
    if (!doc || doc.ownerId !== actorId) {
      throw new ValidationError("One or more selected documents are unavailable.", {
        documentIds: "You may only attach documents you own.",
      });
    }
    if (doc.status !== "AVAILABLE" || doc.scanStatus !== "CLEAN") {
      throw new ValidationError("One or more selected documents are not ready to attach.", {
        documentIds: "A document is still awaiting its security scan.",
      });
    }
    if (doc.requestId !== null) {
      throw new ValidationError("One or more selected documents are already attached.", {
        documentIds: "A document is already linked to another request.",
      });
    }
  }
}

export interface CreateRequestResult {
  request: {
    id: string;
    reference: string;
    status: string;
    amountMinor: number;
    currency: string;
    turnaroundHours: number;
  };
  /** True when an identical recent draft was returned instead of creating one. */
  duplicate: boolean;
}

export async function createServiceRequest(args: {
  actor: AuthUser;
  input: RawRequestInput;
  request?: Request;
  now?: Date;
}): Promise<CreateRequestResult> {
  const { actor, input, request } = args;
  const now = args.now ?? new Date();

  // Defence in depth: the route already restricts to STUDENT, but the service
  // refuses a non-student actor even if called directly.
  if (!canCreateServiceRequest(actor)) {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.REQUEST_CREATE_DENIED,
      metadata: { reason: "role" },
      request,
    });
    throw new ForbiddenError("Only students may create service requests.");
  }

  const parsed = parseRequestInput(input);
  if (!parsed.ok) {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.REQUEST_CREATE_DENIED,
      metadata: { reason: "validation", fields: Object.keys(parsed.fields) },
      request,
    });
    throw new ValidationError("Please correct the highlighted fields.", parsed.fields);
  }

  const { serviceId, title, instructions, turnaroundHours, deadlineAt, documentIds } = parsed.value;

  const service = await prisma.instructorService.findUnique({
    where: { id: serviceId },
    include: { instructor: { include: { user: true } } },
  });

  // A missing or deactivated service is reported as not-found rather than
  // leaking whether an instructor exists.
  if (!service || !service.isActive) {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.REQUEST_CREATE_DENIED,
      metadata: { reason: "service_unavailable", serviceId },
      request,
    });
    throw new NotFoundError("The selected service is not available.");
  }

  const { instructor } = service;
  const instructorUser = instructor.user;
  const eligibility = evaluateInstructorEligibility({
    role: instructorUser.role as Role,
    suspended: instructorUser.suspended,
    profile: { isApproved: instructor.isApproved, isActive: instructor.isActive },
  });
  if (!eligibility.eligible) {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.REQUEST_CREATE_DENIED,
      targetType: "InstructorProfile",
      targetId: instructor.id,
      metadata: { reason: "ineligible_instructor", reasons: eligibility.reasons },
      request,
    });
    throw new IneligibleError(
      "This instructor is not currently accepting service requests.",
      eligibility.reasons,
    );
  }

  // The only turnaround a student may choose is the one the service actually
  // offers; anything else is rejected rather than coerced.
  if (turnaroundHours !== service.turnaroundHours) {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.REQUEST_CREATE_DENIED,
      metadata: { reason: "turnaround_mismatch", serviceId },
      request,
    });
    throw new ValidationError("That turnaround is not offered by this service.", {
      turnaroundHours: "Select the turnaround offered by this service.",
    });
  }

  await assertAttachableDocuments(actor.id, documentIds);

  // Duplicate guard: an identical draft created moments ago is almost certainly
  // a double-click, so return it instead of creating a second request.
  const recent = await prisma.serviceRequest.findFirst({
    where: { studentId: actor.id, serviceId: service.id, status: "DRAFT", title },
    orderBy: { createdAt: "desc" },
  });
  if (recent && now.getTime() - recent.createdAt.getTime() <= LIMITS.duplicateWindowMs) {
    return {
      request: {
        id: recent.id,
        reference: recent.reference,
        status: recent.status,
        amountMinor: recent.amountMinor,
        currency: recent.currency,
        turnaroundHours: service.turnaroundHours,
      },
      duplicate: true,
    };
  }

  // Price/currency snapshot from the trusted row — never the request body.
  const amountMinor = service.amountMinor;
  const currency = service.currency;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reference = generateReference(now);
    try {
      const created = await prisma.$transaction(async (tx) => {
        const req = await tx.serviceRequest.create({
          data: {
            reference,
            studentId: actor.id,
            instructorId: instructor.id,
            serviceId: service.id,
            title,
            instructions,
            deadlineAt,
            status: "DRAFT",
            amountMinor,
            currency,
          },
        });

        if (documentIds.length > 0) {
          const attached = await tx.document.updateMany({
            where: {
              id: { in: documentIds },
              ownerId: actor.id,
              status: "AVAILABLE",
              scanStatus: "CLEAN",
              requestId: null,
            },
            data: { requestId: req.id },
          });
          // If any document slipped away between validation and here, abort —
          // the transaction rolls back so no request is left half-built.
          if (attached.count !== documentIds.length) {
            throw new ConflictError("One or more documents could not be attached.");
          }
        }

        return req;
      });

      await recordAuditEvent({
        actorId: actor.id,
        action: AUDIT_ACTIONS.REQUEST_CREATED,
        targetType: "ServiceRequest",
        targetId: created.id,
        metadata: {
          reference: created.reference,
          serviceId: service.id,
          instructorProfileId: instructor.id,
          documentCount: documentIds.length,
        },
        request,
      });

      return {
        request: {
          id: created.id,
          reference: created.reference,
          status: created.status,
          amountMinor: created.amountMinor,
          currency: created.currency,
          turnaroundHours: service.turnaroundHours,
        },
        duplicate: false,
      };
    } catch (error) {
      // A reference collision is the only retryable failure; re-roll the code.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        continue;
      }
      throw error;
    }
  }

  throw new ConflictError("Could not allocate a request reference. Please try again.");
}

export async function submitServiceRequest(args: {
  actor: AuthUser;
  requestId: string;
  request?: Request;
}): Promise<{ id: string; reference: string; status: string }> {
  const { actor, requestId, request } = args;

  if (typeof requestId !== "string" || requestId.trim() === "") {
    throw new NotFoundError("Request not found.");
  }

  const existing = await prisma.serviceRequest.findUnique({ where: { id: requestId } });
  if (!existing) throw new NotFoundError("Request not found.");

  if (!canSubmitServiceRequest(actor, existing)) {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.REQUEST_SUBMIT_DENIED,
      targetType: "ServiceRequest",
      targetId: existing.id,
      metadata: { reason: "not_owner" },
      request,
    });
    // Report as not-found so a non-owner cannot confirm the request exists.
    throw new NotFoundError("Request not found.");
  }

  const from = isRequestStatus(existing.status) ? existing.status : "DRAFT";
  if (!canTransitionRequestStatus(from, "AWAITING_PAYMENT")) {
    await recordAuditEvent({
      actorId: actor.id,
      action: AUDIT_ACTIONS.REQUEST_SUBMIT_DENIED,
      targetType: "ServiceRequest",
      targetId: existing.id,
      metadata: { reason: "invalid_transition", from },
      request,
    });
    throw new ConflictError("This request can no longer be submitted.");
  }

  // Only the student-owned, current draft moves to AWAITING_PAYMENT. Payment is
  // NOT recorded here — a later phase owns the payment lifecycle.
  const updated = await prisma.serviceRequest.update({
    where: { id: existing.id },
    data: { status: "AWAITING_PAYMENT" },
  });

  await recordAuditEvent({
    actorId: actor.id,
    action: AUDIT_ACTIONS.REQUEST_SUBMITTED,
    targetType: "ServiceRequest",
    targetId: updated.id,
    metadata: { reference: updated.reference, from, to: updated.status },
    request,
  });

  return { id: updated.id, reference: updated.reference, status: updated.status };
}

/** The signed-in student's own requests, newest first. */
export async function listStudentRequests(actor: AuthUser): Promise<ServiceRequestSummary[]> {
  if (!canCreateServiceRequest(actor) && actor.role !== "ADMIN") return [];
  const rows = await prisma.serviceRequest.findMany({
    where: { studentId: actor.id },
    orderBy: { createdAt: "desc" },
    include: requestInclude,
  });
  return rows.map(toSummary);
}

const detailInclude = {
  ...requestInclude,
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

function toDetail(row: RequestDetailRow): ServiceRequestDetail {
  return {
    ...toSummary(row),
    instructions: row.instructions,
    instructorId: row.instructorId,
    serviceId: row.serviceId,
    serviceCode: row.service.code,
    decisionAt: row.decisionAt,
    declineReason: row.declineReason,
    documents: row.documents,
    llmProcessingConsentAt: row.llmProcessingConsentAt,
    llmProcessingConsentVersion: row.llmProcessingConsentVersion,
  };
}

/**
 * A single request by reference, only when the viewer may see it. Returns null
 * for a missing request AND for one the viewer does not own, so the caller can
 * answer 404 without disclosing that another student's request exists.
 */
export async function getStudentRequest(
  actor: AuthUser,
  reference: unknown,
): Promise<ServiceRequestDetail | null> {
  if (typeof reference !== "string" || reference.trim() === "" || reference.length > 64) {
    return null;
  }

  const row = await prisma.serviceRequest.findUnique({
    where: { reference },
    include: detailInclude,
  });
  if (!row) return null;
  if (!canViewServiceRequest(actor, row)) return null;

  return toDetail(row);
}

/** Same as getStudentRequest, but keyed by the internal id (used by the wizard). */
export async function getStudentRequestById(
  actor: AuthUser,
  id: unknown,
): Promise<ServiceRequestDetail | null> {
  if (typeof id !== "string" || id.trim() === "" || id.length > 64) return null;

  const row = await prisma.serviceRequest.findUnique({ where: { id }, include: detailInclude });
  if (!row) return null;
  if (!canViewServiceRequest(actor, row)) return null;

  return toDetail(row);
}
